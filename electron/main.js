const { app, BrowserWindow, BrowserView, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const pie = require("puppeteer-in-electron");
const puppeteer = require("puppeteer-core");
const puppeteer1 = require("puppeteer");
const http = require("http");
const { session } = require("electron");
const express = require("express");
const expressApp = express();
const HoverSessions = new Map();
const axios = require("axios");
const synonymsLib = require("synonyms");
const inspectorSessions = new Map(); // sessionId -> { page, window, lastState }
// Start Express/Playwright server inside the Electron main process
let serverStarted = false;
expressApp.use(express.json());
const cors = require("cors");
const { json } = require("stream/consumers");
expressApp.use(cors());
function startServer() {
  if (serverStarted) return;
  serverStarted = true;
  try {
    // Requiring the file runs app.listen in server.js
    const serverPath = path.resolve(__dirname, "..", "server.js");
    require(serverPath);
  } catch (err) {
    console.error("Failed to start embedded server:", err);
  }
}

app.commandLine.appendSwitch("remote-debugging-port", "9222");

async function initializePie() {
  try {
    await pie.initialize(app);
  } catch (err) {
    console.error(
      "puppeteer-in-electron initialize failed (continuing):",
      err && err.message,
    );
  }
}

let mainWindow;
let clientWindow;
// Optional embedded view + resize support (safe if not used)
let inspectorView = null;
let inspectorHeight = 440;

const relayExtractStateToRenderer = (sessionId, state, opts = {}) => {
  try {
    const entry = inspectorSessions.get(sessionId) || {};
    if (opts.page) entry.page = opts.page;
    if (opts.window) entry.window = opts.window;

    const incomingGuid = state && state.__hliFrameGuid;
    const incomingHasData = !!(
      state &&
      Array.isArray(state.columns) &&
      state.columns.length
    );
    const existingHasData = !!(
      entry.lastState &&
      Array.isArray(entry.lastState.columns) &&
      entry.lastState.columns.length
    );

    if (
      entry.frameGuid &&
      incomingGuid &&
      entry.frameGuid !== incomingGuid &&
      existingHasData &&
      !incomingHasData
    ) {
      return;
    }

    if (incomingGuid && (incomingHasData || !entry.frameGuid)) {
      entry.frameGuid = incomingGuid;
    }

    entry.lastState = state;
    inspectorSessions.set(sessionId, entry);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("extract-state-updated", {
        sessionId,
        state,
      });
    }
  } catch (err) {
    console.error("Failed to relay extract state", err);
  }
};

const upsertInspectorSession = (sessionId, data = {}) => {
  const existing = inspectorSessions.get(sessionId) || {
    page: null,
    window: null,
    lastState: null,
  };
  const next = { ...existing, ...data };
  inspectorSessions.set(sessionId, next);
  return next;
};

function attachInspectorResizeHandlers() {
  if (!mainWindow) return;
  const updateBounds = () => {
    if (!mainWindow || !inspectorView) return;
    try {
      const bounds = mainWindow.getContentBounds();
      const topHeight = Math.max(0, bounds.height - inspectorHeight);
      inspectorView.setBounds({
        x: 0,
        y: topHeight,
        width: bounds.width,
        height: Math.max(100, Math.min(inspectorHeight, bounds.height)),
      });
    } catch {}
  };
  mainWindow.on("resize", updateBounds);
  mainWindow.on("maximize", updateBounds);
  mainWindow.on("unmaximize", updateBounds);
}

// Defer any session usage until after app is ready

// Handle the authentication logic [cite: 5, 7]
app.on("login", (event, webContents, request, authInfo, callback) => {
  event.preventDefault();
  callback("lnobit", "lLh4~t0LxQVac1anl8"); // Use credentials from your file
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    webPreferences: {
      webSecurity: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      preload: path.join(__dirname, "preload.js"),
    },
    show: false,
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  attachInspectorResizeHandlers();

  if (!app.isPackaged) {
    // Development: expect Angular dev server on 4200
    const devUrl = "http://localhost:4200";
    mainWindow
      .loadURL(devUrl)
      .catch((e) => console.error("Failed to load dev URL", e));
  } else {
    // Production: load built Angular index.html from dist
    const indexHtmlCandidates = [
      path.join(__dirname, "..", "dist", "angular-hello-world", "index.html"),
      // In some pack configs, resources/app is the base. __dirname inside asar should still resolve, but keep a fallback:
      path.join(
        process.resourcesPath || "",
        "app",
        "dist",
        "angular-hello-world",
        "index.html",
      ),
    ];
    const indexPath = indexHtmlCandidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (indexPath) {
      mainWindow
        .loadFile(indexPath)
        .catch((e) => console.error("Failed to load file", indexPath, e));
    } else {
      console.error("index.html not found in dist/angular-hello-world");
    }
  }
}

app
  .whenReady()
  .then(async () => {
    // Initialize PIE only after app is ready
    await initializePie();

    // Apply proxy after app is ready
    try {
      const { session } = require("electron");
      await session.defaultSession.setProxy({
        proxyRules: "http://dc.decodo.com:10000",
      });
    } catch (e) {
      console.error("Failed to set proxy on defaultSession:", e && e.message);
    }

    // startServer();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  })
  .catch((err) => {
    console.error("app.whenReady chain failed:", (err && err.stack) || err);
  });

process.on("unhandledRejection", (reason) => {
  try {
    console.error(
      "Unhandled promise rejection:",
      reason && (reason.stack || reason),
    );
  } catch {}
});

// --- PIE control over main window ---
ipcMain.handle("pie:open", async (_evt, { url, sessionId }) => {
  try {
    const browser = await pie.connect(app, puppeteer);
    const page = await pie.getPage(browser, mainWindow);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Bridge: receive overlay reports and forward to local server
    await page.exposeFunction(
      "reportSiblings",
      (payload) =>
        new Promise((resolve) => {
          try {
            const body = Buffer.from(
              JSON.stringify({ sessionId, payload }),
              "utf8",
            );
            const req = http.request(
              {
                method: "POST",
                hostname: "127.0.0.1",
                port: 3000,
                path: "/hover-link-inspector/report",
                headers: {
                  "Content-Type": "application/json",
                  "Content-Length": body.length,
                },
              },
              (res) => {
                res.resume();
                res.on("end", () => resolve(true));
              },
            );
            req.on("error", () => resolve(false));
            req.end(body);
          } catch {
            resolve(false);
          }
        }),
    );

    // Inject hover inspector overlay and sibling reporting
    const cssText = [
      ".rd-hi { outline: 2px solid #00bcd4 !important; outline-offset: 2px; cursor: crosshair !important; }",
      ".rd-float { position: fixed; z-index: 2147483647; background: #111; color: #fff; padding: 6px 10px; border-radius: 6px; font: 12px/1.2 -apple-system,Segoe UI,Roboto,Arial; box-shadow: 0 2px 8px rgba(0,0,0,.35); }",
      ".rd-btn { margin-left: 8px; background: #1976d2; color: #fff; border: 0; border-radius: 4px; padding: 4px 8px; cursor: pointer; }",
    ].join("\n");

    const overlayScript = `(() => {
      try {
        const frameGuid = (() => {
          try { if (window.__hliFrameGuid) return window.__hliFrameGuid; } catch {}
          const id = 'hli_' + Math.random().toString(36).slice(2);
          try { window.__hliFrameGuid = id; } catch {}
          return id;
        })();
        const styleId = 'rd-inspector-style';
        if (!document.getElementById(styleId)) {
          const st = document.createElement('style'); st.id = styleId; st.textContent = ${JSON.stringify(cssText)}; document.head.appendChild(st);
        }
        let currentEl = null;
        let float = document.getElementById('rd-float');
        if (!float) {
          float = document.createElement('div'); float.id = 'rd-float'; float.className = 'rd-float'; float.style.display = 'none';
          const label = document.createElement('span'); label.id = 'rd-label';
          const btn = document.createElement('button'); btn.className = 'rd-btn'; btn.textContent = 'Copy Selector';
          btn.addEventListener('click', async (e) => {
            e.preventDefault(); e.stopPropagation();
            const a = currentEl && currentEl.closest ? currentEl.closest('a[href]') : null; if (!a) return;
            const sel = makeSelector(a); const payload = collectSiblings(a, sel);
            try { await window.reportSiblings && window.reportSiblings(payload); } catch {}
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
          if (label) label.textContent = describe(currentEl);
          float.style.display = 'block'; moveFloat(e.clientX, e.clientY);
          const a = currentEl && currentEl.closest ? currentEl.closest('a[href]') : null; if (!a) return;
          const sel = makeSelector(a); const payload = collectSiblings(a, sel);
          const now = Date.now(); if (now - lastReport > 700) { lastReport = now; try { window.reportSiblings && window.reportSiblings(payload); } catch {} }
        };
        float.style.display = 'none';
        const onOut = () => { if (float) float.style.display='none'; if (currentEl) currentEl.classList.remove('rd-hi'); currentEl = null; };
        window.addEventListener('mousemove', onMove, true); window.addEventListener('mouseout', onOut, true);

        function describe(el){ if(!el) return 'None'; const t=(el.textContent||'').trim(); const tag=(el.tagName||'').toLowerCase(); const id=el.id?('#'+el.id):''; const cls=(el.classList&&el.classList.length)?('.'+Array.from(el.classList).slice(0,2).join('.')):''; return tag+id+cls+(t?(' '+t.slice(0,40)):''); }
        function cssEscape(s){ try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([ #;.:!+>~*\[\]\(\)\/=,])/g,'\\$1'); } catch { return String(s); } }
        function makeSelector(node){ if(!node || node.nodeType!==1) return ''; const parts=[]; while(node && node.nodeType===1 && node!==document.body && node!==document.documentElement){ let sel=node.nodeName.toLowerCase(); if(node.id){ parts.unshift(sel+'#'+cssEscape(node.id)); break; } const cls=Array.from(node.classList||[]); if(cls.length){ sel += '.'+cls.map(cssEscape).join('.'); } let nth=1, sib=node; while((sib=sib.previousElementSibling)){ if(sib.nodeName.toLowerCase()===node.nodeName.toLowerCase()) nth++; } if(nth>1) sel += ':nth-of-type('+nth+')'; parts.unshift(sel); node=node.parentElement; } return parts.join(' > '); }
        function toAbsHref(href){ try { return new URL(href, document.location.href).href; } catch { return null; } }
        function collectSiblings(el, selector){ const t=(e)=> (e ? (e.textContent||'').trim(): ''); let container=el.parentElement, depth=0; while(container && depth<8){ const links=container.querySelectorAll('a[href]'); if(links && links.length>=3) break; container=container.parentElement; depth++; } if(!container) container=document.body; const anchors=Array.from(container.querySelectorAll('a[href]')); const items=anchors.map(a=>({ href: toAbsHref(a.getAttribute('href')), text: t(a) })).filter(it=>!!it.href); return { selector, currentHref: (el.getAttribute('href') ? toAbsHref(el.getAttribute('href')) : (el.href||'')), pageUrl: location.href, siblings: items }; }
      } catch (e) { console.warn('overlay injection failed', e); }
    })();`;

    try {
      await page.evaluate(overlayScript);
    } catch (e) {
      console.error("PIE overlay evaluate failed:", e && e.message);
    }
    return true;
  } catch (e) {
    console.error("pie:open failed:", e && e.message);
    return false;
  }
});

ipcMain.handle("pie:home", async () => {
  try {
    if (!mainWindow) return false;
    if (!app.isPackaged) {
      const devUrl = "http://localhost:4200";
      await mainWindow.loadURL(devUrl);
    } else {
      const indexPath = path.join(
        __dirname,
        "..",
        "dist",
        "angular-hello-world",
        "index.html",
      );
      await mainWindow.loadFile(indexPath);
    }
    return true;
  } catch (e) {
    console.error("pie:home failed:", e && e.message);
    return false;
  }
});

// Bridge the scraping logic to the Webview
ipcMain.handle("attach-inspector", async (event, sessionId) => {
  const browser = await pie.connect(app, puppeteer);
  const window = BrowserWindow.getAllWindows()[0]; // Or target your specific window
  const page = await pie.getPage(browser, window);

  // Use the exact bridge from your document [cite: 5]
  await page.exposeFunction("reportSiblings", (payload) => {
    event.sender.send("siblings-reported", payload);
  });

  // Inject the inspector logic exactly as in your source
  await page.evaluate((sid) => {}, sessionId);

  return { success: true };
});

ipcMain.handle("extractor:action", async (_event, args = {}) => {
  const { sessionId, action, payload } = args || {};
  if (!sessionId || !action) {
    return { success: false, error: "Missing sessionId or action" };
  }
  const session = inspectorSessions.get(sessionId);
  if (!session || !session.page) {
    return { success: false, error: "Inspector session not ready" };
  }
  const frames =
    typeof session.page.frames === "function"
      ? session.page.frames()
      : [session.page.mainFrame ? session.page.mainFrame() : null];
  const preferredGuid = session.frameGuid || null;
  const lastState =
    session.lastState && typeof session.lastState === "object"
      ? session.lastState
      : null;

  const hydrateFrameState = async (frame) => {
    if (!frame || !lastState) return;
    try {
      await frame.evaluate((state) => {
        try {
          if (
            window.__hliBridge &&
            typeof window.__hliBridge.loadState === "function"
          ) {
            window.__hliBridge.loadState(state);
          }
        } catch (err) {
          console.error("loadState hydration failed", err);
        }
      }, lastState);
    } catch {}
  };

  const frameInfos = await Promise.all(
    frames.map(async (frame) => {
      if (!frame) return null;
      try {
        const info = await frame.evaluate(() => {
          try {
            const bridge = window.__hliBridge;
            if (!bridge || typeof bridge.getState !== "function") return null;
            const state = bridge.getState();
            const guid = window.__hliFrameGuid || null;
            const hasColumns = !!(
              state &&
              ((state.columnBindings &&
                Object.keys(state.columnBindings).length) ||
                (Array.isArray(state.columns) && state.columns.length) ||
                (state.columnMap && Object.keys(state.columnMap).length))
            );
            return { guid, hasColumns };
          } catch {
            return null;
          }
        });
        return info
          ? { frame, guid: info.guid, hasColumns: info.hasColumns }
          : null;
      } catch {
        return null;
      }
    }),
  );

  const candidates = [];
  const pushCandidate = (frame) => {
    if (!frame) return;
    if (!candidates.includes(frame)) candidates.push(frame);
  };
  if (preferredGuid) {
    frameInfos.forEach((info) => {
      if (info && info.guid === preferredGuid) pushCandidate(info.frame);
    });
  }
  frameInfos.forEach((info) => {
    if (info && info.hasColumns) pushCandidate(info.frame);
  });
  frames.forEach((frame) => pushCandidate(frame));

  let invoked = false;
  let actionFrame = null;
  for (const frame of candidates) {
    if (!frame) continue;
    await hydrateFrameState(frame);
    try {
      const hit = await frame.evaluate(
        (act, data) => {
          try {
            if (
              window.__hliBridge &&
              typeof window.__hliBridge.trigger === "function"
            ) {
              window.__hliBridge.trigger(act, data || {});
              return true;
            }
          } catch (err) {
            console.error("extract bridge trigger failed", err);
          }
          return false;
        },
        action,
        payload || {},
      );
      if (hit) {
        invoked = true;
        actionFrame = frame;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!invoked) {
    return {
      success: false,
      error: "Inspector UI not ready yet. Try again in a moment.",
    };
  }
  if (actionFrame) {
    try {
      const snapshot = await actionFrame.evaluate(() => {
        try {
          if (
            window.__hliBridge &&
            typeof window.__hliBridge.getState === "function"
          ) {
            return window.__hliBridge.getState();
          }
        } catch {}
        return null;
      });
      if (snapshot) {
        relayExtractStateToRenderer(sessionId, snapshot, {
          page: session.page,
          window: session.window,
        });
      }
    } catch (err) {
      console.warn(
        "Failed to capture extract state after action",
        err && err.message,
      );
    }
  }
  return { success: true };
});

ipcMain.handle("extractor:get-state", async (_event, args = {}) => {
  const { sessionId } = args || {};
  if (!sessionId) return null;
  const session = inspectorSessions.get(sessionId);
  return session && session.lastState ? session.lastState : null;
});

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

expressApp.get("/search", async (req, res) => {
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

  const PRIORITY_LINK_REGEX =
    /(contact|about|team|leadership|management|people|executive|board|company|who-we-are|our-story)/i;
  const DEFAULT_SCRAPER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
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

  const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

  async function scrapeFullCompanyData(
    url,
    keywords,
    requestedMaxDepth = null,
    options = {},
  ) {
    const browser = await puppeteer1.launch({
      headless: false, // Set to false if you want to watch the process
      args: ["--no-sandbox"],
      defaultViewport: null,
      protocolTimeout: 900000,
    });
    const page = await browser.newPage();
    await page.setUserAgent(DEFAULT_SCRAPER_UA);

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
    const keywordMatchBuckets = new Map(
      keywordConfigs.map((cfg) => [cfg.keyword, []]),
    );
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

        try {
          console.log(
            `[crawler] Loading Page (depth ${currentDepth}): ${current}`,
          );
          await page.goto(current, {
            waitUntil: "networkidle2",
            timeout: 30000,
          });
          await pause(5000); // pause to let dynamic content render before evaluation
        } catch (navErr) {
          console.warn(`Navigation failed for ${current}:`, navErr.message);
          continue;
        }
        const pageLanguage = await page.evaluate(() => {
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
        });
        const normalizedLang = (pageLanguage || "").trim().toLowerCase();
        const isEnglishPage =
          !normalizedLang || normalizedLang.startsWith("en");
        if (!isEnglishPage) {
          console.log(
            `[crawler] Skipping non-English page (lang=${
              normalizedLang || "unknown"
            }): ${current}`,
          );
          continue;
        }

        if (current === normalizedStart) {
          const homeInfo = await page.evaluate(() => {
            return {
              title: document.title,
              desc:
                document.querySelector('meta[name="description"]')?.content ||
                "",
            };
          });
          results.companyName = homeInfo.title;
          results.metaDescription = homeInfo.desc;

          if (!results.contactPageUrl) {
            try {
              const contactLink = await page.evaluate(() => {
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
              });
              if (contactLink) {
                const normalizedContact = normalizeUrl(contactLink, current);
                if (normalizedContact) {
                  results.contactPageUrl = normalizedContact;
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
              console.warn(
                "Contact page detection failed:",
                err && err.message,
              );
            }
          }
        }

        if (!results.extractedAddresses.length) {
          try {
            const extraction = await page.evaluate(() => {
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
            });

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
            }
          } catch (err) {
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
              remainingBudgetForKeyword !== null &&
              remainingBudgetForKeyword > 0
                ? remainingBudgetForKeyword
                : null;
            const pageMatches = await page.evaluate(
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
            );

            if (Array.isArray(pageMatches) && pageMatches.length) {
              const bucket = keywordMatchBuckets.get(config.keyword);
              if (!bucket) continue;
              for (const match of pageMatches) {
                if (matchLimit !== null && bucket.length >= matchLimit) {
                  break;
                }
                bucket.push({
                  ...match,
                  pageUrl: current,
                });
              }
            }
          }
        } catch (err) {
          console.warn("Keyword extraction failed:", err && err.message);
        }

        let prioritizedLinks = [];
        try {
          prioritizedLinks = await page.evaluate(
            ({ seedUrl, pattern, flags }) => {
              const anchors = Array.from(document.querySelectorAll("a[href]"));
              const seen = new Set();
              const collected = [];
              let source = null;
              const regex = new RegExp(pattern, flags);
              try {
                source = new URL(seedUrl);
              } catch {
                source = null;
              }

              for (const anchor of anchors) {
                const href = anchor.getAttribute("href");
                if (!href) continue;
                let normalized;
                try {
                  normalized = new URL(href, seedUrl).href;
                } catch {
                  continue;
                }
                if (seen.has(normalized)) continue;

                if (source) {
                  try {
                    if (new URL(normalized).origin !== source.origin) continue;
                  } catch {
                    continue;
                  }
                }

                const text = (anchor.innerText || "").toLowerCase();
                const hrefLower = normalized.toLowerCase();
                if (!regex.test(text) && !regex.test(hrefLower)) {
                  continue;
                }

                seen.add(normalized);
                collected.push(normalized);
                if (collected.length >= 20) break;
              }
              return collected;
            },
            {
              seedUrl: current,
              pattern: PRIORITY_LINK_REGEX.source,
              flags: "i",
            },
          );
        } catch (err) {
          prioritizedLinks = [];
        }

        for (const link of prioritizedLinks || []) {
          const normalizedLink = normalizeUrl(link, current);
          if (!normalizedLink) continue;
          if (visited.has(normalizedLink)) continue;
          if (isQueued(normalizedLink)) continue;
          if (maxDepth !== null && currentDepth + 1 > maxDepth) continue;
          queue.push({ href: normalizedLink, depth: currentDepth + 1 });
        }

        let discoveredLinks = [];
        try {
          discoveredLinks = await page.evaluate(
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
                typeof limit === "number" &&
                Number.isFinite(limit) &&
                limit > 0;
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
            { seedUrl: current, limit: linkCapPerPage },
          );
        } catch (err) {
          discoveredLinks = [];
        }

        for (const link of discoveredLinks || []) {
          const normalizedLink = normalizeUrl(link, current);
          if (!normalizedLink) continue;
          if (visited.has(normalizedLink)) continue;
          if (isQueued(normalizedLink)) continue;
          if (maxDepth !== null && currentDepth + 1 > maxDepth) continue;
          queue.push({ href: normalizedLink, depth: currentDepth + 1 });
        }

        if (matchLimit !== null && areAllKeywordLimitsSatisfied()) {
          break;
        }
      }

      const summaries = keywordConfigs.map((config) => {
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
      results.keywordSummaries = summaries;
      const primarySummary = summaries[0] || {
        keywordMatches: [],
        keywordHit: null,
      };
      results.keywordMatches = primarySummary.keywordMatches;
      results.keywordHit = primarySummary.keywordHit;
    } finally {
      await browser.close();
    }

    return results;
  }

  function summarizeKeywordMatches(matches, _matchMode, cap = null) {
    if (!Array.isArray(matches) || !matches.length) {
      return { keywordMatches: [], keywordHit: null };
    }

    const seen = new Set();
    const unique = [];
    for (const match of matches) {
      const key = `${(match.pageUrl || "").toLowerCase()}|${(
        match.value || ""
      ).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(match);
    }

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

  try {
    const data = await scrapeFullCompanyData(targetUrl, keywords, maxDepth, {
      fullCrawl,
      maxResults,
    }); // Note: using actual CSO domain
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
    });
  }
});

const randomBetween = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

expressApp.get("/google-search", async (req, res) => {
  const targetUrl = req.query.url;
  const keywords = mergeKeywords(req.query.keywords, req.query.keyword);
  let perKeyword = 5;
  const rawMaxResults = req.query.maxResults;
  if (typeof rawMaxResults !== "undefined" && rawMaxResults !== null) {
    const value = Array.isArray(rawMaxResults)
      ? rawMaxResults[0]
      : rawMaxResults;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      perKeyword = Math.min(parsed, 10);
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
  const domain = extractDomain(targetUrl);
  if (!domain) {
    return res.status(400).json({
      success: false,
      error: "Unable to determine domain from the provided URL.",
    });
  }
  let browser = null;
  const GOOGLE_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
  const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    browser = await puppeteer1.launch({
      headless: false,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    await page.setUserAgent(GOOGLE_UA);

    const dismissConsentIfPresent = async () => {
      try {
        await page.evaluate(() => {
          const buttons = Array.from(
            document.querySelectorAll('button, div[role="button"]'),
          );
          const consent = buttons.find((btn) => {
            const txt = (btn.textContent || "").trim();
            return /accept all|accept|i agree/i.test(txt);
          });
          if (consent) consent.click();
        });
      } catch {}
    };

    const SEARCH_INPUT_SELECTOR = 'textarea[name="q"], input[name="q"]';

    const focusAndClearSearchBox = async () => {
      await page.waitForSelector(SEARCH_INPUT_SELECTOR, {
        timeout: 12000,
        visible: true,
      });
      const inputHandle = await page.$(SEARCH_INPUT_SELECTOR);
      if (!inputHandle) {
        throw new Error("Unable to find Google search box.");
      }
      await inputHandle.focus();
      await page.click(SEARCH_INPUT_SELECTOR, {
        clickCount: 3,
        delay: randomBetween(60, 180),
      });
      await page.keyboard.press("Backspace");
    };

    const typeHumanQuery = async (text) => {
      for (const char of text) {
        await page.keyboard.type(char, {
          delay: randomBetween(40, 150),
        });
      }
    };

    const simulateHumanScroll = async () => {
      try {
        await page.evaluate(async () => {
          const delay = (ms) =>
            new Promise((resolve) => setTimeout(resolve, ms));
          const maxScroll = Math.max(
            0,
            document.body.scrollHeight - window.innerHeight,
          );
          const steps = Math.min(4, Math.max(1, Math.floor(Math.random() * 4)));
          for (let i = 0; i < steps; i += 1) {
            const target = Math.min(
              maxScroll,
              Math.max(0, window.scrollY + (200 + Math.random() * 400)),
            );
            window.scrollTo({ top: target, behavior: "smooth" });
            await delay(200 + Math.random() * 300);
          }
        });
      } catch {}
    };

    const waitForResults = async () => {
      await Promise.race([
        page
          .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 })
          .catch(() => {}),
        page.waitForSelector("#search", { timeout: 20000 }).catch(() => {}),
      ]);
      await dismissConsentIfPresent();
    };

    await page.goto("https://www.google.com/?hl=en&gl=us", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await dismissConsentIfPresent();
    await sleep(randomBetween(800, 1600));

    const keywordResults = [];
    for (const keyword of keywords) {
      const query = `site:${domain} ${keyword}`;
      const entry = { keyword, query, matches: [] };
      try {
        await sleep(randomBetween(800, 1800));
        let prepared = false;
        for (let attempt = 0; attempt < 2 && !prepared; attempt += 1) {
          try {
            await focusAndClearSearchBox();
            prepared = true;
          } catch (err) {
            if (attempt === 0) {
              await page.goto("https://www.google.com/?hl=en&gl=us", {
                waitUntil: "domcontentloaded",
                timeout: 45000,
              });
              await dismissConsentIfPresent();
              await sleep(randomBetween(800, 1500));
              continue;
            }
            throw err;
          }
        }
        await sleep(randomBetween(200, 500));
        await typeHumanQuery(query);
        await sleep(randomBetween(150, 400));
        await page.keyboard.press("Enter");
        await waitForResults();
        await simulateHumanScroll();
        await sleep(randomBetween(1200, 3000));
        const currentUrl = page.url();
        if (/:\/\/www\.google\.com\/sorry/.test(currentUrl)) {
          entry.error =
            "Google blocked the automated request (captcha / unusual traffic). Try again later or run the query manually.";
          entry.matches = [];
          keywordResults.push(entry);
          await sleep(randomBetween(1500, 3000));
          continue;
        }
        const matches = await page.evaluate(
          ({ maxResults }) => {
            const results = [];
            const cards = Array.from(
              document.querySelectorAll("div.g, div[data-header-feature='0']"),
            );
            for (const card of cards) {
              const titleEl = card.querySelector("h3");
              const linkEl = card.querySelector("a");
              if (!titleEl || !linkEl) continue;
              const href = linkEl.getAttribute("href") || linkEl.href || "";
              if (!href || href.startsWith("/search")) continue;
              const snippetEl =
                card.querySelector(".IsZvec") ||
                card.querySelector(".VwiC3b") ||
                card.querySelector(".BNeawe.s3v9rd.AP7Wnd");
              results.push({
                title: titleEl.innerText.trim(),
                link: href,
                snippet: snippetEl ? snippetEl.innerText.trim() : "",
              });
              if (maxResults && results.length >= maxResults) break;
            }
            return results;
          },
          { maxResults: perKeyword },
        );
        entry.matches = matches;
      } catch (err) {
        entry.matches = [];
        entry.error =
          (err && err.message) ||
          "Unable to fetch Google results for this keyword.";
      }
      keywordResults.push(entry);
      await sleep(randomBetween(1800, 3600));
    }

    return res.json({
      success: true,
      data: { domain, results: keywordResults },
    });
  } catch (err) {
    console.error("Google site search failed:", err);
    return res.status(500).json({
      success: false,
      error:
        (err && err.message) ||
        "Unable to complete Google search for the provided keywords.",
    });
  } finally {
    try {
      if (browser) await browser.close();
    } catch {}
  }
});

expressApp.get("/list-urls", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || !isValidUrl(targetUrl)) {
    return res
      .status(400)
      .json({ success: false, error: "Provide a valid ?url=" });
  }
  let browser = null;
  try {
    browser = await puppeteer1.launch({
      channel: "chrome",
      headless: false,
      args: ["--no-sandbox"],
      defaultViewport: null,
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    );
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const links = await page.evaluate(() => {
      const paginationSelectors = [
        ".pagination",
        ".pager",
        ".page-numbers",
        '[aria-label*="pagination" i]',
      ];
      const paginationWords = [
        "next",
        "prev",
        "previous",
        "pagination",
        "page",
        "older",
        "newer",
      ];
      const seen = new Set();
      const results = [];
      const isPaginationNode = (node) => {
        let current = node;
        let depth = 0;
        while (current && depth < 4) {
          if (
            paginationSelectors.some((selector) =>
              current.matches ? current.matches(selector) : false,
            )
          ) {
            return true;
          }
          current = current.parentElement;
          depth += 1;
        }
        return false;
      };
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      for (const anchor of anchors) {
        const rawHref = anchor.getAttribute("href") || "";
        if (!rawHref || rawHref.startsWith("#")) continue;
        if (/^(javascript:|mailto:|tel:)/i.test(rawHref)) continue;
        if (isPaginationNode(anchor)) continue;
        const text = (anchor.textContent || "").toLowerCase();
        const aria = (anchor.getAttribute("aria-label") || "").toLowerCase();
        if (
          paginationWords.some(
            (word) => text.includes(word) || aria.includes(word),
          )
        ) {
          continue;
        }
        try {
          const absolute = new URL(rawHref, location.href).href;
          if (!seen.has(absolute)) {
            seen.add(absolute);
            results.push(absolute);
          }
        } catch {
          continue;
        }
      }
      return results;
    });
    return res.json({ success: true, links });
  } catch (err) {
    console.error("Failed to list URLs", err);
    return res.status(500).json({
      success: false,
      error: (err && err.message) || "Unable to list URLs for the page.",
    });
  } finally {
    try {
      if (browser) await browser.close();
    } catch {}
  }
});

expressApp.get("/hover-link-inspector", async (req, res) => {
  const targetUrl = req.query.url;
  // Optional login flow parameters
  const loginUrl =
    (req.query.loginUrl || req.query.login || "").toString().trim() || null;
  const username = (req.query.username || req.query.user || "").toString();
  const password = (req.query.password || req.query.pass || "").toString();
  const userSel = (req.query.userSel || "").toString().trim() || null;
  const passSel = (req.query.passSel || "").toString().trim() || null;
  const submitSel =
    (req.query.submitSel || req.query.btnSel || "").toString().trim() || null;
  const afterSel = (req.query.afterSel || "").toString().trim() || null;
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
  let page;
  let isPie = false;
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

    clientWindow = new BrowserWindow({
      width: 1280,
      height: 900,
      webPreferences: {
        webSecurity: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
        preload: path.join(__dirname, "preload.js"),
        // Isolate session per inspector so we can tune proxy per run
        partition: `persist:rd-hli-${sessionId}`,
      },
      show: false,
    });

    clientWindow.on("closed", () => {
      inspectorSessions.delete(sessionId);
    });

    clientWindow.once("ready-to-show", () => clientWindow.show());
    // Configure this window's session proxy; allow auto-retry without proxy later
    try {
      const ses = clientWindow.webContents.session;
      if (disableProxy) {
        await ses.setProxy({ mode: "direct" });
        usedProxy = false;
      } else if (
        typeof proxyHost === "string" &&
        proxyHost &&
        typeof proxyPort !== "undefined"
      ) {
        await ses.setProxy({ proxyRules: `http://${proxyHost}:${proxyPort}` });
        usedProxy = true;
      }
    } catch {}

    // Attach to the existing Electron window using Puppeteer-in-Electron
    browser = await pie.connect(app, puppeteer);
    isPie = true;
    // const win = BrowserWindow.getAllWindows()[0];
    page = await pie.getPage(browser, clientWindow);
    upsertInspectorSession(sessionId, { page, window: clientWindow });
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
    await page.exposeFunction("reportExtractState", (payload) => {
      if (!payload || typeof payload !== "object") return;
      relayExtractStateToRenderer(sessionId, payload, {
        page,
        window: clientWindow,
      });
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
    try {
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      );
      await page.setExtraHTTPHeaders({
        "accept-language": "en-US,en;q=0.9",
        "upgrade-insecure-requests": "1",
        "sec-ch-ua":
          '"Chromium";v="120", "Not=A?Brand";v="24", "Google Chrome";v="120"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      });
      await page.evaluateOnNewDocument(() => {
        try {
          Object.defineProperty(navigator, "webdriver", {
            get: () => undefined,
          });
        } catch {}
      });
    } catch {}

    // Helper to perform login if parameters are provided
    const doLoginIfRequested = async () => {
      const haveCreds = !!(
        loginUrl &&
        username &&
        password &&
        userSel &&
        passSel &&
        submitSel
      );
      if (!haveCreds) return;
      try {
        await page.goto(loginUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
      } catch {}
      try {
        await page.waitForSelector(userSel, { timeout: 20000 });
      } catch {}
      try {
        await page.waitForSelector(passSel, { timeout: 20000 });
      } catch {}
      try {
        await page.$eval(userSel, (el) => {
          try {
            el.focus();
          } catch (e) {}
          try {
            el.value = "";
          } catch (e) {}
        });
      } catch {}
      try {
        await page.type(userSel, username, { delay: 20 });
      } catch {}
      try {
        await page.$eval(passSel, (el) => {
          try {
            el.focus();
          } catch (e) {}
          try {
            el.value = "";
          } catch (e) {}
        });
      } catch {}
      try {
        await page.type(passSel, password, { delay: 20 });
      } catch {}
      try {
        await page.click(submitSel);
      } catch {
        try {
          await page.$eval(submitSel, (el) => el && el.click && el.click());
        } catch {}
      }
      // Wait for login to settle: either a selector appears or navigation completes
      let settled = false;
      if (afterSel) {
        try {
          await page.waitForSelector(afterSel, { timeout: 25000 });
          settled = true;
        } catch {}
      }
      if (!settled) {
        try {
          await page.waitForNavigation({
            waitUntil: "networkidle0",
            timeout: 25000,
          });
          settled = true;
        } catch {}
      }
      if (!settled) {
        try {
          await pause(1500);
        } catch {}
      }
    };
    let navError = null;
    try {
      await doLoginIfRequested();
      const ses = clientWindow.webContents.session;
      let resp = await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      // If proxy caused a 403, retry once without proxy using same session
      if (
        resp &&
        typeof resp.status === "function" &&
        resp.status() === 403 &&
        usedProxy
      ) {
        try {
          await ses.setProxy({ mode: "direct" });
          usedProxy = false;
        } catch {}
        try {
          resp = await page.goto(targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });
        } catch {}
      }
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
      // try { await page.close().catch(()=>{}); await browser.close().catch(()=>{}); } catch {}
      // Retry without proxy
      isPie = false;
      browser = await puppeteer.launch({
        channel: "chrome",
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
      await frame.evaluate(
        (sid, allowPrompt) => {
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
          const deriveLegacyColumnMap = () => {
            const map = {};
            try {
              Object.entries(columnBindings || {}).forEach(
                ([column, binding]) => {
                  if (!binding || !binding.label || map[binding.label]) return;
                  map[binding.label] = column;
                },
              );
            } catch {}
            return map;
          };

          const detectPaginationElement = (el) => {
            if (!el) return null;
            // Check if element is likely a pagination control
            const isPaginationControl = () => {
              // Check element text
              const text = (el.textContent || "").trim().toLowerCase();
              if (
                /^(More Obituaries →|next|next page|»|›|>+|forward|more)$/i.test(
                  text,
                )
              )
                return true;

              // Check aria attributes
              if (
                el.getAttribute &&
                ((el.getAttribute("aria-label") || "")
                  .toLowerCase()
                  .includes("next") ||
                  (el.getAttribute("title") || "")
                    .toLowerCase()
                    .includes("next"))
              )
                return true;

              // Check classes and IDs
              const classAndId = (el.className || "") + " " + (el.id || "");
              if (
                /\b(More Obituaries →|pagination|pager|next|nav)\b/i.test(
                  classAndId,
                )
              )
                return true;

              // Check if it's inside a pagination container
              const parent = el.closest
                ? el.closest('.pagination, .pager, nav ul, [role="navigation"]')
                : null;
              if (parent) return true;

              return false;
            };

            // If the element itself is a pagination control
            if (isPaginationControl()) {
              return makeSelector(el);
            }

            // If it's a container, look for the next button inside
            if (el.querySelector) {
              // Try to find the next button within this container
              const nextButton = el.querySelector(
                'a[rel="next"], a[aria-label*="next" i], button[aria-label*="next" i], ' +
                  "a.next, button.next, .next a, .next button, " +
                  'a:has(svg[aria-label*="next" i]), ' +
                  "a:has(i.fa-chevron-right), a:has(i.fa-arrow-right), " +
                  'a:has(span:contains("Next")), a:contains("Next"), ' +
                  'a:contains("»"), a:contains("›"), a:contains(">")',
              );

              if (nextButton) {
                return makeSelector(nextButton);
              }
            }

            return null;
          };

          const makeRelSelector = (el, root) => {
            if (!el || el.nodeType !== 1) return "";
            const parts = [];
            let node = el;
            while (
              node &&
              node.nodeType === 1 &&
              node !== document.body &&
              node !== document.documentElement
            ) {
              if (root && node === root) break;
              let selector = node.nodeName.toLowerCase();
              if (node.id && (!root || node !== root)) {
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
          const showPaginationFeedback = (host, text, color, emphasize) => {
            const container = host || popup;
            if (!container) return;
            const msg = document.createElement("div");
            msg.textContent = text;
            msg.style.cssText = [
              `color:${color}`,
              "margin-top:4px",
              emphasize ? "font-weight:bold" : "",
            ]
              .filter(Boolean)
              .join(";");
            container.appendChild(msg);
            setTimeout(() => {
              try {
                container.removeChild(msg);
              } catch {}
            }, 2000);
          };
          const applyPaginationSelection = (feedbackHost) => {
            const paginationSelector = detectPaginationElement(lastTarget);
            if (paginationSelector) {
              const nextSelInp = document.getElementById(
                "__hli_pagination_selector__",
              );
              if (nextSelInp) nextSelInp.value = paginationSelector;
              nextPageSelector = paginationSelector;
              saveState();
              try {
                emitExtractStateUpdate({
                  nextPageSelector: paginationSelector,
                });
              } catch {}
              showPaginationFeedback(
                feedbackHost || popup,
                "Pagination selector set!",
                "#2ecc71",
                true,
              );
              return true;
            }
            showPaginationFeedback(
              feedbackHost || popup,
              "Not detected as pagination. Try another element.",
              "#e74c3c",
            );
            return false;
          };
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
          const list = document.createElement("div");
          list.id = "__hover_link_list__";
          list.style.cssText = [
            "margin-top:6px",
            "max-height:240px",
            "overflow:auto",
            "border-top:1px solid rgba(255,255,255,0.15)",
            "padding-top:6px",
          ].join(";");
          // popup.appendChild(list);
          // document.body.appendChild(popup);
          let lastTarget = null;
          let lastHoverSelector = null;
          // let lastHoverSelector = null;
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
            const __hli_raw = sessionStorage.getItem("__hli_state__");
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
              // Use capture + stopImmediatePropagation to defeat site-level interceptors
              btn.addEventListener(
                "click",
                (e) => {
                  try {
                    e.preventDefault();
                  } catch {}
                  try {
                    e.stopImmediatePropagation();
                  } catch {}
                  try {
                    e.stopPropagation();
                  } catch {}
                  if (typeof handleMenuClick === "function")
                    handleMenuClick(label);
                },
                true,
              );
              return btn;
            };
            const rowWrap = document.createElement("div");
            rowWrap.style.cssText = [
              "display:flex",
              "flex-wrap:wrap",
              "align-items:center",
            ].join(";");
            const defaultFields = ["Capture Link", "Capture Text"];
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
            addBtn.addEventListener(
              "click",
              (e) => {
                try {
                  e.preventDefault();
                } catch {}
                try {
                  e.stopImmediatePropagation();
                } catch {}
                try {
                  e.stopPropagation();
                } catch {}
                addField();
              },
              true,
            );
            inp.addEventListener(
              "keydown",
              (e) => {
                if (e.key === "Enter") {
                  try {
                    e.preventDefault();
                  } catch {}
                  try {
                    e.stopImmediatePropagation();
                  } catch {}
                  try {
                    e.stopPropagation();
                  } catch {}
                  addField();
                }
              },
              true,
            );
            addWrap.appendChild(inp);
            addWrap.appendChild(addBtn);
            ctxMenu.appendChild(rowWrap);
            // ctxMenu.appendChild(addWrap);

            // Inline column-name prompt shown after clicking a field button
            const colNameWrap = document.createElement("div");
            colNameWrap.style.cssText =
              "margin-top:6px; display:none; gap:6px; align-items:center;";
            const colNameInp = document.createElement("input");
            colNameInp.type = "text";
            colNameInp.placeholder = "Column name";
            colNameInp.style.cssText =
              "background:#111;border:1px solid rgba(255,255,255,0.2);color:#fff;padding:6px 8px;border-radius:4px;flex:1 1 auto;min-width:160px";
            const btnColOk = document.createElement("button");
            btnColOk.textContent = "Submit";
            btnColOk.style.cssText =
              "background:#43a047;border:0;color:#fff;padding:6px 10px;border-radius:4px;cursor:pointer;flex:0 0 auto";
            const btnColCancel = document.createElement("button");
            btnColCancel.textContent = "Cancel";
            btnColCancel.style.cssText =
              "background:#8e8e8e;border:0;color:#fff;padding:6px 10px;border-radius:4px;cursor:pointer;flex:0 0 auto";
            colNameWrap.appendChild(colNameInp);
            colNameWrap.appendChild(btnColOk);
            colNameWrap.appendChild(btnColCancel);
            ctxMenu.appendChild(colNameWrap);

            const paginationMenuWrap = document.createElement("div");
            paginationMenuWrap.style.cssText = "margin-top:6px;";
            const paginationMenuBtn = document.createElement("button");
            paginationMenuBtn.textContent = "Set as Pagination";
            paginationMenuBtn.style.cssText = [
              "background:#8e44ad",
              "border:0",
              "color:#fff",
              "padding:6px 10px",
              "border-radius:4px",
              "cursor:pointer",
              "width:100%",
            ].join(";");
            paginationMenuBtn.addEventListener(
              "click",
              (e) => {
                try {
                  e.preventDefault();
                } catch {}
                try {
                  e.stopImmediatePropagation();
                } catch {}
                try {
                  e.stopPropagation();
                } catch {}
                applyPaginationSelection(paginationMenuWrap);
              },
              true,
            );
            paginationMenuWrap.appendChild(paginationMenuBtn);
            ctxMenu.appendChild(paginationMenuWrap);

            const hideColPrompt = () => {
              colNameWrap.style.display = "none";
              colNameWrap._onDone = null;
            };
            const showColPrompt = (label, suggested, onDone) => {
              try {
                colNameInp.value = suggested || label || "";
              } catch {}
              colNameWrap._onDone = onDone;
              colNameWrap.style.display = "flex";
              try {
                colNameInp.focus();
                colNameInp.select();
              } catch {}
            };
            try {
              window.__hliShowColPrompt = showColPrompt;
            } catch {}
            btnColOk.addEventListener(
              "click",
              (e) => {
                try {
                  e.preventDefault();
                } catch {}
                try {
                  e.stopImmediatePropagation();
                } catch {}
                try {
                  e.stopPropagation();
                } catch {}
                const v = (colNameInp.value || "").trim();
                const cb = colNameWrap._onDone;
                hideColPrompt();
                if (cb && v) {
                  try {
                    cb(v);
                  } catch {}
                }
              },
              true,
            );
            btnColCancel.addEventListener(
              "click",
              (e) => {
                try {
                  e.preventDefault();
                } catch {}
                try {
                  e.stopImmediatePropagation();
                } catch {}
                try {
                  e.stopPropagation();
                } catch {}
                hideColPrompt();
              },
              true,
            );
            colNameInp.addEventListener(
              "keydown",
              (e) => {
                if (e.key === "Enter") {
                  try {
                    e.preventDefault();
                  } catch {}
                  try {
                    e.stopImmediatePropagation();
                  } catch {}
                  try {
                    e.stopPropagation();
                  } catch {}
                  btnColOk.click();
                }
                if (e.key === "Escape") {
                  try {
                    e.preventDefault();
                  } catch {}
                  try {
                    e.stopImmediatePropagation();
                  } catch {}
                  try {
                    e.stopPropagation();
                  } catch {}
                  hideColPrompt();
                }
              },
              true,
            );
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
              const url = navWrap.getAttribute("data-url") || "";
              if (!url) return;
              try {
                window.open(url, "_blank");
              } catch {
                try {
                  const win = window.open("", "_blank");
                  if (win) win.location.href = url;
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
              placeCtx(
                window.scrollX + br.left,
                window.scrollY + br.bottom + 6,
              );
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
                  const sel = window.getSelection
                    ? window.getSelection()
                    : null;
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
                  if (typeof showFor === "function")
                    showFor(ctxSelectedEl || el);
                } catch {}
                ctxCurrentEl = el;
                updateNavButtons(el);
                // If target is an iframe, observe lazy src changes to update url state
                try {
                  if (
                    el &&
                    el.tagName &&
                    el.tagName.toLowerCase() === "iframe"
                  ) {
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
          const applyNextSelectorCore = (value, opts = {}) => {
            try {
              nextPageSelector = (value || "").trim() || null;
              saveState();
              if (!opts.silent) {
                emitExtractStateUpdate({
                  nextPageSelector: nextPageSelector || "",
                });
              }
            } catch {}
          };
          const applyMaxPagesCore = (value, opts = {}) => {
            try {
              const v = parseInt(value, 10);
              if (v > 0 && isFinite(v)) {
                maxPagesSetting = v;
                saveState();
                if (!opts.silent) {
                  emitExtractStateUpdate({ maxPages: maxPagesSetting });
                }
              }
            } catch {}
          };
          let applyNextSelectorValue = applyNextSelectorCore;
          let applyMaxPagesValue = applyMaxPagesCore;
          const applyLoadMoreValue = (value, opts = {}) => {
            try {
              loadMoreMode = !!value;
              if (loadMoreCheckboxEl) {
                loadMoreCheckboxEl.checked = loadMoreMode;
              }
              saveState();
              if (!opts.silent) {
                emitExtractStateUpdate({ loadMoreMode });
              }
            } catch {}
          };
          let extractState = { columns: [], rows: [] };
          const ROWS_BACKUP_KEY = "__hli_rows_union__";
          const rowKeyOf = (row) => {
            if (!row || typeof row !== "object")
              return `json:${JSON.stringify(row || {})}`;
            const link =
              row["Capture Link"] || row.captureLink || row.link || "";
            const pageTag =
              typeof row.__hliPageIndex !== "undefined"
                ? `|page:${row.__hliPageIndex}`
                : "";
            return link
              ? `link:${link}${pageTag}`
              : `json:${JSON.stringify(row)}`;
          };
          const mergeRowsUnique = (base, incoming) => {
            const map = new Map();
            const addRows = (rows) => {
              if (!Array.isArray(rows)) return;
              rows.forEach((row) => {
                const key = rowKeyOf(row);
                if (!map.has(key)) map.set(key, row);
              });
            };
            addRows(base);
            addRows(incoming);
            return Array.from(map.values());
          };
          const persistRowsBackup = () => {
            try {
              const existingRaw = sessionStorage.getItem(ROWS_BACKUP_KEY);
              const existing = existingRaw ? JSON.parse(existingRaw) : [];
              const union = mergeRowsUnique(existing, extractState.rows || []);
              sessionStorage.setItem(ROWS_BACKUP_KEY, JSON.stringify(union));
            } catch {}
          };
          const restoreRowsBackup = () => {
            try {
              const existingRaw = sessionStorage.getItem(ROWS_BACKUP_KEY);
              if (!existingRaw) return;
              const existing = JSON.parse(existingRaw);
              if (!Array.isArray(existing) || !existing.length) return;
              extractState.rows = mergeRowsUnique(
                existing,
                extractState.rows || [],
              );
            } catch {}
          };
          const clearRowsBackup = () => {
            try {
              sessionStorage.removeItem(ROWS_BACKUP_KEY);
            } catch {}
          };
          let columnBindings = {}; // columnName -> { label, listSelector, detailSelector, createdAt }
          let columnOrderCounter = 0;
          let detailSelectors = {}; // columnName -> CSS selector captured on detail page (legacy view)
          let labelSuggestions = {}; // label -> last column that was mapped
          let siblingsHrefs = []; // hrefs of detected siblings
          let detailWindowRef = null; // reusable window for detail navigation
          // customFields is declared earlier to avoid TDZ during menu render
          let baseAnchorSelector = null; // remembered when choosing Capture Link
          let baseAnchorHref = null; // absolute URL of base anchor
          let baseItemSignature = null; // structural signature for list items
          let baseItemSelector = null; // CSS selector for representative list item
          let ctxCurrentEl = null;
          let nextPageSelector = null; // optional CSS selector for the Next page link/button
          let maxPagesSetting = null; // default max pages for pagination
          let panelCollapsed = false; // collapse/expand Extracted Table content
          let panelPos = null; // persisted { left, top } for draggable panel
          let loadMoreMode = false; // use load-more flow instead of navigation
          let loadMoreCheckboxEl = null;

          const saveState = () => {
            try {
              const st = {
                columnBindings,
                detailSelectors,
                labelSuggestions,
                siblingsHrefs,
                baseAnchorSelector,
                baseAnchorHref,
                baseItemSelector: baseItemSelector || null,
                baseItemSignature,
                customFields,
                nextPageSelector,
                maxPagesSetting,
                loadMoreMode,
                extractState,
                panelCollapsed,
                panelPos,
              };
              sessionStorage.setItem("__hli_state__", JSON.stringify(st));
              persistRowsBackup();
            } catch {}
          };
          const loadState = () => {
            try {
              const raw = sessionStorage.getItem("__hli_state__");
              if (!raw) return;
              const st = JSON.parse(raw) || {};
              if (st.columnBindings && typeof st.columnBindings === "object") {
                columnBindings = { ...columnBindings, ...st.columnBindings };
              } else if (st.columnMap && typeof st.columnMap === "object") {
                // Legacy shape: label -> column
                Object.entries(st.columnMap).forEach(([label, col]) => {
                  if (!col || typeof col !== "string") return;
                  if (!columnBindings[col]) {
                    columnBindings[col] = { label, createdAt: Date.now() };
                  }
                });
              }
              const legacyDetailSelectors = st.detailSelectors;
              detailSelectors = legacyDetailSelectors || detailSelectors;
              if (
                st.columnMap &&
                legacyDetailSelectors &&
                typeof legacyDetailSelectors === "object"
              ) {
                const converted = {};
                Object.entries(st.columnMap).forEach(([label, col]) => {
                  if (!label || !col) return;
                  const legacySel = legacyDetailSelectors[label];
                  if (legacySel) converted[col] = legacySel;
                });
                if (Object.keys(converted).length) {
                  detailSelectors = converted;
                }
              }
              labelSuggestions = st.labelSuggestions || labelSuggestions;
              siblingsHrefs = st.siblingsHrefs || siblingsHrefs;
              baseAnchorSelector = st.baseAnchorSelector || baseAnchorSelector;
              baseAnchorHref = st.baseAnchorHref || baseAnchorHref;
              baseItemSignature = st.baseItemSignature || baseItemSignature;
              if (typeof st.baseItemSelector !== "undefined") {
                baseItemSelector = st.baseItemSelector;
              }
              customFields = Array.isArray(st.customFields)
                ? st.customFields
                : customFields;
              nextPageSelector = st.nextPageSelector || nextPageSelector;

              if (
                typeof st.maxPagesSetting === "number" &&
                isFinite(st.maxPagesSetting) &&
                st.maxPagesSetting > 0
              ) {
                maxPagesSetting = Math.floor(st.maxPagesSetting);
              }
              if (typeof st.panelCollapsed === "boolean") {
                panelCollapsed = st.panelCollapsed;
              }
              if (
                st.panelPos &&
                typeof st.panelPos.left === "number" &&
                typeof st.panelPos.top === "number"
              ) {
                panelPos = { left: st.panelPos.left, top: st.panelPos.top };
              }
              if (typeof st.loadMoreMode === "boolean") {
                loadMoreMode = st.loadMoreMode;
              }
              if (st.extractState && typeof st.extractState === "object") {
                const cols = Array.isArray(st.extractState.columns)
                  ? st.extractState.columns
                  : [];
                const rows = Array.isArray(st.extractState.rows)
                  ? st.extractState.rows
                  : [];
                extractState = { columns: cols, rows: rows };
              }
              restoreRowsBackup();
              try {
                const existing = new Set(extractState.columns || []);
                Object.keys(columnBindings || {}).forEach((col) => {
                  if (!col || existing.has(col)) return;
                  extractState.columns.push(col);
                });
              } catch {}
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
              panelPos ? `left:${Math.max(0, panelPos.left)}px` : "right:12px",
              panelPos ? `top:${Math.max(0, panelPos.top)}px` : "bottom:12px",
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
              "display:none",
            ].join(";");
            const header = document.createElement("div");
            header.style.cssText =
              "margin-bottom:6px; font-weight:600; display:flex; align-items:center; justify-content:space-between; gap:8px;";
            const headerTitle = document.createElement("span");
            headerTitle.textContent = "Extracted Table";
            const headerBtns = document.createElement("div");
            headerBtns.style.cssText =
              "display:flex; gap:6px; align-items:center;";
            const btnToggle = document.createElement("button");
            const setToggleText = () => {
              btnToggle.textContent = panelCollapsed ? "Maximize" : "Minimize";
            };
            setToggleText();
            btnToggle.style.cssText =
              "background:#555;border:0;color:#fff;padding:2px 8px;border-radius:4px;cursor:pointer;";
            btnToggle.addEventListener("click", () => {
              try {
                panelCollapsed = !panelCollapsed;
                setToggleText();
                applyCollapsedState();
                saveState();
              } catch {}
            });
            const btnHide = document.createElement("button");
            btnHide.textContent = "Hide";
            btnHide.style.cssText =
              "background:#444;border:0;color:#fff;padding:2px 8px;border-radius:4px;cursor:pointer;";
            btnHide.addEventListener("click", () => {
              try {
                panel.style.display = "none";
                sessionStorage.setItem("__hli_hidden__", "1");
              } catch {}
            });
            headerBtns.appendChild(btnToggle);
            headerBtns.appendChild(btnHide);
            header.appendChild(headerTitle);
            header.appendChild(headerBtns);
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
            const btnExtractPages = document.createElement("button");
            btnExtractPages.textContent = "Extract + Pages";
            btnExtractPages.style.cssText = [
              "background:#67c23a",
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
            const btnClearAll = document.createElement("button");
            btnClearAll.textContent = "Clear All";
            btnClearAll.title =
              "Clear all persisted settings and extracted data";
            btnClearAll.style.cssText = [
              "background:#b85c00",
              "border:0",
              "color:#fff",
              "padding:4px 8px",
              "border-radius:4px",
              "cursor:pointer",
            ].join(";");
            const nextSelWrap = document.createElement("div");
            nextSelWrap.style.cssText =
              "margin:6px 0; display:flex; gap:6px; align-items:center; flex-wrap:wrap;";
            const nextSelInp = document.createElement("input");
            nextSelInp.id = "__hli_pagination_selector__";
            nextSelInp.type = "text";
            nextSelInp.placeholder = "Custom Next selector (optional)";
            nextSelInp.value = nextPageSelector || "";
            nextSelInp.style.cssText =
              "background:#111;border:1px solid rgba(255,255,255,0.2);color:#fff;padding:4px 8px;border-radius:4px;flex:1 1 auto;min-width:160px";
            const nextSelBtn = document.createElement("button");
            nextSelBtn.textContent = "Save Next Selector";
            nextSelBtn.style.cssText =
              "background:#2d8cf0;border:0;color:#fff;padding:4px 8px;border-radius:4px;cursor:pointer;flex:0 0 auto";
            applyNextSelectorValue = (value, opts = {}) => {
              applyNextSelectorCore(value, opts);
              try {
                if (nextSelInp) nextSelInp.value = nextPageSelector || "";
              } catch {}
            };
            nextSelBtn.addEventListener("click", () =>
              applyNextSelectorValue(nextSelInp.value),
            );
            const maxPagesInp = document.createElement("input");
            maxPagesInp.type = "number";
            maxPagesInp.min = "1";
            maxPagesInp.step = "1";
            maxPagesInp.placeholder = "Max pages";
            maxPagesInp.value =
              maxPagesSetting !== null && typeof maxPagesSetting !== "undefined"
                ? String(maxPagesSetting)
                : "";
            maxPagesInp.style.cssText =
              "background:#111;border:1px solid rgba(255,255,255,0.2);color:#fff;padding:4px 8px;border-radius:4px;flex:0 0 120px;min-width:120px";
            const maxPagesBtn = document.createElement("button");
            maxPagesBtn.textContent = "Save Max Pages";
            maxPagesBtn.style.cssText =
              "background:#19be6b;border:0;color:#fff;padding:4px 8px;border-radius:4px;cursor:pointer;flex:0 0 auto";
            applyMaxPagesValue = (value, opts = {}) => {
              applyMaxPagesCore(value, opts);
              try {
                if (maxPagesInp) {
                  maxPagesInp.value =
                    maxPagesSetting !== null &&
                    typeof maxPagesSetting !== "undefined"
                      ? String(maxPagesSetting)
                      : "";
                }
              } catch {}
            };
            maxPagesBtn.addEventListener("click", () =>
              applyMaxPagesValue(maxPagesInp.value),
            );
            maxPagesInp.addEventListener("change", () =>
              applyMaxPagesValue(maxPagesInp.value, { silent: true }),
            );
            nextSelWrap.appendChild(nextSelInp);
            nextSelWrap.appendChild(nextSelBtn);
            nextSelWrap.appendChild(maxPagesInp);
            nextSelWrap.appendChild(maxPagesBtn);
            const loadMoreLabel = document.createElement("label");
            loadMoreLabel.style.cssText =
              "display:flex; align-items:center; gap:4px; color:#fff; font-size:12px;";
            const loadMoreInput = document.createElement("input");
            loadMoreInput.type = "checkbox";
            loadMoreInput.checked = loadMoreMode;
            loadMoreInput.addEventListener("change", () =>
              applyLoadMoreValue(loadMoreInput.checked),
            );
            loadMoreLabel.appendChild(loadMoreInput);
            const loadMoreText = document.createElement("span");
            loadMoreText.textContent = "Load more button";
            loadMoreLabel.appendChild(loadMoreText);
            nextSelWrap.appendChild(loadMoreLabel);
            loadMoreCheckboxEl = loadMoreInput;
            const statusWrap = document.createElement("div");
            statusWrap.style.cssText =
              "margin:6px 0; display:flex; align-items:center; gap:8px;";
            const statusText = document.createElement("span");
            statusText.id = "__hli_status__";
            statusText.style.cssText = "opacity:0.9;";
            statusText.textContent = "Idle";
            const countText = document.createElement("span");
            countText.id = "__hli_count__";
            countText.style.cssText = "opacity:0.8;";
            countText.textContent = "Rows: 0";
            const stopBtn = document.createElement("button");
            stopBtn.textContent = "Stop";
            stopBtn.title = "Stop paginated extraction";
            stopBtn.style.cssText =
              "background:#d9534f;border:0;color:#fff;padding:4px 8px;border-radius:4px;cursor:pointer;display:none;";
            stopBtn.addEventListener("click", () => {
              try {
                stopPaginatedExtract();
              } catch {}
            });
            statusWrap.appendChild(statusText);
            statusWrap.appendChild(countText);
            statusWrap.appendChild(stopBtn);
            const tableWrap = document.createElement("div");
            panel.appendChild(header);
            actions.appendChild(btnExtract);
            actions.appendChild(btnExtractDetails);
            actions.appendChild(btnExtractPages);
            actions.appendChild(btnExport);
            actions.appendChild(btnClear);
            actions.appendChild(btnClearAll);
            panel.appendChild(actions);
            panel.appendChild(nextSelWrap);
            panel.appendChild(statusWrap);
            panel.appendChild(tableWrap);
            document.body.appendChild(panel);

            btnClear.addEventListener("click", () => {
              clearExtractedTable();
            });
            btnClearAll.addEventListener("click", () => {
              resetAllExtractionState();
            });
            btnExtract.addEventListener("click", () => {
              extractAllUsingSiblings();
            });
            btnExtractDetails.addEventListener("click", async () => {
              try {
                await extractAllDetails();
              } catch {}
            });
            btnExtractPages.addEventListener("click", () => {
              try {
                const raw = parseInt(maxPagesInp.value, 10);
                const chosen =
                  Number.isFinite(raw) && raw > 0
                    ? raw
                    : maxPagesSetting && maxPagesSetting > 0
                      ? maxPagesSetting
                      : 1;
                const selector =
                  (nextSelInp.value && nextSelInp.value.trim()) || null;
                startPaginatedExtract(chosen, selector, loadMoreMode);
              } catch {}
            });
            // btnExtractPages.addEventListener('click', () => { try { startPaginatedExtractAllDetail(parseInt(maxPagesInp.value, 10) || maxPagesSetting || 5, (nextSelInp.value||'').trim()||null); } catch {} });

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
            panel._statusText = statusText;
            panel._stopBtn = stopBtn;
            panel._countText = countText;
            try {
              panel._countText.textContent =
                "Rows: " + (extractState.rows ? extractState.rows.length : 0);
            } catch {}
            const applyCollapsedState = () => {
              try {
                panel._tableWrap.style.display = panelCollapsed ? "none" : "";
                statusWrap.style.display = panelCollapsed ? "none" : "";
                nextSelWrap.style.display = panelCollapsed ? "none" : "";
              } catch {}
            };
            applyCollapsedState();

            // Draggable: drag panel by header
            try {
              let dragging = false;
              let sx = 0,
                sy = 0,
                sl = 0,
                st = 0;
              header.addEventListener("mousedown", (e) => {
                try {
                  if (e.button !== 0) return;
                } catch {}
                dragging = true;
                sx = e.clientX;
                sy = e.clientY;
                const r = panel.getBoundingClientRect();
                sl = r.left;
                st = r.top;
                e.preventDefault();
              });
              window.addEventListener("mousemove", (e) => {
                if (!dragging) return;
                const dx = e.clientX - sx;
                const dy = e.clientY - sy;
                const nl = Math.max(0, sl + dx);
                const nt = Math.max(0, st + dy);
                panel.style.left = nl + "px";
                panel.style.top = nt + "px";
                panel.style.right = "auto";
                panel.style.bottom = "auto";
              });
              window.addEventListener("mouseup", () => {
                if (!dragging) return;
                dragging = false;
                try {
                  const r = panel.getBoundingClientRect();
                  panelPos = {
                    left: Math.round(r.left),
                    top: Math.round(r.top),
                  };
                  saveState();
                } catch {}
              });
            } catch {}

            // Restore hidden state if user hid the panel
            try {
              if (sessionStorage.getItem("__hli_hidden__") === "1")
                panel.style.display = "none";
            } catch {}
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

          function emitExtractStateUpdate(extra) {
            try {
              const panel = document.getElementById(tablePanelId);
              const statusText =
                panel && panel._statusText
                  ? panel._statusText.textContent
                  : "Idle";
              let isPaginating = false;
              try {
                const rawJob = sessionStorage.getItem("__hli_paginate__");
                if (rawJob) {
                  const job = JSON.parse(rawJob);
                  isPaginating = !!(job && job.active);
                }
              } catch {}
              const payload = Object.assign(
                {
                  columns: Array.isArray(extractState.columns)
                    ? extractState.columns.slice()
                    : [],
                  rows: Array.isArray(extractState.rows)
                    ? extractState.rows.map((r) => ({ ...(r || {}) }))
                    : [],
                  nextPageSelector: nextPageSelector || "",
                  maxPages: maxPagesSetting,
                  loadMoreMode,
                  statusText,
                  rowCount: extractState.rows ? extractState.rows.length : 0,
                  timestamp: Date.now(),
                  isPaginating,
                  columnBindings: columnBindings
                    ? JSON.parse(JSON.stringify(columnBindings))
                    : {},
                  columnMap: deriveLegacyColumnMap(),
                  detailSelectors: detailSelectors
                    ? { ...detailSelectors }
                    : {},
                  labelSuggestions: labelSuggestions
                    ? { ...labelSuggestions }
                    : {},
                  customFields: Array.isArray(customFields)
                    ? customFields.slice()
                    : [],
                  baseAnchorSelector: baseAnchorSelector || null,
                  baseAnchorHref: baseAnchorHref || null,
                  baseItemSelector: baseItemSelector || null,
                  baseItemSignature: baseItemSignature
                    ? { ...baseItemSignature }
                    : null,
                  siblingsHrefs: Array.isArray(siblingsHrefs)
                    ? siblingsHrefs.slice()
                    : [],
                  panelCollapsed: !!panelCollapsed,
                  panelPos: panelPos ? { ...panelPos } : null,
                },
                extra || {},
              );
              if (window.reportExtractState) {
                window.reportExtractState(payload);
              }
            } catch (err) {
              console.warn("Failed to emit extract state", err);
            }
          }

          const renderTable = () => {
            const panel = ensureTablePanel();
            const wrap = panel._tableWrap;
            wrap.innerHTML = "";
            if (!extractState.columns.length) {
              const empty = document.createElement("div");
              empty.textContent = "No data yet. Use right-click menu.";
              empty.style.opacity = "0.8";
              wrap.appendChild(empty);
              emitExtractStateUpdate();
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
            try {
              const p = ensureTablePanel();
              p._countText.textContent =
                "Rows: " + (extractState.rows ? extractState.rows.length : 0);
            } catch {}
            emitExtractStateUpdate();
          };

          const clearExtractedTable = () => {
            extractState = { columns: [], rows: [] };
            clearRowsBackup();
            renderTable();
            try {
              saveState();
            } catch {}
          };

          const resetAllExtractionState = () => {
            try {
              sessionStorage.removeItem("__hli_state__");
              sessionStorage.removeItem("__hli_paginate__");
              sessionStorage.removeItem("__hli_hidden__");
            } catch {}
            try {
              columnBindings = {};
              detailSelectors = {};
              labelSuggestions = {};
              siblingsHrefs = [];
              baseAnchorSelector = null;
              baseAnchorHref = null;
              baseItemSignature = null;
              customFields = [];
              nextPageSelector = null;
              maxPagesSetting = null;
              loadMoreMode = false;
              if (loadMoreCheckboxEl) loadMoreCheckboxEl.checked = false;
              extractState = { columns: [], rows: [] };
              clearRowsBackup();
              if (typeof baseItemSelector !== "undefined")
                baseItemSelector = null;
              if (typeof panelCollapsed !== "undefined") panelCollapsed = false;
            } catch {}
            try {
              const p = ensureTablePanel();
              p._statusText.textContent = "Idle";
              p._countText.textContent = "Rows: 0";
              p._stopBtn.style.display = "none";
            } catch {}
            try {
              const inp = document.getElementById(
                "__hli_pagination_selector__",
              );
              if (inp) inp.value = "";
            } catch {}
            try {
              renderTable();
            } catch {}
            try {
              saveState();
            } catch {}
            emitExtractStateUpdate({
              nextPageSelector: "",
              maxPages: maxPagesSetting,
            });
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
          const ROW_SELECTOR_HINTS = [
            '[data-testid*="item"]',
            '[data-component*="item"]',
            '[data-test*="item"]',
            ".obituary-item",
            ".obituary",
            ".obit",
            ".listing",
            ".listing-item",
            ".list-item",
            ".result",
            ".result-item",
            ".card",
            ".card-item",
            ".media",
            ".media-item",
            ".row",
            ".vtlistings",
            ".col",
            "article",
            "li",
            "tr",
            '[role="listitem"]',
          ];
          const matchesRowHint = (el) => {
            if (!el || el.nodeType !== 1) return false;
            return ROW_SELECTOR_HINTS.some((sel) => {
              try {
                return el.matches(sel);
              } catch {
                return false;
              }
            });
          };
          const applyRowHints = (target, boundary = null) => {
            if (!target || !target.closest) return target;
            for (const sel of ROW_SELECTOR_HINTS) {
              try {
                const hit = target.closest(sel);
                if (
                  hit &&
                  (!boundary || !boundary.contains || boundary.contains(hit))
                ) {
                  return hit;
                }
              } catch {}
            }
            return target;
          };
          const resolveItemRoot = (el) => {
            if (!el) return null;
            try {
              if (baseItemSelector) {
                const base = document.querySelector(baseItemSelector);
                if (base && base.contains(el)) return base;
              }
            } catch {}
            try {
              if (baseItemSignature) {
                if (matchesItemSignature(el, baseItemSignature)) return el;
                let node = el.parentElement;
                while (node && node !== document.body) {
                  if (matchesItemSignature(node, baseItemSignature))
                    return node;
                  node = node.parentElement;
                }
              }
            } catch {}
            const anchor =
              el.closest && el.closest("a[href]")
                ? el.closest("a[href]")
                : null;
            const candidates = [
              () => el.closest && el.closest('[data-testid*="item"]'),
              () => el.closest && el.closest('[data-component*="item"]'),
              () => el.closest && el.closest("article"),
              () => el.closest && el.closest("li"),
              () => el.closest && el.closest('[role="listitem"]'),
              () =>
                anchor &&
                anchor.closest &&
                anchor.closest('article, li, [role="listitem"]'),
              () => el.parentElement,
            ];
            for (const pick of candidates) {
              try {
                const node = pick();
                if (node) return node;
              } catch {}
            }
            return el;
          };
          const computeRelativeSelector = (root, target) => {
            if (!root || !target || !root.contains(target)) return "";
            const parts = [];
            let node = target;
            while (node && node !== root && node.nodeType === 1) {
              let sel = node.nodeName.toLowerCase();
              try {
                const classList = Array.from(node.classList || [])
                  .filter(Boolean)
                  .slice(0, 2);
                if (classList.length) {
                  sel +=
                    "." +
                    classList
                      .map((c) =>
                        window.CSS && CSS.escape
                          ? CSS.escape(c)
                          : c.replace(/([ #;.])/g, "\\$1"),
                      )
                      .join(".");
                }
                const parent = node.parentElement;
                if (parent) {
                  const siblings = Array.from(parent.children).filter(
                    (ch) => ch.nodeName === node.nodeName,
                  );
                  if (siblings.length > 1) {
                    const idx = siblings.indexOf(node);
                    if (idx >= 0) sel += `:nth-of-type(${idx + 1})`;
                  }
                }
              } catch {}
              parts.unshift(sel);
              node = node.parentElement;
            }
            if (!parts.length) return "";
            return `:scope > ${parts.join(" > ")}`;
          };
          const stableClassList = (list) => {
            try {
              const arr = Array.isArray(list) ? list : Array.from(list || []);
              const filtered = arr.filter((cls) => cls && !/\d/.test(cls));
              const base = filtered.length ? filtered : arr;
              return base.filter(Boolean).sort();
            } catch {
              return [];
            }
          };
          const captureItemSignature = (el) => {
            if (!el || el.nodeType !== 1) return null;
            const classes = stableClassList(Array.from(el.classList || []));
            const role = (el.getAttribute && el.getAttribute("role")) || null;
            return { tag: (el.tagName || "").toLowerCase(), classes, role };
          };
          const matchesItemSignature = (el, sig) => {
            if (!el || !sig) return false;
            if ((el.tagName || "").toLowerCase() !== sig.tag) return false;
            if (sig.role) {
              const role = (el.getAttribute && el.getAttribute("role")) || null;
              if (role !== sig.role) return false;
            }
            const requiredClasses = stableClassList(sig.classes || []);
            if (requiredClasses.length) {
              const classList = new Set(
                stableClassList(Array.from(el.classList || [])),
              );
              return requiredClasses.every((cls) => classList.has(cls));
            }
            return true;
          };
          const countUniqueAnchors = (node) => {
            if (!node || !node.querySelectorAll) return 0;
            try {
              const anchors = node.querySelectorAll("a[href]");
              if (!anchors || !anchors.length) return 0;
              const unique = new Set();
              anchors.forEach((a) => {
                try {
                  const href =
                    toAbs(a) ||
                    a.href ||
                    (a.getAttribute && a.getAttribute("href")) ||
                    "";
                  if (href) unique.add(href);
                } catch {}
              });
              return unique.size || anchors.length;
            } catch {
              return 0;
            }
          };
          const tightenItemContainer = (
            anchorEl,
            candidate,
            boundary = null,
          ) => {
            const MAX_ROW_ANCHORS = 12;
            let node = candidate || anchorEl || null;
            if (!node) return null;
            const limit = boundary && boundary.contains ? boundary : null;
            node = applyRowHints(node, limit) || node;
            let best = node;
            while (node && node !== document.body) {
              if (limit && !limit.contains(node)) break;
              const hinted = applyRowHints(node, limit);
              if (hinted && hinted !== node) {
                node = hinted;
              }
              const anchorCount = countUniqueAnchors(node);
              if (!anchorCount) break;
              if (anchorCount <= MAX_ROW_ANCHORS) {
                best = node;
                if (matchesRowHint(node)) break;
              } else if (best) {
                break;
              }
              if (limit && node === limit) break;
              node = node.parentElement;
            }
            return best;
          };
          const listColumnNames = () => {
            const cols = Array.isArray(extractState.columns)
              ? extractState.columns.slice()
              : [];
            if (!cols.length && columnBindings) {
              Object.keys(columnBindings).forEach((col) => {
                if (!col) return;
                if (!cols.includes(col)) cols.push(col);
              });
            }
            return cols;
          };
          const readFromRelativeSelector = (root, selector) => {
            if (!root || !selector || !root.querySelector) return "";
            try {
              const node = root.querySelector(selector);
              return node ? (node.textContent || "").trim() : "";
            } catch {
              return "";
            }
          };
          const ensureLinkColumnExists = () => {
            if (listColumnNames().length) return;
            const columnName = "Capture Link";
            ensureColumn(columnName);
            if (!columnBindings[columnName]) {
              columnBindings[columnName] = {
                label: "Capture Link",
                createdAt: Date.now() + columnOrderCounter++,
                listSelector: "",
                detailSelector: "",
              };
            }
          };
          const getDetailSelectorFor = (columnName, label) => {
            if (
              columnBindings[columnName] &&
              columnBindings[columnName].detailSelector
            ) {
              return columnBindings[columnName].detailSelector;
            }
            if (detailSelectors[columnName]) return detailSelectors[columnName];
            if (label && detailSelectors[label]) return detailSelectors[label];
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
            const suggestedCol = (labelSuggestions[label] || label).trim();
            let val = "";
            let detailSelector = "";
            let listSelector = "";
            const anchorRef =
              el && el.matches && el.matches("a[href]")
                ? el
                : el && el.closest
                  ? el.closest("a[href]")
                  : null;
            let itemRoot = resolveItemRoot(el);
            if (itemRoot) {
              itemRoot =
                tightenItemContainer(anchorRef || el, itemRoot) || itemRoot;
              listSelector = computeRelativeSelector(itemRoot, el) || "";
            }
            if (label === "Capture Link") {
              const a = el.closest ? el.closest("a[href]") || null : null;
              val = a ? toAbs(a) : toAbs(el);
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
              try {
                const data = computeSiblingsFor(anchorEl);
                const items = (data && data.items) || [];
                siblingsHrefs = items
                  .map((it) => it && it.href)
                  .filter(Boolean);
                try {
                  let itemEl = null;
                  if (
                    data &&
                    data.elMap &&
                    baseAnchorHref &&
                    data.elMap[baseAnchorHref]
                  ) {
                    itemEl = data.elMap[baseAnchorHref];
                  }
                  if (!itemEl && data && data.container && anchorEl) {
                    const cont = data.container;
                    const kids = Array.from(cont.children || []);
                    let direct = kids.find(
                      (k) =>
                        k === anchorEl || (k.contains && k.contains(anchorEl)),
                    );
                    if (!direct) {
                      let n = anchorEl;
                      while (n && n.parentElement && n.parentElement !== cont)
                        n = n.parentElement;
                      if (n && n.parentElement === cont) direct = n;
                    }
                    itemEl = direct || itemEl;
                  }
                  if (!itemEl && anchorEl) {
                    let n = anchorEl;
                    while (n && n !== document.body) {
                      const p = n.parentElement;
                      if (!p) break;
                      const siblings = Array.from(p.children || []);
                      const count = siblings.reduce(
                        (acc, ch) =>
                          acc +
                          (ch.querySelector && ch.querySelector("a[href]")
                            ? 1
                            : 0),
                        0,
                      );
                      if (count >= 2) {
                        itemEl = n;
                        break;
                      }
                      n = p;
                    }
                  }
                  if (!itemEl && anchorEl && anchorEl.closest) {
                    itemEl = anchorEl.closest("li, article, [role=listitem]");
                  }
                  if (itemEl) {
                    itemEl =
                      tightenItemContainer(
                        anchorEl,
                        itemEl,
                        data && data.container,
                      ) || itemEl;
                    if (typeof makeSelector === "function") {
                      baseItemSelector = makeSelector(itemEl);
                    }
                    baseItemSignature = captureItemSignature(itemEl);
                    try {
                      saveState();
                    } catch {}
                  }
                } catch {}
                try {
                  if (typeof renderSiblings === "function")
                    renderSiblings(data, baseAnchorHref || val);
                } catch {}
                try {
                  const payload = {
                    selector: baseAnchorSelector || "",
                    currentHref: baseAnchorHref || val,
                    siblings: items,
                    pageUrl: location.href,
                    sessionId: sid,
                  };
                  if (window.reportSiblings) window.reportSiblings(payload);
                } catch {}
              } catch {}
            } else if (label === "Title") {
              val = extractTitle(el);
              try {
                if (typeof makeSelector === "function")
                  detailSelector = makeSelector(el);
              } catch {}
            } else if (label === "Date") {
              val = extractDate(el);
              try {
                if (typeof makeSelector === "function")
                  detailSelector = makeSelector(el);
              } catch {}
            } else if (label === "Capture Text") {
              val = extractDescription(el);
              try {
                if (typeof makeSelector === "function")
                  detailSelector = makeSelector(el);
              } catch {}
            } else {
              try {
                if (typeof makeSelector === "function")
                  detailSelector = makeSelector(el);
              } catch {}
              val = el && el.textContent ? el.textContent.trim() : "";
            }
            if (
              label !== "Capture Link" &&
              !detailSelector &&
              typeof makeSelector === "function"
            ) {
              try {
                detailSelector = makeSelector(el);
              } catch {
                detailSelector = "";
              }
            }
            const promptFn = window.__hliShowColPrompt
              ? window.__hliShowColPrompt
              : (lab, sugg, cb) => cb(sugg);
            promptFn(label, suggestedCol, (chosen) => {
              const columnName = (chosen || "").trim();
              if (!columnName) return;
              labelSuggestions[label] = columnName;
              ensureColumn(columnName);
              const existing = columnBindings[columnName] || {};
              const binding = {
                label,
                createdAt:
                  existing.createdAt || Date.now() + columnOrderCounter++,
                listSelector: existing.listSelector || "",
                detailSelector: existing.detailSelector || "",
              };
              if (label !== "Capture Link") {
                if (detailSelector) {
                  binding.detailSelector = detailSelector;
                  detailSelectors[columnName] = detailSelector;
                }
                if (listSelector) binding.listSelector = listSelector;
              } else {
                detailSelectors[columnName] = "";
                if (listSelector) binding.listSelector = listSelector;
              }
              columnBindings[columnName] = binding;
              addToTable(columnName, val);
              try {
                saveState();
              } catch {}
              try {
                refreshRenameUI();
              } catch {}
              try {
                emitExtractStateUpdate();
              } catch {}
            });
          };

          // Build a row object for a given element based on current column bindings
          const buildRowForElement = (el) => {
            const row = {};
            const columns = listColumnNames();
            const rawRoot = resolveItemRoot(el) || el;
            const anchor =
              el && el.matches && el.matches("a[href]")
                ? el
                : el && el.querySelector
                  ? el.querySelector("a[href]")
                  : el && el.closest
                    ? el.closest("a[href]")
                    : null;
            const itemRoot =
              tightenItemContainer(anchor || el, rawRoot) || rawRoot;
            const fallbackNode = itemRoot || anchor || el;
            columns.forEach((col) => {
              if (!col) return;
              const binding = columnBindings[col] || {};
              const label = binding.label || "Capture Text";
              let val = "";
              if (label === "Capture Link") {
                const linkEl =
                  anchor ||
                  (itemRoot && itemRoot.querySelector
                    ? itemRoot.querySelector("a[href]")
                    : null) ||
                  itemRoot;
                val = linkEl ? toAbs(linkEl) : "";
                if (!val && binding.listSelector && itemRoot) {
                  try {
                    const target = itemRoot.querySelector(binding.listSelector);
                    if (target)
                      val =
                        toAbs(target) ||
                        (target.getAttribute && target.getAttribute("href")) ||
                        (target.textContent || "").trim();
                  } catch {}
                }
              } else {
                if (binding.listSelector) {
                  val = readFromRelativeSelector(
                    itemRoot || el,
                    binding.listSelector,
                  );
                }
                if (!val) {
                  const context = fallbackNode || el;
                  if (label === "Title") {
                    val = extractTitle(context);
                  } else if (label === "Date") {
                    val = extractDate(context);
                  } else if (label === "Capture Text") {
                    val = extractDescription(context);
                  } else {
                    val =
                      context && context.textContent
                        ? context.textContent.trim()
                        : "";
                  }
                }
              }
              row[col] = (val || "").trim();
            });
            return row;
          };

          // Find next-page URL using common patterns and fallbacks
          const findNextPageUrl = () => {
            const abs = (u) => {
              try {
                return new URL(u, location.href).href;
              } catch {
                return null;
              }
            };
            // const prefer = (sel) => { const el = document.querySelector(sel); return el ? (el.getAttribute('href') || el.href || '') : ''; };
            // const cands = [
            //   prefer('link[rel=next]'),
            //   prefer('a[rel=next]'),
            //   prefer('a[rel=Next]'),
            //   prefer('a[aria-label="Next"]'),
            //   prefer('button[aria-label="Next"]'),
            //   prefer('a[title="Next"]'),
            //   prefer('a.pagination-next'),
            //   (()=>{ const n = document.querySelector('li.next a'); return n ? (n.getAttribute('href')||n.href||'') : ''; })(),
            // ].map(abs).filter(Boolean);
            // console.log('cands'+ cands)
            // if (cands.length) {
            //   return cands[0]; }
            const as = Array.from(document.querySelectorAll("a[href]"));
            const m = as.find((a) =>
              /\b(More Obituaries →|Next|next|older|More|more|>+|»|›)\b/i.test(
                (a.textContent || "").trim(),
              ),
            );

            return m ? abs(m.getAttribute("href") || m.href || "") : null;
          };
          // Heuristic: guess a reasonable base anchor on the page
          const guessBaseAnchor = () => {
            const preferIn = [
              "main",
              "article",
              ".content",
              ".container",
              "#content",
              "#main",
              "section",
              "body",
            ];
            const listLike = [
              "ul",
              "ol",
              ".list",
              ".items",
              ".results",
              ".search-results",
              ".post-list",
              ".card-list",
              ".grid",
              ".cards",
              ".media-list",
              ".listing",
              ".catalog",
              ".product-list",
            ];
            let best = null;
            const score = (el) => {
              try {
                const as = Array.from(el.querySelectorAll("a[href]"));
                const good = as.filter(
                  (a) =>
                    !/\b(prev(ious)?|back|first|last|older|newer|next)\b/i.test(
                      (a.textContent || "").trim(),
                    ),
                ).length;
                return good;
              } catch {
                return 0;
              }
            };
            for (const rootSel of preferIn) {
              const r = document.querySelector(rootSel);
              if (!r) continue;
              for (const sel of listLike) {
                const candidates = Array.from(r.querySelectorAll(sel));
                for (const c of candidates) {
                  const s = score(c);
                  if (s >= 3 && (!best || s > best.score))
                    best = { el: c, score: s };
                }
              }
            }
            let anchor = null;
            if (best && best.el) {
              anchor = best.el.querySelector("a[href]");
            }
            if (!anchor) {
              const roots = preferIn
                .map((s) => document.querySelector(s))
                .filter(Boolean);
              const pool = roots.length ? roots : [document.body];
              for (const r of pool) {
                const as = Array.from(r.querySelectorAll("a[href]"));
                anchor = as.find(
                  (a) =>
                    !/\b(prev(ious)?|back|first|last|older|newer|next)\b/i.test(
                      (a.textContent || "").trim(),
                    ),
                );
                if (anchor) break;
              }
            }
            return anchor || null;
          };

          // Try to find a clickable "Next" control (buttons or anchors without href)
          const findNextClickable = (preferredSel = null) => {
            const pick = (el) =>
              el && typeof el.click === "function" ? el : null;
            if (preferredSel) {
              const el = document.querySelector(preferredSel);
              if (el) return pick(el);
            }
            const sels = [
              'button[aria-label="Next"]',
              'button[title~="Next"]',
              "button.next",
              "li.next button",
              'a[role=button][aria-label="Next"]',
              "a[role=button].next",
              '[data-testid*="next" i]',
              '[data-test*="next" i]',
              '[aria-label*="next" i]',
              ".pagination .next button",
              ".pager .next button",
            ];
            for (const s of sels) {
              const el = document.querySelector(s);
              if (el) return pick(el);
            }
            return null;
          };

          const findLoadMoreButton = (preferredSel = null) => {
            const pick = (el) => {
              if (!el || typeof el.click !== "function") return null;
              if (
                el.matches &&
                el.matches(
                  "[disabled],[aria-disabled='true'],[aria-busy='true']",
                )
              )
                return null;
              return el;
            };
            if (preferredSel) {
              const el = document.querySelector(preferredSel);
              if (el) {
                const picked = pick(el);
                if (picked) return picked;
              }
            }
            const textRegex =
              /(load|show|display|get|view)\s+more|more\s+(stories|results|items|obituaries|entries)/i;
            const classRegex =
              /load[-_\s]?more|show[-_\s]?more|more[-_\s]?results|more[-_\s]?stories|more[-_\s]?items/i;
            const nodes = Array.from(
              document.querySelectorAll(
                "button, a[role='button'], a, [role='button'], [data-testid], [data-test], .load-more, .show-more",
              ),
            );
            for (const el of nodes) {
              if (!el) continue;
              const candidate = pick(el);
              if (!candidate) continue;
              const text = (
                (el.textContent || "") +
                " " +
                (el.getAttribute("aria-label") || "") +
                " " +
                (el.getAttribute("title") || "")
              )
                .trim()
                .toLowerCase();
              const dataAttrs = (
                (el.getAttribute("data-testid") || "") +
                " " +
                (el.getAttribute("data-test") || "") +
                " " +
                (el.className || "")
              )
                .trim()
                .toLowerCase();
              if (textRegex.test(text) || classRegex.test(dataAttrs)) {
                return candidate;
              }
            }
            return null;
          };

          // Pagination job controller persisted in sessionStorage
          // const continuePaginatedExtract = () => {
          //   const raw = sessionStorage.getItem('__hli_paginate__');
          //   if (!raw) return;
          //   let job = {};
          //   try { job = JSON.parse(raw) || {}; } catch { job = {}; }
          //   if (!job.active) return;
          //   try { const p = ensureTablePanel(); p._statusText.textContent = `Extracting page ${Math.max(1, (job.page||0)+1)} of ${job.maxPages||maxPagesSetting}...`; p._stopBtn.style.display = 'inline-block'; } catch {}
          //   if (!Object.keys(columnMap).length) columnMap['Capture Link'] = 'Capture Link';
          //   extractState.columns = Array.from(new Set(Object.values(columnMap)));
          //   // Parent-only extraction using saved item selector from page 1
          //   let parents = [];
          //   // If missing in the job (fresh start or resume), use the saved baseItemSelector
          //   try {
          //     if (!job.itemSelector && typeof baseItemSelector === 'string' && baseItemSelector) {
          //       job.itemSelector = baseItemSelector;
          //       try { sessionStorage.setItem('__hli_paginate__', JSON.stringify(job)); } catch {}
          //     }
          //   } catch {}
          //   try { if (job.itemSelector)
          //    parents = [Array.from(document.querySelectorAll('#tukios-obituary-listing > div:nth-child(10)'))[0].parentElement][0].childNodes;; } catch {}

          //    if (!parents || !parents.length) {
          //     // Nothing to extract on this page with the saved parent selector; stop gracefully
          //     // sessionStorage.removeItem('__hli_paginate__');
          //     try { const p = ensureTablePanel(); p._statusText.textContent = 'Done (no items found)'; p._stopBtn.style.display = 'none'; } catch {}
          //     // return;
          //   }

          //           try {
          //     // Remember container selector for subsequent pages if not already stored
          //     if (!job.containerSelector && typeof makeSelector === 'function') {
          //       const contEl = (parents && parents[0] && parents[0].parentElement) ? parents[0].parentElement : document.body;
          //       job.containerSelector = makeSelector(contEl);
          //       sessionStorage.setItem('__hli_paginate__', JSON.stringify(job));
          //     }
          //   } catch {}
          //   try {
          //     const seenRows = new Set(extractState.rows.map(r => r && r['Capture Link']).filter(Boolean));

          //     for (const parentEl of parents) {
          //       try {

          //         const row = buildRowForElement(parentEl);
          //         if (row && row['Capture Link'] && !seenRows.has(row['Capture Link'])) {
          //           extractState.rows.push(row);
          //           seenRows.add(row['Capture Link']);
          //         }
          //       } catch {}
          //     }
          //   } catch {}

          //   try { const p = ensureTablePanel(); p._countText.textContent = 'Rows: ' + (extractState.rows ? extractState.rows.length : 0); } catch {}
          //   renderTable();
          //   saveState();

          //   // After scraping this page, increment page counter and persist
          //   job.page = (job.page || 0) + 1;
          //   try { sessionStorage.setItem('__hli_paginate__', JSON.stringify(job)); } catch {}
          //   // Enforce max pages before attempting any navigation/click
          //   if (job.page >= (job.maxPages || maxPagesSetting || 5)) {
          //     // sessionStorage.removeItem('__hli_paginate__');
          //     // alert(maxPagesSetting)
          //     try { const p = ensureTablePanel(); p._statusText.textContent = 'Done (max pages reached)'; p._stopBtn.style.display = 'none'; } catch {}
          //     return;
          //   }
          //   // If user provided nextSelector, prefer clicking it to avoid full reloads
          //   if (job.nextSelector) {
          //     const clickable = findNextClickable(job.nextSelector || null);
          //     if (clickable) {
          //       try { const p = ensureTablePanel(); p._statusText.textContent = 'Navigating to next (click - forced)...'; } catch {}
          //       const prevUrl = location.href;
          //       const cont = (job.containerSelector && document.querySelector(job.containerSelector)) || (document.querySelector(job.itemSelector) && document.querySelector(job.itemSelector).parentElement) || document.body;
          //       let prevCount = 0, prevLen = 0;
          //       try { prevCount = cont ? cont.querySelectorAll('a[href]').length : document.querySelectorAll('a[href]').length; } catch {}
          //       try { prevLen = cont ? (cont.innerHTML||'').length : (document.body.innerHTML||'').length; } catch {}
          //       const waitChange = (timeout=20000) => new Promise((resolve) => {
          //         const start = Date.now();
          //         const tick = () => {
          //           const urlChanged = location.href !== prevUrl;
          //           let cnt = 0, len = 0;
          //           try { cnt = cont ? cont.querySelectorAll('a[href]').length : document.querySelectorAll('a[href]').length; } catch {}
          //           try { len = cont ? (cont.innerHTML||'').length : (document.body.innerHTML||'').length; } catch {}
          //           const domChanged = (cnt !== prevCount) || (Math.abs(len - prevLen) > 200);
          //           if (urlChanged || domChanged) return resolve(true);
          //           if (Date.now() - start > timeout) return resolve(false);
          //           setTimeout(tick, 250);
          //         };
          //         setTimeout(tick, 250);
          //       });
          //       try { clickable.scrollIntoView({ block: 'center' }); } catch {}
          //       setTimeout(() => {
          //         try {
          //           clickable.click();
          //         }
          //         catch
          //         {
          //           try
          //           {
          //             clickable.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, composed:true }));
          //           }
          //           catch {}
          //         }
          //         try { sessionStorage.setItem('__hli_paginate__', JSON.stringify(job)); } catch {}
          //         waitChange().then((ok) => {
          //           if (!ok) {
          //             // sessionStorage.removeItem('__hli_paginate__');
          //             try { const p = ensureTablePanel(); p._statusText.textContent = 'Done (no further pages)'; p._stopBtn.style.display = 'none'; } catch {}
          //             return;
          //           }
          //           // Give the DOM a moment to stabilize before next extraction
          //           setTimeout(() => { try { continuePaginatedExtract(); } catch {} }, 400);
          //         });
          //       }, 550);
          //       return;
          //     }
          //   }
          //   let nextUrl = findNextPageUrl();
          //   job.seen = job.seen || {};
          //   if (!nextUrl) {
          //     // Try clickable Next (button or link without href)
          //     const clickable = findNextClickable(job.nextSelector || null);
          //     if (clickable) {
          //       try { const p = ensureTablePanel(); p._statusText.textContent = 'Navigating to next (click)...'; } catch {}
          //       const prevUrl = location.href;
          //       const cont = (job.containerSelector && document.querySelector(job.containerSelector)) || (document.querySelector(job.itemSelector) && document.querySelector(job.itemSelector).parentElement) || document.body;
          //       let prevCount = 0, prevLen = 0;
          //       try { prevCount = cont ? cont.querySelectorAll('a[href]').length : document.querySelectorAll('a[href]').length; } catch {}
          //       try { prevLen = cont ? (cont.innerHTML||'').length : (document.body.innerHTML||'').length; } catch {}
          //       const waitChange = (timeout=20000) => new Promise((resolve) => {
          //         const start = Date.now();
          //         const tick = () => {
          //           const urlChanged = location.href !== prevUrl;
          //           let cnt = 0, len = 0;
          //           try { cnt = cont ? cont.querySelectorAll('a[href]').length : document.querySelectorAll('a[href]').length; } catch {}
          //           try { len = cont ? (cont.innerHTML||'').length : (document.body.innerHTML||'').length; } catch {}
          //           const domChanged = (cnt !== prevCount) || (Math.abs(len - prevLen) > 200);
          //           if (urlChanged || domChanged) return resolve(true);
          //           if (Date.now() - start > timeout) return resolve(false);
          //           setTimeout(tick, 250);
          //         };
          //         setTimeout(tick, 250);
          //       });
          //       try { clickable.scrollIntoView({ block: 'center' }); } catch {}
          //       setTimeout(() => {
          //         try { clickable.click(); } catch { try { clickable.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, composed:true })); } catch {} }
          //         try { sessionStorage.setItem('__hli_paginate__', JSON.stringify(job)); } catch {}
          //         waitChange().then((ok) => {
          //           if (!ok) {
          //             // Could not detect navigation/content change; stop gracefully
          //             // sessionStorage.removeItem('__hli_paginate__');
          //             try { const p = ensureTablePanel(); p._statusText.textContent = 'Done (no further pages)'; p._stopBtn.style.display = 'none'; } catch {}
          //             return;
          //           }
          //           // Content changed; continue extraction on same page context
          //           setTimeout(() => { try { continuePaginatedExtract(); } catch {} }, 400);
          //         });
          //       }, 150);
          //       return;
          //     }
          //   }
          //   if (!nextUrl || job.seen[nextUrl] || job.page >= (job.maxPages || 5)) {
          //     // sessionStorage.removeItem('__hli_paginate__');
          //     try { const p = ensureTablePanel(); p._statusText.textContent = 'Done'; p._stopBtn.style.display = 'none'; } catch {}
          //     return;
          //   }
          //   job.seen[nextUrl] = true;
          //   sessionStorage.setItem('__hli_paginate__', JSON.stringify(job));
          //   location.href = nextUrl;
          // };

          const anchorFromItemRoot = (node) => {
            if (!node) return null;
            if (node.matches && node.matches("a[href]")) return node;
            if (node.querySelector) {
              const anchor = node.querySelector("a[href]");
              if (anchor) return anchor;
            }
            return null;
          };
          const locateItemBySignature = (sig, scope = document) => {
            if (!sig || !sig.tag) return null;
            const root = scope && scope.querySelectorAll ? scope : document;
            const tag = sig.tag || "*";
            try {
              const nodes = root.querySelectorAll(tag);
              for (const node of nodes) {
                try {
                  if (matchesItemSignature(node, sig)) return node;
                } catch {}
              }
            } catch {}
            return null;
          };
          const recoverAnchorFromSavedContext = (job = {}) => {
            const selectors = [];
            const pushSelector = (sel) => {
              if (typeof sel === "string" && sel.trim()) {
                selectors.push(sel.trim());
              }
            };
            pushSelector(job.baseItemSelector);
            pushSelector(baseItemSelector);
            const container =
              job.containerSelector &&
              typeof document.querySelector === "function"
                ? document.querySelector(job.containerSelector)
                : null;
            for (const sel of selectors) {
              let el = null;
              try {
                if (container && container.querySelector) {
                  el = container.querySelector(sel);
                }
              } catch {}
              if (!el) {
                try {
                  el = document.querySelector(sel);
                } catch {}
              }
              const anchor = anchorFromItemRoot(el);
              if (anchor) return anchor;
            }
            const signatures = [];
            const pushSignature = (sig) => {
              if (sig && typeof sig === "object") signatures.push(sig);
            };
            pushSignature(job.baseItemSignature);
            pushSignature(baseItemSignature);
            for (const sig of signatures) {
              const el = locateItemBySignature(sig, container || document);
              const anchor = anchorFromItemRoot(el);
              if (anchor) return anchor;
            }
            if (container && container.querySelector) {
              const hints = [
                job.baseItemSelector,
                baseItemSelector,
                '[data-testid*="item"]',
                '[data-component*="item"]',
                ".obituary-item",
                ".obituary",
                ".list-item",
                ".listing",
                ".result",
                ".card",
                ".row",
                "article",
                "li",
                "[role=listitem]",
              ].filter(Boolean);
              for (const sel of hints) {
                try {
                  const el = container.querySelector(sel);
                  const anchor = anchorFromItemRoot(el);
                  if (anchor) return anchor;
                } catch {}
              }
              try {
                const fallback = container.querySelector("a[href]");
                if (fallback) return fallback;
              } catch {}
            }
            return null;
          };

          // continuePaginatedExtract function with this improved version
          const continuePaginatedExtract = () => {
            const raw = sessionStorage.getItem("__hli_paginate__");
            if (!raw) return;
            let job = {};
            try {
              job = JSON.parse(raw) || {};
            } catch {
              job = {};
            }
            if (!job.active) return;
            if (job.mode && job.mode === "details") {
              setTimeout(() => {
                try {
                  continuePaginatedExtractDetails();
                } catch {}
              }, 0);
              return;
            }
            let jobDirty = false;
            const justNavigated = !!job.justNavigated;
            if (job.justNavigated) {
              job.justNavigated = false;
              jobDirty = true;
            }
            const jobMaxPages = Math.max(
              1,
              Number(job.maxPages) || Number(maxPagesSetting) || 1,
            );
            if (!job.loadMoreMode && (job.page || 0) >= jobMaxPages) {
              try {
                const p = ensureTablePanel();
                p._statusText.textContent = "Done (max pages reached)";
                p._stopBtn.style.display = "none";
              } catch {}
              try {
                sessionStorage.removeItem("__hli_paginate__");
              } catch {}
              emitExtractStateUpdate();
              return;
            }

            try {
              const p = ensureTablePanel();
              p._statusText.textContent = `Extracting page ${Math.max(1, (job.page || 0) + 1)} of ${jobMaxPages}...`;
              p._stopBtn.style.display = "inline-block";
            } catch {}

            if (job.loadMoreMode && !job.loadMoreComplete) {
              const clicks = job.loadMoreClicks || 0;
              const loadMoreLimit = jobMaxPages;
              const loadMoreButton = findLoadMoreButton(
                job.nextSelector || null,
              );
              if (clicks >= loadMoreLimit || !loadMoreButton) {
                job.loadMoreComplete = true;
                jobDirty = true;
              } else {
                try {
                  const p = ensureTablePanel();
                  p._statusText.textContent = `Load more (${clicks + 1}/${loadMoreLimit})...`;
                } catch {}
                const loadContainer =
                  (job.containerSelector &&
                    document.querySelector(job.containerSelector)) ||
                  document.body;
                let prevCount = 0;
                let prevLen = 0;
                try {
                  prevCount = loadContainer
                    ? loadContainer.querySelectorAll("a[href]").length
                    : document.querySelectorAll("a[href]").length;
                } catch {}
                try {
                  prevLen = loadContainer
                    ? (loadContainer.innerHTML || "").length
                    : (document.body.innerHTML || "").length;
                } catch {}
                const waitLoadMoreChange = (timeout = 20000) =>
                  new Promise((resolve) => {
                    const start = Date.now();
                    const tick = () => {
                      let cnt = 0;
                      let len = 0;
                      try {
                        cnt = loadContainer
                          ? loadContainer.querySelectorAll("a[href]").length
                          : document.querySelectorAll("a[href]").length;
                      } catch {}
                      try {
                        len = loadContainer
                          ? (loadContainer.innerHTML || "").length
                          : (document.body.innerHTML || "").length;
                      } catch {}
                      if (cnt !== prevCount || Math.abs(len - prevLen) > 200)
                        return resolve(true);
                      if (Date.now() - start > timeout) return resolve(false);
                      setTimeout(tick, 250);
                    };
                    setTimeout(tick, 250);
                  });
                try {
                  loadMoreButton.scrollIntoView({ block: "center" });
                } catch {}
                setTimeout(() => {
                  try {
                    loadMoreButton.click();
                  } catch {
                    try {
                      loadMoreButton.dispatchEvent(
                        new MouseEvent("click", {
                          bubbles: true,
                          cancelable: true,
                          composed: true,
                        }),
                      );
                    } catch {}
                  }
                  waitLoadMoreChange().then((ok) => {
                    if (ok) {
                      job.loadMoreClicks = clicks + 1;
                    } else {
                      job.loadMoreComplete = true;
                    }
                    try {
                      sessionStorage.setItem(
                        "__hli_paginate__",
                        JSON.stringify(job),
                      );
                    } catch {}
                    setTimeout(() => {
                      try {
                        continuePaginatedExtract();
                      } catch {}
                    }, 400);
                  });
                }, 200);
                return;
              }
            }
            if (!job.baseItemSelector && baseItemSelector) {
              job.baseItemSelector = baseItemSelector;
              jobDirty = true;
            }
            if (!job.baseItemSignature && baseItemSignature) {
              job.baseItemSignature = baseItemSignature;
              jobDirty = true;
            }
            if (jobDirty) {
              try {
                sessionStorage.setItem("__hli_paginate__", JSON.stringify(job));
              } catch {}
            }
            jobDirty = false;

            ensureLinkColumnExists();
            extractState.columns = listColumnNames();
            // First, try to find the base anchor on the current page
            let baseAnchorOnPage = null;
            try {
              if (job.baseAnchorSelector) {
                baseAnchorOnPage = document.querySelector(
                  job.baseAnchorSelector,
                );
              }
              // If not found by selector, try by href
              if (!baseAnchorOnPage && job.baseAnchorHref) {
                const anchors = Array.from(
                  document.querySelectorAll("a[href]"),
                );
                baseAnchorOnPage = anchors.find((a) => {
                  try {
                    return toAbs(a) === job.baseAnchorHref;
                  } catch {
                    return false;
                  }
                });
              }
              if (!baseAnchorOnPage) {
                baseAnchorOnPage = recoverAnchorFromSavedContext(job);
              }
              // If still not found, try to guess a reasonable anchor
              if (!baseAnchorOnPage) {
                baseAnchorOnPage = guessBaseAnchor();
              }
            } catch {}

            const storedContainer =
              job.containerSelector &&
              typeof document.querySelector === "function"
                ? document.querySelector(job.containerSelector)
                : null;
            const pickAnchorFromContainer = (container) => {
              if (!container) return null;
              try {
                const anchors = Array.from(
                  container.querySelectorAll("a[href]"),
                );
                return anchors.find((a) => a && a.href) || null;
              } catch {
                return null;
              }
            };
            const containersMatch = (expected, actual) => {
              if (!expected || !actual) return false;
              if (expected === actual) return true;
              try {
                return expected.contains(actual) || actual.contains(expected);
              } catch {
                return false;
              }
            };

            const MAX_PAGE_SIGNATURE_LINKS = 25;
            const collectPageSignatureFromItems = (
              items,
              limit = MAX_PAGE_SIGNATURE_LINKS,
            ) => {
              if (!Array.isArray(items) || !items.length) return [];
              const signature = [];
              const seen = new Set();
              for (const item of items) {
                const href = item && item.href;
                if (!href || seen.has(href)) continue;
                seen.add(href);
                signature.push(href);
                if (signature.length >= limit) break;
              }
              return signature;
            };
            const signatureKey = (signature) =>
              Array.isArray(signature) && signature.length
                ? signature.join("||")
                : "";
            const signaturesEqual = (a, b) => {
              if (!Array.isArray(a) || !Array.isArray(b)) return false;
              if (a.length !== b.length) return false;
              for (let i = 0; i < a.length; i += 1) {
                if (a[i] !== b[i]) return false;
              }
              return true;
            };
            const hasVisitedSignature = (job, signature) => {
              if (!job || !Array.isArray(signature) || !signature.length)
                return false;
              const key = signatureKey(signature);
              if (!key) return false;
              const map =
                job.visitedSignatureMap || job.visitedSignatures || {};
              return !!map[key];
            };
            const rememberSignature = (job, signature) => {
              if (!job || !Array.isArray(signature) || !signature.length)
                return;
              const key = signatureKey(signature);
              if (!key) return;
              if (!job.visitedSignatureMap) job.visitedSignatureMap = {};
              job.visitedSignatureMap[key] = true;
            };
            const resolveJobContainer = (job, fallback = null) => {
              if (job && job.containerSelector) {
                try {
                  const el = document.querySelector(job.containerSelector);
                  if (el) return el;
                } catch {}
              }
              if (
                fallback &&
                typeof fallback.querySelectorAll === "function" &&
                typeof document.contains === "function"
              ) {
                try {
                  if (document.contains(fallback)) return fallback;
                } catch {}
              }
              return null;
            };
            const captureSignatureFromDom = (
              job,
              fallback = null,
              limit = MAX_PAGE_SIGNATURE_LINKS,
            ) => {
              const container =
                resolveJobContainer(job, fallback) || document.body || null;
              if (!container || !container.querySelectorAll) return [];
              try {
                const anchors = Array.from(
                  container.querySelectorAll("a[href]"),
                );
                const signature = [];
                const seen = new Set();
                for (const a of anchors) {
                  let href = "";
                  try {
                    href = toAbs(a);
                  } catch {
                    href =
                      (a && (a.getAttribute ? a.getAttribute("href") : "")) ||
                      (a && a.href) ||
                      "";
                  }
                  if (!href || seen.has(href)) continue;
                  seen.add(href);
                  signature.push(href);
                  if (signature.length >= limit) break;
                }
                return signature;
              } catch {
                return [];
              }
            };
            const snapshotContainerStats = (job, fallback = null) => {
              const container =
                resolveJobContainer(job, fallback) || fallback || document.body;
              let count = 0;
              let len = 0;
              try {
                count =
                  container && container.querySelectorAll
                    ? container.querySelectorAll("a[href]").length
                    : document.querySelectorAll("a[href]").length;
              } catch {}
              try {
                len =
                  container && typeof container.innerHTML === "string"
                    ? (container.innerHTML || "").length
                    : (document.body.innerHTML || "").length;
              } catch {}
              return { count, len };
            };
            const waitForPaginationChange = ({
              job,
              fallbackContainer = null,
              prevUrl = "",
              prevSignature = [],
              timeout = 20000,
            }) => {
              const prevStats = snapshotContainerStats(job, fallbackContainer);
              const prevSig = Array.isArray(prevSignature)
                ? prevSignature.slice()
                : [];
              return new Promise((resolve) => {
                let done = false;
                let observer = null;
                const finish = (ok) => {
                  if (done) return;
                  done = true;
                  if (observer && observer.disconnect) {
                    try {
                      observer.disconnect();
                    } catch {}
                  }
                  resolve(ok);
                };
                const signatureChanged = () => {
                  if (!prevSig.length) return false;
                  const current = captureSignatureFromDom(
                    job,
                    fallbackContainer,
                  );
                  return current.length && !signaturesEqual(prevSig, current);
                };
                const target =
                  resolveJobContainer(job, fallbackContainer) ||
                  fallbackContainer ||
                  document.body;
                if (
                  typeof MutationObserver === "function" &&
                  target &&
                  prevSig.length
                ) {
                  observer = new MutationObserver(() => {
                    if (signatureChanged()) finish(true);
                  });
                  try {
                    observer.observe(target, {
                      childList: true,
                      subtree: true,
                    });
                  } catch {
                    try {
                      observer.disconnect();
                    } catch {}
                  }
                }
                const start = Date.now();
                const tick = () => {
                  if (done) return;
                  const urlChanged = prevUrl
                    ? location.href !== prevUrl
                    : false;
                  const stats = snapshotContainerStats(job, fallbackContainer);
                  const domChanged =
                    !prevSig.length &&
                    (stats.count !== prevStats.count ||
                      stats.len !== prevStats.len);
                  const sigChanged = signatureChanged();
                  if (urlChanged || domChanged || sigChanged)
                    return finish(true);
                  if (Date.now() - start > timeout) return finish(false);
                  setTimeout(tick, 250);
                };
                setTimeout(tick, 250);
              });
            };

            // Use computeSiblingsFor to find siblings consistently with the same approach as the popup
            let siblings = { items: [], container: null, elMap: {} };
            console.log("baseAnchorOnPage called", baseAnchorOnPage);
            try {
              let anchorForSiblings = pickAnchorFromContainer(storedContainer);
              if (!anchorForSiblings) {
                anchorForSiblings = baseAnchorOnPage;
              }
              if (
                !anchorForSiblings &&
                job.containerSelector &&
                storedContainer
              ) {
                anchorForSiblings = pickAnchorFromContainer(storedContainer);
              }
              if (!anchorForSiblings) {
                anchorForSiblings = guessBaseAnchor();
              }
              if (anchorForSiblings) {
                siblings = computeSiblingsFor(anchorForSiblings);
              }

              // If the detected container doesn't match the saved one, try using the saved container directly
              if (
                storedContainer &&
                (!siblings.container ||
                  !containersMatch(storedContainer, siblings.container))
              ) {
                const fallbackAnchor = pickAnchorFromContainer(storedContainer);
                if (fallbackAnchor) {
                  siblings = computeSiblingsFor(fallbackAnchor);
                }
              }

              // Store the container selector for future pages if not already stored
              if (
                !job.containerSelector &&
                siblings.container &&
                typeof makeSelector === "function"
              ) {
                job.containerSelector = makeSelector(siblings.container);
                sessionStorage.setItem("__hli_paginate__", JSON.stringify(job));
              }
            } catch {}

            const fallbackNavContainer =
              siblings.container || storedContainer || document.body;
            const currentSignature = collectPageSignatureFromItems(
              siblings.items || [],
            );
            let repeatedPage = false;
            if (
              justNavigated &&
              currentSignature.length &&
              (job.page || 0) > 0
            ) {
              const sameAsLast =
                Array.isArray(job.lastPageSignature) &&
                signaturesEqual(job.lastPageSignature, currentSignature);
              if (sameAsLast || hasVisitedSignature(job, currentSignature)) {
                repeatedPage = true;
              }
            }
            if (!repeatedPage && currentSignature.length) {
              rememberSignature(job, currentSignature);
              job.lastPageSignature = currentSignature;
              jobDirty = true;
            }
            if (jobDirty) {
              try {
                sessionStorage.setItem("__hli_paginate__", JSON.stringify(job));
              } catch {}
              jobDirty = false;
            }
            if (repeatedPage) {
              try {
                const p = ensureTablePanel();
                p._statusText.textContent = "Done (no new results)";
                p._stopBtn.style.display = "none";
              } catch {}
              try {
                sessionStorage.removeItem("__hli_paginate__");
              } catch {}
              emitExtractStateUpdate();
              return;
            }

            // Extract data from siblings
            try {
              const seenRows = new Set(
                extractState.rows
                  .map((r) => r && r["Capture Link"])
                  .filter(Boolean),
              );
              const items = siblings.items || [];
              if (items.length) {
                const merged = new Set(
                  Array.isArray(siblingsHrefs) ? siblingsHrefs : [],
                );
                for (const item of items) {
                  if (item && item.href) merged.add(item.href);
                }
                siblingsHrefs = Array.from(merged);
              }

              const currentPageIndex = job.page || 0;
              for (const item of items) {
                try {
                  if (!item.href || seenRows.has(item.href)) continue;

                  // Get the element from the element map
                  const el = siblings.elMap[item.href] || null;
                  if (!el) continue;

                  const row = buildRowForElement(el);
                  row.__hliPageIndex = currentPageIndex;
                  if (
                    row &&
                    row["Capture Link"] &&
                    !seenRows.has(row["Capture Link"])
                  ) {
                    extractState.rows.push(row);
                    seenRows.add(row["Capture Link"]);
                  }
                } catch {}
              }
            } catch {}

            try {
              const p = ensureTablePanel();
              p._countText.textContent =
                "Rows: " + (extractState.rows ? extractState.rows.length : 0);
            } catch {}

            renderTable();
            saveState();

            if (job.loadMoreMode) {
              job.page = jobMaxPages;
              job.active = false;
              try {
                sessionStorage.removeItem("__hli_paginate__");
              } catch {}
              try {
                const p = ensureTablePanel();
                p._statusText.textContent = "Done (load more)";
                p._stopBtn.style.display = "none";
              } catch {}
              emitExtractStateUpdate();
              return;
            }

            // After scraping this page, increment page counter and persist
            job.page = (job.page || 0) + 1;
            try {
              sessionStorage.setItem("__hli_paginate__", JSON.stringify(job));
            } catch {}

            // Enforce max pages before attempting any navigation/click
            if (job.page >= jobMaxPages) {
              try {
                const p = ensureTablePanel();
                p._statusText.textContent = "Done (max pages reached)";
                p._stopBtn.style.display = "none";
              } catch {}
              try {
                sessionStorage.removeItem("__hli_paginate__");
              } catch {}
              emitExtractStateUpdate();
              return;
            }

            // Navigation logic - first try clicking with nextSelector if provided
            if (job.nextSelector) {
              const clickable = findNextClickable(job.nextSelector || null);
              if (clickable) {
                try {
                  const p = ensureTablePanel();
                  p._statusText.textContent =
                    "Navigating to next (click - forced)...";
                } catch {}
                const prevUrl = location.href;
                const waitChange = (timeout = 20000) =>
                  waitForPaginationChange({
                    job,
                    fallbackContainer: fallbackNavContainer,
                    prevUrl,
                    prevSignature: currentSignature,
                    timeout,
                  });

                try {
                  clickable.scrollIntoView({ block: "center" });
                } catch {}
                setTimeout(() => {
                  try {
                    clickable.click();
                  } catch {
                    try {
                      clickable.dispatchEvent(
                        new MouseEvent("click", {
                          bubbles: true,
                          cancelable: true,
                          composed: true,
                        }),
                      );
                    } catch {}
                  }

                  try {
                    sessionStorage.setItem(
                      "__hli_paginate__",
                      JSON.stringify(job),
                    );
                  } catch {}
                  const NAV_DELAY_MS = 5000;
                  setTimeout(() => {
                    waitChange().then((ok) => {
                      if (!ok) {
                        console.log(
                          "Navigation or content change not detected after click",
                        );
                        try {
                          const p = ensureTablePanel();
                          p._statusText.textContent = "Done (no further pages)";
                          p._stopBtn.style.display = "none";
                        } catch {}
                        // continuePaginatedExtract();
                        return;
                      } else if (ok) {
                        job.baseAnchorSelector = null;
                        job.baseAnchorHref = null;
                        job.justNavigated = true;
                        try {
                          sessionStorage.setItem(
                            "__hli_paginate__",
                            JSON.stringify(job),
                          );
                        } catch {}
                        setTimeout(() => {
                          try {
                            continuePaginatedExtract();
                          } catch {}
                        }, 400);
                      }
                    });
                  }, NAV_DELAY_MS);
                }, 550);
                return;
              }
            }

            // Try to find next page URL if clicking didn't work
            let nextUrl = findNextPageUrl();
            job.seen = job.seen || {};

            if (!nextUrl) {
              // Try clickable Next (button or link without href)
              const clickable = findNextClickable(job.nextSelector || null);
              console.log(
                "No next URL found, trying clickable next...",
                clickable,
              );
              if (clickable) {
                try {
                  const p = ensureTablePanel();
                  p._statusText.textContent = "Navigating to next (click)...";
                } catch {}
                const prevUrl = location.href;
                const waitChange = (timeout = 20000) =>
                  waitForPaginationChange({
                    job,
                    fallbackContainer: fallbackNavContainer,
                    prevUrl,
                    prevSignature: currentSignature,
                    timeout,
                  });

                try {
                  clickable.scrollIntoView({ block: "center" });
                } catch {}
                setTimeout(() => {
                  try {
                    clickable.click();
                  } catch {
                    try {
                      clickable.dispatchEvent(
                        new MouseEvent("click", {
                          bubbles: true,
                          cancelable: true,
                          composed: true,
                        }),
                      );
                    } catch {}
                  }

                  try {
                    sessionStorage.setItem(
                      "__hli_paginate__",
                      JSON.stringify(job),
                    );
                  } catch {}

                  waitChange().then((ok) => {
                    if (!ok) {
                      try {
                        const p = ensureTablePanel();
                        p._statusText.textContent = "Done (no further pages)";
                        p._stopBtn.style.display = "none";
                      } catch {}
                      try {
                        sessionStorage.removeItem("__hli_paginate__");
                      } catch {}
                      // emitExtractStateUpdate();
                      return;
                    } else if (ok) {
                      job.baseAnchorSelector = null;
                      job.baseAnchorHref = null;
                      job.justNavigated = true;
                      try {
                        sessionStorage.setItem(
                          "__hli_paginate__",
                          JSON.stringify(job),
                        );
                      } catch {}
                      // Content changed; continue extraction on same page context
                      setTimeout(() => {
                        try {
                          continuePaginatedExtract();
                        } catch {}
                      }, 400);
                    }
                  });
                }, 150);
                return;
              }
            }

            if (!nextUrl || job.seen[nextUrl] || job.page >= jobMaxPages) {
              try {
                const p = ensureTablePanel();
                p._statusText.textContent = "Done";
                p._stopBtn.style.display = "none";
              } catch {}
              try {
                sessionStorage.removeItem("__hli_paginate__");
              } catch {}
              emitExtractStateUpdate();
              return;
            }

            job.seen[nextUrl] = true;
            job.baseAnchorSelector = null;
            job.baseAnchorHref = null;
            job.justNavigated = true;
            sessionStorage.setItem("__hli_paginate__", JSON.stringify(job));
            location.href = nextUrl;
          };

          const continuePaginatedExtractDetails = async () => {
            const raw = sessionStorage.getItem("__hli_paginate__");
            if (!raw) return;
            let job = {};
            try {
              job = JSON.parse(raw) || {};
            } catch {
              job = {};
            }
            if (job.mode && job.mode !== "details") return;
            //   if (!job.active) return;
            let jobDirty = false;
            if (job.justNavigated) {
              job.justNavigated = false;
              jobDirty = true;
            }
            const jobMaxPages = Math.max(
              1,
              Number(job.maxPages) || Number(maxPagesSetting) || 1,
            );
            if ((job.page || 0) >= jobMaxPages) {
              try {
                const p = ensureTablePanel();
                p._statusText.textContent = "Done (max pages reached)";
                p._stopBtn.style.display = "none";
              } catch {}
              try {
                sessionStorage.removeItem("__hli_paginate__");
              } catch {}
              emitExtractStateUpdate();
              return;
            }
            if (jobDirty) {
              try {
                sessionStorage.setItem("__hli_paginate__", JSON.stringify(job));
              } catch {}
              jobDirty = false;
            }

            try {
              const p = ensureTablePanel();
              p._statusText.textContent = `Extracting page ${Math.max(1, (job.page || 0) + 1)} of ${jobMaxPages}...`;
              p._stopBtn.style.display = "inline-block";
            } catch {}

            await extractAllDetails();

            // After scraping this page, increment page counter and persist
            job.page = (job.page || 0) + 1;
            try {
              sessionStorage.setItem("__hli_paginate__", JSON.stringify(job));
            } catch {}

            // Enforce max pages before attempting any navigation/click
            if (job.page >= jobMaxPages) {
              try {
                const p = ensureTablePanel();
                p._statusText.textContent = "Done (max pages reached)";
                p._stopBtn.style.display = "none";
              } catch {}
              try {
                sessionStorage.removeItem("__hli_paginate__");
              } catch {}
              emitExtractStateUpdate();
              return;
            }

            // Navigation logic - first try clicking with nextSelector if provided
            if (job.nextSelector) {
              const clickable = findNextClickable(job.nextSelector || null);
              if (clickable) {
                try {
                  const p = ensureTablePanel();
                  p._statusText.textContent =
                    "Navigating to next (click - forced)...";
                } catch {}
                const prevUrl = location.href;
                const fallbackContainer =
                  resolveJobContainer(job) || document.body;
                const waitChange = (timeout = 20000) =>
                  waitForPaginationChange({
                    job,
                    fallbackContainer,
                    prevUrl,
                    prevSignature: [],
                    timeout,
                  });

                try {
                  clickable.scrollIntoView({ block: "center" });
                } catch {}
                setTimeout(() => {
                  try {
                    clickable.click();
                  } catch {
                    try {
                      clickable.dispatchEvent(
                        new MouseEvent("click", {
                          bubbles: true,
                          cancelable: true,
                          composed: true,
                        }),
                      );
                    } catch {}
                  }

                  try {
                    sessionStorage.setItem(
                      "__hli_paginate__",
                      JSON.stringify(job),
                    );
                  } catch {}

                  waitChange().then((ok) => {
                    if (!ok) {
                      try {
                        const p = ensureTablePanel();
                        p._statusText.textContent = "Done (no further pages)";
                        p._stopBtn.style.display = "none";
                      } catch {}
                      try {
                        sessionStorage.removeItem("__hli_paginate__");
                      } catch {}
                      // emitExtractStateUpdate();
                      return;
                    }
                    job.justNavigated = true;
                    job.baseAnchorSelector = null;
                    job.baseAnchorHref = null;
                    try {
                      sessionStorage.setItem(
                        "__hli_paginate__",
                        JSON.stringify(job),
                      );
                    } catch {}
                    setTimeout(() => {
                      try {
                        continuePaginatedExtractDetails();
                      } catch {}
                    }, 400);
                  });
                }, 550);
                return;
              }
            }

            // Try to find next page URL if clicking didn't work
            let nextUrl = findNextPageUrl();
            job.seen = job.seen || {};

            if (!nextUrl) {
              // Try clickable Next (button or link without href)
              const clickable = findNextClickable(job.nextSelector || null);
              if (clickable) {
                try {
                  const p = ensureTablePanel();
                  p._statusText.textContent = "Navigating to next (click)...";
                } catch {}
                const prevUrl = location.href;
                const fallbackContainer =
                  resolveJobContainer(job) || document.body;
                const waitChange = (timeout = 20000) =>
                  waitForPaginationChange({
                    job,
                    fallbackContainer,
                    prevUrl,
                    prevSignature: [],
                    timeout,
                  });

                try {
                  clickable.scrollIntoView({ block: "center" });
                } catch {}
                setTimeout(() => {
                  try {
                    clickable.click();
                  } catch {
                    try {
                      clickable.dispatchEvent(
                        new MouseEvent("click", {
                          bubbles: true,
                          cancelable: true,
                          composed: true,
                        }),
                      );
                    } catch {}
                  }

                  try {
                    sessionStorage.setItem(
                      "__hli_paginate__",
                      JSON.stringify(job),
                    );
                  } catch {}

                  waitChange().then((ok) => {
                    if (!ok) {
                      try {
                        const p = ensureTablePanel();
                        p._statusText.textContent = "Done (no further pages)";
                        p._stopBtn.style.display = "none";
                      } catch {}
                      try {
                        sessionStorage.removeItem("__hli_paginate__");
                      } catch {}
                      // emitExtractStateUpdate();
                      return;
                    }
                    job.justNavigated = true;
                    job.baseAnchorSelector = null;
                    job.baseAnchorHref = null;
                    try {
                      sessionStorage.setItem(
                        "__hli_paginate__",
                        JSON.stringify(job),
                      );
                    } catch {}
                    // Content changed; continue extraction on same page context
                    setTimeout(() => {
                      try {
                        continuePaginatedExtractDetails();
                      } catch {}
                    }, 400);
                  });
                }, 150);
                return;
              }
            }

            if (!nextUrl || job.seen[nextUrl] || job.page >= jobMaxPages) {
              try {
                const p = ensureTablePanel();
                p._statusText.textContent = "Done";
                p._stopBtn.style.display = "none";
              } catch {}
              try {
                sessionStorage.removeItem("__hli_paginate__");
              } catch {}
              emitExtractStateUpdate();
              return;
            }

            job.seen[nextUrl] = true;
            job.baseAnchorSelector = null;
            job.baseAnchorHref = null;
            sessionStorage.setItem("__hli_paginate__", JSON.stringify(job));
            location.href = nextUrl;
          };

          // Update the startPaginatedExtract function to store the base anchor information
          // const startPaginatedExtract = (maxPages = 5, nextSelector = null) => {
          //   // Store the base anchor selector and href for consistent sibling detection
          //   const job = {
          //     baseAnchorSelector: baseAnchorSelector || null,
          //     baseAnchorHref: baseAnchorHref || null,
          //     active: true,
          //     maxPages: Math.max(1, maxPages|0),
          //     nextSelector,
          //     page: 0,
          //     seen: {}
          //   };

          //   sessionStorage.setItem('__hli_paginate__', JSON.stringify(job));

          //   try {
          //     const p = ensureTablePanel();
          //     p._statusText.textContent = `Starting (max ${job.maxPages})...`;
          //     p._countText.textContent = 'Rows: ' + (extractState.rows ? extractState.rows.length : 0);
          //     p._stopBtn.style.display = 'inline-block';
          //   } catch {}

          //   continuePaginatedExtract();
          // };

          const PAGINATION_START_DELAY_MS = 5000;

          const startPaginatedExtractAllDetail = (
            maxPages = 5,
            nextSelector = null,
          ) => {
            // Auto-detect pagination selector if not provided
            if (!nextSelector) {
              // Try to find a good pagination selector automatically
              const candidates = [
                'a[rel="next"]',
                'link[rel="next"]',
                "a.next",
                "button.next",
                'a[aria-label="Next"]',
                'button[aria-label="Next"]',
                '.pagination a:contains("Next")',
                '.pagination a:contains("»")',
                '.pagination a:contains(">")',
                ".pager .next a",
                "nav ul li.next a",
                '[role="navigation"] a:contains("Next")',
              ];

              for (const selector of candidates) {
                try {
                  const el = document.querySelector(selector);
                  if (el) {
                    nextSelector = makeSelector(el);
                    // Update the input field
                    const nextSelInp = document.getElementById(
                      "__hli_pagination_selector__",
                    );
                    if (nextSelInp) nextSelInp.value = nextSelector;
                    break;
                  }
                } catch {}
              }

              // If still not found, try a more generic approach
              if (!nextSelector) {
                const allLinks = Array.from(
                  document.querySelectorAll("a[href]"),
                );
                const nextLink = allLinks.find((a) => {
                  const text = (a.textContent || "").trim().toLowerCase();
                  return /^(next|next page|»|›|>+)$/i.test(text);
                });

                if (nextLink) {
                  nextSelector = makeSelector(nextLink);
                  // Update the input field
                  const nextSelInp = document.getElementById(
                    "__hli_pagination_selector__",
                  );
                  if (nextSelInp) nextSelInp.value = nextSelector;
                }
              }
            }

            const resolvedPages = Math.max(1, maxPages | 0);
            applyMaxPagesValue(resolvedPages, { silent: true });
            extractState.columns = listColumnNames();
            extractState.rows = [];
            clearRowsBackup();
            saveState();
            // Store the base anchor selector and href for consistent sibling detection
            const job = {
              baseAnchorSelector: baseAnchorSelector || null,
              baseAnchorHref: baseAnchorHref || null,
              baseItemSelector: baseItemSelector || null,
              baseItemSignature: baseItemSignature || null,
              active: true,
              maxPages: resolvedPages,
              nextSelector,
              page: 0,
              seen: {},
              mode: "details",
              visitedSignatureMap: {},
              lastPageSignature: null,
              justNavigated: false,
              loadMoreMode: false,
              loadMoreClicks: 0,
              loadMoreComplete: true,
            };

            sessionStorage.setItem("__hli_paginate__", JSON.stringify(job));

            try {
              const p = ensureTablePanel();
              p._statusText.textContent = `Starting (max ${job.maxPages})...${nextSelector ? "" : " Auto-detecting pagination..."}`;
              p._countText.textContent =
                "Rows: " + (extractState.rows ? extractState.rows.length : 0);
              p._stopBtn.style.display = "inline-block";
            } catch {}
            emitExtractStateUpdate();

            setTimeout(() => {
              try {
                continuePaginatedExtractDetails();
              } catch {}
            }, PAGINATION_START_DELAY_MS);
          };

          const startPaginatedExtract = (
            maxPages = 5,
            nextSelector = null,
            loadMoreOverride = null,
          ) => {
            // Auto-detect pagination selector if not provided
            if (!nextSelector) {
              // Try to find a good pagination selector automatically
              const candidates = [
                'a[rel="next"]',
                'link[rel="next"]',
                "a.next",
                "button.next",
                'a[aria-label="Next"]',
                'button[aria-label="Next"]',
                '.pagination a:contains("Next")',
                '.pagination a:contains("»")',
                '.pagination a:contains(">")',
                ".pager .next a",
                "nav ul li.next a",
                '[role="navigation"] a:contains("Next")',
              ];

              for (const selector of candidates) {
                try {
                  const el = document.querySelector(selector);
                  if (el) {
                    nextSelector = makeSelector(el);
                    // Update the input field
                    const nextSelInp = document.getElementById(
                      "__hli_pagination_selector__",
                    );
                    if (nextSelInp) nextSelInp.value = nextSelector;
                    break;
                  }
                } catch {}
              }

              // If still not found, try a more generic approach
              if (!nextSelector) {
                const allLinks = Array.from(
                  document.querySelectorAll("a[href]"),
                );
                const nextLink = allLinks.find((a) => {
                  const text = (a.textContent || "").trim().toLowerCase();
                  return /^(next|next page|»|›|>+)$/i.test(text);
                });

                if (nextLink) {
                  nextSelector = makeSelector(nextLink);
                  // Update the input field
                  const nextSelInp = document.getElementById(
                    "__hli_pagination_selector__",
                  );
                  if (nextSelInp) nextSelInp.value = nextSelector;
                }
              }
            }

            const resolvedPages = Math.max(1, maxPages | 0);
            applyMaxPagesValue(resolvedPages, { silent: true });
            extractState.columns = listColumnNames();
            extractState.rows = [];
            clearRowsBackup();
            saveState();
            // Store the base anchor selector and href for consistent sibling detection
            const jobLoadMore =
              typeof loadMoreOverride === "boolean"
                ? loadMoreOverride
                : !!loadMoreMode;
            const job = {
              baseAnchorSelector: baseAnchorSelector || null,
              baseAnchorHref: baseAnchorHref || null,
              baseItemSelector: baseItemSelector || null,
              baseItemSignature: baseItemSignature || null,
              active: true,
              maxPages: resolvedPages,
              nextSelector,
              page: 0,
              seen: {},
              mode: "list",
              visitedSignatureMap: {},
              lastPageSignature: null,
              justNavigated: false,
              loadMoreMode: jobLoadMore,
              loadMoreClicks: 0,
              loadMoreComplete: !jobLoadMore,
            };

            sessionStorage.setItem("__hli_paginate__", JSON.stringify(job));

            try {
              const p = ensureTablePanel();
              p._statusText.textContent = `Starting (max ${job.maxPages})...${nextSelector ? "" : " Auto-detecting pagination..."}`;
              p._countText.textContent =
                "Rows: " + (extractState.rows ? extractState.rows.length : 0);
              p._stopBtn.style.display = "inline-block";
            } catch {}
            emitExtractStateUpdate();

            setTimeout(() => {
              try {
                continuePaginatedExtract();
              } catch {}
            }, PAGINATION_START_DELAY_MS);
          };

          const resumePaginatedIfNeeded = () => {
            const raw = sessionStorage.getItem("__hli_paginate__");
            if (!raw) return;
            let job = null;
            try {
              job = JSON.parse(raw) || {};
              const p = ensureTablePanel();
              if (job && job.active) {
                // Repaint restored table immediately so user sees progress after refresh
                try {
                  renderTable();
                } catch {}
                p._statusText.textContent = `Resuming page ${Math.max(1, (job.page || 0) + 1)} of ${job.maxPages || maxPagesSetting}...`;
                p._countText.textContent =
                  "Rows: " + (extractState.rows ? extractState.rows.length : 0);
                p._stopBtn.style.display = "inline-block";
              }
            } catch {}
            setTimeout(() => {
              try {
                if (job && job.mode === "details") {
                  continuePaginatedExtractDetails();
                } else {
                  continuePaginatedExtract();
                }
              } catch {}
            }, 60);
          };

          const stopPaginatedExtract = () => {
            try {
              sessionStorage.removeItem("__hli_paginate__");
            } catch {}
            try {
              const p = ensureTablePanel();
              p._statusText.textContent = "Stopped";
              p._countText.textContent =
                "Rows: " + (extractState.rows ? extractState.rows.length : 0);
              p._stopBtn.style.display = "none";
            } catch {}
            emitExtractStateUpdate();
          };

          // Extract all using siblings of the current hovered element's nearest anchor
          const extractAllUsingSiblings = () => {
            ensureLinkColumnExists();
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
            const fallbackHoverAnchor = () => {
              try {
                if (lastHoverSelector) {
                  const el = document.querySelector(lastHoverSelector);
                  if (el && el.closest) {
                    return el.closest("a[href]") || el;
                  }
                  return el;
                }
              } catch {}
              return null;
            };
            const anchor =
              resolveBaseAnchor() ||
              (lastTarget && lastTarget.closest
                ? lastTarget.closest("a[href]")
                : null) ||
              fallbackHoverAnchor();
            const data = computeSiblingsFor(anchor);
            const items = (data && data.items) || [];
            if (!items.length) {
              alert("No siblings found. Hover a list item link and try again.");
            }
            // Reset table to multi-row mode for export
            extractState.columns = listColumnNames();
            extractState.rows = [];
            clearRowsBackup();
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

          const ensureDetailWindow = () => {
            try {
              if (detailWindowRef && !detailWindowRef.closed) {
                try {
                  detailWindowRef.focus();
                } catch {}
                return detailWindowRef;
              }
              const win = window.open(
                "about:blank",
                "__hli_details_viewer__",
                "width=1100,height=800,resizable=yes",
              );
              if (!win) return null;
              detailWindowRef = win;
              try {
                win.document.title = "Detail Extract Viewer";
                win.document.body.innerHTML =
                  '<div style="font-family:sans-serif;padding:16px;">Preparing detail extraction...</div>';
              } catch {}
              return win;
            } catch (err) {
              console.warn("Unable to open detail viewer window", err);
              return null;
            }
          };

          window.addEventListener("beforeunload", () => {
            try {
              if (detailWindowRef && !detailWindowRef.closed) {
                detailWindowRef.close();
              }
            } catch {}
            detailWindowRef = null;
          });

          const resolveAnchorForCurrentPage = () => {
            const matchesSignature = (el, sig) => {
              if (!el || !sig) return false;
              if (
                (el.tagName || "").toLowerCase() !==
                (sig.tag || "").toLowerCase()
              )
                return false;
              if (sig.role) {
                const role =
                  (el.getAttribute && el.getAttribute("role")) || null;
                if (
                  (role || "").toLowerCase() !== (sig.role || "").toLowerCase()
                )
                  return false;
              }
              if (sig.classes && sig.classes.length) {
                const classList = new Set(Array.from(el.classList || []));
                return sig.classes.every((cls) => classList.has(cls));
              }
              return true;
            };
            const anchorFromElement = (el) => {
              if (!el) return null;
              if (el.matches && el.matches("a[href]")) return el;
              return el.querySelector ? el.querySelector("a[href]") : null;
            };
            let anchor = null;
            try {
              if (baseAnchorSelector) {
                anchor = document.querySelector(baseAnchorSelector);
              }
            } catch {}
            if (!anchor && baseAnchorHref) {
              try {
                const anchors = Array.from(
                  document.querySelectorAll("a[href]"),
                );
                anchor =
                  anchors.find((a) => {
                    try {
                      return toAbs(a) === baseAnchorHref;
                    } catch {
                      return false;
                    }
                  }) || null;
              } catch {}
            }
            if (!anchor && baseItemSelector) {
              try {
                const el = document.querySelector(baseItemSelector);
                anchor = anchorFromElement(el);
              } catch {}
            }
            if (!anchor && baseItemSignature && baseItemSignature.tag) {
              try {
                const candidates = Array.from(
                  document.querySelectorAll(baseItemSignature.tag),
                );
                const hit =
                  candidates.find((el) =>
                    matchesSignature(el, baseItemSignature),
                  ) || null;
                anchor = anchorFromElement(hit);
              } catch {}
            }
            if (!anchor) {
              anchor = guessBaseAnchor();
            }
            if (anchor) {
              try {
                const newHref = toAbs(anchor);
                if (newHref && newHref !== baseAnchorHref) {
                  baseAnchorHref = newHref;
                  try {
                    saveState();
                  } catch {}
                }
              } catch {}
            }
            return anchor;
          };

          const refreshSiblingsForCurrentPage = () => {
            try {
              const anchor = resolveAnchorForCurrentPage();
              if (!anchor) return false;
              const data = computeSiblingsFor(anchor);
              const items = (data && data.items) || [];
              const hrefs = items.map((it) => it && it.href).filter(Boolean);
              if (hrefs.length) {
                siblingsHrefs = hrefs;
                return true;
              }
            } catch {}
            return false;
          };

          const getDetailPaginationState = () => {
            try {
              const raw = sessionStorage.getItem("__hli_paginate__");
              if (!raw) return { active: false, page: 0 };
              const job = JSON.parse(raw) || {};
              if (job && job.active && job.mode === "details") {
                return { active: true, page: job.page || 0 };
              }
            } catch {}
            return { active: false, page: 0 };
          };

          // Extract details by loading each sibling URL and querying saved detailSelectors
          const extractAllDetails = async () => {
            try {
              if (!listColumnNames().length) {
                alert(
                  "Define at least one column using the context menu first.",
                );
                return;
              }
              const refreshed = refreshSiblingsForCurrentPage();
              if (!siblingsHrefs || !siblingsHrefs.length) {
                if (!refreshed) {
                  // As a fallback, try recomputing one more time in case selector changed
                  try {
                    const altAnchor = guessBaseAnchor();
                    if (altAnchor) {
                      const data = computeSiblingsFor(altAnchor);
                      const items = (data && data.items) || [];
                      siblingsHrefs = items
                        .map((it) => it && it.href)
                        .filter(Boolean);
                    }
                  } catch {}
                }
              }
              if (!siblingsHrefs || !siblingsHrefs.length) {
                alert(
                  "No siblings recorded. Choose Capture Link first to capture siblings.",
                );
                return;
              }
              const detailState = getDetailPaginationState();
              const appendMode = detailState.active;
              const currentPageIndex = detailState.page || 0;
              extractState.columns = listColumnNames();
              if (!appendMode) {
                extractState.rows = [];
                clearRowsBackup();
              } else if (!Array.isArray(extractState.rows)) {
                extractState.rows = [];
              }
              const existingLinks = new Set(
                (extractState.rows || [])
                  .map((row) => row && row["Capture Link"])
                  .filter(Boolean),
              );
              let detailWin = ensureDetailWindow();
              if (!detailWin) {
                alert(
                  "Unable to open detail window. Allow pop-ups and try again.",
                );
                return;
              }
              const sameOrigin = (u) => {
                try {
                  return new URL(u, location.href).origin === location.origin;
                } catch {
                  return false;
                }
              };
              const columns = listColumnNames();
              const buildLinkOnlyRow = (href) => {
                const row = {};
                columns.forEach((col) => {
                  if (!col) return;
                  const binding = columnBindings[col] || {};
                  row[col] =
                    (binding.label || "") === "Capture Link" ? href : "";
                });
                return row;
              };
              const navigateDetailWindow = async (win, href) =>
                new Promise((resolve) => {
                  if (!win || win.closed) return resolve();
                  let settled = false;
                  const finish = () => {
                    if (settled) return;
                    settled = true;
                    try {
                      win.removeEventListener("load", onLoad);
                    } catch {}
                    resolve();
                  };
                  const onLoad = () => finish();
                  try {
                    win.addEventListener("load", onLoad, { once: true });
                  } catch {
                    resolve();
                    return;
                  }
                  try {
                    win.focus();
                  } catch {}
                  try {
                    win.location.href = href;
                  } catch {
                    finish();
                    return;
                  }
                  setTimeout(finish, 30000);
                });
              for (const href of siblingsHrefs) {
                try {
                  if (!detailWin || detailWin.closed) {
                    detailWindowRef = null;
                    detailWin = ensureDetailWindow();
                    if (!detailWin) {
                      alert("Detail window was closed. Extraction stopped.");
                      break;
                    }
                  }
                  if (!sameOrigin(href)) {
                    // skip cross-origin due to SOP
                    extractState.rows.push(buildLinkOnlyRow(href));
                    renderTable();
                    continue;
                  }
                  await navigateDetailWindow(detailWin, href);
                  let doc = null;
                  try {
                    doc = detailWin.document;
                  } catch {}
                  if (!doc) {
                    extractState.rows.push(buildLinkOnlyRow(href));
                    renderTable();
                    continue;
                  }
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
                  columns.forEach((col) => {
                    if (!col) return;
                    const binding = columnBindings[col] || {};
                    const label = binding.label || "Capture Text";
                    if (label === "Capture Link") {
                      row[col] = href;
                      return;
                    }
                    let selector = getDetailSelectorFor(col, label);
                    let value = "";
                    if (label === "Date") {
                      selector = selector || "time";
                      value = qDate(selector);
                    } else if (label === "Capture Text") {
                      selector =
                        selector || "article, main, .content, .entry-content";
                      value = qText(selector).slice(0, 500);
                    } else if (label === "Title") {
                      selector = selector || "";
                      value = selector
                        ? qText(selector)
                        : qText("h1, h2, h3, title");
                    } else {
                      selector = selector || "";
                      value = selector ? qText(selector) : "";
                    }
                    row[col] = value;
                  });
                  if (!existingLinks.has(row["Capture Link"])) {
                    row.__hliPageIndex = currentPageIndex;
                    extractState.rows.push(row);
                    if (row["Capture Link"])
                      existingLinks.add(row["Capture Link"]);
                  }
                  renderTable();
                } catch {}
              }
              saveState();
            } catch {}
          };

          // Parent-tree heuristic to find sibling link items (robust)
          const computeSiblingsFor = (anchor) => {
            console.log("Computing siblings for anchor:", anchor);
            const results = [];
            if (!anchor)
              return {
                items: results,
                container: null,
                elMap: Object.create(null),
              };
            const toArr = (x) => Array.prototype.slice.call(x || []);
            const sigOf = (el) =>
              el ? el.tagName + "|" + (el.className || "") : "";
            const normalizeNoHash = (href) => {
              try {
                return new URL(href, document.location.href).href.replace(
                  /#.*$/,
                  "",
                );
              } catch {
                return "";
              }
            };
            const pageHrefNoHash = normalizeNoHash(document.location.href);
            const baseHref = anchor ? toAbs(anchor) : "";
            let baseUrl = null;
            try {
              baseUrl = baseHref ? new URL(baseHref) : null;
            } catch {
              baseUrl = null;
            }
            const basePathSegments = (() => {
              if (!baseUrl) return [];
              return baseUrl.pathname.split("/").filter(Boolean);
            })();
            const baseDepth = basePathSegments.length;
            const baseLastSegmentInfo = (() => {
              if (!baseUrl) return null;
              try {
                const parts = baseUrl.pathname.split("/").filter(Boolean);
                if (!parts.length) return null;
                const last = parts[parts.length - 1] || "";
                if (!last) return null;
                const cleaned = last
                  .replace(/\?.*$/, "")
                  .replace(/#[^#]*$/, "");
                const extMatch = cleaned.match(/\.([a-z0-9]+)$/i);
                const ext = extMatch ? (extMatch[1] || "").toLowerCase() : "";
                const baseName = ext
                  ? cleaned.slice(0, -(ext.length + 1))
                  : cleaned;
                const prefixMatch = baseName.match(/^([a-z0-9-]+)_/i);
                const prefix = prefixMatch
                  ? (prefixMatch[1] || "").toLowerCase()
                  : "";
                if (!prefix && !ext) return null;
                return { prefix, extension: ext };
              } catch {
                return null;
              }
            })();
            const articleSegmentPattern = /^article[-_]/i;
            const isArticleDetail =
              baseDepth >= 2 &&
              articleSegmentPattern.test(basePathSegments[baseDepth - 1] || "");
            const prefixSegmentCount = (() => {
              if (!baseDepth) return 0;
              if (isArticleDetail) {
                return Math.max(1, baseDepth - 2);
              }
              return Math.max(1, baseDepth - 1);
            })();
            const basePrefixLower =
              prefixSegmentCount > 0
                ? "/" +
                  basePathSegments
                    .slice(0, prefixSegmentCount)
                    .join("/")
                    .toLowerCase()
                : "";
            const isMeaningfulHref = (href) => {
              if (!href) return false;
              const trimmed = href.trim();
              if (
                !trimmed ||
                trimmed === "#" ||
                /^javascript:/i.test(trimmed) ||
                /^mailto:/i.test(trimmed) ||
                /^tel:/i.test(trimmed)
              ) {
                return false;
              }
              let abs;
              try {
                abs = new URL(trimmed, document.location.href);
              } catch {
                return false;
              }
              const absNoHash = abs.href.replace(/#.*$/, "");
              if (!absNoHash) return false;
              if (absNoHash === pageHrefNoHash) return false;
              if (baseUrl && abs.origin !== baseUrl.origin) return false;
              const segs = abs.pathname.split("/").filter(Boolean);
              if (baseDepth && !isArticleDetail && segs.length !== baseDepth) {
                return false;
              }
              if (isArticleDetail) {
                const minDepth = Math.max(prefixSegmentCount + 1, 2);
                if (segs.length < minDepth) return false;
              }
              if (prefixSegmentCount > 0) {
                const sliceCount = Math.min(prefixSegmentCount, segs.length);
                const prefix =
                  "/" + segs.slice(0, sliceCount).join("/").toLowerCase();
                if (prefix !== basePrefixLower) return false;
              }
              if (baseLastSegmentInfo) {
                const lastSeg = (segs[segs.length - 1] || "").toLowerCase();
                if (
                  baseLastSegmentInfo.prefix &&
                  (!lastSeg ||
                    !lastSeg.startsWith(baseLastSegmentInfo.prefix + "_"))
                ) {
                  return false;
                }
                if (
                  baseLastSegmentInfo.extension &&
                  (!lastSeg ||
                    !lastSeg.endsWith("." + baseLastSegmentInfo.extension))
                ) {
                  return false;
                }
              }
              return true;
            };
            const makeItem = (lnk) => {
              if (!lnk) return null;
              const href = toAbs(lnk);
              if (!isMeaningfulHref(href)) return null;
              const canonical = normalizeNoHash(href);
              if (!canonical) return null;
              return {
                href: canonical,
                text: (lnk && (lnk.textContent || "")).trim(),
              };
            };
            const hasMappedSiblingTargets = () =>
              !loadMoreMode &&
              Array.isArray(siblingsHrefs) &&
              siblingsHrefs.length > 0;
            const filterItemsToMappedSiblings = (items, elMap) => {
              if (!hasMappedSiblingTargets()) {
                return { items, elMap };
              }
              const filtered = [];
              const filteredMap = Object.create(null);
              for (const href of siblingsHrefs) {
                if (!href) continue;
                const match =
                  items &&
                  items.find(
                    (it) =>
                      it && typeof it.href === "string" && it.href === href,
                  );
                if (match) {
                  filtered.push(match);
                  if (elMap && elMap[href]) filteredMap[href] = elMap[href];
                }
              }
              return { items: filtered, elMap: filteredMap };
            };
            const candidateSatisfiesMappedSiblings = (items) => {
              if (!hasMappedSiblingTargets()) return false;
              const hrefSet = new Set(
                (items || [])
                  .map((it) =>
                    it && typeof it.href === "string" ? it.href : "",
                  )
                  .filter(Boolean),
              );
              return siblingsHrefs.every(
                (href) => typeof href === "string" && href && hrefSet.has(href),
              );
            };
            // Strategy 1: original "same tag+class siblings" walk upwards
            // const tryGroupBySignature = (start) => {
            //   let node = start;
            //   let best = null;
            //   while (node && node !== document.body) {
            //     const p = node.parentElement;
            //     if (!p) break;
            //     const sig = sigOf(node);
            //     const group = toArr(p.children).filter((ch) => sigOf(ch) === sig);
            //     const items = [];
            //     const elMap = Object.create(null);
            //     for (const it of group) {
            //       const l = it.querySelector ? it.querySelector('a[href]') : null;
            //       if (l) {
            //         const obj = makeItem(l);
            //         items.push(obj);
            //         try { elMap[obj.href] = it; } catch {}
            //       }
            //     }
            //     const seen = new Set();
            //     const ded = [];
            //     const elMapDed = Object.create(null);
            //     for (const it of items) {
            //       if (it.href && !seen.has(it.href)) {
            //         seen.add(it.href);
            //         ded.push(it);
            //         try { elMapDed[it.href] = elMap[it.href]; } catch {}
            //       }
            //     }
            //     if (ded.length >= 2) {
            //       if (!best || ded.length > best.items.length) best = { container: p, items: ded, elMap: elMapDed };
            //     }
            //     node = p;
            //   }
            //   return best;
            // };

            // Strategy 2: list containers (UL/OL) -> LI children
            const tryListContainers = (start) => {
              let node = start;
              while (node && node !== document.body) {
                const p = node.parentElement;
                if (!p) break;
                if (p) {
                  const lis = toArr(p.children);
                  console.log(
                    "Trying list container strategy at node:",
                    p,
                    "with children:",
                    lis,
                  );
                  const items = [];
                  const elMap = Object.create(null);
                  for (const li of lis) {
                    const anchors = Array.from(li.querySelectorAll("a[href]"));
                    for (const link of anchors) {
                      const obj = makeItem(link);
                      if (!obj) continue;
                      items.push(obj);
                      try {
                        elMap[obj.href] = link;
                      } catch {}
                    }

                    // const l = li.querySelector
                    //   ? li.querySelector("a[href]")
                    //   : null;
                    // if (l) {
                    //   const obj = makeItem(l);
                    //   if (!obj) continue;
                    //   items.push(obj);
                    //   try {
                    //     elMap[obj.href] = li;
                    //   } catch {}
                    // }
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
                  // Deduplicate
                  const seen1 = new Set();
                  const ded1 = items.filter(
                    (it) => !seen1.has(it.href) && seen1.add(it.href),
                  );
                  if (ded.length >= 2) {
                    let candidateItems = ded1;
                    let candidateMap = elMapDed;
                    if (hasMappedSiblingTargets()) {
                      const filtered = filterItemsToMappedSiblings(
                        candidateItems,
                        candidateMap,
                      );
                      candidateItems = filtered.items;
                      candidateMap = filtered.elMap;
                      if (!candidateItems.length) {
                        node = p;
                        continue;
                      }
                      if (!candidateSatisfiesMappedSiblings(candidateItems)) {
                        node = p;
                        continue;
                      }
                    }
                    return {
                      container: p,
                      items: candidateItems,
                      elMap: candidateMap,
                    };
                  }
                }
                node = p;
              }
              return null;
            };

            // Strategy 3: ancestor whose direct children contain anchors
            const tryChildrenWithAnchors = (start) => {
              let node = start;
              while (node && node !== document.body) {
                const p = node.parentElement;
                if (!p) break;
                const kids = toArr(p.children);
                const items = [];
                const elMap = Object.create(null);
                for (const ch of kids) {
                  const l = ch.querySelector
                    ? ch.querySelector("a[href]")
                    : null;
                  if (l) {
                    const obj = makeItem(l);
                    items.push(obj);
                    try {
                      elMap[obj.href] = ch;
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
                // Deduplicate
                const seen1 = new Set();
                const ded1 = items.filter(
                  (it) => !seen1.has(it.href) && seen1.add(it.href),
                );
                if (ded.length >= 2)
                  return { container: p, items: ded1, elMap: elMapDed };
                node = p;
              }
              return null;
            };

            // Strategy 4: broad fallback — nearest ancestor with many anchors
            const tryManyAnchors = (start) => {
              let node = start;
              while (node && node !== document.body) {
                const p = node.parentElement;
                if (!p) break;
                const as = toArr(
                  p.querySelectorAll ? p.querySelectorAll("a[href]") : [],
                );
                if (as.length >= 3) {
                  const items = [];
                  const elMap = Object.create(null);
                  for (const a of as) {
                    const obj = makeItem(a);
                    items.push(obj);
                    try {
                      elMap[obj.href] = a.parentElement || p;
                    } catch {}
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
                  // Deduplicate
                  const seen1 = new Set();
                  const ded1 = items.filter(
                    (it) => !seen1.has(it.href) && seen1.add(it.href),
                  );
                  if (ded.length >= 2)
                    return { container: p, items: ded1, elMap: elMapDed };
                }
                node = p;
              }
              return null;
            };

            const tryUrlPattern = (startLnk) => {
              const selectedUrl = toAbs(startLnk);
              const getBase = (u) => {
                try {
                  const url = new URL(u);
                  const parts = url.pathname.split("/").filter(Boolean);
                  if (parts.length > 0) parts.pop(); // Remove the specific ID/slug
                  return url.origin + "/" + parts.join("/");
                } catch {
                  return u;
                }
              };

              const basePattern = getBase(selectedUrl);
              const allLinks = toArr(document.querySelectorAll("a[href]"));
              const items = [];
              const elMap = Object.create(null);

              for (const l of allLinks) {
                const href = toAbs(l);
                if (
                  href.startsWith(basePattern) &&
                  href !== basePattern + "/"
                ) {
                  const obj = makeItem(l);
                  items.push(obj);
                  elMap[obj.href] = l;
                }
              }

              // Deduplicate
              const seen = new Set();
              const ded = items.filter((it) => {
                if (it.href && !seen.has(it.href)) {
                  seen.add(it.href);
                  return true;
                }
                return false;
              });

              if (ded.length >= 2) {
                // Find common ancestor for the 'container'
                return { container: document.body, items: ded, elMap: elMap };
              }
              return null;
            };

            // const tryUrlPattern = (startLnk) => {
            //   const toAbs = (lnk) => {
            //     try {
            //       return new URL(lnk.getAttribute("href"), document.baseURI)
            //         .href;
            //     } catch {
            //       return lnk.href;
            //     }
            //   };

            //   const selectedUrlStr = toAbs(startLnk);
            //   const selectedUrl = new URL(selectedUrlStr);

            //   // 1. Get Path segments (e.g., ['obituaries', 'michael-john'])
            //   const selectedSegments = selectedUrl.pathname
            //     .split("/")
            //     .filter(Boolean);
            //   const selectedDepth = selectedSegments.length;

            //   // 2. Create a "Sibling Regex"
            //   // If the URL is /obituaries/name-123, the base is /obituaries/
            //   const baseSegments = selectedSegments.slice(0, -1);
            //   const basePath = "/" + baseSegments.join("/");

            //   const allLinks = Array.from(document.querySelectorAll("a[href]"));
            //   const items = [];
            //   const elMap = Object.create(null);

            //   // Noise filters for common non-sibling links
            //   const noiseRegex =
            //     /(login|signup|cart|checkout|page|category|search|contact|about|privacy|terms|pagenum)/i;

            //   for (const l of allLinks) {
            //     try {
            //       console.log("Evaluating link:", l);
            //       const hrefStr = toAbs(l);
            //       const u = new URL(hrefStr);
            //       const segments = u.pathname.split("/").filter(Boolean);

            //       // --- STRICT FILTERS ---

            //       // A. Domain must match
            //       if (u.hostname !== selectedUrl.hostname) continue;

            //       // B. URL Path Depth must be EXACTLY the same
            //       // (This prevents picking up /obituaries/ which is a root/list page)
            //       if (segments.length !== selectedDepth) continue;

            //       // C. Must share the same base path
            //       if (!u.pathname.startsWith(basePath)) continue;

            //       // D. Exclude the selected URL itself
            //       if (hrefStr === selectedUrlStr) continue;

            //       // E. Exclude common navigation noise
            //       if (
            //         noiseRegex.test(hrefStr) ||
            //         noiseRegex.test(l.textContent)
            //       )
            //         continue;

            //       // If it passed all tests, it's a true sibling
            //       const obj = {
            //         href: hrefStr,
            //         text: (l.textContent || l.title || "").trim(),
            //       };
            //       items.push(obj);
            //       elMap[obj.href] = l;
            //     } catch (e) {
            //       continue;
            //     }
            //   }

            //   // Deduplicate
            //   const seen = new Set();
            //   const ded = items.filter(
            //     (it) => !seen.has(it.href) && seen.add(it.href),
            //   );

            //   if (ded.length >= 2) {
            //     return {
            //       container: document.body,
            //       items: ded,
            //       elMap: elMap,
            //     };
            //   }
            //   return null;
            // };

            /**
             * UPDATED STRATEGY: Signature grouping (row-spanning)
             * - Groups sibling items by exact tag+class signature
             * - Also searches deeper within higher ancestors to include multiple rows/grids
             *   so we don't stop at just one visual row.
             * - Handles cases where the element itself is an anchor or contains one.
             */
            const tryGroupBySignature = (start) => {
              let node = start;
              let best = null;
              const sigOf = (el) =>
                el
                  ? el.tagName +
                    "|" +
                    (el.className || "").split(" ").sort().join(" ")
                  : "";
              const hasAllClasses = (el, classes) => {
                try {
                  if (!el || !el.classList) return classes.length === 0;
                  for (const c of classes) {
                    if (c && !el.classList.contains(c)) return false;
                  }
                  return true;
                } catch {
                  return false;
                }
              };

              // Capture the starting element's signature once; we use it to search
              // for matching descendants at higher ancestors to span multiple rows.
              const startTag =
                start && start.tagName ? start.tagName.toUpperCase() : "";
              const startClasses = Array.from((start && start.classList) || [])
                .filter(Boolean)
                .sort();

              while (node && node !== document.body) {
                const p = node.parentElement;
                if (!p) return;
                // 1) Direct same-signature siblings under this parent
                const considerCandidate = (items, elMap) => {
                  if (!items || items.length < 2) return false;
                  let candidateItems = items;
                  let candidateMap = elMap;
                  if (hasMappedSiblingTargets()) {
                    const filtered = filterItemsToMappedSiblings(
                      candidateItems,
                      candidateMap,
                    );
                    candidateItems = filtered.items;
                    candidateMap = filtered.elMap;
                    if (!candidateItems.length) return false;
                  }
                  const candidate = {
                    container: p,
                    items: candidateItems,
                    elMap: candidateMap,
                  };
                  if (!best || candidateItems.length > best.items.length) {
                    best = candidate;
                  }
                  return candidateSatisfiesMappedSiblings(candidateItems);
                };
                const sig = sigOf(node);
                const directGroup = toArr(p.children).filter(
                  (ch) => sigOf(ch) === sig,
                );
                const itemsDirect = [];
                const elMapDirect = Object.create(null);
                for (const it of directGroup) {
                  const l =
                    it.tagName === "A"
                      ? it
                      : it.querySelector
                        ? it.querySelector("a[href]")
                        : null;
                  if (l && l.getAttribute && l.getAttribute("href")) {
                    const obj = makeItem(l);
                    if (!obj) continue;
                    itemsDirect.push(obj);
                    try {
                      elMapDirect[obj.href] = it;
                    } catch {}
                  }
                }
                const seenD = new Set();
                const dedDirect = itemsDirect.filter(
                  (it) =>
                    it && it.href && !seenD.has(it.href) && seenD.add(it.href),
                );
                if (
                  dedDirect.length >= 2 &&
                  considerCandidate(dedDirect, elMapDirect)
                ) {
                  return best;
                }

                // 2) Deep search within this ancestor: find ALL descendants matching the
                //    START element's tag+classes. This lets us aggregate across multiple rows.
                if (startTag) {
                  const deepCands = Array.from(
                    p.querySelectorAll(startTag),
                  ).filter((el) => hasAllClasses(el, startClasses));
                  const itemsDeep = [];
                  const elMapDeep = Object.create(null);
                  for (const it of deepCands) {
                    const l =
                      it.tagName === "A"
                        ? it
                        : it.querySelector
                          ? it.querySelector("a[href]")
                          : null;
                    if (l && l.getAttribute && l.getAttribute("href")) {
                      const obj = makeItem(l);
                      if (!obj) continue;
                      itemsDeep.push(obj);
                      try {
                        elMapDeep[obj.href] = it;
                      } catch {}
                    }
                  }
                  const seenDeep = new Set();
                  const dedDeep = itemsDeep.filter(
                    (it) =>
                      it &&
                      it.href &&
                      !seenDeep.has(it.href) &&
                      seenDeep.add(it.href),
                  );
                  if (
                    dedDeep.length >= 2 &&
                    considerCandidate(dedDeep, elMapDeep)
                  ) {
                    return best;
                  }
                }

                node = p;
              }
              return best;
            };

            const fallbackPathScan = () => {
              try {
                if (!anchor) return null;
                const anchors = Array.from(
                  document.querySelectorAll("a[href]"),
                );
                const items = [];
                const elMap = Object.create(null);
                for (const lnk of anchors) {
                  const obj = makeItem(lnk);
                  if (!obj || !obj.href) continue;
                  items.push(obj);
                  try {
                    elMap[obj.href] = lnk;
                  } catch {}
                  if (items.length >= 300) break;
                }
                const seen = new Set();
                const ded = [];
                const elMapDed = Object.create(null);
                for (const it of items) {
                  if (!it.href || seen.has(it.href)) continue;
                  seen.add(it.href);
                  ded.push(it);
                  try {
                    elMapDed[it.href] = elMap[it.href];
                  } catch {}
                }
                if (ded.length) {
                  return {
                    container: document.body,
                    items: ded,
                    elMap: elMapDed,
                  };
                }
              } catch {}
              return null;
            };
            const start = anchor;
            let result = tryGroupBySignature(start) ||
              tryListContainers(start) ||
              // tryChildrenWithAnchors(start) ||
              // tryManyAnchors(start) ||
              // tryUrlPattern(start) ||
              fallbackPathScan() || {
                items: [],
                container: null,
                elMap: Object.create(null),
              };
            if (
              result &&
              Array.isArray(result.items) &&
              hasMappedSiblingTargets()
            ) {
              const filtered = filterItemsToMappedSiblings(
                result.items,
                result.elMap || Object.create(null),
              );
              if (filtered.items && filtered.items.length) {
                result = {
                  ...result,
                  items: filtered.items,
                  elMap: filtered.elMap,
                };
              }
            }
            try {
              if (
                result &&
                baseHref &&
                Array.isArray(result.items) &&
                !result.items.some((it) => it && it.href === baseHref)
              ) {
                const entry = {
                  href: baseHref,
                  text: (
                    (anchor &&
                      (anchor.textContent ||
                        (anchor.getAttribute &&
                          anchor.getAttribute("aria-label")))) ||
                    ""
                  ).trim(),
                };
                result.items.unshift(entry);
                if (result.elMap) {
                  try {
                    result.elMap[baseHref] = anchor;
                  } catch {}
                }
              }
            } catch {}
            return result;
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
            if (sel) lastHoverSelector = sel;
            if (sel) lastHoverSelector = sel;
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
          const actionHandlers = {
            "extract-all": () => {
              try {
                emitExtractStateUpdate();
                extractAllUsingSiblings();
              } catch (err) {
                console.warn("extract-all failed", err);
              }
            },
            "extract-details": (opts) => {
              try {
                const payload = opts && typeof opts === "object" ? opts : {};
                let selectorOverride = null;
                if (typeof payload.nextSelector === "string") {
                  selectorOverride = payload.nextSelector.trim();
                  applyNextSelectorValue(selectorOverride, { silent: true });
                }
                if (typeof payload.loadMoreMode === "boolean") {
                  applyLoadMoreValue(payload.loadMoreMode, { silent: true });
                }
                const incoming =
                  typeof payload.maxPages !== "undefined"
                    ? payload.maxPages
                    : typeof payload.value !== "undefined"
                      ? payload.value
                      : undefined;
                if (typeof incoming !== "undefined") {
                  applyMaxPagesValue(incoming, { silent: true });
                }
                const pagesSource =
                  typeof payload.maxPages !== "undefined"
                    ? payload.maxPages
                    : typeof payload.value !== "undefined"
                      ? payload.value
                      : maxPagesSetting || 1;
                const pages = Math.max(1, parseInt(pagesSource, 10) || 1);
                const selectorCandidate =
                  (selectorOverride && selectorOverride.length
                    ? selectorOverride
                    : "") ||
                  nextPageSelector ||
                  "";
                const selector =
                  selectorCandidate && selectorCandidate.trim().length
                    ? selectorCandidate.trim()
                    : null;
                const shouldPaginate =
                  pages > 1 || (selector && selector.length > 0);
                if (shouldPaginate) {
                  startPaginatedExtractAllDetail(pages, selector);
                } else {
                  extractAllDetails();
                }
              } catch (err) {
                console.warn("extract-details failed", err);
              }
            },
            "extract-pages": (opts) => {
              try {
                const payload = opts && typeof opts === "object" ? opts : {};
                const incoming =
                  typeof payload.maxPages !== "undefined"
                    ? payload.maxPages
                    : typeof payload.value !== "undefined"
                      ? payload.value
                      : undefined;
                if (typeof incoming !== "undefined") {
                  applyMaxPagesValue(incoming, { silent: true });
                }
                let selectorOverride = null;
                if (typeof payload.nextSelector === "string") {
                  selectorOverride = payload.nextSelector.trim();
                  applyNextSelectorValue(selectorOverride, { silent: true });
                }
                if (typeof payload.loadMoreMode === "boolean") {
                  applyLoadMoreValue(payload.loadMoreMode, { silent: true });
                }
                const pagesSource =
                  typeof payload.maxPages !== "undefined"
                    ? payload.maxPages
                    : typeof payload.value !== "undefined"
                      ? payload.value
                      : maxPagesSetting || 1;
                const pages = Math.max(1, parseInt(pagesSource, 10) || 1);
                const selectorCandidate =
                  (selectorOverride && selectorOverride.length
                    ? selectorOverride
                    : "") ||
                  nextPageSelector ||
                  "";
                const selector =
                  selectorCandidate && selectorCandidate.trim().length
                    ? selectorCandidate.trim()
                    : null;
                const loadMoreOverride =
                  typeof payload.loadMoreMode === "boolean"
                    ? payload.loadMoreMode
                    : undefined;
                startPaginatedExtract(pages, selector, loadMoreOverride);
              } catch (err) {
                console.warn("extract-pages failed", err);
              }
            },
            clear: () => {
              clearExtractedTable();
            },
            "clear-all": () => {
              resetAllExtractionState();
            },
            "save-load-more": (opts) => {
              if (!opts) {
                applyLoadMoreValue(false, { silent: true });
                return;
              }
              const raw =
                typeof opts.enabled !== "undefined"
                  ? opts.enabled
                  : typeof opts.value !== "undefined"
                    ? opts.value
                    : opts;
              applyLoadMoreValue(!!raw, { silent: true });
            },
            "save-next-selector": (opts) => {
              applyNextSelectorValue((opts && opts.nextSelector) || "", {
                silent: true,
              });
            },
            "save-max-pages": (opts) => {
              const incoming = opts && (opts.maxPages || opts.value);
              applyMaxPagesValue(incoming || maxPagesSetting, { silent: true });
            },
            "stop-pagination": () => {
              stopPaginatedExtract();
            },
          };
          try {
            window.__hliBridge = {
              trigger(action, payload) {
                if (!action) return;
                const handler = actionHandlers[action];
                if (handler) handler(payload || {});
              },
              getState() {
                return {
                  columns: Array.isArray(extractState.columns)
                    ? extractState.columns.slice()
                    : [],
                  rows: Array.isArray(extractState.rows)
                    ? extractState.rows.map((r) => ({ ...(r || {}) }))
                    : [],
                  nextPageSelector: nextPageSelector || "",
                  maxPages: maxPagesSetting,
                  loadMoreMode,
                  statusText: (() => {
                    const panel = document.getElementById(tablePanelId);
                    return panel && panel._statusText
                      ? panel._statusText.textContent
                      : "Idle";
                  })(),
                  rowCount: extractState.rows ? extractState.rows.length : 0,
                  timestamp: Date.now(),
                  frameGuid,
                  columnBindings: columnBindings
                    ? JSON.parse(JSON.stringify(columnBindings))
                    : {},
                  columnMap: deriveLegacyColumnMap(),
                  detailSelectors: detailSelectors
                    ? { ...detailSelectors }
                    : {},
                  labelSuggestions: labelSuggestions
                    ? { ...labelSuggestions }
                    : {},
                  customFields: Array.isArray(customFields)
                    ? customFields.slice()
                    : [],
                  baseAnchorSelector: baseAnchorSelector || null,
                  baseAnchorHref: baseAnchorHref || null,
                  baseItemSelector: baseItemSelector || null,
                  baseItemSignature: baseItemSignature
                    ? { ...baseItemSignature }
                    : null,
                  siblingsHrefs: Array.isArray(siblingsHrefs)
                    ? siblingsHrefs.slice()
                    : [],
                  panelCollapsed: !!panelCollapsed,
                  panelPos: panelPos ? { ...panelPos } : null,
                };
              },
              loadState(state) {
                if (!state || typeof state !== "object") return;
                try {
                  if (
                    state.columnBindings &&
                    typeof state.columnBindings === "object"
                  ) {
                    columnBindings = { ...state.columnBindings };
                  } else if (
                    state.columnMap &&
                    typeof state.columnMap === "object"
                  ) {
                    Object.entries(state.columnMap).forEach(([label, col]) => {
                      if (!col || typeof col !== "string") return;
                      columnBindings[col] = columnBindings[col] || {
                        label,
                        createdAt: Date.now() + columnOrderCounter++,
                      };
                    });
                  }
                } catch {}
                try {
                  if (state.detailSelectors) {
                    detailSelectors = { ...state.detailSelectors };
                    if (
                      state.columnMap &&
                      typeof state.columnMap === "object"
                    ) {
                      const converted = {};
                      Object.entries(state.columnMap).forEach(
                        ([label, col]) => {
                          if (!label || !col) return;
                          if (state.detailSelectors[label])
                            converted[col] = state.detailSelectors[label];
                        },
                      );
                      if (Object.keys(converted).length)
                        detailSelectors = converted;
                    }
                  }
                } catch {}
                try {
                  if (state.labelSuggestions)
                    labelSuggestions = { ...state.labelSuggestions };
                } catch {}
                try {
                  if (Array.isArray(state.customFields))
                    customFields = state.customFields.slice();
                } catch {}
                try {
                  if (Array.isArray(state.siblingsHrefs))
                    siblingsHrefs = state.siblingsHrefs.slice();
                } catch {}
                try {
                  if (state.baseAnchorSelector)
                    baseAnchorSelector = state.baseAnchorSelector;
                } catch {}
                try {
                  if (state.baseAnchorHref)
                    baseAnchorHref = state.baseAnchorHref;
                } catch {}
                try {
                  if (state.baseItemSignature)
                    baseItemSignature = { ...state.baseItemSignature };
                } catch {}
                try {
                  if (state.baseItemSelector)
                    baseItemSelector = state.baseItemSelector;
                } catch {}
                try {
                  if (typeof state.panelCollapsed === "boolean")
                    panelCollapsed = state.panelCollapsed;
                  if (
                    state.panelPos &&
                    typeof state.panelPos.left === "number" &&
                    typeof state.panelPos.top === "number"
                  ) {
                    panelPos = {
                      left: state.panelPos.left,
                      top: state.panelPos.top,
                    };
                  }
                } catch {}
                try {
                  if (
                    typeof state.maxPages === "number" &&
                    state.maxPages > 0
                  ) {
                    maxPagesSetting = state.maxPages;
                  } else if (
                    typeof state.maxPagesSetting === "number" &&
                    state.maxPagesSetting > 0
                  ) {
                    maxPagesSetting = state.maxPagesSetting;
                  }
                } catch {}
                try {
                  if (typeof state.nextPageSelector === "string")
                    nextPageSelector = state.nextPageSelector || null;
                } catch {}
                try {
                  if (Array.isArray(state.columns))
                    extractState.columns = state.columns.slice();
                  if (Array.isArray(state.rows))
                    extractState.rows = state.rows.map((r) => ({
                      ...(r || {}),
                    }));
                } catch {}
                try {
                  saveState();
                } catch {}
                try {
                  renderTable();
                } catch {}
              },
            };
          } catch {}
          try {
            ensureTablePanel();
          } catch {}
          try {
            // resumePaginatedIfNeeded();
          } catch {}
        },
        sessionId,
        !isPie,
      );
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
    // try { if (browser) await browser.close(); } catch {}
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Start the Express server
const port = process.env.PORT || 3000;
expressApp.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
