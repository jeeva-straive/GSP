const express = require("express");
const { chromium } = require("playwright");
const http = require("http");
const https = require("https");
const { performance } = require("perf_hooks");
const { BrowserWindow, BrowserView, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const pie = require("puppeteer-in-electron");
const puppeteer = require("puppeteer-core");
const puppeteer1 = require("puppeteer");
const { session } = require("electron");
const synonymsLib = require("synonyms");
const app = express();
// Store latest sibling results by session id for Angular to fetch
const HoverSessions = new Map(); // sessionId -> { selector, currentHref, siblings, pageUrl }
const activeSearchJobs = new Map(); // jobId -> { abortToken, status, lastResult, ... }

const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

app.use(express.json());
const cors = require("cors");
app.use(cors());

// // 1. Serve static files from the Angular build directory
// // Note: Replace 'your-app-name' with the actual folder name generated inside your 'dist' folder
// app.use(express.static(path.join(__dirname, "dist/gsp")));

// // 2. Catch-all route to pass routing over to Angular's frontend router
// // This MUST go after your API routes!
// app.get("*", (req, res) => {
//   res.sendFile(path.join(__dirname, "dist/gsp/index.html"));
// });

function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname || "";
    return hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

function collectKeywords(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    const results = [];
    for (const entry of value) {
      results.push(...collectKeywords(entry));
    }
    return results;
  }
  return String(value)
    .split(/[\n,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function mergeKeywords(...inputs) {
  const deduped = [];
  const seen = new Set();
  for (const input of inputs) {
    for (const keyword of collectKeywords(input)) {
      const key = keyword.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(keyword);
    }
  }
  return deduped;
}

const MANUAL_KEYWORD_SYNONYMS = {
  revenue: [
    "sales",
    "turnover",
    "top line",
    "total revenue",
    "annual revenue",
    "gross revenue",
    "income",
    "revenue",
  ],
  employees: [
    "employee count",
    "staff",
    "headcount",
    "team members",
    "personnel",
    "associates",
    "employees",
    "developers",
  ],
  ceo: [
    "chief executive officer",
    "chief executive",
    "ceo & founder",
    "Chairman of the board",
  ],
  founder: ["co-founder", "founder & ceo", "founding team"],
};

const JOB_RETENTION_MS = 5 * 60 * 1000;
const JOB_SNAPSHOT_THROTTLE_MS = 1200;

function registerSearchJob(jobId, url, keywords, abortToken) {
  const entry = {
    jobId,
    url,
    keywords,
    abortToken,
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    lastResult: null,
    error: null,
  };
  activeSearchJobs.set(jobId, entry);
  return entry;
}

function updateSearchJob(jobId, snapshot, options = {}) {
  const entry = activeSearchJobs.get(jobId);
  if (!entry) return null;
  if (snapshot) {
    entry.lastResult = {
      ...snapshot,
      jobId: snapshot.jobId || entry.jobId,
    };
  }
  if (options.status) {
    entry.status = options.status;
  }
  if (Object.prototype.hasOwnProperty.call(options, "error")) {
    entry.error = options.error;
  }
  entry.updatedAt = Date.now();
  if (options.final) {
    entry.finishedAt = entry.updatedAt;
  }
  return entry;
}

function cleanupFinishedJobs() {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [jobId, entry] of activeSearchJobs.entries()) {
    if (entry && entry.finishedAt && entry.finishedAt < cutoff) {
      activeSearchJobs.delete(jobId);
    }
  }
}

function findSystemChromeExecutable() {
  const candidates = [];
  const pushCandidate = (value) => {
    if (value && typeof value === "string") {
      candidates.push(value);
    }
  };

  pushCandidate(process.env.PUPPETEER_EXECUTABLE_PATH);
  pushCandidate(process.env.CHROME_EXECUTABLE_PATH);
  pushCandidate(process.env.CHROME_PATH);

  if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 =
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    pushCandidate(
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    );
    pushCandidate(
      path.join(
        programFilesX86,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    );
  } else if (process.platform === "darwin") {
    pushCandidate(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    pushCandidate(
      "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    );
  } else {
    pushCandidate("/usr/bin/google-chrome");
    pushCandidate("/usr/bin/google-chrome-stable");
    pushCandidate("/usr/bin/chromium-browser");
    pushCandidate("/usr/bin/chromium");
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

async function launchCrawlerBrowser() {
  const baseOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
    ],
    defaultViewport: null,
    protocolTimeout: 900000,
  };

  const attemptConfigs = [];
  const envExecutable = findSystemChromeExecutable();

  if (envExecutable) {
    attemptConfigs.push({ ...baseOptions, executablePath: envExecutable });
  }

  attemptConfigs.push({ ...baseOptions });
  attemptConfigs.push({ ...baseOptions, channel: "chrome" });

  const deduped = [];
  const seen = new Set();
  for (const config of attemptConfigs) {
    const key = JSON.stringify({
      channel: config.channel || "",
      executablePath: config.executablePath || "",
    });
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(config);
  }

  let lastError = null;
  for (const config of deduped) {
    try {
      return await puppeteer1.launch(config);
    } catch (err) {
      lastError = err;
      continue;
    }
  }
  throw lastError;
}

function buildSynonymList(keyword) {
  const normalized = String(keyword || "").trim();
  if (!normalized) return [];
  if (/\s/.test(normalized)) {
    return [normalized];
  }
  const set = new Set();
  set.add(normalized);
  set.add(normalized.toLowerCase());
  const noPunct = normalized.replace(/[^\w\s-]/g, "");
  if (noPunct && noPunct !== normalized) {
    set.add(noPunct);
    set.add(noPunct.toLowerCase());
  }
  const base = normalized.toLowerCase();
  const manual = MANUAL_KEYWORD_SYNONYMS[base];
  if (Array.isArray(manual)) {
    manual.forEach((entry) => {
      if (!entry) return;
      set.add(entry);
      set.add(entry.toLowerCase());
    });
  }
  try {
    const libSynonyms = synonymsLib(base, "n");
    if (Array.isArray(libSynonyms)) {
      libSynonyms
        .filter(Boolean)
        .forEach((entry) => set.add(String(entry).trim().toLowerCase()));
    }
  } catch {}
  const tokens = base.split(/\s+/).filter(Boolean);
  tokens.forEach((token) => {
    if (!token) return;
    set.add(token);
    if (token.endsWith("y")) {
      set.add(token.slice(0, -1) + "ies");
    } else if (token.endsWith("s")) {
      set.add(token);
    } else {
      set.add(`${token}s`);
    }
  });
  return Array.from(set).filter(Boolean);
}

app.get("/search/cache", (req, res) => {
  const targetUrl = req.query.url;
  const keywords = mergeKeywords(req.query.keywords, req.query.keyword);
  if (!targetUrl || !isValidUrl(targetUrl)) {
    return res
      .status(400)
      .json({ success: false, error: "Provide a valid ?url=" });
  }
  if (!keywords.length) {
    return res.status(400).json({
      success: false,
      error: "Provide at least one ?keyword= or ?keywords=",
    });
  }
  return res.json({
    success: false,
    cacheHit: false,
    error: "No cached crawl available for the provided inputs.",
  });
});

app.get("/search/start", (req, res) => {
  cleanupFinishedJobs();
  const targetUrl = req.query.url;
  const keywords = mergeKeywords(req.query.keywords, req.query.keyword);
  const rawDepth = req.query.maxDepth;
  const fullCrawl = true;
  const maxResults = null;
  let maxDepth = null;
  if (typeof rawDepth !== "undefined" && rawDepth !== null) {
    const depthValue = Array.isArray(rawDepth) ? rawDepth[0] : rawDepth;
    const parsed = Number.parseInt(depthValue, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      maxDepth = parsed;
    }
  }

  if (!targetUrl || !isValidUrl(targetUrl)) {
    return res
      .status(400)
      .json({ success: false, error: "Provide a valid ?url=" });
  }
  if (!keywords.length) {
    return res.status(400).json({
      success: false,
      error: "Provide at least one ?keyword= or ?keywords=",
    });
  }

  const incomingJobId = (req.query.jobId || "").toString().trim();
  const jobId =
    incomingJobId ||
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

  const existing = activeSearchJobs.get(jobId);
  if (existing && existing.status === "running") {
    return res.status(409).json({
      success: false,
      error:
        "A crawl is already running for this job. Please wait for it to finish or use a new jobId.",
    });
  }

  const abortToken = { aborted: false, reason: null };
  registerSearchJob(jobId, targetUrl, keywords, abortToken);
  updateSearchJob(
    jobId,
    {
      website: targetUrl,
      keywords,
      partial: true,
      crawlStatus: "running",
      message: "Preparing crawl...",
    },
    { status: "running" },
  );

  const runner = async () => {
    try {
      const data = await scrapeFullCompanyData(targetUrl, keywords, maxDepth, {
        fullCrawl,
        maxResults,
        abortToken,
        jobId,
      });
      const finalStatus = abortToken.aborted ? "aborted" : "completed";
      const payload = {
        ...(data || {}),
        jobId,
        crawlStatus: finalStatus,
        partial: finalStatus !== "completed",
        message:
          finalStatus === "completed"
            ? "Crawl completed successfully."
            : abortToken.reason || "Crawl aborted.",
      };
      updateSearchJob(jobId, payload, {
        status: finalStatus,
        error: finalStatus === "completed" ? null : abortToken.reason || null,
        final: true,
      });
    } catch (err) {
      const aborted = abortToken.aborted;
      const finalStatus = aborted ? "aborted" : "failed";
      const message =
        (err && err.message) ||
        "Unable to extract company data for the requested URL.";
      const fallback = (activeSearchJobs.get(jobId) &&
        activeSearchJobs.get(jobId).lastResult) || {
        website: targetUrl,
        keywords,
        partial: true,
      };
      fallback.crawlStatus = finalStatus;
      fallback.partial = true;
      fallback.message = message;
      fallback.jobId = jobId;
      updateSearchJob(jobId, fallback, {
        status: finalStatus,
        error: message,
        final: true,
      });
    }
  };
  setImmediate(runner);

  return res.json({
    success: true,
    jobId,
    message:
      "Crawl started. Poll /search/status?jobId=... to receive incremental updates.",
  });
});

app.get("/search/status", (req, res) => {
  cleanupFinishedJobs();
  const jobId = (req.query.jobId || "").toString().trim();
  if (!jobId) {
    return res
      .status(400)
      .json({ success: false, error: "Provide ?jobId in the query string." });
  }
  const entry = activeSearchJobs.get(jobId);
  if (!entry) {
    return res.status(404).json({
      success: false,
      error: "No crawl found for the provided jobId.",
      jobId,
    });
  }
  const status = entry.status || "running";
  const payload = entry.lastResult ? { ...entry.lastResult } : null;
  if (payload && !payload.jobId) {
    payload.jobId = jobId;
  }
  return res.json({
    success: true,
    jobId,
    data: payload,
    status,
    completed: status === "completed",
    failed: status === "failed",
    error: entry.error || null,
    updatedAt: entry.updatedAt || entry.createdAt,
  });
});

app.get("/search", async (req, res) => {
  cleanupFinishedJobs();
  const targetUrl = req.query.url;
  const keywords = mergeKeywords(req.query.keywords, req.query.keyword);
  const rawDepth = req.query.maxDepth;
  const fullCrawl = true;
  let maxDepth = null;
  if (typeof rawDepth !== "undefined" && rawDepth !== null) {
    const depthValue = Array.isArray(rawDepth) ? rawDepth[0] : rawDepth;
    const parsed = Number.parseInt(depthValue, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      maxDepth = parsed;
    }
  }
  const maxResults = null;
  console.log(
    `Received scrape request for URL: ${targetUrl} | keywords: ${
      keywords.length ? keywords.join(", ") : "N/A"
    } | depth: ${maxDepth ?? "auto"} | fullCrawl: ${
      fullCrawl
    } | maxResults: unlimited`,
  );
  if (!targetUrl || !isValidUrl(targetUrl)) {
    return res
      .status(400)
      .json({ success: false, error: "Provide a valid ?url=" });
  }
  if (!keywords.length) {
    return res.status(400).json({
      success: false,
      error: "Provide at least one ?keyword= or ?keywords=",
    });
  }

  const incomingJobId = (req.query.jobId || "").toString().trim();
  const jobId =
    incomingJobId ||
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  if (activeSearchJobs.has(jobId)) {
    return res.status(409).json({
      success: false,
      error:
        "A crawl is already running for this job. Please wait for it to finish or use a new jobId.",
    });
  }
  const abortToken = { aborted: false, reason: null };
  registerSearchJob(jobId, targetUrl, keywords, abortToken);
  // async function scrapeCompanyData(targetUrl) {
  //   const browser = await puppeteer1.launch({
  //     channel: "chrome",
  //     headless: false,
  //     args: [],
  //     defaultViewport: null,
  //   });
  //   const page = await browser.newPage();

  //   // Disguise our scraper as a normal Chrome browser to avoid basic blocks
  //   await page.setUserAgent(
  //     "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  //   );

  //   let result = {
  //     url: targetUrl,
  //     title: null,
  //     description: null,
  //     address: null,
  //   };

  //   try {
  //     console.log(`Navigating to ${targetUrl}...`);
  //     await page.goto(targetUrl, {
  //       waitUntil: "domcontentloaded",
  //       timeout: 30000,
  //     });

  //     // --- STEP 1: Extract Company Details (Title & Meta Description) ---
  //     const companyDetails = await page.evaluate(() => {
  //       const title = document.title || null;

  //       // Look for standard description or OpenGraph (social media) description
  //       const metaDesc =
  //         document.querySelector('meta[name="description"]') ||
  //         document.querySelector('meta[property="og:description"]');

  //       const description = metaDesc
  //         ? metaDesc.getAttribute("content")
  //         : "No description found.";

  //       return { title, description };
  //     });

  //     result.title = companyDetails.title;
  //     result.description = companyDetails.description;

  //     // --- STEP 2: The Address Hunting Logic ---
  //     // A helper function to run inside the browser context to find addresses
  //     const findAddressOnPage = async () => {
  //       return await page.evaluate(() => {
  //         const text = document.body.innerText;
  //         // Regex for standard US/UK/Aus address formats
  //         const addressRegex =
  //           /\d{1,5}\s[\w\s]{1,30}(?:Street|Contact|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Court|Ct|Way|Lane|Ln|Suite|Ste|Floor|Fl)\.?\s*[\w\s,]{1,50}\d{4,5}/gi;
  //         const matches = text.match(addressRegex);
  //         return matches ? matches[0].replace(/\n/g, ", ").trim() : null;
  //       });
  //     };

  //     // Check homepage first
  //     console.log("Scanning homepage for address...");
  //     result.address = await findAddressOnPage();

  //     // --- STEP 3: Navigate to Contact Page if needed ---
  //     if (!result.address) {
  //       console.log(
  //         "Address not found on homepage. Hunting for Contact page...",
  //       );

  //       const contactUrl = await page.evaluate(() => {
  //         const links = Array.from(document.querySelectorAll("a"));
  //         const targetKeywords = ["contact", "about", "location", "reach"];

  //         const contactLink = links.find((a) => {
  //           const text = (a.innerText || "").toLowerCase();
  //           const href = (a.href || "").toLowerCase();
  //           return targetKeywords.some(
  //             (keyword) => text.includes(keyword) || href.includes(keyword),
  //           );
  //         });

  //         return contactLink ? contactLink.href : null;
  //       });

  //       if (contactUrl) {
  //         console.log(`Found contact page: ${contactUrl}. Navigating...`);
  //         await page.goto(contactUrl, {
  //           waitUntil: "domcontentloaded",
  //           timeout: 30000,
  //         });
  //         result.address = await findAddressOnPage();
  //       } else {
  //         console.log("No contact page found.");
  //       }
  //     }

  //     if (!result.address) {
  //       result.address = "Address could not be extracted automatically.";
  //     }
  //   } catch (error) {
  //     console.error(`Error scraping ${targetUrl}:`, error.message);
  //   } finally {
  //     // await browser.close();
  //   }

  //   return result;
  // }

  // async function scrapeFullCompanyData(url) {
  //   const browser = await puppeteer.launch({
  //     headless: false,
  //     channel: "chrome",
  //     args: ["--no-sandbox"],
  //   });
  //   const page = await browser.newPage();
  //   await page.setUserAgent(
  //     "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  //   );

  //   const results = {
  //     website: url,
  //     companyName: "",
  //     metaDescription: "",
  //     contactPageUrl: "",
  //     extractedAddress: null,
  //     contactPageContent: "", // Added this for full content extraction
  //   };

  //   try {
  //     console.log(`🚀 Loading Homepage: ${url}`);
  //     await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  //     // 1. Get Homepage Info
  //     const homeInfo = await page.evaluate(() => {
  //       return {
  //         title: document.title,
  //         desc:
  //           document.querySelector('meta[name="description"]')?.content || "",
  //       };
  //     });
  //     results.companyName = homeInfo.title;
  //     results.metaDescription = homeInfo.desc;

  //     // 2. Find the Contact/Address Link
  //     const contactLink = await page.evaluate(() => {
  //       const anchors = Array.from(document.querySelectorAll("a"));
  //       const keywords = [
  //         "contact",
  //         "contact us",
  //         "location",
  //         "find us",
  //         "office",
  //         "reach",
  //       ];
  //       const found = anchors.find((a) => {
  //         const text = a.innerText.toLowerCase();
  //         const href = (a.getAttribute("href") || "").toLowerCase();
  //         return keywords.some((k) => text.includes(k) || href.includes(k));
  //       });
  //       return found ? found.href : null;
  //     });

  //     // 3. Navigate to the Contact/Details page
  //     if (contactLink) {
  //       results.contactPageUrl = contactLink;
  //       console.log(`🔗 Navigating to Details Link: ${contactLink}`);
  //       await page.goto(contactLink, {
  //         waitUntil: "networkidle2",
  //         timeout: 30000,
  //       });

  //       // 4. EXTRACT CONTENT LOGIC: Capture Address and Full Page Text
  //       const pageData = await page.evaluate(() => {
  //         // Regex for address
  //         const addrRegex =
  //           /\d{1,5}\s[\w\s\.]{1,30}(?:Street|St|Avenue|Ave|Road|Rd|Blvd|Drive|Dr|Court|Ct|Way|Lane|Ln|Suite|Ste|Floor|Fl|Square|Plaza)\.?\s*[\w\s,]{1,50}\d{4,5}/gi;

  //         // Get all text, but clean up white spaces and script/style tags
  //         const clone = document.body.cloneNode(true);
  //         const scripts = clone.querySelectorAll(
  //           "script, style, nav, footer, header",
  //         );
  //         scripts.forEach((s) => s.remove());

  //         const cleanText = clone.innerText.replace(/\s+/g, " ").trim();
  //         const addressMatch = cleanText.match(addrRegex);

  //         return {
  //           fullText: cleanText.substring(0, 1000), // First 1000 chars of relevant content
  //           address: addressMatch ? addressMatch[0] : "Not found in text",
  //         };
  //       });

  //       results.extractedAddress = pageData.address;
  //       results.contactPageContent = pageData.fullText;
  //     } else {
  //       results.contactPageUrl = "No specific contact link found.";
  //     }
  //   } catch (err) {
  //     console.error(`❌ Error: ${err.message}`);
  //   } finally {
  //     await browser.close();
  //   }

  //   return results;
  // }

  try {
    const data = await scrapeFullCompanyData(targetUrl, keywords, maxDepth, {
      fullCrawl,
      maxResults,
      abortToken,
      jobId,
    }); // Note: using actual CSO domain
    if (data && typeof data === "object") {
      data.jobId = jobId;
    }
    console.log("\n--- Extraction Complete ---");
    console.log(JSON.stringify(data, null, 2));
    return res.json({ success: true, data });
  } catch (err) {
    console.error("Failed to scrape search data", err);
    return res.status(500).json({
      success: false,
      error:
        (err && err.message) ||
        "Unable to extract company data for the requested URL.",
      jobId,
    });
  } finally {
    activeSearchJobs.delete(jobId);
  }
});

const DEFAULT_SCRAPER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const UNWANTED_LINK_KEYWORDS = [
  "press",
  "media",
  "story",
  "stories",
  "article",
  "articles",
  "insight",
  "insights",
  "events",
  "event",
  "webinar",
  "webinars",
  "case-study",
  "case-studies",
  "privacy",
  "terms",
  "terms-of",
  "legal",
  "policy",
  "policies",
  "cookie",
  "cookies",
  "disclaimer",
];
// const MAX_KEYWORD_MATCHES = 10;
// const MAX_PAGES_SMART = 30;
// const MAX_PAGES_FULL = 120;
// const MAX_PDF_LINK_SCANS_PER_PAGE = 3;
// const MAX_PDF_LINK_SCANS_TOTAL = 12;
// const MAX_PDF_BYTES = 7 * 1024 * 1024; // 7 MB safety cap
// const PDF_FETCH_TIMEOUT_MS = 20000;
// const PDF_BROWSER_TIMEOUT_MS = 25000;
// const PDF_SNIPPET_RADIUS = 180;

function normalizeUrl(href, base) {
  if (!href) return null;
  const trimmed = String(href).trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^(javascript:|mailto:|tel:)/i.test(trimmed)) return null;
  try {
    const url = base ? new URL(trimmed, base) : new URL(trimmed);
    url.hash = "";
    let result = url.href;
    if (result.length > url.origin.length + 1 && result.endsWith("/")) {
      result = result.replace(/\/+$/, "");
    }
    return result;
  } catch {
    return null;
  }
}

function shouldSkipLinkCandidate(url) {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  const pathname = (parsed && parsed.pathname ? parsed.pathname : url) || "";
  const host = parsed && parsed.hostname ? parsed.hostname : "";
  const search = parsed && parsed.search ? parsed.search : "";
  const normalizedPath = pathname.trim().toLowerCase();
  if (!normalizedPath || normalizedPath === "/") {
    return false;
  }
  const haystack = `${host} ${normalizedPath} ${search}`.toLowerCase();
  return UNWANTED_LINK_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function normalizeMatchFingerprintValue(value) {
  if (value === null || typeof value === "undefined") return "";
  return String(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function buildKeywordMatchFingerprint(match) {
  if (!match || typeof match !== "object") {
    return null;
  }
  const snippetSource =
    match.value || match.snippet || match.text || match.numericValue || "";
  const normalizedSnippet = normalizeMatchFingerprintValue(snippetSource);
  if (!normalizedSnippet) {
    return null;
  }
  return normalizedSnippet;
}

function filterDuplicateMatches(matches) {
  if (!Array.isArray(matches) || !matches.length) {
    return [];
  }
  const seen = new Set();
  const deduped = [];
  for (const match of matches) {
    const fingerprint = buildKeywordMatchFingerprint(match);
    if (!fingerprint) continue;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    deduped.push(match);
  }
  return deduped;
}

function removeContainedMatches(matches) {
  if (!Array.isArray(matches) || !matches.length) {
    return [];
  }
  const withNormalized = matches
    .map((match, index) => {
      const snippet =
        match.value || match.snippet || match.text || match.numericValue || "";
      const normalized = normalizeMatchFingerprintValue(snippet);
      return normalized
        ? { match, normalized, length: normalized.length, index }
        : null;
    })
    .filter(Boolean);
  if (!withNormalized.length) {
    return [];
  }
  withNormalized.sort((a, b) => b.length - a.length);
  const kept = [];
  const normalizedKept = [];
  for (const entry of withNormalized) {
    const isContained = normalizedKept.some((existing) =>
      existing.includes(entry.normalized),
    );
    if (isContained) continue;
    kept.push(entry);
    normalizedKept.push(entry.normalized);
  }
  kept.sort((a, b) => a.index - b.index);
  return kept.map((entry) => entry.match);
}

function isBareDomainUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname || "/";
    const search = parsed.search || "";
    return (pathname === "/" || pathname === "") && !search;
  } catch {
    return false;
  }
}

const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function scrapeFullCompanyData(
  url,
  keywords,
  requestedMaxDepth = null,
  options = {},
) {
  const browser = await launchCrawlerBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(DEFAULT_SCRAPER_UA);

  const abortToken =
    options && typeof options === "object" ? options.abortToken : null;
  const crawlJobId =
    options && typeof options.jobId !== "undefined"
      ? String(options.jobId)
      : null;

  class ManualAbortError extends Error {
    constructor() {
      super("BROWSER_WINDOW_CLOSED");
      this.name = "ManualAbortError";
    }
  }

  let abortedByUser = false;
  let manualAbortTriggered = false;
  const markAbort = () => {
    abortedByUser = true;
  };

  page.on("close", markAbort);
  page.on("crash", markAbort);
  browser.on("disconnected", markAbort);

  const isExternalAbortRequested = () =>
    !!(abortToken && abortToken.aborted === true);

  const isManualCloseError = (err) => {
    if (!err || !err.message) return abortedByUser || page.isClosed();
    const msg = err.message.toLowerCase();
    return (
      msg.includes("target closed") ||
      msg.includes("browser has disconnected") ||
      msg.includes("session closed") ||
      msg.includes("execution context was destroyed") ||
      msg.includes("cannot find context with specified id") ||
      msg.includes("detached frame")
    );
  };

  const isAbortRequested = () =>
    abortedByUser || page.isClosed() || isExternalAbortRequested();

  const runWithPage = async (task) => {
    if (isAbortRequested()) {
      throw new ManualAbortError();
    }
    try {
      return await task();
    } catch (err) {
      if (isManualCloseError(err) || isExternalAbortRequested()) {
        markAbort();
        throw new ManualAbortError();
      }
      throw err;
    }
  };

  const normalizedKeywords = Array.isArray(keywords)
    ? keywords.map((kw) => String(kw || "").trim()).filter(Boolean)
    : [String(keywords || "").trim()].filter(Boolean);
  if (!normalizedKeywords.length) {
    throw new Error("At least one keyword is required for scraping.");
  }
  const keywordConfigs = normalizedKeywords.map((kw) => ({
    keyword: kw,
    matchMode: "text",
    synonyms: buildSynonymList(kw),
  }));

  const keywordMatchBuckets = new Map(
    keywordConfigs.map((cfg) => [cfg.keyword, []]),
  );

  const results = {
    website: url,
    keyword: keywordConfigs[0]?.keyword || "",
    keywords: keywordConfigs.map((cfg) => cfg.keyword),
    companyName: "",
    metaDescription: "",
    contactPageUrl: "",
    contactPageContent: "",
    extractedAddress: null,
    extractedAddresses: [],
    methodUsed: "",
    keywordMatches: [],
    keywordHit: null,
    keywordSummaries: [],
    jobId: crawlJobId || undefined,
    partial: true,
    crawlStatus: "running",
    message: "Starting crawl...",
    currentUrl: url,
    currentDepth: 0,
    visitedCount: 0,
    queueSize: 1,
    lastUpdated: Date.now(),
  };

  const rebuildKeywordSummaries = () => {
    const summaries = keywordConfigs.map((config) => {
      if (!config) return null;
      const matches = keywordMatchBuckets.get(config.keyword) || [];
      const summary = summarizeKeywordMatches(
        matches,
        config.matchMode,
        matchLimit,
      );
      return {
        keyword: config.keyword,
        matchMode: config.matchMode,
        keywordMatches: summary.keywordMatches,
        keywordHit: summary.keywordHit,
      };
    });
    results.keywordSummaries = summaries.filter(Boolean);
    const primary = results.keywordSummaries[0];
    results.keywordMatches = primary ? primary.keywordMatches : [];
    results.keywordHit = primary ? primary.keywordHit : null;
  };

  let lastSnapshotEmit = 0;
  const emitProgressSnapshot = (message, overrides = {}) => {
    if (!crawlJobId) return;
    const now = Date.now();
    if (!message && now - lastSnapshotEmit < JOB_SNAPSHOT_THROTTLE_MS) {
      return;
    }
    lastSnapshotEmit = now;
    const snapshot = {
      ...results,
      ...overrides,
      partial: true,
      crawlStatus: "running",
    };
    snapshot.lastUpdated = Date.now();
    snapshot.message =
      overrides.message ||
      message ||
      snapshot.message ||
      "Collecting company details...";
    updateSearchJob(crawlJobId, snapshot, { status: "running" });
  };

  const linkCapPerPage = null;
  const matchLimit = null;

  const maxDepth =
    typeof requestedMaxDepth === "number" && requestedMaxDepth >= 0
      ? requestedMaxDepth
      : null;
  const normalizedStart = normalizeUrl(url);
  if (!normalizedStart) {
    throw new Error("Unable to normalize start URL.");
  }
  const queue = [{ href: normalizedStart, depth: 0 }];
  const isQueued = (href) => queue.some((entry) => entry.href === href);
  const visited = new Set();
  let keywordLimitSatisfied = false;
  const enqueueLinkCandidate = (candidate, parentUrl, parentDepth) => {
    const normalizedLink = normalizeUrl(candidate, parentUrl);
    if (!normalizedLink) return;
    if (shouldSkipLinkCandidate(normalizedLink)) return;
    if (visited.has(normalizedLink)) return;
    if (isQueued(normalizedLink)) return;
    const nextDepth = typeof parentDepth === "number" ? parentDepth + 1 : 1;
    if (maxDepth !== null && nextDepth > maxDepth) return;
    queue.push({ href: normalizedLink, depth: nextDepth });
  };
  const collectLinksFromPage = async (currentUrl, currentDepth) => {
    let discoveredLinks = [];
    try {
      discoveredLinks = await runWithPage(() =>
        page.evaluate(
          ({ seedUrl, limit }) => {
            const anchors = Array.from(document.querySelectorAll("a[href]"));
            const seen = new Set();
            const collected = [];
            let source = null;
            try {
              source = new URL(seedUrl);
            } catch {
              source = null;
            }
            const hasLimit =
              typeof limit === "number" && Number.isFinite(limit) && limit > 0;
            for (const anchor of anchors) {
              if (hasLimit && collected.length >= limit) break;
              const rawHref = anchor.getAttribute("href") || "";
              if (!rawHref || rawHref.startsWith("#")) continue;
              if (/^(javascript:|mailto:|tel:)/i.test(rawHref)) continue;
              let normalized;
              try {
                normalized = new URL(rawHref, seedUrl).href;
              } catch {
                continue;
              }
              if (seen.has(normalized)) continue;
              if (source) {
                try {
                  if (new URL(normalized).origin !== source.origin) {
                    continue;
                  }
                } catch {
                  continue;
                }
              }
              seen.add(normalized);
              collected.push(normalized);
            }
            return collected;
          },
          { seedUrl: currentUrl, limit: linkCapPerPage },
        ),
      );
    } catch (err) {
      if (err instanceof ManualAbortError) {
        throw err;
      }
      discoveredLinks = [];
    }

    for (const link of discoveredLinks || []) {
      enqueueLinkCandidate(link, currentUrl, currentDepth);
    }
  };
  const getMatchCountForKeyword = (keyword) => {
    const bucket = keywordMatchBuckets.get(keyword);
    return Array.isArray(bucket) ? bucket.length : 0;
  };
  const remainingAllowanceForKeyword = (keyword) => {
    if (matchLimit === null) return null;
    return Math.max(0, matchLimit - getMatchCountForKeyword(keyword));
  };
  const areAllKeywordLimitsSatisfied = () => {
    if (matchLimit === null) return false;
    for (const config of keywordConfigs) {
      if (!config || !config.keyword) continue;
      if (getMatchCountForKeyword(config.keyword) < matchLimit) {
        return false;
      }
    }
    return true;
  };

  try {
    while (queue.length) {
      if (keywordLimitSatisfied) break;
      if (isAbortRequested()) {
        throw new ManualAbortError();
      }
      // if (matchLimit !== null && areAllKeywordLimitsSatisfied()) {
      //   break;
      // }
      const nextEntry = queue.shift();
      if (!nextEntry) continue;
      const current = nextEntry.href;
      const currentDepth =
        typeof nextEntry.depth === "number" ? nextEntry.depth : 0;
      if (!current || visited.has(current)) continue;
      // if (maxDepth !== null && currentDepth > maxDepth) {
      //   continue;
      // }
      visited.add(current);
      results.currentUrl = current;
      results.currentDepth = currentDepth;
      results.visitedCount = visited.size;
      results.queueSize = queue.length;
      emitProgressSnapshot();

      try {
        console.log(
          `[crawler] Loading Page (depth ${currentDepth}): ${current}`,
        );
        await runWithPage(() =>
          page.goto(current, {
            waitUntil: "networkidle2",
            timeout: 30000,
          }),
        );
        await pause(5000); // pause to let dynamic content render before evaluation
        if (isAbortRequested()) {
          throw new ManualAbortError();
        }
      } catch (navErr) {
        if (navErr instanceof ManualAbortError) {
          throw navErr;
        }
        console.warn(`Navigation failed for ${current}:`, navErr.message);
        continue;
      }
      const pageLanguage = await runWithPage(() =>
        page.evaluate(() => {
          try {
            const langCandidates = [];
            const htmlLang =
              (document.documentElement &&
                document.documentElement.getAttribute("lang")) ||
              "";
            if (htmlLang) langCandidates.push(htmlLang);
            const meta = document.querySelector(
              "meta[http-equiv='content-language']",
            );
            const metaLang =
              meta && meta.getAttribute ? meta.getAttribute("content") : "";
            if (metaLang) langCandidates.push(metaLang);
            if (navigator.language) langCandidates.push(navigator.language);
            if (navigator.userLanguage)
              langCandidates.push(navigator.userLanguage);
            const normalized = langCandidates
              .map((entry) => (entry || "").toString().trim().toLowerCase())
              .filter(Boolean);
            return normalized.length ? normalized[0] : "";
          } catch {
            return "";
          }
        }),
      );
      const normalizedLang = (pageLanguage || "").trim().toLowerCase();
      const isEnglishPage = !normalizedLang || normalizedLang.startsWith("en");
      if (!isEnglishPage) {
        console.log(
          `[crawler] Skipping non-English page (lang=${
            normalizedLang || "unknown"
          }): ${current}`,
        );
        continue;
      }

      if (current === normalizedStart) {
        const homeInfo = await runWithPage(() =>
          page.evaluate(() => {
            return {
              title: document.title,
              desc:
                document.querySelector('meta[name="description"]')?.content ||
                "",
            };
          }),
        );
        results.companyName = homeInfo.title;
        results.metaDescription = homeInfo.desc;
        emitProgressSnapshot("Captured homepage metadata");

        if (!results.contactPageUrl) {
          try {
            const contactLink = await runWithPage(() =>
              page.evaluate(() => {
                const anchors = Array.from(
                  document.querySelectorAll("a[href]"),
                );
                const keywords = [
                  "contact",
                  "location",
                  "locations",
                  "find us",
                  "office",
                  "reach",
                  "team",
                  "leadership",
                ];
                const found = anchors.find((a) => {
                  const text = (a.innerText || "").toLowerCase();
                  const href = (a.getAttribute("href") || "").toLowerCase();
                  return keywords.some(
                    (k) => text.includes(k) || href.includes(k),
                  );
                });
                return found ? found.href : null;
              }),
            );
            if (contactLink) {
              const normalizedContact = normalizeUrl(contactLink, current);
              if (normalizedContact) {
                results.contactPageUrl = normalizedContact;
                emitProgressSnapshot("Discovered contact page link");
                if (
                  !visited.has(normalizedContact) &&
                  !isQueued(normalizedContact) &&
                  (maxDepth === null || currentDepth + 1 <= maxDepth)
                ) {
                  queue.push({
                    href: normalizedContact,
                    depth: currentDepth + 1,
                  });
                }
              }
            }
          } catch (err) {
            if (err instanceof ManualAbortError) {
              throw err;
            }
            console.warn("Contact page detection failed:", err && err.message);
          }
        }
      }

      if (currentDepth === 0 && isBareDomainUrl(current)) {
        await collectLinksFromPage(current, currentDepth);
        continue;
      }

      if (!results.extractedAddresses.length) {
        try {
          const extraction = await runWithPage(() =>
            page.evaluate(() => {
              const addrRegex =
                /\d{1,5}\s[\w\s\.]{1,30}(?:Street|Telephone|Toll-Free|Fax|St|Avenue|Ave|Road|Rd|Blvd|Drive|Dr|Court|Ct|Way|Lane|Ln|Suite|Ste|Floor|Fl|Square|Plaza)\.?\s*[\w\s,]{1,50}\d{4,5}/gi;
              const phoneRegex =
                /(?:\+?1[-. ]?)?\(?([2-9][0-8][0-9])\)?[-. ]?([2-9][0-9]{2})[-. ]?([0-9]{4})/;
              const STOP_LINE = /^(get directions|view map|directions|map)$/i;

              const cleanBlock = (text = "") => {
                return text
                  .replace(/\r/g, "")
                  .split("\n")
                  .map((line) => line.replace(/\u00a0/g, " ").trim())
                  .filter((line) => line && !STOP_LINE.test(line))
                  .join("\n")
                  .trim();
              };

              const dedupe = (list) => {
                const seen = new Set();
                const unique = [];
                list.forEach((item) => {
                  const normalized = item.replace(/\s+/g, " ").toLowerCase();
                  if (!seen.has(normalized)) {
                    seen.add(normalized);
                    unique.push(item);
                  }
                });
                return unique;
              };

              const hasAddress = (text) => {
                if (!text) return false;
                addrRegex.lastIndex = 0;
                return addrRegex.test(text);
              };

              const captureStructuredSections = () => {
                const sections = (document.body.innerText || "")
                  .split(/\n\s*\n/g)
                  .map((chunk) => cleanBlock(chunk))
                  .filter(Boolean);
                return dedupe(sections.filter((block) => hasAddress(block)));
              };

              const pageContent = cleanBlock(
                (document.body && document.body.innerText) || "",
              ).substring(0, 1200);

              // 1. Capture entire sections/cards that contain address blocks
              const sectionMatches = captureStructuredSections();
              if (sectionMatches.length) {
                return {
                  addresses: sectionMatches,
                  method: "Section Capture",
                  pageContent,
                };
              }

              // 2. Fall back to plain regex matches found anywhere on the page
              const bodyText = document.body.innerText || "";
              addrRegex.lastIndex = 0;
              const addressMatch = bodyText.match(addrRegex) || [];
              const cleanedMatches = dedupe(
                addressMatch.map((match) => cleanBlock(match)).filter(Boolean),
              );

              if (cleanedMatches.length) {
                return {
                  addresses: cleanedMatches,
                  method: "Standard Regex",
                  pageContent,
                };
              }

              // 3. Phone Number Anchor Logic (Fallback)
              const elements = Array.from(
                document.querySelectorAll("div, p, span, li, address"),
              );
              const fallbackAddresses = [];
              for (let el of elements) {
                const text = (el.innerText || "").trim();
                if (!text) continue;
                if (!phoneRegex.test(text)) continue;

                const candidateContainer =
                  el.closest(
                    "address, article, section, li, [class*='location'], [class*='office'], [class*='contact'], [class*='branch'], [class*='card']",
                  ) || el.parentElement;

                const parentText = candidateContainer
                  ? candidateContainer.innerText
                  : el.innerText;

                if (
                  /\d+/.test(parentText) &&
                  (/\d{5}/.test(parentText) ||
                    /St|Ave|Rd|Drive|Suite|Box/i.test(parentText))
                ) {
                  const snippet = cleanBlock(parentText)
                    .substring(0, 600)
                    .trim();
                  if (snippet) {
                    fallbackAddresses.push(snippet);
                  }
                }
              }

              const cleanedFallback = dedupe(fallbackAddresses);
              if (cleanedFallback.length) {
                return {
                  addresses: cleanedFallback,
                  method: "Phone Anchor Proximity",
                  pageContent,
                };
              }

              return { addresses: [], method: "Failed", pageContent };
            }),
          );

          if (
            extraction &&
            extraction.addresses &&
            extraction.addresses.length
          ) {
            results.extractedAddresses = extraction.addresses;
            results.extractedAddress = extraction.addresses.join(" | ");
            results.methodUsed = extraction.method;
            if (!results.contactPageUrl) {
              results.contactPageUrl = current;
            }
            if (extraction.pageContent) {
              results.contactPageContent = extraction.pageContent;
            }
            emitProgressSnapshot("Extracted contact details");
          }
        } catch (err) {
          if (err instanceof ManualAbortError) {
            throw err;
          }
          console.warn("Address extraction failed:", err && err.message);
        }
      }

      try {
        for (const config of keywordConfigs) {
          if (!config || !config.keyword) continue;
          const remainingBudgetForKeyword = remainingAllowanceForKeyword(
            config.keyword,
          );
          if (remainingBudgetForKeyword === 0) {
            continue;
          }
          const perPageMatchLimit =
            remainingBudgetForKeyword !== null && remainingBudgetForKeyword > 0
              ? remainingBudgetForKeyword
              : null;
          const pageMatches = await runWithPage(() =>
            page.evaluate(
              async ({
                keyword,
                synonyms,
                nodeLimit,
                perPageMatchLimit,
                scanTimeoutMs,
                nodeTextLimit,
              }) => {
                const clean = (value = "") => value.replace(/\s+/g, " ").trim();
                const escapeRegex = (value = "") =>
                  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const normalized = (keyword || "").trim();
                if (!normalized) return [];
                const hasPerf =
                  typeof performance !== "undefined" &&
                  typeof performance.now === "function";
                const now = () => (hasPerf ? performance.now() : Date.now());
                const timeoutMs =
                  typeof scanTimeoutMs === "number" && scanTimeoutMs > 0
                    ? scanTimeoutMs
                    : Number.POSITIVE_INFINITY;
                const deadline = now() + timeoutMs;
                const timedOut = () => now() >= deadline;
                const pause = () =>
                  new Promise((resolve) => requestAnimationFrame(resolve));

                const lower = normalized.toLowerCase();
                const providedSynonyms = Array.isArray(synonyms)
                  ? synonyms.filter(Boolean)
                  : [];
                const labels = providedSynonyms.length
                  ? providedSynonyms
                  : [normalized, lower];

                const labelRegex = new RegExp(
                  labels
                    .map((label) => escapeRegex(label.toLowerCase()))
                    .join("|"),
                  "i",
                );

                const selectors = [
                  "article",
                  "section",
                  "li",
                  "div",
                  "tr",
                  "p",
                  "h1",
                  "h2",
                  "h3",
                  "h4",
                  "h5",
                  "h6",
                  "dt",
                  "dd",
                  "span",
                ];
                const selectorString = selectors.join(",");
                const chunkSize =
                  typeof nodeLimit === "number" && nodeLimit > 0
                    ? nodeLimit
                    : Number.POSITIVE_INFINITY;
                const chunkingEnabled =
                  Number.isFinite(chunkSize) && chunkSize > 0;
                const maxTextLength =
                  typeof nodeTextLimit === "number" && nodeTextLimit > 0
                    ? nodeTextLimit
                    : Number.POSITIVE_INFINITY;
                const matches = [];
                const seenValues = new Set();
                const buildSnippet = (text = "") => {
                  if (!text) return "";
                  const snippetRegex = new RegExp(
                    labelRegex.source,
                    labelRegex.flags,
                  );
                  const match = snippetRegex.exec(text);
                  if (!match || typeof match.index !== "number") {
                    return text.slice(0, 400).trim();
                  }
                  const window = 200;
                  const start = Math.max(match.index - window, 0);
                  const end = Math.min(
                    match.index + match[0].length + window,
                    text.length,
                  );
                  return text.slice(start, end).trim();
                };

                const processNode = (node) => {
                  if (!node || node.nodeType !== 1) {
                    return false;
                  }
                  const raw = node.textContent || "";
                  if (!raw) return false;
                  const limited =
                    raw.length > maxTextLength
                      ? raw.slice(0, maxTextLength)
                      : raw;
                  const normalizedText = clean(limited);
                  if (!normalizedText || !labelRegex.test(normalizedText)) {
                    return false;
                  }

                  const snippet = buildSnippet(normalizedText);
                  if (!snippet) {
                    return false;
                  }

                  if (seenValues.has(snippet)) {
                    return false;
                  }
                  seenValues.add(snippet);

                  matches.push({
                    value: snippet,
                    snippet,
                    confidence: 100,
                    numericValue: null,
                  });

                  return (
                    typeof perPageMatchLimit === "number" &&
                    perPageMatchLimit > 0 &&
                    matches.length >= perPageMatchLimit
                  );
                };

                const shouldStop = () =>
                  timedOut() ||
                  (typeof perPageMatchLimit === "number" &&
                    perPageMatchLimit > 0 &&
                    matches.length >= perPageMatchLimit);

                const maybeScroll = async () => {
                  if (timedOut()) return;
                  const scroller =
                    document.scrollingElement ||
                    document.documentElement ||
                    document.body;
                  if (!scroller) {
                    await pause();
                    return;
                  }
                  const step = Math.max((window.innerHeight || 600) * 0.8, 400);
                  const next =
                    scroller.scrollTop + step >= scroller.scrollHeight
                      ? scroller.scrollHeight
                      : scroller.scrollTop + step;
                  if (next !== scroller.scrollTop) {
                    scroller.scrollTop = next;
                    await pause();
                  } else {
                    await pause();
                  }
                };

                const root = document.body || document.documentElement;
                let processed = 0;
                if (
                  root &&
                  typeof document.createNodeIterator === "function" &&
                  typeof NodeFilter !== "undefined"
                ) {
                  const iterator = document.createNodeIterator(
                    root,
                    NodeFilter.SHOW_ELEMENT,
                    {
                      acceptNode(node) {
                        if (
                          !node ||
                          node.nodeType !== 1 ||
                          typeof node.matches !== "function"
                        ) {
                          return NodeFilter.FILTER_SKIP;
                        }
                        return node.matches(selectorString)
                          ? NodeFilter.FILTER_ACCEPT
                          : NodeFilter.FILTER_SKIP;
                      },
                    },
                  );
                  let current;
                  while (!shouldStop() && (current = iterator.nextNode())) {
                    processed += 1;
                    const shouldBreak = processNode(current);
                    if (
                      chunkingEnabled &&
                      processed > 0 &&
                      processed % chunkSize === 0
                    ) {
                      await maybeScroll();
                    }
                    if (shouldBreak || shouldStop()) {
                      break;
                    }
                  }
                } else if (root) {
                  const fallbackNodes = root.querySelectorAll(selectorString);
                  for (let i = 0; i < fallbackNodes.length; i += 1) {
                    if (shouldStop()) break;
                    processed += 1;
                    const shouldBreak = processNode(fallbackNodes[i]);
                    if (
                      chunkingEnabled &&
                      processed > 0 &&
                      processed % chunkSize === 0
                    ) {
                      await maybeScroll();
                    }
                    if (shouldBreak) {
                      break;
                    }
                  }
                }

                return typeof perPageMatchLimit === "number" &&
                  perPageMatchLimit > 0
                  ? matches.slice(0, perPageMatchLimit)
                  : matches;
              },
              {
                keyword: config.keyword,
                synonyms: config.synonyms,
                nodeLimit: null,
                perPageMatchLimit,
                scanTimeoutMs: null,
                nodeTextLimit: null,
              },
            ),
          );

          if (Array.isArray(pageMatches) && pageMatches.length) {
            const bucket = keywordMatchBuckets.get(config.keyword);
            if (!bucket) continue;
            let newMatches = 0;
            for (const match of pageMatches) {
              if (matchLimit !== null && bucket.length >= matchLimit) {
                break;
              }
              bucket.push({
                ...match,
                pageUrl: current,
              });
              newMatches += 1;
            }
            if (newMatches > 0) {
              rebuildKeywordSummaries();
              const totalMatches = Array.from(
                keywordMatchBuckets.values(),
              ).reduce(
                (sum, entries) => sum + (entries ? entries.length : 0),
                0,
              );
              emitProgressSnapshot(
                `Found ${totalMatches} keyword match${totalMatches === 1 ? "" : "es"}`,
              );
              if (matchLimit !== null && areAllKeywordLimitsSatisfied()) {
                keywordLimitSatisfied = true;
                emitProgressSnapshot(
                  `Captured ${matchLimit} matches for each keyword, stopping crawl.`,
                );
                break;
              }
            }
          }
          if (keywordLimitSatisfied) {
            break;
          }
        }
      } catch (err) {
        if (err instanceof ManualAbortError) {
          throw err;
        }
        console.warn("Keyword extraction failed:", err && err.message);
      }

      await collectLinksFromPage(current, currentDepth);

      if (matchLimit !== null && areAllKeywordLimitsSatisfied()) {
        keywordLimitSatisfied = true;
        break;
      }
    }
  } catch (err) {
    if (err instanceof ManualAbortError) {
      manualAbortTriggered = true;
    } else {
      throw err;
    }
  } finally {
    try {
      await browser.close();
    } catch {}
  }

  for (const [keyword, entries] of keywordMatchBuckets.entries()) {
    if (!Array.isArray(entries) || !entries.length) continue;
    const deduped = filterDuplicateMatches(entries);
    keywordMatchBuckets.set(keyword, removeContainedMatches(deduped));
  }

  rebuildKeywordSummaries();
  const primarySummary = results.keywordSummaries[0] || {
    keywordMatches: [],
    keywordHit: null,
  };
  results.keywordMatches = primarySummary.keywordMatches;
  results.keywordHit = primarySummary.keywordHit;
  results.resultsLimited = !!keywordLimitSatisfied;

  const externalStop = isExternalAbortRequested();
  if (abortedByUser || manualAbortTriggered || externalStop) {
    results.partial = true;
    results.crawlStatus = externalStop ? "stopped" : "aborted";
    results.message =
      (abortToken && abortToken.reason) ||
      results.message ||
      (externalStop
        ? "Crawl was stopped before completion."
        : "Browser window was closed before crawl completed.");
    if (!results.contactPageUrl) {
      results.contactPageUrl = normalizedStart;
    }
  } else {
    results.partial = false;
    results.crawlStatus = "completed";
    if (keywordLimitSatisfied && matchLimit !== null) {
      results.message =
        results.message ||
        `Captured ${matchLimit} matches for each keyword and stopped early.`;
    } else {
      results.message = results.message || "";
    }
  }

  return results;
}

function summarizeKeywordMatches(matches, _matchMode, cap = null) {
  if (!Array.isArray(matches) || !matches.length) {
    return { keywordMatches: [], keywordHit: null };
  }

  const unique = removeContainedMatches(filterDuplicateMatches(matches));
  unique.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  const limit = typeof cap === "number" && cap > 0 ? Math.floor(cap) : null;

  return {
    keywordMatches: limit !== null ? unique.slice(0, limit) : unique,
    keywordHit: unique[0] || null,
  };
}

// async function getCompanyDetailsFromGoogle(websiteUrl, apiKey) {
//   // 1. Clean the URL to use as a search query
//   const domain = websiteUrl
//     .replace(/^(?:https?:\/\/)?(?:www\.)?/i, "")
//     .split("/")[0];

//   const searchUrl = "https://places.googleapis.com/v1/places:searchText";

//   try {
//     console.log(`🔎 Searching Google for domain: ${domain}...`);

//     // STEP 1: Search for the place using the domain
//     const searchResponse = await axios.post(
//       searchUrl,
//       {
//         textQuery: domain,
//       },
//       {
//         headers: {
//           "Content-Type": "application/json",
//           "X-Goog-Api-Key": apiKey,
//           // Requesting only the specific fields we need to save on costs
//           "X-Goog-FieldMask":
//             "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri",
//         },
//       },
//     );

//     const places = searchResponse.data.places;

//     if (!places || places.length === 0) {
//       return {
//         error: "No matching business found on Google Maps for this website.",
//       };
//     }

//     // STEP 2: Filter results to ensure the website matches (Google might return similar names)
//     // We look for a result where the websiteUri contains our domain
//     const bestMatch =
//       places.find(
//         (p) =>
//           p.websiteUri &&
//           p.websiteUri.toLowerCase().includes(domain.toLowerCase()),
//       ) || places[0]; // Fallback to first result if no exact website match

//     return {
//       companyName: bestMatch.displayName.text,
//       address: bestMatch.formattedAddress,
//       phone: bestMatch.nationalPhoneNumber || "Not listed",
//       website: bestMatch.websiteUri,
//       googlePlaceId: bestMatch.id,
//     };
//   } catch (error) {
//     const errorMsg = error.response
//       ? JSON.stringify(error.response.data)
//       : error.message;
//     return { error: `API Request Failed: ${errorMsg}` };
//   }
// }

// const MY_API_KEY = "AIzaSyA9uBDTquLDGjnPA4y4YcJYddT56wZYawc";

// getCompanyDetailsFromGoogle(targetUrl, MY_API_KEY).then((data) => {
//   console.log("\n--- Google Business Result ---");
//   console.log(data);
// });

app.post("/search/stop", (req, res) => {
  const jobId = (
    req.body && req.body.jobId ? String(req.body.jobId) : ""
  ).trim();
  if (!jobId) {
    return res
      .status(400)
      .json({ success: false, error: "Provide jobId in the request body." });
  }
  const entry = activeSearchJobs.get(jobId);
  if (!entry || !entry.abortToken) {
    return res.status(404).json({
      success: false,
      error: "No active crawl found for the provided jobId.",
    });
  }
  entry.abortToken.aborted = true;
  if (!entry.abortToken.reason) {
    entry.abortToken.reason = "Crawl stopped by user request.";
  }
  const snapshot = entry.lastResult || {
    website: entry.url,
    keywords: entry.keywords || [],
    partial: true,
  };
  snapshot.crawlStatus = "aborting";
  snapshot.partial = true;
  snapshot.message = entry.abortToken.reason;
  updateSearchJob(jobId, snapshot, { status: "aborting", error: null });
  return res.json({ success: true, message: "Stop signal sent.", jobId });
});

// ---------- Utilities ----------
function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function requestWithMethod(
  rawUrl,
  method = "HEAD",
  timeoutMs = 10000,
  maxRedirects = 5,
) {
  return new Promise((resolve) => {
    if (!isValidUrl(rawUrl)) return resolve({ error: "Invalid URL" });
    let redirects = [];
    const doReq = (urlToFetch, depth) => {
      const urlObj = new URL(urlToFetch);
      const lib = urlObj.protocol === "https:" ? https : http;
      const start = performance.now();
      const req = lib.request(
        urlObj,
        {
          method,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        },
        (res) => {
          const status = res.statusCode || 0;
          const headers = res.headers || {};
          const loc = headers.location;
          if (status >= 300 && status < 400 && loc && depth < maxRedirects) {
            const nextUrl = new URL(loc, urlObj).href;
            redirects.push({ status, location: nextUrl });
            res.resume();
            return doReq(nextUrl, depth + 1);
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              status,
              headers,
              finalUrl: urlObj.href,
              redirects,
              bodySnippet: method === "GET" ? body.slice(0, 2000) : undefined,
              responseTimeMs: Math.round(performance.now() - start),
            });
          });
        },
      );
      req.on("error", (err) => resolve({ error: err.message }));
      req.setTimeout(timeoutMs, () =>
        req.destroy(new Error("Request timed out")),
      );
      req.end();
    };
    doReq(rawUrl, 0);
  });
}

// ---------- URL Analyzer ----------
app.post("/analyze-url", async (req, res) => {
  const { url } = req.body || {};
  if (!isValidUrl(url)) {
    return res
      .status(400)
      .json({ success: false, valid: false, error: "Invalid URL" });
  }
  let result = await requestWithMethod(url, "HEAD");
  if (!result || result.error || result.status >= 400 || result.status === 0) {
    result = await requestWithMethod(url, "GET");
  }
  const contentType =
    (result.headers &&
      (result.headers["content-type"] || result.headers["Content-Type"])) ||
    "";
  return res.json({
    success: true,
    valid: true,
    reachable: !result.error && (result.status || 0) > 0,
    status: result.status || 0,
    finalUrl: result.finalUrl || url,
    redirects: result.redirects || [],
    responseTimeMs: result.responseTimeMs || 0,
    contentType,
    server:
      (result.headers && (result.headers.server || result.headers.Server)) ||
      "",
    bodySnippet: result.bodySnippet,
  });
});

// ---------- Content Detector ----------
app.post("/detect-content", async (req, res) => {
  const { url } = req.body || {};
  if (!isValidUrl(url))
    return res.status(400).json({ success: false, error: "Invalid URL" });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {}
    try {
      await page.evaluate(async () => {
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let y = 0; y < (document.body?.scrollHeight || 0); y += 600) {
          window.scrollTo(0, y);
          await delay(150);
        }
        window.scrollTo(0, document.body?.scrollHeight || 0);
      });
    } catch {}
    // Try to accept cookie banners to avoid overlays
    try {
      const cookieSelectors = [
        "#onetrust-accept-btn-handler",
        'button:has-text("Accept")',
        'button:has-text("I Agree")',
        ".cookie-accept",
        '[aria-label*="accept" i]',
      ];
      for (const s of cookieSelectors) {
        const el = await page.$(s);
        if (el) {
          await el.click({ timeout: 1000 }).catch(() => {});
          break;
        }
      }
    } catch {}
    const data = await page.evaluate(() => {
      const sel = [
        "main",
        "article",
        ".content",
        ".main-content",
        ".entry-content",
        "#content",
        ".post-content",
        '[role="main"]',
        "body",
      ];
      const pick = () => {
        for (const s of sel) {
          const el = document.querySelector(s);
          if (el && (el.textContent || "").trim().length > 50) return el;
        }
        return document.body;
      };
      const main = pick();
      const t = (e) => (e ? e.textContent || "" : "").trim();
      const txt = t(main);
      const wordCount = txt.split(/\s+/).filter(Boolean).length;
      const allLinks = Array.from(main.querySelectorAll("a[href]"));
      const docLinks = Array.from(document.querySelectorAll("a[href]"));
      const isFilterZone = (el) => {
        const badSelectors = [
          "form",
          "nav",
          "header",
          "footer",
          "aside",
          '[role="search"]',
          '[role="navigation"]',
          ".breadcrumb",
          ".pagination",
          ".pager",
        ];
        let node = el;
        let depth = 0;
        while (node && depth < 6) {
          if (badSelectors.some((sel) => node.matches && node.matches(sel)))
            return true;
          node = node.parentElement;
          depth++;
        }
        return false;
      };
      const isFilterHref = (href) => {
        try {
          const u = new URL(href, location.href);
          const qp = u.searchParams;
          const keys = Array.from(qp.keys()).join(",").toLowerCase();
          if (
            keys.includes("filter") ||
            keys.includes("facet") ||
            keys.includes("refine") ||
            keys.includes("search") ||
            keys.includes("q=")
          )
            return true;
          return false;
        } catch {
          return false;
        }
      };
      const linkEls = allLinks.filter((a) => {
        const href = a.getAttribute("href") || "";
        if (
          !href ||
          href.startsWith("#") ||
          href.startsWith("javascript:") ||
          href.startsWith("mailto:") ||
          href.startsWith("tel:")
        )
          return false;
        if (isFilterZone(a)) return false;
        if (isFilterHref(a.href)) return false;
        const text = t(a);
        const aria =
          a.getAttribute("aria-label") ||
          a.getAttribute("aria-labelledby") ||
          "";
        if (!text && !a.getAttribute("title") && !aria) return false;
        return true;
      });
      const images = Array.from(main.querySelectorAll("img"));
      const tables = Array.from(main.querySelectorAll("table"));
      const videos = Array.from(
        main.querySelectorAll(
          'video, iframe[src*="youtube"], iframe[src*="vimeo"]',
        ),
      );
      const forms = Array.from(main.querySelectorAll("form"));
      const headings = Array.from(
        main.querySelectorAll("h1,h2,h3,h4,h5,h6"),
      ).map((h) => ({ level: h.tagName.toLowerCase(), text: t(h) }));
      const hasLogin = !!document.querySelector(
        'input[type="password"], [name*="password" i]',
      );
      const frameworkSignals = {
        hasAngular: !!window.ng || !!document.querySelector("[ng-version]"),
        hasReact:
          !!window.React ||
          !!document.querySelector("[data-reactroot], [data-reactid]"),
        hasVue:
          !!window.Vue || !!document.querySelector('[id^="__nuxt"], [data-v-]'),
      };
      let contentType = "generic";
      if (tables.length > 0 && wordCount < 800) contentType = "tabular";
      if (videos.length > 0) contentType = "media";
      if (forms.length > 2 || hasLogin) contentType = "app/form";
      if (headings.length > 4 && wordCount > 500) contentType = "article/docs";
      if (linkEls.length > 100 && wordCount < 400)
        contentType = "directory/listing";

      const hasHyperlinks = docLinks.length > 0;
      const hasDirectContent = wordCount > 50;
      const hasKeyValue = (() => {
        const hasDL = !!document.querySelector("dl dt, dl dd");
        const kvTable = Array.from(document.querySelectorAll("table")).some(
          (tb) => {
            const rows = Array.from(tb.querySelectorAll("tr"));
            let score = 0;
            for (const tr of rows) {
              const ths = tr.querySelectorAll("th");
              const tds = tr.querySelectorAll("td");
              if ((ths.length === 1 && tds.length === 1) || tds.length === 2)
                score++;
            }
            return score >= Math.max(1, Math.floor(rows.length * 0.5));
          },
        );
        const colonPairs = (txt.match(/\b\w[\w\s]{1,40}:\s+\S+/g) || []).length;
        return hasDL || kvTable || colonPairs > 5;
      })();

      // gather up to 50 unique hrefs (fallback to document-wide anchors if needed)
      const baseForList = linkEls.length
        ? linkEls
        : allLinks.length
          ? allLinks
          : docLinks;
      const hrefs = Array.from(new Set(baseForList.map((a) => a.href))).slice(
        0,
        50,
      );

      return {
        title: t(document.querySelector("title")),
        pageHeading: t(document.querySelector("h1")),
        wordCount,
        linkCount: baseForList.length,
        imageCount: images.length,
        tableCount: tables.length,
        videoCount: videos.length,
        formCount: forms.length,
        headings,
        frameworkSignals,
        contentType,
        url: location.href,
        types: {
          hyperlinks: hasHyperlinks,
          directContent: hasDirectContent,
          keyValue: hasKeyValue,
        },
        linksList: hrefs,
      };
    });
    await browser.close();
    res.json({ success: true, data });
  } catch (e) {
    await browser.close();
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------- Scraping Jobs API ----------
const { runJob } = require("./electron/scraper/engine");

const Runs = new Map(); // runId -> { status, startedAt, finishedAt, rows, error }

app.post("/jobs/run", async (req, res) => {
  try {
    const job = req.body || {};
    const runId = Math.random().toString(36).slice(2);
    Runs.set(runId, { status: "queued", startedAt: Date.now(), rows: [] });
    (async () => {
      Runs.set(
        runId,
        Object.assign({}, Runs.get(runId), { status: "running" }),
      );
      try {
        const { rows } = await runJob(job);
        Runs.set(runId, {
          status: "done",
          startedAt: Runs.get(runId).startedAt,
          finishedAt: Date.now(),
          rows,
        });
        const outDir = path.join(__dirname, "runs", runId);
        try {
          fs.mkdirSync(outDir, { recursive: true });
        } catch {}
        const cols = Array.from(
          new Set(rows.flatMap((r) => Object.keys(r || {}))),
        );
        const esc = (s) => '"' + String(s ?? "").replace(/"/g, '""') + '"';
        const csv = [cols.join(",")]
          .concat(rows.map((r) => cols.map((c) => esc(r[c])).join(",")))
          .join("\n");
        try {
          fs.writeFileSync(path.join(outDir, "result.csv"), csv, "utf8");
        } catch {}
        try {
          fs.writeFileSync(
            path.join(outDir, "result.json"),
            JSON.stringify(rows, null, 2),
            "utf8",
          );
        } catch {}
      } catch (e) {
        Runs.set(runId, {
          status: "failed",
          startedAt: Runs.get(runId).startedAt,
          finishedAt: Date.now(),
          rows: [],
          error: String((e && e.message) || e),
        });
      }
    })();
    return res.json({ success: true, runId });
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, error: String((e && e.message) || e) });
  }
});

app.get("/jobs/:id/status", (req, res) => {
  const run = Runs.get(req.params.id);
  if (!run)
    return res.status(404).json({ success: false, error: "Run not found" });
  res.json({
    success: true,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || null,
    rows: (run.rows || []).length,
    error: run.error || null,
  });
});

app.get("/jobs/:id/result", (req, res) => {
  const run = Runs.get(req.params.id);
  if (!run)
    return res.status(404).json({ success: false, error: "Run not found" });
  res.json({ success: true, rows: run.rows || [] });
});

// ---------- Scraping Strategy Selector ----------
app.post("/select-strategy", async (req, res) => {
  const { url } = req.body || {};
  if (!isValidUrl(url))
    return res.status(400).json({ success: false, error: "Invalid URL" });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const status = response ? response.status() : 0;
    const signals = await page.evaluate(() => {
      const textLen = (document.body.innerText || "").trim().length;
      const scriptCount = document.querySelectorAll("script").length;
      const hasCF =
        /cloudflare|attention required|captcha/i.test(
          document.body.innerText || "",
        ) || !!document.querySelector("#cf-please-wait");
      const hasBlock = /access denied|forbidden|not authorized|blocked/i.test(
        document.body.innerText || "",
      );
      const spa =
        !!window.ng ||
        !!window.React ||
        !!window.Vue ||
        !!document.querySelector(
          '[ng-version], [data-reactroot], [id^="__nuxt"], [data-v-]',
        );
      const jsHeavy = scriptCount > 20 && textLen < 1000;
      return { textLen, scriptCount, hasCF, hasBlock, spa, jsHeavy };
    });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {}
    const textAfter = await page.evaluate(
      () => (document.body.innerText || "").trim().length,
    );
    let strategy = "Static HTML";
    if (
      status === 403 ||
      status === 401 ||
      status === 429 ||
      signals.hasCF ||
      signals.hasBlock
    )
      strategy = "Blocked/WAF";
    else if (
      signals.spa ||
      signals.jsHeavy ||
      textAfter > signals.textLen * 1.5
    )
      strategy = "JS/SPA/Dynamic";
    await browser.close();
    res.json({
      success: true,
      data: { status, strategy, signals: { ...signals, textAfter } },
    });
  } catch (e) {
    await browser.close();
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------- Data Extractor ----------
app.post("/extract", async (req, res) => {
  const { url, maxPages = 2 } = req.body || {};
  if (!isValidUrl(url))
    return res.status(400).json({ success: false, error: "Invalid URL" });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
    viewport: { width: 1366, height: 768 },
  });
  await context.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    DNT: "1",
    "Upgrade-Insecure-Requests": "1",
  });
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    } catch {}
    try {
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
    } catch {}
    try {
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
    } catch {}
  });
  const page = await context.newPage();
  try {
    const origin = new URL(url).origin;
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
      referer: origin,
    });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {}
    try {
      const cookieSelectors = [
        "#onetrust-accept-btn-handler",
        'button:has-text("Accept")',
        'button:has-text("I Agree")',
        ".cookie-accept",
        '[aria-label*="accept" i]',
      ];
      for (const s of cookieSelectors) {
        const el = await page.$(s);
        if (el) {
          await el.click({ timeout: 1000 }).catch(() => {});
          break;
        }
      }
    } catch {}
    try {
      await page.evaluate(async () => {
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let y = 0; y < (document.body?.scrollHeight || 0); y += 600) {
          window.scrollTo(0, y);
          await delay(150);
        }
        window.scrollTo(0, document.body?.scrollHeight || 0);
      });
    } catch {}

    const getEligibleCount = async () => {
      return await page.evaluate(() => {
        const t = (e) => (e ? (e.textContent || "").trim() : "");
        const allLinks = Array.from(document.querySelectorAll("a[href]"));
        const badSelectors = [
          "form",
          "nav",
          "header",
          "footer",
          "aside",
          '[role="search"]',
          '[role="navigation"]',
          ".breadcrumb",
          ".pagination",
          ".pager",
          ".filters",
          ".filter",
          ".facets",
          ".facet",
          ".refine",
          ".search",
          ".toolbar",
          ".sidebar",
        ];
        const isFilterZone = (el) => {
          let node = el;
          while (node) {
            if (badSelectors.some((sel) => node.matches && node.matches(sel)))
              return true;
            node = node.parentElement;
          }
          return false;
        };
        const isFilterHref = (href) => {
          try {
            const u = new URL(href, location.href);
            const keys = Array.from(u.searchParams.keys())
              .join(",")
              .toLowerCase();
            return (
              keys.includes("filter") ||
              keys.includes("facet") ||
              keys.includes("refine") ||
              keys.includes("search") ||
              keys.includes("q=")
            );
          } catch {
            return false;
          }
        };
        const eligible = allLinks.filter((a) => {
          const href = a.getAttribute("href") || "";
          if (
            !href ||
            href.startsWith("#") ||
            href.startsWith("javascript:") ||
            href.startsWith("mailto:") ||
            href.startsWith("tel:")
          )
            return false;
          if (isFilterZone(a)) return false;
          if (isFilterHref(a.href)) return false;
          const text = t(a);
          const aria =
            a.getAttribute("aria-label") ||
            a.getAttribute("aria-labelledby") ||
            "";
          if (!text && !a.getAttribute("title") && !aria) return false;
          return true;
        });
        return eligible.length;
      });
    };

    // Try to advance pagination/load-more up to maxPages
    const maxAdvances = Math.max(1, Math.min(Number(maxPages) || 2, 5));
    let pagesVisited = 1;
    while (pagesVisited < maxAdvances) {
      const before = await getEligibleCount();
      let advanced = false;
      // Try clicking a load more / next button
      const selectors = [
        'button:has-text("Load more")',
        'a:has-text("Load more")',
        'button:has-text("More")',
        'a:has-text("More")',
        'button[aria-label*="more" i]',
        'a[aria-label*="more" i]',
        'a[rel="next"]',
        'a[aria-label*="next" i]',
        'button:has-text("Next")',
        'a:has-text("Next")',
      ];
      for (const s of selectors) {
        try {
          const el = await page.$(s);
          if (el) {
            await el.click({ timeout: 2000 });
            advanced = true;
            break;
          }
        } catch {}
      }
      // If no button, try explicit next href
      if (!advanced) {
        try {
          const nextHref = await page.evaluate(() => {
            const a = document.querySelector(
              'a[rel="next"], a[aria-label*="next" i]',
            );
            return a ? a.getAttribute("href") : "";
          });
          if (nextHref) {
            await page.goto(nextHref, {
              waitUntil: "domcontentloaded",
              timeout: 30000,
            });
            advanced = true;
          }
        } catch {}
      }
      // If still not advanced, try extra scroll
      if (!advanced) {
        try {
          await page.evaluate(async () => {
            const delay = (ms) => new Promise((r) => setTimeout(r, ms));
            for (let y = 0; y < (document.body?.scrollHeight || 0); y += 800) {
              window.scrollTo(0, y);
              await delay(150);
            }
            window.scrollTo(0, document.body?.scrollHeight || 0);
          });
          advanced = true;
        } catch {}
      }
      if (!advanced) break;
      try {
        await page.waitForLoadState("networkidle", { timeout: 8000 });
      } catch {}
      // Wait up to ~8s for an actual increase in eligible links
      let increased = false;
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(1000);
        const after = await getEligibleCount();
        if (after > before) {
          increased = true;
          break;
        }
      }
      if (!increased) break;
      pagesVisited++;
    }
    const data = await page.evaluate(() => {
      const sel = [
        "main",
        "article",
        ".content",
        ".main-content",
        ".entry-content",
        "#content",
        ".post-content",
        '[role="main"]',
        "body",
      ];
      const pick = () => {
        for (const s of sel) {
          const el = document.querySelector(s);
          if (el && (el.textContent || "").trim().length > 50) return el;
        }
        return document.body;
      };
      const main = pick();
      const t = (e) => (e ? e.textContent || "" : "").trim();
      const headings = Array.from(
        main.querySelectorAll("h1,h2,h3,h4,h5,h6"),
      ).map((h) => ({ level: h.tagName.toLowerCase(), text: t(h) }));
      const allLinks = Array.from(main.querySelectorAll("a[href]"));
      const isFilterZone = (el) => {
        const badSelectors = [
          "form",
          "nav",
          "header",
          "footer",
          "aside",
          '[role="search"]',
          '[role="navigation"]',
          ".breadcrumb",
          ".pagination",
          ".pager",
          ".filters",
          ".filter",
          ".facets",
          ".facet",
          ".refine",
          ".search",
          ".toolbar",
          ".sidebar",
        ];
        let node = el;
        while (node) {
          if (badSelectors.some((sel) => node.matches && node.matches(sel)))
            return true;
          node = node.parentElement;
        }
        return false;
      };
      const isFilterHref = (href) => {
        try {
          const u = new URL(href, location.href);
          const qp = u.searchParams;
          const keys = Array.from(qp.keys()).join(",").toLowerCase();
          if (
            keys.includes("filter") ||
            keys.includes("facet") ||
            keys.includes("refine") ||
            keys.includes("search") ||
            keys.includes("q=")
          )
            return true;
          return false;
        } catch {
          return false;
        }
      };
      let links = allLinks
        .filter((a) => {
          const href = a.getAttribute("href") || "";
          if (
            !href ||
            href.startsWith("#") ||
            href.startsWith("javascript:") ||
            href.startsWith("mailto:") ||
            href.startsWith("tel:")
          )
            return false;
          if (isFilterZone(a)) return false;
          if (isFilterHref(a.href)) return false;
          const text = t(a);
          const aria =
            a.getAttribute("aria-label") ||
            a.getAttribute("aria-labelledby") ||
            "";
          const img = a.querySelector ? a.querySelector("img") : null;
          const alt = img ? img.alt || "" : "";
          if (!text && !a.getAttribute("title") && !aria && !alt) return false;
          return true;
        })
        .map((a) => ({
          href: a.href,
          text: t(a),
          titleAttr: a.getAttribute("title") || "",
        }));
      if (!links.length) {
        links = allLinks
          .filter((a) => {
            const href = a.getAttribute("href") || "";
            if (
              !href ||
              href.startsWith("#") ||
              href.startsWith("javascript:") ||
              href.startsWith("mailto:") ||
              href.startsWith("tel:")
            )
              return false;
            return true;
          })
          .slice(0, 50)
          .map((a) => ({
            href: a.href,
            text: t(a),
            titleAttr: a.getAttribute("title") || "",
          }));
      }
      const images = Array.from(main.querySelectorAll("img")).map((i) => ({
        src: i.src,
        alt: i.alt || "",
      }));
      const tables = Array.from(main.querySelectorAll("table")).map(
        (tb) => tb.outerHTML,
      );
      const lists = Array.from(main.querySelectorAll("ul,ol")).map((list) => ({
        type: list.tagName.toLowerCase(),
        items: Array.from(list.querySelectorAll("li")).map((li) => t(li)),
      }));
      const totalLinks = links.length;
      const linksWithText = links.filter((l) => l.text.length > 0).length;
      const linksWithTitleAttr = links.filter(
        (l) => l.titleAttr && l.titleAttr.length > 0,
      ).length;
      const maxTextLen = links.reduce((m, l) => Math.max(m, l.text.length), 1);
      const linksScored = links.map((l) => ({
        ...l,
        textCoveragePct: Math.round(
          (l.text.length / Math.max(maxTextLen, 1)) * 100,
        ),
      }));
      return {
        url: location.href,
        title: t(document.querySelector("title")),
        pageHeading: t(document.querySelector("h1")),
        headings,
        links: linksScored,
        images,
        tables,
        lists,
        stats: {
          totalLinks,
          linksWithText,
          linksWithTitleAttr,
          percentWithText: totalLinks
            ? Math.round((linksWithText / totalLinks) * 100)
            : 0,
          percentWithTitleAttr: totalLinks
            ? Math.round((linksWithTitleAttr / totalLinks) * 100)
            : 0,
        },
      };
    });
    await browser.close();
    res.json({ success: true, data });
  } catch (e) {
    await browser.close();
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------- Extract a single hyperlink content ----------
app.post("/extract-one", async (req, res) => {
  const { url } = req.body || {};
  if (!isValidUrl(url))
    return res.status(400).json({ success: false, error: "Invalid URL" });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {}
    const status = resp ? resp.status() : 0;
    const contentType =
      resp && typeof resp.headers === "function"
        ? resp.headers()["content-type"] || ""
        : "";
    let content = null;
    if (
      /text\/html|application\/xhtml\+xml/i.test(contentType) ||
      !contentType
    ) {
      content = await page.evaluate(() => {
        const sels = [
          "main",
          "article",
          ".content",
          ".main-content",
          ".entry-content",
          "#content",
          ".post-content",
          '[role="main"]',
          "body",
        ];
        let main = null;
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el && (el.textContent || "").trim().length > 50) {
            main = el;
            break;
          }
        }
        if (!main) main = document.body;
        const t = (e) => (e ? e.textContent || "" : "").trim();
        const title = t(document.querySelector("title"));
        const pageHeading = t(document.querySelector("h1"));
        const textContent = t(main);
        const headings = Array.from(
          main.querySelectorAll("h1,h2,h3,h4,h5,h6"),
        ).map((h) => ({ level: h.tagName.toLowerCase(), text: t(h) }));
        const images = Array.from(main.querySelectorAll("img")).map((i) => ({
          src: i.src,
          alt: i.alt || "",
        }));
        const tables = Array.from(main.querySelectorAll("table")).map(
          (tb) => tb.outerHTML,
        );
        return {
          title,
          pageHeading,
          textContent,
          headings,
          images,
          tables,
          html: main.innerHTML,
        };
      });
    }
    await browser.close();
    res.json({ success: true, data: { url, status, contentType, content } });
  } catch (e) {
    await browser.close();
    res.status(500).json({ success: false, error: e.message });
  }
});
// ---------- Extract key-value style content (tables, definition lists, label:value) ----------
app.post("/extract-keyvalue", async (req, res) => {
  const { url } = req.body || {};
  if (!isValidUrl(url))
    return res.status(400).json({ success: false, error: "Invalid URL" });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    const result = await page.evaluate(() => {
      const t = (e) => (e ? (e.textContent || "").trim() : "");
      const sel = [
        "main",
        "article",
        ".content",
        ".main-content",
        ".entry-content",
        "#content",
        ".post-content",
        '[role="main"]',
        "body",
      ];
      const pick = () => {
        for (const s of sel) {
          const el = document.querySelector(s);
          if (el && (el.textContent || "").trim().length > 50) return el;
        }
        return document.body;
      };
      const main = pick();

      const tables = Array.from(main.querySelectorAll("table"));
      const tableKeyValues = tables
        .map((tb) => {
          const rows = Array.from(tb.querySelectorAll("tr"));
          const list = [];
          for (const tr of rows) {
            const ths = Array.from(tr.querySelectorAll("th")).map(t);
            const tds = Array.from(tr.querySelectorAll("td")).map(t);
            if (ths.length === 1 && tds.length === 1)
              list.push({ key: ths[0], value: tds[0] });
            else if (tds.length === 2)
              list.push({ key: tds[0], value: tds[1] });
          }
          return list.filter((kv) => kv.key || kv.value);
        })
        .filter((arr) => arr.length);

      const dlKeyValues = Array.from(main.querySelectorAll("dl"))
        .map((dl) => {
          const items = [];
          let currentKey = "";
          Array.from(dl.children).forEach((node) => {
            if (node.tagName && node.tagName.toLowerCase() === "dt")
              currentKey = t(node);
            else if (node.tagName && node.tagName.toLowerCase() === "dd")
              items.push({ key: currentKey, value: t(node) });
          });
          return items.filter((kv) => kv.key || kv.value);
        })
        .filter((arr) => arr.length);

      const textKeyValue = [];
      const candidates = Array.from(main.querySelectorAll("p, li, div"));
      for (const el of candidates) {
        const lines = (el.textContent || "")
          .split(/\n|\r/)
          .map((s) => s.trim())
          .filter(Boolean);
        for (const line of lines) {
          const idx = line.indexOf(":");
          if (idx > 0 && idx < 80) {
            const key = line.slice(0, idx).trim();
            const value = line.slice(idx + 1).trim();
            if (key && value) textKeyValues.push({ key, value });
          }
        }
      }

      return {
        title: t(document.querySelector("title")),
        pageHeading: t(document.querySelector("h1")),
        tableKeyValues,
        dlKeyValues,
        textKeyValues,
      };
    });
    await browser.close();
    res.json({ success: true, data: result });
  } catch (e) {
    await browser.close();
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------- Scrape using a chosen strategy ----------
app.post("/scrape-with-strategy", async (req, res) => {
  const { url, strategy } = req.body || {};
  if (!isValidUrl(url))
    return res.status(400).json({ success: false, error: "Invalid URL" });
  const s = String(strategy || "").toLowerCase();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    if (s.includes("blocked")) {
      const head = await requestWithMethod(url, "HEAD");
      const get =
        !head || (head.status || 0) >= 400
          ? await requestWithMethod(url, "GET")
          : null;
      await browser.close();
      return res.json({
        success: true,
        data: {
          strategy: "Blocked/WAF",
          note: "Access appears restricted. Consider authentication, proxy, or manual headers.",
          head,
          get,
        },
      });
    }

    if (s.includes("js") || s.includes("dynamic") || s.includes("spa")) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      try {
        await page.waitForLoadState("networkidle", { timeout: 20000 });
      } catch {}
      try {
        await page.evaluate(async () => {
          const delay = (ms) => new Promise((r) => setTimeout(r, ms));
          for (let y = 0; y < document.body.scrollHeight; y += 600) {
            window.scrollTo(0, y);
            await delay(200);
          }
          window.scrollTo(0, document.body.scrollHeight);
        });
      } catch {}
    } else {
      await page.goto(url, { waitUntil: "load", timeout: 60000 });
    }

    const content = await page.evaluate(() => {
      const sels = [
        "main",
        "article",
        ".content",
        ".main-content",
        ".entry-content",
        "#content",
        ".post-content",
        '[role="main"]',
        "body",
      ];
      let main = null;
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && (el.textContent || "").trim().length > 50) {
          main = el;
          break;
        }
      }
      if (!main) main = document.body;
      const t = (e) => (e ? e.textContent || "" : "").trim();
      const title = t(document.querySelector("title"));
      const pageHeading = t(document.querySelector("h1"));
      const textContent = t(main);
      const headings = Array.from(
        main.querySelectorAll("h1,h2,h3,h4,h5,h6"),
      ).map((h) => ({ level: h.tagName.toLowerCase(), text: t(h) }));
      const links = Array.from(main.querySelectorAll("a[href]")).map((a) => ({
        href: a.href,
        text: t(a),
        titleAttr: a.getAttribute("title") || "",
      }));
      const images = Array.from(main.querySelectorAll("img")).map((i) => ({
        src: i.src,
        alt: i.alt || "",
      }));
      const tables = Array.from(main.querySelectorAll("table")).map(
        (tb) => tb.outerHTML,
      );
      return {
        title,
        pageHeading,
        textContent,
        headings,
        links,
        images,
        tables,
        html: main.innerHTML,
      };
    });
    await browser.close();
    res.json({ success: true, data: { strategy: s, content } });
  } catch (e) {
    await browser.close();
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------- Extract content from a list of links ----------
app.post("/extract-links", async (req, res) => {
  const {
    links = [],
    limit = 20,
    waitTime = 500,
    concurrency = 3,
  } = req.body || {};
  if (!Array.isArray(links) || links.length === 0) {
    return res.status(400).json({ success: false, error: "links[] required" });
  }
  const list = links
    .filter((u) => {
      try {
        new URL(u);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, Math.max(1, Math.min(limit, 100)));

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const results = new Array(list.length);
  const maxWorkers = Math.max(
    1,
    Math.min(Number(concurrency) || 1, 10, list.length),
  );

  const worker = async (workerId) => {
    const page = await context.newPage();
    try {
      while (true) {
        const idx = nextIndex++;
        if (idx >= list.length) break;
        const href = list[idx];
        try {
          const resp = await page.goto(href, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });
          try {
            await page.waitForLoadState("networkidle", { timeout: 5000 });
          } catch {}
          const status = resp ? resp.status() : 0;
          const content = await page.evaluate(() => {
            const sels = [
              "main",
              "article",
              ".content",
              ".main-content",
              ".entry-content",
              "#content",
              ".post-content",
              '[role="main"]',
              "body",
            ];
            let main = null;
            for (const s of sels) {
              const el = document.querySelector(s);
              if (el && (el.textContent || "").trim().length > 50) {
                main = el;
                break;
              }
            }
            if (!main) main = document.body;
            const t = (e) => (e ? e.textContent || "" : "").trim();
            const title = t(document.querySelector("title"));
            const pageHeading = t(document.querySelector("h1"));
            const textContent = t(main);
            const headings = Array.from(
              main.querySelectorAll("h1,h2,h3,h4,h5,h6"),
            ).map((h) => ({ level: h.tagName.toLowerCase(), text: t(h) }));
            const images = Array.from(main.querySelectorAll("img")).map(
              (i) => ({ src: i.src, alt: i.alt || "" }),
            );
            const tables = Array.from(main.querySelectorAll("table")).map(
              (tb) => tb.outerHTML,
            );
            return {
              title,
              pageHeading,
              textContent,
              headings,
              images,
              tables,
              html: main.innerHTML,
            };
          });
          results[idx] = { url: href, status, content };
          if (waitTime) await page.waitForTimeout(waitTime);
        } catch (err) {
          results[idx] = { url: href, error: err.message };
        }
      }
    } finally {
      await page.close().catch(() => {});
    }
  };

  let nextIndex = 0;
  try {
    const workers = [];
    for (let i = 0; i < maxWorkers; i++) workers.push(worker(i));
    await Promise.all(workers);
    await browser.close();
    res.json({
      success: true,
      count: results.length,
      concurrency: maxWorkers,
      data: results,
    });
  } catch (e) {
    await browser.close();
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/scrape", async (req, res) => {
  const { url: bodyUrl, projectUrl } = req.body || {};
  // const url = bodyUrl || projectUrl || "https://esbiomech.org/esb-awards/";

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Navigate to the main awards page
    await page.goto(url, { waitUntil: "networkidle" });

    // Extract all award links from the page
    const awardLinks = await page.evaluate(() => {
      // This targets links within the main content area
      // You may need to adjust the selector based on the site structure
      const links = Array.from(document.querySelectorAll(".entry-content a"));
      return links
        .filter(
          (link) =>
            link.href &&
            !link.href.startsWith("#") &&
            !link.href.includes("mailto:"),
        )
        .map((link) => ({
          url: link.href,
          text: link.textContent.trim(),
        }));
    });

    console.log(`Found ${awardLinks.length} links to process`);

    // Process each link to extract content
    const results = [];
    for (const link of awardLinks) {
      try {
        console.log(`Processing: ${link.text} - ${link.url}`);

        // Navigate to the award page
        await page.goto(link.url, { waitUntil: "networkidle" });

        // Extract content from the award page
        const pageContent = await page.evaluate(() => {
          const content = document.querySelector(".entry-content");
          if (!content) return null;

          // Extract text content
          const textContent = content.textContent.trim();

          // Extract images
          const images = Array.from(content.querySelectorAll("img")).map(
            (img) => ({
              src: img.src,
              alt: img.alt,
            }),
          );

          // Extract any tables
          const tables = Array.from(content.querySelectorAll("table")).map(
            (table) => table.outerHTML,
          );

          return {
            title: document.querySelector("h1")?.textContent.trim() || "",
            content: textContent,
            images,
            tables,
            html: content.innerHTML,
          };
        });

        if (pageContent) {
          results.push({
            link,
            content: pageContent,
          });
        }

        // Wait a bit between requests to avoid overloading the server
        await page.waitForTimeout(1000);
      } catch (error) {
        console.error(`Error processing ${link.url}:`, error.message);
        results.push({
          link,
          error: error.message,
        });
      }
    }

    await browser.close();

    res.json({
      success: true,
      totalLinks: awardLinks.length,
      processedLinks: results.length,
      data: results,
    });
  } catch (error) {
    console.error("Scraping error:", error);
    await browser.close();
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ---------- Detect Filters on a page ----------
app.post("/detect-filters", async (req, res) => {
  const { url } = req.body || {};
  if (!isValidUrl(url))
    return res.status(400).json({ success: false, error: "Invalid URL" });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {}
    // Try to accept cookie banners to avoid overlays blocking filters
    try {
      const cookieSelectors = [
        "#onetrust-accept-btn-handler",
        'button:has-text("Accept")',
        'button:has-text("I Agree")',
        ".cookie-accept",
        '[aria-label*="accept" i]',
      ];
      for (const s of cookieSelectors) {
        const el = await page.$(s);
        if (el) {
          await el.click({ timeout: 1000 }).catch(() => {});
          break;
        }
      }
    } catch {}

    // Try to reveal filters panels/accordions commonly used on sites
    try {
      const revealSelectors = [
        'a[href="#show-filters"]',
        "#show-filters",
        'button:has-text("Show Filters")',
        'a:has-text("Show Filters")',
        'button:has-text("Filters")',
        'a:has-text("Filters")',
        ".filters-toggle",
        ".filter-toggle",
        '[data-toggle="collapse"][href*="filter" i]',
        '[data-bs-toggle="collapse"][href*="filter" i]',
      ];
      for (const s of revealSelectors) {
        const el = await page.$(s);
        if (el) {
          await el.click({ timeout: 2000 }).catch(() => {});
        }
      }
      // Expand collapsed sections that control filters
      await page.evaluate(() => {
        const maybeClick = (el) => {
          try {
            el instanceof HTMLElement && el.click();
          } catch {}
        };
        document
          .querySelectorAll('[aria-expanded="false"][aria-controls]')
          .forEach((btn) => {
            const ctrl =
              btn && btn.getAttribute
                ? btn.getAttribute("aria-controls") || ""
                : "";
            if (/filter|facet|refine|option|panel/i.test(ctrl || ""))
              maybeClick(btn);
          });
        // Also expand common accordion controls
        document
          .querySelectorAll(
            '[data-bs-toggle="collapse"],[data-toggle="collapse"]',
          )
          .forEach((btn) => maybeClick(btn));
      });
      await page.waitForTimeout(600);
    } catch {}

    const data = await page.evaluate(() => {
      const t = (e) => (e ? (e.textContent || "").trim() : "");
      const getLabel = (el) => {
        const id = el.getAttribute("id") || "";
        if (id) {
          const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lab) return t(lab);
        }
        let n = el;
        while (n && n !== document.body) {
          if (n.tagName && n.tagName.toLowerCase() === "label") return t(n);
          n = n.parentElement;
        }
        return (
          el.getAttribute("aria-label") || el.getAttribute("placeholder") || ""
        );
      };
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          parseFloat(style.opacity || "1") === 0
        )
          return false;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return false;
        return true;
      };
      const isControlVisible = (el) => {
        if (isVisible(el)) return true;
        const id = el && el.getAttribute ? el.getAttribute("id") : "";
        const byFor = id
          ? document.querySelector(`label[for="${CSS.escape(id)}"]`)
          : null;
        if (byFor && isVisible(byFor)) return true;
        const wrap = el.closest ? el.closest("label") : null;
        if (wrap && isVisible(wrap)) return true;
        return false;
      };

      const collectFields = (rootEl) => {
        const byName = new Map();
        const add = (name, field) => {
          if (!name) return;
          if (field.kind === "checkbox" || field.kind === "radio") {
            const existing = byName.get(name) || {
              kind: field.kind,
              name,
              label: field.label,
              options: [],
            };
            const opts = existing.options || [];
            opts.push({
              value: field.optionValue || field.value || "on",
              label: field.optionLabel || field.label || field.value || "",
            });
            existing.options = opts;
            existing.label = existing.label || field.label;
            byName.set(name, existing);
          } else if (field.kind === "select") {
            byName.set(name, {
              kind: "select",
              name,
              label: field.label,
              options: field.options || [],
            });
          } else if (field.kind === "textarea") {
            byName.set(name, {
              kind: "textarea",
              name,
              label: field.label,
              value: field.value || "",
            });
          } else {
            byName.set(name, {
              kind: field.kind || "text",
              name,
              label: field.label,
              value: field.value || "",
            });
          }
        };
        const els = Array.from(
          rootEl.querySelectorAll("input[name], select[name], textarea[name]"),
        );
        for (const el of els) {
          const tag = el.tagName.toLowerCase();
          let name = (
            el.getAttribute("name") ||
            el.getAttribute("id") ||
            ""
          ).trim();
          const type =
            tag === "input"
              ? ((el.getAttribute("type") || "text") + "").toLowerCase()
              : tag;
          if (!name) continue;
          if (type === "password" || type === "hidden") continue;
          if (el.hasAttribute && el.hasAttribute("disabled")) continue;
          const labelText = getLabel(el);
          if (type === "checkbox" || type === "radio") {
            if (!isControlVisible(el)) continue;
            const optLabel =
              labelText ||
              (el.getAttribute && (el.getAttribute("title") || "")) ||
              el.value ||
              "";
            if (!(optLabel || "").trim().length) continue;
            add(name, {
              kind: type,
              name,
              label: labelText,
              value: el && el.value ? el.value : "on",
              optionValue: el && el.value ? el.value : "on",
              optionLabel: optLabel,
            });
          } else if (type === "select") {
            if (!isVisible(el)) continue;
            const options = Array.from(el && el.options ? el.options : [])
              .map((o) => ({
                value: o.value,
                label: o.text,
                selected: o.selected,
              }))
              .filter(
                (o) =>
                  (o.label || "").trim().length > 0 ||
                  (o.value || "").trim().length > 0,
              );
            if (options.length < 1) continue;
            add(name, { kind: "select", name, label: labelText, options });
          } else if (type === "textarea") {
            if (!isVisible(el)) continue;
            add(name, {
              kind: "textarea",
              name,
              label: labelText,
              value: el && el.value ? el.value : "",
            });
          } else {
            if (!isVisible(el)) continue;
            const placeholder =
              (el.getAttribute && el.getAttribute("placeholder")) || "";
            if (!labelText && !placeholder) continue;
            add(name, {
              kind: type,
              name,
              label: labelText,
              value: el && el.value ? el.value : "",
            });
          }
        }
        return byName;
      };

      // Collect common filter-like forms
      const forms = Array.from(document.querySelectorAll("form")).map((f) => {
        const method = (f.getAttribute("method") || "GET").toUpperCase();
        const action = f.getAttribute("action") || "";
        const byName = new Map();
        for (const el of Array.from(
          f.querySelectorAll("input[name], select[name], textarea[name]"),
        )) {
          let name = (
            el.getAttribute("name") ||
            el.getAttribute("id") ||
            ""
          ).trim();
          if (!name) continue;
          const kind =
            el.tagName.toLowerCase() === "input"
              ? ((el.getAttribute("type") || "text") + "").toLowerCase()
              : el.tagName.toLowerCase();
          if (kind === "password" || kind === "hidden") continue;
          if (el.hasAttribute && el.hasAttribute("disabled")) continue;
          if (kind === "checkbox" || kind === "radio") {
            if (!isControlVisible(el)) continue;
            const lbl =
              getLabel(el) ||
              (el.getAttribute && (el.getAttribute("title") || "")) ||
              el.value ||
              "";
            if (!(lbl || "").trim().length) continue;
            const opt = { value: el.value || "on", label: lbl };
            const group = byName.get(name) || {
              kind,
              name,
              label: getLabel(el.parentElement || el),
              options: [],
            };
            group.options.push(opt);
            byName.set(name, group);
          } else if (kind === "select") {
            if (!isVisible(el)) continue;
            const options = Array.from(el.options || [])
              .map((o) => ({
                value: o.value,
                label: o.text,
                selected: o.selected,
              }))
              .filter(
                (o) =>
                  (o.label || "").trim().length > 0 ||
                  (o.value || "").trim().length > 0,
              );
            if (options.length < 1) continue;
            byName.set(name, {
              kind: "select",
              name,
              label: getLabel(el),
              options,
            });
          } else {
            if (!isVisible(el)) continue;
            const lbl = getLabel(el);
            const placeholder =
              (el.getAttribute && el.getAttribute("placeholder")) || "";
            if (!lbl && !placeholder) continue;
            byName.set(name, { kind, name, label: lbl, value: el.value || "" });
          }
        }
        return { method, action, fields: Array.from(byName.values()) };
      });

      // Also collect filter-like inputs from a broader filter container
      const candidates = Array.from(
        document.querySelectorAll(
          '#filters, [id*="filter" i], [class*="filter" i], [aria-label*="filter" i]',
        ),
      );
      let scope =
        candidates.sort((a, b) => {
          const ac = a.querySelectorAll(
            "input[name], select[name], textarea[name]",
          ).length;
          const bc = b.querySelectorAll(
            "input[name], select[name], textarea[name]",
          ).length;
          return bc - ac;
        })[0] || document.body;
      try {
        const pageByName = collectFields(scope);
        const extraFields = Array.from(pageByName.values());
        if (extraFields.length) {
          forms.push({
            method: "GET",
            action: "#filters",
            fields: extraFields,
          });
        }
      } catch {}

      // Infer anchor-based query parameters used as filters
      const keysHint = [
        "filter",
        "filters",
        "facet",
        "facets",
        "refine",
        "refinement",
        "fq",
        "category",
        "type",
        "tag",
        "topic",
        "discipline",
        "program",
        "sort",
        "order",
        "page_size",
        "per_page",
        "q",
        "from",
        "to",
        "year",
      ];
      const paramMap = new Map();
      const trackRe = /^(utm_|gclid$|fbclid$|msclkid$|_hs|ref$)/i;
      for (const a of Array.from(scope.querySelectorAll("a[href]"))) {
        const href = a.getAttribute("href") || "";
        try {
          const u = new URL(href, location.href);
          for (const [k, v] of u.searchParams.entries()) {
            const kl = k.toLowerCase();
            if (trackRe.test(kl)) continue;
            if (
              keysHint.some((h) => kl.includes(h)) ||
              u.searchParams.getAll(k).length > 1
            ) {
              const set = paramMap.get(k) || new Set();
              if (v) set.add(v);
              paramMap.set(k, set);
            }
          }
        } catch {}
      }
      const anchorParams = Array.from(paramMap.entries()).map(([key, set]) => ({
        key,
        options: Array.from(set)
          .slice(0, 100)
          .map((v) => ({ value: v, label: v })),
      }));
      return { url: location.href, forms, anchorParams };
    });
    await browser.close();
    res.json({ success: true, data });
  } catch (e) {
    await browser.close();
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------- Build Filtered URL ----------
app.post("/build-filtered-url", async (req, res) => {
  try {
    const { url, params } = req.body || {};
    if (!isValidUrl(url) || typeof params !== "object") {
      return res
        .status(400)
        .json({ success: false, error: "url and params required" });
    }
    const u = new URL(url);
    // Append/replace params; if value is array, set multiple
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      u.searchParams.delete(k);
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item !== undefined && item !== null && String(item).length)
            u.searchParams.append(k, String(item));
        }
      } else {
        u.searchParams.set(k, String(v));
      }
    }
    return res.json({ success: true, data: { finalUrl: u.toString() } });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ---------- Parent Tree Interactive Extractor ----------
app.post("/parent-tree", async (req, res) => {
  const { url } = req.body || {};
  if (!isValidUrl(url))
    return res.status(400).json({ success: false, error: "Invalid URL" });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  });

  try {
    // First, analyze the URL to identify potential parent URLs
    const urlObj = new URL(url);
    const pathSegments = urlObj.pathname.split("/").filter(Boolean);

    // Generate potential parent URLs by removing path segments
    const potentialParents = [];
    let currentPath = "";

    // Add the domain root
    potentialParents.push(urlObj.origin + "/");

    // Add each path segment to build potential parent URLs
    for (let i = 0; i < pathSegments.length - 1; i++) {
      currentPath += "/" + pathSegments[i];
      potentialParents.push(urlObj.origin + currentPath + "/");
    }

    // Reverse the array to check from closest parent to furthest
    potentialParents.reverse();

    // Check each potential parent URL to see if it links to our target URL
    const results = [];
    const page = await context.newPage();

    for (const parentUrl of potentialParents) {
      try {
        await page.goto(parentUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        try {
          await page.waitForLoadState("networkidle", { timeout: 5000 });
        } catch {}

        // Check if this page links to our target URL
        const containsTarget = await page.evaluate((targetUrl) => {
          const links = Array.from(document.querySelectorAll("a[href]"));
          return links.some((link) => {
            try {
              const href = new URL(link.href).href;
              return href === targetUrl || targetUrl.startsWith(href);
            } catch {
              return false;
            }
          });
        }, url);

        if (containsTarget) {
          // This is a parent page - extract all links
          const extractedData = await page.evaluate(() => {
            const t = (e) => (e ? (e.textContent || "").trim() : "");
            const sel = [
              "main",
              "article",
              ".content",
              ".main-content",
              ".entry-content",
              "#content",
              ".post-content",
              '[role="main"]',
              "body",
            ];
            const pick = () => {
              for (const s of sel) {
                const el = document.querySelector(s);
                if (el && (el.textContent || "").trim().length > 50) return el;
              }
              return document.body;
            };
            const main = pick();

            // Extract all links from the main content
            const allLinks = Array.from(main.querySelectorAll("a[href]"));
            const isFilterZone = (el) => {
              const badSelectors = [
                "form",
                "nav",
                "header",
                "footer",
                "aside",
                '[role="search"]',
                '[role="navigation"]',
                ".breadcrumb",
                ".pagination",
                ".pager",
              ];
              let node = el;
              while (node) {
                if (
                  badSelectors.some((sel) => node.matches && node.matches(sel))
                )
                  return true;
                node = node.parentElement;
              }
              return false;
            };

            const links = allLinks
              .filter((a) => {
                const href = a.getAttribute("href") || "";
                if (
                  !href ||
                  href.startsWith("#") ||
                  href.startsWith("javascript:") ||
                  href.startsWith("mailto:") ||
                  href.startsWith("tel:")
                )
                  return false;
                if (isFilterZone(a)) return false;
                return true;
              })
              .map((a) => {
                try {
                  return {
                    href: new URL(a.href, document.location.href).href,
                    text: t(a),
                    titleAttr: a.getAttribute("title") || "",
                  };
                } catch {
                  return null;
                }
              })
              .filter(Boolean);

            return {
              title: t(document.querySelector("title")),
              pageHeading: t(document.querySelector("h1")),
              url: document.location.href,
              links,
            };
          });

          results.push({
            parentUrl,
            isParent: true,
            data: extractedData,
          });

          // We found a parent, no need to check further parents
          break;
        } else {
          results.push({
            parentUrl,
            isParent: false,
          });
        }
      } catch (error) {
        results.push({
          parentUrl,
          isParent: false,
          error: error.message,
        });
      }
    }

    // If no parent was found, try to find siblings by analyzing the URL structure
    if (!results.some((r) => r.isParent)) {
      try {
        // Try to infer parent from URL structure
        const inferredParentUrl =
          urlObj.origin +
          urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf("/") + 1);

        await page.goto(inferredParentUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        try {
          await page.waitForLoadState("networkidle", { timeout: 5000 });
        } catch {}

        const extractedData = await page.evaluate(() => {
          const t = (e) => (e ? (e.textContent || "").trim() : "");
          const sel = [
            "main",
            "article",
            ".content",
            ".main-content",
            ".entry-content",
            "#content",
            ".post-content",
            '[role="main"]',
            "body",
          ];
          const pick = () => {
            for (const s of sel) {
              const el = document.querySelector(s);
              if (el && (el.textContent || "").trim().length > 50) return el;
            }
            return document.body;
          };
          const main = pick();

          const allLinks = Array.from(main.querySelectorAll("a[href]"));
          const links = allLinks
            .filter((a) => {
              const href = a.getAttribute("href") || "";
              return (
                href &&
                !href.startsWith("#") &&
                !href.startsWith("javascript:") &&
                !href.startsWith("mailto:") &&
                !href.startsWith("tel:")
              );
            })
            .map((a) => {
              try {
                return {
                  href: new URL(a.href, document.location.href).href,
                  text: t(a),
                  titleAttr: a.getAttribute("title") || "",
                };
              } catch {
                return null;
              }
            })
            .filter(Boolean);

          return {
            title: t(document.querySelector("title")),
            pageHeading: t(document.querySelector("h1")),
            url: document.location.href,
            links,
          };
        });

        results.push({
          parentUrl: inferredParentUrl,
          isParent: true,
          isInferred: true,
          data: extractedData,
        });
      } catch (error) {
        results.push({
          parentUrl: inferredParentUrl,
          isParent: false,
          isInferred: true,
          error: error.message,
        });
      }
    }

    await browser.close();

    // Find the first successful parent result
    const parentResult = results.find((r) => r.isParent && r.data);

    if (parentResult) {
      // Identify which links from the parent are siblings of our target URL
      const siblings = parentResult.data.links.filter(
        (link) =>
          link.href !== url && new URL(link.href).origin === urlObj.origin,
      );

      // Identify which link is our target
      const targetLink = parentResult.data.links.find(
        (link) => link.href === url,
      );

      res.json({
        success: true,
        data: {
          targetUrl: url,
          parent: {
            url: parentResult.parentUrl,
            title: parentResult.data.title,
            pageHeading: parentResult.data.pageHeading,
            isInferred: !!parentResult.isInferred,
          },
          targetLinkInfo: targetLink || null,
          siblingLinks: siblings,
          allLinks: parentResult.data.links,
          potentialParentsChecked: results,
        },
      });
    } else {
      res.json({
        success: false,
        error: "Could not identify a parent page that links to the target URL",
        data: {
          targetUrl: url,
          potentialParentsChecked: results,
        },
      });
    }
  } catch (e) {
    await browser.close();
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------- Siblings via Selectors (no URL trimming) ----------
// Given a detail `url`, optionally a `parentSelector` to locate a link on the
// page that leads to the listing/parent, and optional selectors for the parent
// page to scope where to collect item links. This avoids path trimming and
// relies solely on DOM selectors.
app.post("/selector-siblings", async (req, res) => {
  const {
    url,
    parentUrl: directParentUrl, // Optional direct parent URL to skip detection on the detail page
    parentSelector, // CSS selector on the detail page that points to a parent/listing link (or wrapper containing one)
    itemsContainerSelector, // Optional CSS selector on the parent page to scope where to collect siblings
    itemLinkSelector, // Optional CSS selector (within the container) to pick item links
    headless = true, // Optional: allow overriding headless for debugging
    autoScope = true, // If true, scope siblings to same repeated container as the target link
  } = req.body || {};

  if (!isValidUrl(url))
    return res.status(400).json({ success: false, error: "Invalid URL" });

  const browser = await chromium.launch({ headless: !!headless });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    let parentUrl =
      directParentUrl && isValidUrl(directParentUrl) ? directParentUrl : null;

    if (!parentUrl) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      try {
        await page.waitForLoadState("networkidle", { timeout: 15000 });
      } catch {}

      // Best-effort: accept cookie overlays
      try {
        const cookieSelectors = [
          "#onetrust-accept-btn-handler",
          'button:has-text("Accept")',
          'button:has-text("I Agree")',
          ".cookie-accept",
          '[aria-label*="accept" i]',
        ];
        for (const s of cookieSelectors) {
          const el = await page.$(s);
          if (el) {
            await el.click({ timeout: 1000 }).catch(() => {});
            break;
          }
        }
      } catch {}

      // Prefer an explicit parent selector if provided
      if (parentSelector) {
        parentUrl = await page.evaluate((sel) => {
          try {
            const root = document.querySelector(sel);
            if (!root) return null;
            const a =
              root.tagName && root.tagName.toLowerCase() === "a"
                ? root
                : (root.closest && root.closest("a[href]")) ||
                  root.querySelector("a[href]");
            if (!a) return null;
            return new URL(a.href, document.location.href).href;
          } catch {
            return null;
          }
        }, parentSelector);
      }

      // Fallback: try common breadcrumb/parent rel patterns (DOM-safe)
      if (!parentUrl) {
        parentUrl = await page.evaluate(() => {
          const t = (e) => (e ? (e.textContent || "").trim() : "");
          const first = (sel) => document.querySelector(sel);
          const fromCandidates = (els) => {
            for (const a of els) {
              try {
                return new URL(a.href, document.location.href).href;
              } catch {}
            }
            return null;
          };

          // Try common breadcrumb containers and rel attributes
          const breadcrumbAnchor = fromCandidates(
            [
              first(".breadcrumb a[href]"),
              first(".breadcrumbs a[href]"),
              first("nav.breadcrumb a[href]"),
              (() => {
                const nav = document.querySelector(
                  '[aria-label*="breadcrumb" i]',
                );
                return nav ? nav.querySelector("a[href]") : null;
              })(),
              first('a[rel="up"]'),
              first('a[rel="parent"]'),
            ].filter(Boolean),
          );
          if (breadcrumbAnchor) return breadcrumbAnchor;

          // Fallback by anchor text/aria-label since :has-text() is not valid in querySelector
          const hints = ["back", "view all", "see all", "all", "up"];
          const anchors = Array.from(document.querySelectorAll("a[href]"));
          for (const a of anchors) {
            const txt = t(a).toLowerCase();
            const aria = (a.getAttribute("aria-label") || "").toLowerCase();
            if (hints.some((h) => txt.includes(h) || aria.includes(h))) {
              try {
                return new URL(a.href, document.location.href).href;
              } catch {}
            }
          }
          return null;
        });
      }
    }

    if (!parentUrl) {
      await browser.close();
      return res.json({
        success: false,
        error: "Could not locate a parent link via selectors on the page",
      });
    }

    // Go to the parent/listing page to collect sibling links
    await page.goto(parentUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {}

    const data = await page.evaluate(
      (containerSel, linkSel, targetUrl, doAutoScope) => {
        const t = (e) => (e ? (e.textContent || "").trim() : "");
        const pickMain = () => {
          const sels = [
            "main",
            "article",
            ".content",
            ".main-content",
            ".entry-content",
            "#content",
            ".post-content",
            '[role="main"]',
            "body",
          ];
          for (const s of sels) {
            const el = document.querySelector(s);
            if (el && (el.textContent || "").trim().length > 50) return el;
          }
          return document.body;
        };
        const toAbs = (a) => {
          try {
            return new URL(a.href, document.location.href).href;
          } catch {
            return null;
          }
        };
        let scope =
          (containerSel ? document.querySelector(containerSel) : null) ||
          pickMain();

        const badSelectors = [
          "form",
          "nav",
          "header",
          "footer",
          "aside",
          '[role="search"]',
          '[role="navigation"]',
          ".breadcrumb",
          ".pagination",
          ".pager",
          ".filters",
          ".filter",
          ".facets",
          ".facet",
          ".refine",
          ".search",
          ".toolbar",
          ".sidebar",
        ];
        const isFilterZone = (el) => {
          let n = el;
          while (n) {
            if (badSelectors.some((sel) => n.matches && n.matches(sel)))
              return true;
            n = n.parentElement;
          }
          return false;
        };

        let linkNodes = Array.from(
          scope.querySelectorAll(linkSel || "a[href]"),
        );
        linkNodes = linkNodes.filter((a) => {
          const href = a.getAttribute("href") || "";
          if (
            !href ||
            href.startsWith("#") ||
            href.startsWith("javascript:") ||
            href.startsWith("mailto:") ||
            href.startsWith("tel:")
          )
            return false;
          if (isFilterZone(a)) return false;
          return true;
        });

        const links = linkNodes
          .map((a) => {
            try {
              return {
                href: toAbs(a),
                text: t(a),
                titleAttr: a.getAttribute("title") || "",
              };
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        // Deduplicate by href
        const seen = new Set();
        const dedup = [];
        for (const l of links) {
          if (!seen.has(l.href)) {
            seen.add(l.href);
            dedup.push(l);
          }
        }

        let targetLink = dedup.find((l) => l.href === targetUrl) || null;

        // Optional: auto-scope to the same repeated container as the target link
        if (doAutoScope) {
          const targetAnchor =
            Array.from(document.querySelectorAll("a[href]")).find((a) => {
              try {
                return (
                  new URL(a.href, document.location.href).href === targetUrl
                );
              } catch {
                return false;
              }
            }) || null;
          if (targetAnchor) {
            const hasItemLink = (el) =>
              !!(
                el &&
                (el.querySelector
                  ? el.querySelector(linkSel || "a[href]")
                  : null)
              );
            let node = targetAnchor;
            let container = null;
            while (node && node !== document.body) {
              const p = node.parentElement;
              if (!p) break;
              const siblings = Array.from(p.children).filter(
                (ch) =>
                  ch.tagName === node.tagName &&
                  ch.className === node.className,
              );
              const valid = siblings.filter(hasItemLink);
              if (valid.length >= 1 && hasItemLink(node)) {
                container = node;
                break;
              }
              node = p;
            }
            if (container && container.parentElement) {
              const groupItems = Array.from(
                container.parentElement.children,
              ).filter(
                (ch) =>
                  ch.tagName === container.tagName &&
                  ch.className === container.className,
              );
              const grouped = [];
              for (const it of groupItems) {
                const firstLink = linkSel
                  ? it.querySelector(linkSel)
                  : it.querySelector("a[href]");
                if (firstLink) {
                  const hrefAbs = toAbs(firstLink);
                  if (hrefAbs)
                    grouped.push({
                      href: hrefAbs,
                      text: t(firstLink),
                      titleAttr: firstLink.getAttribute("title") || "",
                    });
                }
              }
              const seen2 = new Set();
              const ded2 = [];
              for (const l of grouped) {
                if (!seen2.has(l.href)) {
                  seen2.add(l.href);
                  ded2.push(l);
                }
              }
              if (ded2.length) {
                dedup = ded2;
                targetLink = dedup.find((l) => l.href === targetUrl) || null;
              }
            }
          }
        }

        const siblings = dedup.filter((l) => l.href !== targetUrl);

        return {
          title: t(document.querySelector("title")),
          pageHeading: t(document.querySelector("h1")),
          url: document.location.href,
          links: dedup,
          targetLink,
          siblings,
        };
      },
      itemsContainerSelector || null,
      itemLinkSelector || null,
      url,
      !!autoScope,
    );

    await browser.close();

    return res.json({
      success: true,
      data: {
        targetUrl: url,
        parentUrl,
        parent: {
          title: data.title,
          pageHeading: data.pageHeading,
        },
        targetLinkInfo: data.targetLink,
        siblingLinks: data.siblings,
        allLinks: data.links,
      },
    });
  } catch (e) {
    await browser.close();
    return res.status(500).json({ success: false, error: e.message });
  }
});

const proxyHost = "dc.decodo.com";
const proxyPort = 10000; // 10001 for static
const proxyUser = "lnobit";
const proxyPass = "lLh4~t0LxQVac1anl8";
// const puppeteer = require("puppeteer");
const proxyUrl = `http://${proxyUser}:${proxyPass}@${proxyHost}:${proxyPort}`;

const agent = new HttpsProxyAgent(proxyUrl);

// ---------- Hover Link Inspector (Puppeteer) ----------
app.get("/hover-link-inspector", async (req, res) => {
  const targetUrl = req.query.url;
  const noProxyParam = String(
    req.query.noProxy || req.query.proxy || "",
  ).toLowerCase();
  const disableProxy =
    noProxyParam === "1" || noProxyParam === "true" || noProxyParam === "off";
  const sessionId =
    (req.query.sessionId || "").toString() ||
    Math.random().toString(36).slice(2);
  if (!targetUrl || !isValidUrl(targetUrl)) {
    return res
      .status(400)
      .json({ success: false, error: "Provide a valid ?url=" });
  }
  let browser;
  try {
    const launchArgs = [];
    var finladata = null;
    let usedProxy = false;
    try {
      if (
        !disableProxy &&
        typeof proxyHost === "string" &&
        proxyHost &&
        typeof proxyPort !== "undefined"
      ) {
        launchArgs.push(`--proxy-server=http://${proxyHost}:${proxyPort}`);
        usedProxy = true;
      }
    } catch {}
    browser = await puppeteer.launch({
      headless: false,
      args: launchArgs,
      defaultViewport: null,
    });
    let page = await browser.newPage();
    if (usedProxy) {
      try {
        await page.authenticate({ username: proxyUser, password: proxyPass });
      } catch {}
    }
    // Bridge from page to Node: receive siblings payloads
    await page.exposeFunction("reportSiblings", (payload) => {
      try {
        if (payload && typeof payload === "object") {
          HoverSessions.set(sessionId, payload);
        }
      } catch {}
    });
    try {
      if (
        typeof proxyUser === "string" &&
        proxyUser &&
        typeof proxyPass === "string"
      ) {
        await page.authenticate({ username: proxyUser, password: proxyPass });
      }
    } catch {}
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    );
    let navError = null;
    try {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    } catch (e) {
      navError = e;
    }
    if (
      navError &&
      usedProxy &&
      /tunnel|ERR_TUNNEL|ERR_PROXY/i.test(
        String((navError && navError.message) || ""),
      )
    ) {
      try {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
      } catch {}
      // Retry without proxy
      browser = await puppeteer.launch({
        headless: false,
        args: [],
        defaultViewport: null,
      });
      page = await browser.newPage();
      try {
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        );
      } catch {}
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      usedProxy = false;
      navError = null;
    }
    if (navError) throw navError;
    const installInspector = async (frame = page) => {
      await frame.evaluate((sid) => {
        const makeSelector = (el) => {
          if (!el || el.nodeType !== 1) return "";
          const parts = [];
          let node = el;
          while (
            node &&
            node.nodeType === 1 &&
            node !== document.body &&
            node !== document.documentElement
          ) {
            let selector = node.nodeName.toLowerCase();
            if (node.id) {
              selector +=
                "#" +
                (window.CSS && CSS.escape
                  ? CSS.escape(node.id)
                  : node.id.replace(/([ #;.])/g, "\\$1"));
              parts.unshift(selector);
              break;
            }
            const classList = Array.from(node.classList || []);
            if (classList.length) {
              selector +=
                "." +
                classList
                  .map((c) =>
                    window.CSS && CSS.escape
                      ? CSS.escape(c)
                      : c.replace(/([ #;.])/g, "\\$1"),
                  )
                  .join(".");
            }
            let nth = 1,
              sib = node;
            while ((sib = sib.previousElementSibling)) {
              if (sib.nodeName.toLowerCase() === node.nodeName.toLowerCase())
                nth++;
            }
            if (nth > 1) selector += `:nth-of-type(${nth})`;
            parts.unshift(selector);
            node = node.parentElement;
          }
          return parts.join(" > ");
        };

        const popupId = "__hover_link_popup__";
        if (document.getElementById(popupId)) return;
        const popup = document.createElement("div");
        popup.id = popupId;
        popup.style.cssText = [
          "position:absolute",
          "z-index:2147483647",
          "background:rgba(20,20,20,0.95)",
          "color:#fff",
          "font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial",
          "padding:8px 10px",
          "border-radius:6px",
          "box-shadow:0 4px 12px rgba(0,0,0,0.3)",
          "max-width:420px",
          "word-break:break-all",
          "display:none",
          "pointer-events:auto",
        ].join(";");
        const label = document.createElement("div");
        label.style.marginBottom = "6px";
        const btn = document.createElement("button");
        btn.textContent = "Copy Selector";
        btn.style.cssText = [
          "background:#4a90e2",
          "border:0",
          "color:#fff",
          "padding:6px 10px",
          "border-radius:4px",
          "cursor:pointer",
        ].join(";");
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const sel = popup.getAttribute("data-selector") || "";
          try {
            await (navigator.clipboard
              ? navigator.clipboard.writeText(sel)
              : Promise.reject());
          } catch {
            const ta = document.createElement("textarea");
            ta.value = sel;
            ta.style.position = "fixed";
            ta.style.left = "-9999px";
            document.body.appendChild(ta);
            ta.select();
            try {
              document.execCommand("copy");
            } catch {}
            ta.remove();
          }
          // After copying, compute and render siblings for the hovered anchor and report to Node
          const target =
            lastTarget && lastTarget.closest
              ? lastTarget.closest("a[href]")
              : null;
          const data = computeSiblingsFor(target);
          const currentHref = target ? toAbs(target) : "";
          renderSiblings(data, currentHref);
          try {
            const payload = {
              selector: sel,
              currentHref,
              siblings: (data && data.items) || [],
              pageUrl: location.href,
              sessionId: sid,
            };
            if (window.reportSiblings) {
              window.reportSiblings(payload);
            }
          } catch {}
        });
        popup.appendChild(label);
        popup.appendChild(btn);
        const list = document.createElement("div");
        list.id = "__hover_link_list__";
        list.style.cssText = [
          "margin-top:6px",
          "max-height:240px",
          "overflow:auto",
          "border-top:1px solid rgba(255,255,255,0.15)",
          "padding-top:6px",
        ].join(";");
        popup.appendChild(list);
        document.body.appendChild(popup);
        let lastTarget = null;
        const highlight = document.createElement("div");
        highlight.style.cssText = [
          "position:absolute",
          "z-index:2147483646",
          "border:2px solid #4a90e2",
          "border-radius:3px",
          "pointer-events:none",
          "display:none",
        ].join(";");
        document.body.appendChild(highlight);

        const toAbs = (el) => {
          try {
            const href =
              (el && (el.getAttribute ? el.getAttribute("href") : null)) ||
              (el && el.href) ||
              "";
            return new URL(href, document.location.href).href;
          } catch {
            return "";
          }
        };

        // Preload dynamic custom fields before building the context menu
        let customFields = [];
        try {
          const __hli_raw = localStorage.getItem("__hli_state__");
          if (__hli_raw) {
            const __hli_st = JSON.parse(__hli_raw) || {};
            if (Array.isArray(__hli_st.customFields))
              customFields = __hli_st.customFields;
          }
        } catch {}

        // ----- Custom right-click context menu for hovered element -----
        const ctxMenuId = "__hover_context_menu__";
        let ctxMenu = document.getElementById(ctxMenuId);
        if (!ctxMenu) {
          ctxMenu = document.createElement("div");
          ctxMenu.id = ctxMenuId;
          ctxMenu.style.cssText = [
            "position:absolute",
            "z-index:2147483648",
            "background:rgba(20,20,20,0.98)",
            "color:#fff",
            "font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial",
            "padding:8px 10px",
            "border-radius:6px",
            "box-shadow:0 8px 24px rgba(0,0,0,0.35)",
            "min-width:320px",
            "max-width:480px",
            "display:none",
            "pointer-events:auto",
            "user-select:text",
          ].join(";");
          const makeBtn = (label) => {
            const btn = document.createElement("button");
            btn.textContent = label;
            btn.style.cssText = [
              "background:#2d2d2d",
              "border:1px solid rgba(255,255,255,0.15)",
              "color:#fff",
              "padding:6px 10px",
              "border-radius:4px",
              "cursor:pointer",
              "margin:4px 6px 4px 0",
            ].join(";");
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              if (typeof handleMenuClick === "function") handleMenuClick(label);
            });
            return btn;
          };
          const rowWrap = document.createElement("div");
          rowWrap.style.cssText = [
            "display:flex",
            "flex-wrap:wrap",
            "align-items:center",
          ].join(";");
          const defaultFields = ["Hyperlink", "Title", "Date", "Description"];
          const renderMenuButtons = () => {
            rowWrap.innerHTML = "";
            const fields = Array.from(
              new Set(
                defaultFields.concat(
                  Array.isArray(customFields) ? customFields : [],
                ),
              ),
            );
            fields.forEach((lab) => rowWrap.appendChild(makeBtn(lab)));
          };
          renderMenuButtons();
          // Dynamic field entry
          const addWrap = document.createElement("div");
          addWrap.style.cssText =
            "margin-top:6px; display:flex; gap:6px; align-items:center;";
          const inp = document.createElement("input");
          inp.type = "text";
          inp.placeholder = "New field label";
          inp.style.cssText =
            "background:#111;border:1px solid rgba(255,255,255,0.2);color:#fff;padding:6px 8px;border-radius:4px;flex:1 1 auto;min-width:120px";
          const addBtn = document.createElement("button");
          addBtn.textContent = "Add Field";
          addBtn.style.cssText =
            "background:#5c6bc0;border:0;color:#fff;padding:6px 10px;border-radius:4px;cursor:pointer;flex:0 0 auto";
          const addField = () => {
            const lab = (inp.value || "").trim();
            if (!lab) return;
            if (!customFields.includes(lab) && !defaultFields.includes(lab)) {
              customFields.push(lab);
              saveState();
              renderMenuButtons();
            }
            try {
              if (typeof handleMenuClick === "function") handleMenuClick(lab);
            } catch {}
            inp.value = "";
          };
          addBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            addField();
          });
          inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              addField();
            }
          });
          addWrap.appendChild(inp);
          addWrap.appendChild(addBtn);
          ctxMenu.appendChild(rowWrap);
          ctxMenu.appendChild(addWrap);
          // Navigation helper row: open/copy current target (anchor or iframe)
          const navWrap = document.createElement("div");
          navWrap.style.cssText =
            "margin-top:6px; display:flex; gap:6px; align-items:center;";
          const openBtn = document.createElement("button");
          openBtn.textContent = "Open Target";
          openBtn.style.cssText =
            "background:#2e7d32;border:0;color:#fff;padding:6px 10px;border-radius:4px;cursor:pointer;flex:0 0 auto";
          const copyBtn = document.createElement("button");
          copyBtn.textContent = "Copy URL";
          copyBtn.style.cssText =
            "background:#1976d2;border:0;color:#fff;padding:6px 10px;border-radius:4px;cursor:pointer;flex:0 0 auto";
          const getOpenUrl = (el) => {
            try {
              const abs = (u) => {
                try {
                  return new URL(u, document.location.href).href;
                } catch {
                  return "";
                }
              };
              if (!el) {
                // If running inside an iframe document, fallback to its URL
                try {
                  if (window.top !== window) return document.location.href;
                } catch {}
                return "";
              }
              // Iframe targets: prefer property src, then attribute, then contentWindow (same-origin), then data-* fallbacks
              if (el.tagName && el.tagName.toLowerCase() === "iframe") {
                const prop = (el.src || "").trim();
                if (prop && prop !== "about:blank") return prop;
                const attr = (el.getAttribute("src") || "").trim();
                if (attr) return abs(attr);
                try {
                  if (el.contentWindow) {
                    const href =
                      el.contentWindow.location &&
                      el.contentWindow.location.href;
                    if (href && href !== "about:blank") return href;
                  }
                } catch {}
                const dataAttrs = [
                  "data-src",
                  "data-lazy-src",
                  "data-iframe-src",
                  "data-url",
                  "data-href",
                ];
                for (const k of dataAttrs) {
                  const v = (el.getAttribute && el.getAttribute(k)) || "";
                  if (v) {
                    const u = abs(v);
                    if (u) return u;
                  }
                }
                return "";
              }
              // Anchors: property href or absolute via helper
              if (el.matches && el.matches("a[href]"))
                return el.href || toAbs(el);
              const a = el.closest ? el.closest("a[href]") : null;
              if (a) return a.href || toAbs(a);
              // Inside an iframe document? Open the frame document itself
              try {
                if (window.top !== window) return document.location.href;
              } catch {}
              return "";
            } catch {
              return "";
            }
          };
          const setBtnState = (btn, enabled) => {
            btn.disabled = !enabled;
            btn.style.opacity = enabled ? "1" : "0.5";
            btn.style.cursor = enabled ? "pointer" : "not-allowed";
          };
          const updateNavButtons = (el) => {
            const url = getOpenUrl(el);
            navWrap.setAttribute("data-url", url || "");
            const ok = !!url;
            setBtnState(openBtn, ok);
            setBtnState(copyBtn, ok);
          };
          openBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const el =
              ctxCurrentEl && document.contains(ctxCurrentEl)
                ? ctxCurrentEl
                : lastTarget && document.contains(lastTarget)
                  ? lastTarget
                  : null;
            const url = getOpenUrl(el);
            if (url) {
              try {
                window.open(url, "_blank", "noopener");
              } catch {}
            } else {
              try {
                alert(
                  "No hyperlink or iframe URL found for the current target.",
                );
              } catch {}
            }
          });
          copyBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const url = navWrap.getAttribute("data-url") || "";
            if (!url) return;
            try {
              await (navigator.clipboard
                ? navigator.clipboard.writeText(url)
                : Promise.reject());
            } catch {
              const ta = document.createElement("textarea");
              ta.value = url;
              ta.style.position = "fixed";
              ta.style.left = "-9999px";
              document.body.appendChild(ta);
              ta.select();
              try {
                document.execCommand("copy");
              } catch {}
              ta.remove();
            }
          });
          navWrap.appendChild(openBtn);
          navWrap.appendChild(copyBtn);
          ctxMenu.appendChild(navWrap);
          document.body.appendChild(ctxMenu);

          // Lightweight iframe hover affordance to open menu
          let iframeTargetEl = null;
          let iframeBtn = document.getElementById("__hli_iframe_btn__");
          if (!iframeBtn) {
            iframeBtn = document.createElement("button");
            iframeBtn.id = "__hli_iframe_btn__";
            iframeBtn.textContent = "Menu";
            iframeBtn.style.cssText = [
              "position:absolute",
              "z-index:2147483650",
              "background:rgba(20,20,20,0.9)",
              "color:#fff",
              "font:12px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial",
              "padding:4px 6px",
              "border-radius:4px",
              "border:1px solid rgba(255,255,255,0.2)",
              "cursor:pointer",
              "display:none",
              "pointer-events:auto",
            ].join(";");
            document.body.appendChild(iframeBtn);
          }
          const showIframeButton = (el) => {
            try {
              if (!el || !el.getBoundingClientRect) return;
              iframeTargetEl = el;
              const r = el.getBoundingClientRect();
              // Pin the handle to the iframe's top-left corner for reliability
              const x = window.scrollX + r.left + 6;
              const y = window.scrollY + r.top + 6;
              iframeBtn.style.left = x + "px";
              iframeBtn.style.top = y + "px";
              iframeBtn.style.display = "block";
            } catch {}
          };
          const hideIframeButton = () => {
            try {
              iframeBtn.style.display = "none";
              iframeTargetEl = null;
            } catch {}
          };
          iframeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const el = iframeTargetEl;
            if (!el) return;
            try {
              if (typeof showFor === "function") showFor(el);
            } catch {}
            ctxCurrentEl = el;
            try {
              updateNavButtons && updateNavButtons(el);
            } catch {}
            // Place menu near the button
            const br = iframeBtn.getBoundingClientRect();
            placeCtx(window.scrollX + br.left, window.scrollY + br.bottom + 6);
          });
          document.addEventListener("scroll", hideIframeButton, true);
          window.addEventListener("resize", hideIframeButton);

          const placeCtx = (x, y) => {
            ctxMenu.style.display = "block";
            ctxMenu.style.visibility = "hidden";
            ctxMenu.style.left = x + "px";
            ctxMenu.style.top = y + "px";
            const r = ctxMenu.getBoundingClientRect();
            const vw = window.innerWidth,
              vh = window.innerHeight;
            let left = x,
              top = y;
            if (r.right > vw) left = Math.max(window.scrollX, x - r.width);
            if (r.bottom > vh) top = Math.max(window.scrollY, y - r.height);
            ctxMenu.style.left = left + "px";
            ctxMenu.style.top = top + "px";
            ctxMenu.style.visibility = "visible";
          };

          let navObserver = null;
          const hideCtx = () => {
            ctxMenu.style.display = "none";
            try {
              if (navObserver) {
                navObserver.disconnect();
                navObserver = null;
              }
            } catch {}
          };
          let ctxSelectedEl = null;
          document.addEventListener(
            "contextmenu",
            (e) => {
              const target = e.target;
              const inPopup = !!(
                target &&
                (target === popup ||
                  (popup.contains && popup.contains(target)) ||
                  (ctxMenu.contains && ctxMenu.contains(target)))
              );
              if (inPopup) {
                e.preventDefault();
                return;
              }
              let el = null;
              try {
                const sel = window.getSelection ? window.getSelection() : null;
                if (sel && sel.rangeCount && !sel.isCollapsed) {
                  const range = sel.getRangeAt(0);
                  let node = range.commonAncestorContainer;
                  if (node && node.nodeType !== 1) node = node.parentElement;
                  if (node && node.nodeType === 1) {
                    el = node;
                    ctxSelectedEl = node;
                  }
                }
              } catch {}
              if (!el)
                el =
                  lastTarget && document.contains(lastTarget)
                    ? lastTarget
                    : target && target.nodeType === 1
                      ? target
                      : null;
              if (!el) return;
              e.preventDefault();
              // Update popup/selector to reflect the selected element
              try {
                if (typeof showFor === "function") showFor(ctxSelectedEl || el);
              } catch {}
              ctxCurrentEl = el;
              updateNavButtons(el);
              // If target is an iframe, observe lazy src changes to update url state
              try {
                if (el && el.tagName && el.tagName.toLowerCase() === "iframe") {
                  if (navObserver) {
                    try {
                      navObserver.disconnect();
                    } catch {}
                  }
                  navObserver = new MutationObserver(() =>
                    updateNavButtons(el),
                  );
                  navObserver.observe(el, {
                    attributes: true,
                    attributeFilter: [
                      "src",
                      "data-src",
                      "data-lazy-src",
                      "data-iframe-src",
                      "data-url",
                      "data-href",
                    ],
                  });
                  // Also poll contentWindow location for same-origin
                  let ticks = 0;
                  const poll = () => {
                    if (!navObserver) return;
                    try {
                      updateNavButtons(el);
                    } catch {}
                    if (++ticks < 20) setTimeout(poll, 500);
                  };
                  setTimeout(poll, 300);
                }
              } catch {}
              placeCtx(
                e.pageX ||
                  window.scrollX +
                    (el.getBoundingClientRect
                      ? el.getBoundingClientRect().left
                      : 0),
                e.pageY ||
                  window.scrollY +
                    (el.getBoundingClientRect
                      ? el.getBoundingClientRect().bottom
                      : 0),
              );
            },
            true,
          );

          document.addEventListener(
            "click",
            (e) => {
              const t = e.target;
              if (
                t &&
                (t === ctxMenu || (ctxMenu.contains && ctxMenu.contains(t)))
              )
                return;
              hideCtx();
            },
            true,
          );
          document.addEventListener("scroll", hideCtx, true);
          window.addEventListener("resize", hideCtx);
          window.addEventListener("keydown", (e) => {
            if (e.key === "Escape") hideCtx();
            try {
              const isMac =
                navigator.platform.toUpperCase().indexOf("MAC") >= 0;
              const mod = isMac ? e.metaKey : e.ctrlKey;
              if (mod && e.shiftKey && (e.key === "M" || e.key === "m")) {
                e.preventDefault();
                e.stopPropagation();
                const el =
                  ctxCurrentEl && document.contains(ctxCurrentEl)
                    ? ctxCurrentEl
                    : lastTarget && document.contains(lastTarget)
                      ? lastTarget
                      : null;
                if (!el) return;
                if (ctxMenu && ctxMenu.style.display === "block") {
                  hideCtx();
                  return;
                }
                try {
                  if (typeof showFor === "function") showFor(el);
                } catch {}
                updateNavButtons && updateNavButtons(el);
                const r = el.getBoundingClientRect();
                placeCtx(
                  window.scrollX + r.left,
                  window.scrollY + r.bottom + 8,
                );
              }
            } catch {}
          });
        }

        // ----- Dynamic extraction table panel -----
        const tablePanelId = "__hover_extract_table_panel__";
        let extractState = { columns: [], rows: [] };
        let columnMap = {}; // label -> column name mapping selected by user
        let detailSelectors = {}; // label -> CSS selector captured on detail page
        let siblingsHrefs = []; // hrefs of detected siblings
        // customFields is declared earlier to avoid TDZ during menu render
        let baseAnchorSelector = null; // remembered when choosing Hyperlink
        let baseAnchorHref = null; // absolute URL of base anchor
        let ctxCurrentEl = null;

        const saveState = () => {
          try {
            const st = {
              columnMap,
              detailSelectors,
              siblingsHrefs,
              baseAnchorSelector,
              baseAnchorHref,
              customFields,
            };
            localStorage.setItem("__hli_state__", JSON.stringify(st));
          } catch {}
        };
        const loadState = () => {
          try {
            const raw = localStorage.getItem("__hli_state__");
            if (!raw) return;
            const st = JSON.parse(raw) || {};
            columnMap = st.columnMap || columnMap;
            detailSelectors = st.detailSelectors || detailSelectors;
            siblingsHrefs = st.siblingsHrefs || siblingsHrefs;
            baseAnchorSelector = st.baseAnchorSelector || baseAnchorSelector;
            baseAnchorHref = st.baseAnchorHref || baseAnchorHref;
            customFields = Array.isArray(st.customFields)
              ? st.customFields
              : customFields;
          } catch {}
        };
        loadState();

        const ensureTablePanel = () => {
          let panel = document.getElementById(tablePanelId);
          if (panel) return panel;
          panel = document.createElement("div");
          panel.id = tablePanelId;
          panel.style.cssText = [
            "position:fixed",
            "right:12px",
            "bottom:12px",
            "z-index:2147483649",
            "background:rgba(20,20,20,0.95)",
            "color:#fff",
            "font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial",
            "padding:8px",
            "border-radius:6px",
            "box-shadow:0 8px 24px rgba(0,0,0,0.35)",
            "max-width:60vw",
            "max-height:40vh",
            "overflow:auto",
          ].join(";");
          const header = document.createElement("div");
          header.textContent = "Extracted Table";
          header.style.cssText = "margin-bottom:6px; font-weight:600;";
          const actions = document.createElement("div");
          actions.style.cssText = "margin-bottom:6px;";
          const btnExtract = document.createElement("button");
          btnExtract.textContent = "Extract All";
          btnExtract.style.cssText = [
            "background:#3cb371",
            "border:0",
            "color:#fff",
            "padding:4px 8px",
            "border-radius:4px",
            "cursor:pointer",
            "margin-right:6px",
          ].join(";");
          const btnExtractDetails = document.createElement("button");
          btnExtractDetails.textContent = "Extract Details";
          btnExtractDetails.style.cssText = [
            "background:#e6a23c",
            "border:0",
            "color:#fff",
            "padding:4px 8px",
            "border-radius:4px",
            "cursor:pointer",
            "margin-right:6px",
          ].join(";");
          const btnExport = document.createElement("button");
          btnExport.textContent = "Export CSV";
          btnExport.style.cssText = [
            "background:#4a90e2",
            "border:0",
            "color:#fff",
            "padding:4px 8px",
            "border-radius:4px",
            "cursor:pointer",
            "margin-right:6px",
          ].join(";");
          const btnClear = document.createElement("button");
          btnClear.textContent = "Clear";
          btnClear.style.cssText = [
            "background:#a33",
            "border:0",
            "color:#fff",
            "padding:4px 8px",
            "border-radius:4px",
            "cursor:pointer",
          ].join(";");
          const tableWrap = document.createElement("div");
          panel.appendChild(header);
          actions.appendChild(btnExtract);
          actions.appendChild(btnExtractDetails);
          actions.appendChild(btnExport);
          actions.appendChild(btnClear);
          panel.appendChild(actions);
          panel.appendChild(tableWrap);
          document.body.appendChild(panel);

          btnClear.addEventListener("click", () => {
            extractState = { columns: [], rows: [] };
            renderTable();
          });
          btnExtract.addEventListener("click", () => {
            extractAllUsingSiblings();
          });
          btnExtractDetails.addEventListener("click", async () => {
            try {
              await extractAllDetails();
            } catch {}
          });
          btnExport.addEventListener("click", () => {
            const csv = toCSV(extractState.columns, extractState.rows);
            const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "extracted.csv";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
          });

          panel._tableWrap = tableWrap;
          return panel;
        };

        const toCSV = (cols, rows) => {
          const esc = (s) => '"' + String(s || "").replace(/"/g, '""') + '"';
          const head = cols.map(esc).join(",");
          const lines = rows.map((r) =>
            cols.map((c) => esc(r[c] || "")).join(","),
          );
          return [head].concat(lines).join("\n");
        };

        const renderTable = () => {
          const panel = ensureTablePanel();
          const wrap = panel._tableWrap;
          wrap.innerHTML = "";
          if (!extractState.columns.length) {
            const empty = document.createElement("div");
            empty.textContent = "No data yet. Use right-click menu.";
            empty.style.opacity = "0.8";
            wrap.appendChild(empty);
            return;
          }
          const t = document.createElement("table");
          t.style.cssText =
            "border-collapse:collapse; width:100%; table-layout:fixed;";
          const thead = document.createElement("thead");
          const trh = document.createElement("tr");
          extractState.columns.forEach((c) => {
            const th = document.createElement("th");
            th.textContent = c;
            th.style.cssText =
              "text-align:left; border-bottom:1px solid rgba(255,255,255,0.2); padding:4px; position:sticky; top:0; background:rgba(20,20,20,0.98)";
            trh.appendChild(th);
          });
          thead.appendChild(trh);
          const tbody = document.createElement("tbody");
          extractState.rows.forEach((r) => {
            const tr = document.createElement("tr");
            extractState.columns.forEach((c) => {
              const td = document.createElement("td");
              td.textContent = r[c] || "";
              td.style.cssText =
                "padding:4px; border-bottom:1px solid rgba(255,255,255,0.1); word-break:break-word;";
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });
          t.appendChild(thead);
          t.appendChild(tbody);
          wrap.appendChild(t);
        };

        const ensureColumn = (name) => {
          if (!extractState.columns.includes(name))
            extractState.columns.push(name);
        };

        const addToTable = (colName, value) => {
          ensureColumn(colName);
          if (!extractState.rows.length) extractState.rows.push({});
          const row = extractState.rows[0];
          row[colName] = value;
          renderTable();
        };

        // Lightweight extractors used when menu item clicked
        const extractTitle = (el) => {
          const a =
            el && el.matches && el.matches("a[href]")
              ? el
              : el && el.querySelector
                ? el.querySelector("a[href]")
                : null;
          if (a) {
            const t = (a.getAttribute("title") || a.textContent || "").trim();
            if (t) return t;
          }
          // If no anchor, try a heading inside the element
          try {
            const h =
              el && el.querySelector
                ? el.querySelector("h1,h2,h3,h4,h5,h6")
                : null;
            if (h && h.textContent) return h.textContent.trim();
          } catch {}
          // Fallback to element's own title-like attributes only (avoid full text to prevent overlap with description)
          if (el && el.getAttribute) {
            const t =
              el.getAttribute("title") ||
              el.getAttribute("aria-label") ||
              el.getAttribute("alt") ||
              "";
            return (t || "").trim();
          }
          return "";
        };
        const extractDescription = (el) => {
          // Prefer a dedicated description container inside the item if present
          try {
            const descEl =
              el && el.querySelector
                ? el.querySelector(
                    'p, .description, [itemprop="description"], meta[name="description"]',
                  ) || null
                : null;
            if (descEl) {
              const txt = (descEl.content || descEl.textContent || "")
                .replace(/\s+/g, " ")
                .trim();
              if (txt) return txt.slice(0, 300);
            }
          } catch {}
          // Fallback to excluding heading text to avoid duplicating title
          let txt = el.textContent || "";
          try {
            const h =
              el && el.querySelector
                ? el.querySelector("h1,h2,h3,h4,h5,h6")
                : null;
            if (h && h.textContent) {
              const htxt = h.textContent.trim();
              if (htxt) txt = txt.replace(h.textContent, "");
            }
          } catch {}
          return txt.replace(/\s+/g, " ").trim().slice(0, 300);
        };
        const extractDate = (el) => {
          try {
            const t =
              (el && el.querySelector ? el.querySelector("time") : null) ||
              (el && el.closest ? el.closest("time") : null);
            const dt = t && (t.getAttribute("datetime") || t.textContent);
            if (dt) return dt.trim();
          } catch {}
          const rxMonth =
            "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
          const dateMatchers = [
            new RegExp("\\b\\d{4}-\\d{2}-\\d{2}\\b"),
            new RegExp("\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b"),
            new RegExp("\\b" + rxMonth + " \\d{1,2},? \\d{4}\\b", "i"),
          ];
          const txt = (el.textContent || "").trim().slice(0, 400);
          for (const re of dateMatchers) {
            const m = re.exec(txt);
            if (m) return m[0];
          }
          return "";
        };

        const handleMenuClick = (label) => {
          const el =
            ctxCurrentEl && document.contains(ctxCurrentEl)
              ? ctxCurrentEl
              : lastTarget && document.contains(lastTarget)
                ? lastTarget
                : null;
          if (!el) return;
          const defCol = columnMap[label] || label;
          const col = prompt("Column name for " + label, defCol);
          if (!col) return;
          columnMap[label] = col.trim();
          let val = "";
          if (label === "Hyperlink") {
            const a = el.closest ? el.closest("a[href]") || null : null;
            val = a ? toAbs(a) : toAbs(el);
            // Remember base anchor for Extract All
            const anchorEl =
              a || (el && el.matches && el.matches("a[href]") ? el : null);
            if (anchorEl && typeof makeSelector === "function") {
              try {
                baseAnchorSelector = makeSelector(anchorEl);
              } catch {}
              try {
                baseAnchorHref = toAbs(anchorEl);
              } catch {}
            }
            // Also compute and persist siblings immediately
            try {
              const data = computeSiblingsFor(anchorEl);
              const items = (data && data.items) || [];
              siblingsHrefs = items.map((it) => it && it.href).filter(Boolean);
            } catch {}
          } else if (label === "Title") {
            val = extractTitle(el);
          } else if (label === "Date") {
            val = extractDate(el);
          } else if (label === "Description") {
            val = extractDescription(el);
          } else {
            // Custom field: capture selector and value (default to element text)
            try {
              if (typeof makeSelector === "function")
                detailSelectors[label] = makeSelector(el);
            } catch {}
            val = el && el.textContent ? el.textContent.trim() : "";
          }
          // For any non-hyperlink field, ensure we persist the selector used
          if (label !== "Hyperlink") {
            try {
              if (typeof makeSelector === "function")
                detailSelectors[label] =
                  detailSelectors[label] || makeSelector(el);
            } catch {}
          }
          addToTable(col.trim(), val);
          saveState();
        };

        // Build a row object for a given element based on current columnMap
        const buildRowForElement = (el) => {
          const row = {};
          for (const [label, col] of Object.entries(columnMap)) {
            if (!col) continue;
            let val = "";
            if (label === "Hyperlink") {
              const a =
                el && el.matches && el.matches("a[href]")
                  ? el
                  : el && el.querySelector
                    ? el.querySelector("a[href]")
                    : el && el.closest
                      ? el.closest("a[href]")
                      : null;
              val = a ? toAbs(a) : toAbs(el);
            } else if (label === "Title") {
              val = extractTitle(el);
            } else if (label === "Date") {
              val = extractDate(el);
            } else if (label === "Description") {
              val = extractDescription(el);
            }
            row[col] = val;
          }
          return row;
        };

        // Extract all using siblings of the current hovered element's nearest anchor
        const extractAllUsingSiblings = () => {
          if (!Object.keys(columnMap).length) {
            // Ensure at least Hyperlink is included by default
            columnMap["Hyperlink"] = "Hyperlink";
          }
          // Try to resolve a stable base anchor first
          const resolveBaseAnchor = () => {
            try {
              if (baseAnchorSelector) {
                const el = document.querySelector(baseAnchorSelector);
                if (el) return el;
              }
            } catch {}
            try {
              if (baseAnchorHref) {
                const list = Array.from(document.querySelectorAll("a[href]"));
                const found = list.find((a) => toAbs(a) === baseAnchorHref);
                if (found) return found;
              }
            } catch {}
            return null;
          };
          const anchor =
            resolveBaseAnchor() ||
            (lastTarget && lastTarget.closest
              ? lastTarget.closest("a[href]")
              : null);
          const data = computeSiblingsFor(anchor);
          const items = (data && data.items) || [];
          if (!items.length) {
            alert("No siblings found. Hover a list item link and try again.");
          }
          // Reset table to multi-row mode for export
          extractState.columns = Array.from(new Set(Object.values(columnMap)));
          extractState.rows = [];
          siblingsHrefs = items.map((it) => it && it.href).filter(Boolean);
          saveState();
          for (const it of items) {
            try {
              // Use element map from computeSiblingsFor for better context
              let el =
                data && data.elMap && data.elMap[it.href]
                  ? data.elMap[it.href]
                  : null;
              if (!el) {
                if (data && data.container && it && it.href) {
                  const cands = Array.from(
                    data.container.querySelectorAll("a[href]"),
                  );
                  el = cands.find((a) => toAbs(a) === it.href) || null;
                }
              }
              if (!el) {
                const a = document.createElement("a");
                a.href = it.href;
                a.textContent = it.text || "";
                el = a;
              }
              const row = buildRowForElement(el);
              extractState.rows.push(row);
            } catch {}
          }
          renderTable();
          saveState();
        };

        // Extract details by loading each sibling URL and querying saved detailSelectors
        const extractAllDetails = async () => {
          try {
            if (!Object.keys(columnMap).length) {
              alert("Define at least one column using the context menu first.");
              return;
            }
            if (!siblingsHrefs || !siblingsHrefs.length) {
              // Try recomputing siblings from base anchor
              try {
                const anchor =
                  (baseAnchorSelector &&
                    document.querySelector(baseAnchorSelector)) ||
                  null;
                const data = computeSiblingsFor(anchor);
                const items = (data && data.items) || [];
                siblingsHrefs = items
                  .map((it) => it && it.href)
                  .filter(Boolean);
              } catch {}
            }
            if (!siblingsHrefs || !siblingsHrefs.length) {
              alert(
                "No siblings recorded. Choose Hyperlink first to capture siblings.",
              );
              return;
            }
            // Setup columns and reset rows
            extractState.columns = Array.from(
              new Set(Object.values(columnMap)),
            );
            extractState.rows = [];
            // Create hidden iframe for same-origin loads
            let frame = document.getElementById("__hli_frame__");
            if (!frame) {
              frame = document.createElement("iframe");
              frame.id = "__hli_frame__";
              frame.style.cssText =
                "position:fixed;left:-99999px;top:-99999px;width:800px;height:600px;opacity:0;pointer-events:none;";
              document.body.appendChild(frame);
            }
            const sameOrigin = (u) => {
              try {
                return new URL(u, location.href).origin === location.origin;
              } catch {
                return false;
              }
            };
            const waitLoad = (f) =>
              new Promise((resolve) => {
                const done = () => {
                  f.removeEventListener("load", done);
                  resolve();
                };
                f.addEventListener("load", done, { once: true });
              });
            for (const href of siblingsHrefs) {
              try {
                if (!sameOrigin(href)) {
                  // skip cross-origin due to SOP
                  const row = {};
                  for (const [label, col] of Object.entries(columnMap)) {
                    if (label === "Hyperlink") row[col] = href;
                    else row[col] = "";
                  }
                  extractState.rows.push(row);
                  continue;
                }
                frame.src = href;
                await waitLoad(frame);
                const doc = frame.contentDocument;
                const qText = (sel) => {
                  try {
                    const el = sel ? doc.querySelector(sel) : null;
                    return el ? (el.textContent || "").trim() : "";
                  } catch {
                    return "";
                  }
                };
                const qDate = (sel) => {
                  try {
                    const el = sel ? doc.querySelector(sel) : null;
                    if (!el) return "";
                    const t =
                      el.getAttribute && (el.getAttribute("datetime") || "");
                    if (t) return t.trim();
                    return (el.textContent || "").trim();
                  } catch {
                    return "";
                  }
                };
                const row = {};
                for (const [label, col] of Object.entries(columnMap)) {
                  if (label === "Hyperlink") {
                    row[col] = href;
                  } else if (label === "Title") {
                    const sel = detailSelectors["Title"] || "";
                    row[col] = qText(sel);
                  } else if (label === "Date") {
                    const sel = detailSelectors["Date"] || "time";
                    row[col] = qDate(sel);
                  } else if (label === "Description") {
                    const sel =
                      detailSelectors["Description"] ||
                      "article, main, .content, .entry-content";
                    row[col] = qText(sel).slice(0, 500);
                  } else {
                    const sel = detailSelectors[label] || "";
                    row[col] = qText(sel);
                  }
                }
                extractState.rows.push(row);
                renderTable();
              } catch {}
            }
            saveState();
          } catch {}
        };

        // Parent-tree heuristic to find sibling link items
        const computeSiblingsFor = (anchor) => {
          const results = [];
          if (!anchor) return { items: results, container: null };
          const sigOf = (el) =>
            el ? el.tagName + "|" + (el.className || "") : "";
          let node = anchor;
          let best = null;
          const makeItem = (lnk) => ({
            href: toAbs(lnk),
            text: (lnk && (lnk.textContent || "")).trim(),
          });
          while (node && node !== document.body) {
            const p = node.parentElement;
            if (!p) break;
            const sig = sigOf(node);
            const group = Array.from(p.children).filter(
              (ch) => sigOf(ch) === sig,
            );
            const items = [];
            const elMap = Object.create(null);
            for (const it of group) {
              const l = it.querySelector ? it.querySelector("a[href]") : null;
              if (l) {
                const obj = makeItem(l);
                items.push(obj);
                try {
                  elMap[obj.href] = it;
                } catch {}
              }
            }
            const seen = new Set();
            const ded = [];
            const elMapDed = Object.create(null);
            for (const it of items) {
              if (it.href && !seen.has(it.href)) {
                seen.add(it.href);
                ded.push(it);
                try {
                  elMapDed[it.href] = elMap[it.href];
                } catch {}
              }
            }
            if (ded.length >= 2) {
              if (!best || ded.length > best.items.length)
                best = { container: node, items: ded, elMap: elMapDed };
            }
            node = p;
          }
          return (
            best || { items: [], container: null, elMap: Object.create(null) }
          );
        };

        const renderSiblings = (data, currentHref) => {
          list.innerHTML = "";
          const { items } = data || { items: [] };
          const hdr = document.createElement("div");
          hdr.style.cssText = "opacity:0.8;margin-bottom:4px;";
          hdr.textContent = items.length
            ? `Siblings found: ${items.length}`
            : "No siblings detected";
          list.appendChild(hdr);
          if (!items.length) return;
          for (const it of items) {
            const row = document.createElement("div");
            row.style.cssText = "margin:4px 0;";
            const a = document.createElement("a");
            a.href = it.href;
            a.target = "_blank";
            a.textContent = it.text || it.href;
            a.style.cssText = "color:#9bd1ff;text-decoration:underline;";
            if (currentHref && it.href === currentHref) {
              const mark = document.createElement("span");
              mark.textContent = "  (this)";
              mark.style.cssText = "color:#ffd27a;";
              row.appendChild(a);
              row.appendChild(mark);
            } else {
              row.appendChild(a);
            }
            list.appendChild(row);
          }
        };

        // After copying, compute and render siblings for the hovered anchor
        btn.addEventListener("click", (e) => {
          const target =
            lastTarget && lastTarget.closest
              ? lastTarget.closest("a[href]")
              : null;
          const data = computeSiblingsFor(target);
          const currentHref = target ? toAbs(target) : "";
          finladata = data;
          // browser.close();
          // renderSiblings(data, currentHref);
        });

        const place = (rect) => {
          const margin = 8;
          let top = window.scrollY + rect.top;
          let left = window.scrollX + rect.right + margin;
          const vw = window.innerWidth,
            vh = window.innerHeight;
          popup.style.display = "block";
          popup.style.visibility = "hidden";
          popup.style.left = left + "px";
          popup.style.top = top + "px";
          const pr = popup.getBoundingClientRect();
          if (pr.right > vw)
            left = window.scrollX + rect.left - margin - pr.width;
          if (pr.bottom > vh) top = window.scrollY + rect.bottom - pr.height;
          popup.style.left = Math.max(window.scrollX, left) + "px";
          popup.style.top = Math.max(window.scrollY, top) + "px";
          popup.style.visibility = "visible";
        };
        const showFor = (a) => {
          if (!a) return;
          lastTarget = a;
          let sel = makeSelector(a);
          let labelText = sel;
          try {
            if (a.tagName && a.tagName.toLowerCase() === "iframe") {
              let originOk = false;
              try {
                const src = a.getAttribute("src") || "";
                originOk =
                  !!src &&
                  new URL(src, document.location.href).origin ===
                    document.location.origin;
              } catch {}
              labelText = originOk
                ? sel
                : "Cross-origin iframe — open link in a new tab to map selectors";
            }
          } catch {}
          popup.setAttribute("data-selector", sel);
          label.textContent = labelText;
          const r = a.getBoundingClientRect();
          place(r);
          highlight.style.display = "block";
          highlight.style.left = window.scrollX + r.left - 2 + "px";
          highlight.style.top = window.scrollY + r.top - 2 + "px";
          highlight.style.width = r.width + 4 + "px";
          highlight.style.height = r.height + 4 + "px";
        };
        const hide = () => {
          popup.style.display = "none";
          highlight.style.display = "none";
          lastTarget = null;
        };
        document.addEventListener(
          "mouseover",
          (e) => {
            const target = e.target;
            const inPopup = !!(
              target &&
              (target === popup ||
                (popup.contains && popup.contains(target)) ||
                (typeof ctxMenu !== "undefined" &&
                  ctxMenu &&
                  (target === ctxMenu ||
                    (ctxMenu.contains && ctxMenu.contains(target)))))
            );
            if (inPopup) {
              // keep popup visible while interacting with it
              return;
            }
            try {
              if (
                target &&
                target.tagName &&
                target.tagName.toLowerCase() === "iframe"
              ) {
                showIframeButton(target);
              } else {
                hideIframeButton();
              }
            } catch {}
            const el = target && target.nodeType === 1 ? target : null;
            if (el) {
              showFor(el);
            } else {
              hide();
            }
          },
          true,
        );
        document.addEventListener(
          "scroll",
          () => {
            if (lastTarget) showFor(lastTarget);
          },
          true,
        );
        window.addEventListener("resize", () => {
          if (lastTarget) showFor(lastTarget);
        });
        try {
          ensureTablePanel();
        } catch {}
      }, sessionId);
    };
    page.on("domcontentloaded", () => installInspector().catch(() => {}));
    page.on("frameattached", (f) => {
      try {
        installInspector(f).catch(() => {});
      } catch {}
    });
    page.on("framenavigated", (f) => {
      try {
        installInspector(f).catch(() => {});
      } catch {}
    });
    await installInspector();
    // return res.json({ success: true, siblings: finladata });
    return res.json({
      success: true,
      sessionId,
      message: "Browser opened. Hover over links to see selector popup.",
    });
  } catch (e) {
    try {
      if (browser) await browser.close();
    } catch {}
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Fetch latest siblings result for a session
app.get("/hover-link-inspector/result", (req, res) => {
  const sessionId = (req.query.sessionId || "").toString();
  if (!sessionId)
    return res
      .status(400)
      .json({ success: false, error: "Provide ?sessionId=" });
  const data = HoverSessions.get(sessionId) || null;
  return res.json({ success: true, sessionId, data });
});

// Receive overlay payloads from embedded inspector / PIE
// Body: { sessionId, payload: { selector, currentHref, siblings, pageUrl } }
app.post("/hover-link-inspector/report", (req, res) => {
  try {
    const { sessionId, payload } = req.body || {};
    if (!sessionId || !payload || typeof payload !== "object") {
      return res
        .status(400)
        .json({ success: false, error: "Missing sessionId or payload" });
    }
    HoverSessions.set(sessionId, payload);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Serve overlay script so Electron/PIE can inject the same behavior
// GET /hover-link-inspector/embed.js?sessionId=...
app.get("/hover-link-inspector/embed.js", (req, res) => {
  const sid =
    (req.query.sessionId || req.query.sid || "").toString() ||
    Math.random().toString(36).slice(2);
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  const css = [
    ".rd-hi { outline: 2px solid #00bcd4 !important; outline-offset: 2px; cursor: crosshair !important; }",
    ".rd-float { position: fixed; z-index: 2147483647; background: #111; color: #fff; padding: 6px 10px; border-radius: 6px; font: 12px/1.2 -apple-system,Segoe UI,Roboto,Arial; box-shadow: 0 2px 8px rgba(0,0,0,.35); }",
    ".rd-btn { margin-left: 8px; background: #1976d2; color: #fff; border: 0; border-radius: 4px; padding: 4px 8px; cursor: pointer; }",
  ].join("\n");
  const body = `(() => {
    const sessionId = ${JSON.stringify(sid)};
    try {
      const styleId = 'rd-inspector-style';
      if (!document.getElementById(styleId)) { const st = document.createElement('style'); st.id = styleId; st.textContent = ${JSON.stringify(css)}; document.head.appendChild(st); }
      let currentEl = null;
      let float = document.getElementById('rd-float');
      if (!float) {
        float = document.createElement('div'); float.id = 'rd-float'; float.className = 'rd-float'; float.style.display='none';
        const label = document.createElement('span'); label.id = 'rd-label';
        const btn = document.createElement('button'); btn.className = 'rd-btn'; btn.textContent = 'Copy Selector';
        btn.addEventListener('click', async (e) => {
          e.preventDefault(); e.stopPropagation();
          const a = currentEl && currentEl.closest ? currentEl.closest('a[href]') : null; if (!a) return;
          const sel = makeSelector(a); const payload = collectSiblings(a, sel);
          try { if (window.reportSiblings) window.reportSiblings({ sessionId, payload }); } catch {}
          try { if (navigator.clipboard) await navigator.clipboard.writeText(sel); } catch {}
        });
        float.appendChild(label); float.appendChild(btn); document.body.appendChild(float);
      }
      const label = document.getElementById('rd-label');
      const moveFloat = (x,y)=>{ const pad=8; float.style.left=Math.max(8,Math.min(x+pad, window.innerWidth-200))+'px'; float.style.top=Math.max(8,Math.min(y+pad, window.innerHeight-60))+'px'; };
      let lastReport=0;
      const onMove = (e) => {
        const el = e.target && (e.target.closest ? e.target.closest('a,button,[role="link"],img,div,span') : e.target);
        if (el !== currentEl) { if (currentEl) currentEl.classList.remove('rd-hi'); currentEl = el; if (currentEl && currentEl.classList) currentEl.classList.add('rd-hi'); }
        const a = currentEl && currentEl.closest ? currentEl.closest('a[href]') : null;
        if (label) label.textContent = describe(currentEl);
        float.style.display='block'; moveFloat(e.clientX,e.clientY);
        if (!a) return;
        const sel = makeSelector(a); const payload = collectSiblings(a, sel);
        const now = Date.now(); if (now - lastReport > 700) { lastReport = now; try { if (window.reportSiblings) window.reportSiblings({ sessionId, payload }); } catch {} }
      };
      const onOut = () => { if (float) float.style.display='none'; if (currentEl) currentEl.classList.remove('rd-hi'); currentEl=null; };
      window.addEventListener('mousemove', onMove, true); window.addEventListener('mouseout', onOut, true);

      function describe(el){ if(!el) return 'None'; const t=(el.textContent||'').trim(); const tag=(el.tagName||'').toLowerCase(); const id=el.id?('#'+el.id):''; const cls=(el.classList&&el.classList.length)?('.'+Array.from(el.classList).slice(0,2).join('.')):''; return tag+id+cls+(t?(' '+t.slice(0,40)):''); }
      function cssEscape(s){ try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([ #;.:!+>~*\[\]\(\)\/=,])/g,'\\$1'); } catch { return String(s); } }
      function makeSelector(node){ if(!node || node.nodeType!==1) return ''; const parts=[]; while(node && node.nodeType===1 && node!==document.body && node!==document.documentElement){ let sel=node.nodeName.toLowerCase(); if(node.id){ parts.unshift(sel+'#'+cssEscape(node.id)); break; } const cls=Array.from(node.classList||[]); if(cls.length){ sel += '.'+cls.map(cssEscape).join('.'); } let nth=1, sib=node; while((sib=sib.previousElementSibling)){ if(sib.nodeName.toLowerCase()===node.nodeName.toLowerCase()) nth++; } if(nth>1) sel += ':nth-of-type('+nth+')'; parts.unshift(sel); node=node.parentElement; } return parts.join(' > '); }
      function toAbsHref(href){ try { return new URL(href, document.location.href).href; } catch { return null; } }
      function collectSiblings(el, selector){ const t=(e)=> (e ? (e.textContent||'').trim(): ''); let container=el.parentElement, depth=0; while(container && depth<8){ const links=container.querySelectorAll('a[href]'); if(links && links.length>=3) break; container=container.parentElement; depth++; } if(!container) container=document.body; const anchors=Array.from(container.querySelectorAll('a[href]')); const items=anchors.map(a=>({ href: toAbsHref(a.getAttribute('href')), text: t(a) })).filter(it=>!!it.href); return { selector, currentHref: (el.getAttribute('href') ? toAbsHref(el.getAttribute('href')) : (el.href||'')), pageUrl: location.href, siblings: items }; }
    } catch (e) { console.warn('overlay injection failed', e); }
  })();`;
  res.end(body);
});

// Full-featured overlay (context menu + Add Field + table preview)
app.get("/hover-link-inspector/embed-full.js", (req, res) => {
  const sid =
    (req.query.sessionId || req.query.sid || "").toString() ||
    Math.random().toString(36).slice(2);
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  const css = [
    ".rd-hi{outline:2px solid #4a90e2!important;outline-offset:1px;cursor:crosshair!important}",
    "#__hover_context_menu__{position:absolute;z-index:2147483648;background:rgba(20,20,20,.98);color:#fff;font:12px/1.4 -apple-system,Segoe UI,Roboto,Arial;padding:8px 10px;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.35);min-width:320px;max-width:520px;display:none;pointer-events:auto;user-select:text}",
    "#__hover_context_menu__ button{background:#2d2d2d;border:1px solid rgba(255,255,255,0.15);color:#fff;padding:6px 10px;border-radius:4px;cursor:pointer;margin:4px 6px 4px 0}",
    "#__hli_table__{position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111;color:#fff;font:12px/1.2 -apple-system,Segoe UI,Roboto,Arial;border:1px solid rgba(255,255,255,0.15);border-radius:6px;max-width:50vw;max-height:50vh;overflow:auto;padding:8px}",
  ].join("\n");
  const body = `(() => {
    const sessionId = ${JSON.stringify(sid)};
    try {
      const styleId = 'rd-inspector-style';
      if (!document.getElementById(styleId)) { const st = document.createElement('style'); st.id = styleId; st.textContent = ${JSON.stringify(css)}; document.head.appendChild(st); }
      const cssEscape = (s)=>{ try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([ #;.:!+>~*\\[\\]\\(\\)\\/=,])/g,'\\\\$1'); } catch { return String(s) } };
      const toAbs = (el)=>{ try { const href=(el && el.getAttribute && el.getAttribute('href')) || (el && el.href) || ''; return new URL(href, document.location.href).href; } catch { return '' } };
      const makeSel = (el)=>{ if(!el||el.nodeType!==1) return ''; const parts=[]; let n=el; while(n&&n.nodeType===1&&n!==document.body&&n!==document.documentElement){ let s=n.nodeName.toLowerCase(); if(n.id){ parts.unshift(s+'#'+cssEscape(n.id)); break;} const cls=Array.from(n.classList||[]); if(cls.length) s+='.'+cls.map(cssEscape).join('.'); let nth=1, sib=n; while((sib=sib.previousElementSibling)) if(sib.nodeName.toLowerCase()===n.nodeName.toLowerCase()) nth++; if(nth>1) s+=(':nth-of-type('+nth+')'); parts.unshift(s); n=n.parentElement; } return parts.join(' > ') };
      const computeSiblingsFor = (anchor)=>{ const results=[]; if(!anchor) return { items: results, container: null }; const sigOf=(el)=>(el?(el.tagName+'|'+(el.className||'')):''); let node=anchor; let best=null; const makeItem=(lnk)=>({ href: toAbs(lnk), text: (lnk && (lnk.textContent||'')).trim() }); while(node && node!==document.body){ const p=node.parentElement; if(!p) break; const sig=sigOf(node); const group=Array.from(p.children).filter(ch=>sigOf(ch)===sig); const items=[]; const elMap=Object.create(null); for(const it of group){ const l=it.querySelector?it.querySelector('a[href]'):null; if(l){ const obj=makeItem(l); items.push(obj); try { elMap[obj.href]=it; } catch {} } } const seen=new Set(); const ded=[]; const elMapDed=Object.create(null); for(const it of items){ if(it.href && !seen.has(it.href)){ seen.add(it.href); ded.push(it); try { elMapDed[it.href]=elMap[it.href]; } catch {} } } if(ded.length>=2){ if(!best || ded.length>(best.items?best.items.length:0)) best={ container: node, items: ded, elMap: elMapDed }; } node=p; } return best || { items: [], container: null, elMap: Object.create(null) }; };
      // floating table preview
      function ensureTable(){ let wrap=document.getElementById('__hli_table__'); if(!wrap){ wrap=document.createElement('div'); wrap.id='__hli_table__'; document.body.appendChild(wrap); } return wrap; }
      function renderTable(state){ const el=ensureTable(); try { const cols=Array.isArray(state.columns)?state.columns:[]; const rows=Array.isArray(state.rows)?state.rows:[]; let html='<div style="margin-bottom:6px;opacity:.8">Preview ('+rows.length+' rows)</div>'; if(!cols.length){ html+='<div style="opacity:.6">No columns yet</div>'; } else { html+='<table style="border-collapse:collapse;width:100%">'; html+='<tr>'+cols.map(c=>'<th style="text-align:left;border-bottom:1px solid rgba(255,255,255,.15);padding:4px 6px">'+c+'</th>').join('')+'</tr>'; rows.forEach(r=>{ html+='<tr>'+cols.map(c=>'<td style="border-bottom:1px solid rgba(255,255,255,.08);padding:4px 6px">'+(r[c]||'')+'</td>').join('')+'</tr>'; }); html+='</table>'; } el.innerHTML=html; } catch { el.textContent=''; } }
      function loadState(){ try { return JSON.parse(localStorage.getItem('__hli_state__')||'{}')||{} } catch { return {} } }
      function saveState(st){ try { localStorage.setItem('__hli_state__', JSON.stringify(st||{})) } catch {} }

      let currentEl=null; let lastReport=0; let hovered=null; let extractState={ columns: [], rows: [] };
      // hover highlight + reporter
      const onMove=(e)=>{ const el=e.target && (e.target.closest? e.target.closest('a,button,[role="link"],img,div,span') : e.target); if(el!==currentEl){ try { currentEl && currentEl.classList && currentEl.classList.remove('rd-hi'); } catch{}; currentEl=el; try { currentEl && currentEl.classList && currentEl.classList.add('rd-hi'); } catch{} } hovered = el || hovered; const a = currentEl && currentEl.closest ? currentEl.closest('a[href]') : null; if(!a) return; const sel = makeSel(a); const payload = collectSiblings(a, sel); const now=Date.now(); if(now-lastReport>700){ lastReport=now; try { if(window.reportSiblings) window.reportSiblings({ sessionId, payload }); } catch{} } };
      const onOut=()=>{ try { currentEl && currentEl.classList && currentEl.classList.remove('rd-hi'); } catch{}; currentEl=null; };
      window.addEventListener('mousemove', onMove, true); window.addEventListener('mouseout', onOut, true);

      // context menu + add field
      const menu=document.getElementById('__hover_context_menu__') || (function(){ const m=document.createElement('div'); m.id='__hover_context_menu__'; m.style.cssText='position:absolute;z-index:2147483648;background:rgba(20,20,20,.98);color:#fff;font:12px/1.4 -apple-system,Segoe UI,Roboto,Arial;padding:8px 10px;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.35);min-width:320px;max-width:520px;display:none;pointer-events:auto;user-select:text'; document.body.appendChild(m); return m; })();
      const rowWrap=document.createElement('div'); rowWrap.style.cssText='display:flex;flex-wrap:wrap;align-items:center'; menu.appendChild(rowWrap);
      const addWrap=document.createElement('div'); addWrap.style.cssText='margin-top:6px; display:flex; gap:6px; align-items:center;';
      const inp=document.createElement('input'); inp.type='text'; inp.placeholder='New field label'; inp.style.cssText='background:#111;border:1px solid rgba(255,255,255,0.2);color:#fff;padding:6px 8px;border-radius:4px;flex:1 1 auto;min-width:120px';
      const addBtn=document.createElement('button'); addBtn.textContent='Add Field'; addBtn.style.cssText='background:#5c6bc0;border:0;color:#fff;padding:6px 10px;border-radius:4px;cursor:pointer;flex:0 0 auto';
      addWrap.appendChild(inp); addWrap.appendChild(addBtn); menu.appendChild(addWrap);
      const defaultFields=['Hyperlink','Title','Date','Description'];
      function renderMenu(){ const st=loadState(); const customs=Array.isArray(st.customFields)?st.customFields:[]; const seen={}; const list=[]; defaultFields.concat(customs).forEach(f=>{ if(!seen[f]){ seen[f]=1; list.push(f); } }); rowWrap.innerHTML=''; list.forEach(f=>{ const b=document.createElement('button'); b.textContent=f; b.addEventListener('click', (ev)=>{ try { ev.stopPropagation(); } catch{} handleMenuClick(f); hideMenu(); }); rowWrap.appendChild(b); }); }
      function showMenu(x,y){ renderMenu(); menu.style.left=x+'px'; menu.style.top=y+'px'; menu.style.display='block'; }
      function hideMenu(){ menu.style.display='none'; }
      addBtn.addEventListener('click', ()=>{ const v=(inp.value||'').trim(); if(!v) return; const st=loadState(); st.customFields=Array.isArray(st.customFields)?st.customFields:[]; if(st.customFields.indexOf(v)<0 && defaultFields.indexOf(v)<0) st.customFields.push(v); saveState(st); inp.value=''; renderMenu(); });
      window.addEventListener('click', hideMenu, true);
      window.addEventListener('contextmenu', (e)=>{ try { e.preventDefault(); e.stopPropagation(); } catch{}; const x=e.clientX||0, y=e.clientY||0; showMenu(x,y); }, true);

      function handleMenuClick(label){ try {
        const target = (hovered && hovered.closest) ? (hovered.closest('a[href],iframe,*') || hovered) : hovered;
        const sel = makeSel(target);
        const st = loadState(); st.detailSelectors=st.detailSelectors||{}; st.columnMap=st.columnMap||{}; st.detailSelectors[label]=sel; if(!st.columnMap[label]) st.columnMap[label]=label; saveState(st);
        // recompute siblings and preview rows
        const anchor = target && (target.matches && target.matches('a[href]') ? target : (target.closest?target.closest('a[href]'):null));
        const sib = computeSiblingsFor(anchor); const items = (sib && sib.items) || [];
        const cols = Array.from(new Set(Object.values(st.columnMap||{})));
        const rows = items.map(it => { const r={}; for(const [lab,col] of Object.entries(st.columnMap||{})){ if(lab==='Hyperlink') r[col]=it.href; else if(lab==='Title') r[col]=(target && (target.textContent||'')).trim(); else r[col]=''; } return r; });
        extractState.columns = cols; extractState.rows = rows; renderTable(extractState);
        try { window.reportSiblings && window.reportSiblings({ sessionId, payload: { selector: sel, currentHref: anchor?toAbs(anchor):'', siblings: items, pageUrl: location.href } }); } catch{}
      } catch{} }
    } catch (e) { console.warn('overlay-full injection failed', e); }
  })();`;
  res.end(body);
});

app.listen(3000, "0.0.0.0", () => console.log("Server running on :3000"));
