const puppeteer = require('puppeteer');
const { normWaitUntil, extractFields, autoDetectItemContainers, autoDetectFields, smartExtract } = require('./selectors');

async function openBrowser(opts = {}) {
  const { headless = true, args = [], proxy } = opts || {};
  const launchArgs = Array.isArray(args) ? args.slice() : [];
  if (proxy && proxy.host && proxy.port) {
    launchArgs.push(`--proxy-server=http://${proxy.host}:${proxy.port}`);
  }
  const browser = await puppeteer.launch({ headless, args: launchArgs, defaultViewport: null });
  return browser;
}

async function goto(page, url, behavior = {}) {
  const waitUntil = normWaitUntil(behavior.waitUntil || 'domcontentloaded');
  const timeout = behavior.timeout || 60000;
  await page.goto(url, { waitUntil, timeout });
  if (behavior.extraWaitMs) {
    await page.waitForTimeout(behavior.extraWaitMs);
  }
}

/**
 * Intelligent list page scraping with auto-detection
 */
async function scrapeListPage(page, job) {
  const list = job.list || {};
  let itemSelector = list.itemSelector;
  let linkSelector = list.linkSelector;
  let fields = list.fields || {};
  
  // Auto-detect if no selectors provided
  if (!itemSelector) {
    console.log('[AUTO-DETECT] Detecting item containers...');
    const containers = await autoDetectItemContainers(page);
    if (containers.length > 0) {
      const bestContainer = containers[0];
      itemSelector = bestContainer.selector;
      console.log('[AUTO-DETECT] Found container:', itemSelector);
    }
  }
  
  if (!itemSelector) {
    itemSelector = 'a[href]'; // fallback
  }
  
  // Auto-detect fields if none provided
  if (Object.keys(fields).length === 0 && itemSelector) {
    console.log('[AUTO-DETECT] Detecting fields...');
    const detectedFields = await autoDetectFields(page, itemSelector);
    if (Object.keys(detectedFields).length > 0) {
      fields = detectedFields;
      console.log('[AUTO-DETECT] Detected fields:', Object.keys(fields));
    }
  }
  
  const items = await page.$$(itemSelector);
  const rows = [];
  const links = [];
  
  console.log(`[SCRAPE] Found ${items.length} items with selector: ${itemSelector}`);
  
  for (const it of items) {
    try {
      const linkEl = linkSelector ? await it.$(linkSelector) : (await it.$('a[href]') || it);
      const href = linkEl ? await linkEl.evaluate((el) => {
        const h = el.getAttribute('href') || el.href || '';
        try { return new URL(h, document.location.href).href; } catch { return h; }
      }) : '';
      
      if (!href) continue;
      links.push(href);
      
      // Extract fields from list item
      let row = {};
      if (Object.keys(fields).length > 0) {
        row = await extractFieldsFromElement(page, it, fields);
      }
      row.Hyperlink = href;
      if (Object.keys(row).length > 0) rows.push(row);
    } catch (e) {
      console.error('[ERROR] Error processing item:', e.message);
    }
  }
  
  return { rows, links };
}

/**
 * Extract fields from a specific element context
 */
async function extractFieldsFromElement(page, element, fieldsMap) {
  const result = {};
  const entries = Object.entries(fieldsMap || {});
  
  for (const [name, selectorOrConfig] of entries) {
    try {
      let value = '';
      
      if (typeof selectorOrConfig === 'string') {
        // Try to find within the element first
        const el = await element.$(selectorOrConfig);
        if (el) {
          value = await el.evaluate((e) => {
            if (e.tagName && e.tagName.toLowerCase() === 'a') {
              return e.getAttribute('href') || e.href || (e.textContent || '').trim();
            }
            if (e.tagName && e.tagName.toLowerCase() === 'img') {
              return e.getAttribute('src') || e.getAttribute('alt') || '';
            }
            return (e.textContent || '').trim();
          });
        }
      } else if (selectorOrConfig.selector) {
        // Handle config objects with fallbacks
        const configs = [selectorOrConfig, ...(selectorOrConfig.fallbacks || []).map(f => ({ selector: f }))];
        
        for (const config of configs) {
          try {
            const el = await element.$(config.selector);
            if (el) {
              value = await el.evaluate((e, attr) => {
                if (attr) return e.getAttribute(attr) || '';
                if (e.tagName && e.tagName.toLowerCase() === 'a') {
                  return e.getAttribute('href') || e.href || (e.textContent || '').trim();
                }
                if (e.tagName && e.tagName.toLowerCase() === 'img') {
                  return e.getAttribute('src') || e.getAttribute('alt') || '';
                }
                return (e.textContent || '').trim();
              }, config.attribute || null);
              
              if (value) break;
            }
          } catch {}
        }
      }
      
      if (value) result[name] = value;
    } catch {}
  }
  
  return result;
}

/**
 * Scrape detail pages
 */
async function scrapeDetailPages(browser, links, job) {
  const out = [];
  const detailFields = (job.detail && job.detail.fields) || {};
  
  for (const href of links) {
    const page = await browser.newPage();
    try {
      await goto(page, href, job.behavior || {});
      
      let row = {};
      if (Object.keys(detailFields).length > 0) {
        row = await extractFields(page, detailFields);
      } else {
        // Auto-detect fields on detail page
        console.log('[AUTO-DETECT] Detecting detail fields...');
        row = await autoDetectDetailFields(page);
      }
      
      row.Hyperlink = href;
      out.push(row);
    } catch (e) {
      console.error('[ERROR] Error scraping detail page:', href, e.message);
    }
    finally { 
      try { await page.close(); } catch {} 
    }
  }
  
  return out;
}

/**
 * Smart auto-detection for detail pages
 */
async function autoDetectDetailFields(page) {
  return await page.evaluate(() => {
    const result = {};
    
    // Extract text content and try to match patterns
    const allText = document.body.innerText;
    
    // Name - usually first significant line
    const nameMatch = allText.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/m);
    if (nameMatch) result.Name = nameMatch[1];
    
    // Dates - look for date patterns
    const dateMatch = allText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/gi);
    if (dateMatch && dateMatch.length >= 1) {
      result.BirthDate = dateMatch[0];
    }
    if (dateMatch && dateMatch.length >= 2) {
      result.DeathDate = dateMatch[dateMatch.length - 1];
    }
    
    // Image - first image on page
    const img = document.querySelector('img');
    if (img) result.Image = img.src || img.getAttribute('alt') || '';
    
    // Description/Biography - largest text block
    const paragraphs = document.querySelectorAll('p');
    if (paragraphs.length > 0) {
      let longestP = paragraphs[0];
      for (const p of paragraphs) {
        if (p.textContent.length > longestP.textContent.length) {
          longestP = p;
        }
      }
      const bio = longestP.textContent.trim();
      if (bio.length > 50) result.Biography = bio.substring(0, 500) + (bio.length > 500 ? '...' : '');
    }
    
    return result;
  });
}

/**
 * Main job runner with dynamic detection
 */
async function runJob(job) {
  const behavior = job.behavior || {};
  const browser = await openBrowser(behavior);
  const page = await browser.newPage();
  const results = [];
  
  try {
    const startUrls = Array.isArray(job.startUrls) ? job.startUrls : (job.startUrls ? [job.startUrls] : []);
    
    for (const url of startUrls) {
      console.log(`[JOB] Scraping: ${url}`);
      
      try {
        await goto(page, url, behavior);
        const { rows, links } = await scrapeListPage(page, job);
        console.log(`[JOB] Found ${links.length} detail links`);
        
        const details = await scrapeDetailPages(browser, links, job);
        
        // Merge list and detail data intelligently
        if (details.length && rows.length && details.length === rows.length) {
          for (let i = 0; i < details.length; i++) {
            results.push(Object.assign({}, rows[i], details[i]));
          }
        } else if (details.length) {
          results.push(...details);
        } else if (rows.length) {
          results.push(...rows);
        }
      } catch (e) {
        console.error(`[ERROR] Error processing URL ${url}:`, e.message);
      }
    }
  } finally {
    try { await page.close(); } catch {}
    try { await browser.close(); } catch {}
  }
  
  console.log(`[JOB] Completed. Scraped ${results.length} items`);
  return { rows: results };
}

module.exports = { runJob, scrapeListPage, scrapeDetailPages };

