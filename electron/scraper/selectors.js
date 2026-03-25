const SUPPORTED_WAIT_UNTIL = ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'];

function normWaitUntil(v) {
  if (!v) return 'domcontentloaded';
  const s = String(v).toLowerCase();
  if (SUPPORTED_WAIT_UNTIL.includes(s)) return s;
  if (s === 'networkidle') return 'networkidle0';
  return 'domcontentloaded';
}

async function extractFields(page, fieldsMap) {
  const entries = Object.entries(fieldsMap || {});
  if (!entries.length) return {};
  const result = {};
  for (const [name, selectorOrJs] of entries) {
    const val = await extractOne(page, selectorOrJs);
    result[name] = val;
  }
  return result;
}

async function extractOne(page, selectorOrJs) {
  if (!selectorOrJs) return '';
  const s = String(selectorOrJs);
  if (s.startsWith('js:')) {
    const body = s.slice(3);
    try {
      return await page.evaluate(new Function(`return (async () => { ${body} })()`));
    } catch {
      return '';
    }
  }
  const selector = s;
  try {
    return await page.$eval(selector, (el) => {
      if (!el) return '';
      if (el.tagName && el.tagName.toLowerCase() === 'a') {
        const href = el.getAttribute('href') || el.href || '';
        try { return new URL(href, document.location.href).href; } catch { return href || (el.textContent || '').trim(); }
      }
      return (el.textContent || '').trim();
    });
  } catch {
    return '';
  }
}

// ===== DYNAMIC DETECTION FRAMEWORK =====

/**
 * Auto-detect item containers that have repeating patterns
 */
async function autoDetectItemContainers(page) {
  return await page.evaluate(() => {
    const candidates = [];
    const minItems = 2;
    
    // Common container selectors for lists/grids
    const containerSelectors = [
      'div[class*="grid"]', 'div[class*="list"]', 'div[class*="card"]',
      'div[class*="item"]', 'section', 'article', 'li', 'div[role="listitem"]',
      '[data-testid*="item"]', '[class*="obituary"]', '[class*="listing"]'
    ];
    
    const containers = document.querySelectorAll(containerSelectors.join(','));
    
    containers.forEach((container) => {
      // Count child containers that look like items
      const children = container.children;
      if (children.length >= minItems) {
        const itemsWithLinks = Array.from(children).filter(child => {
          return child.querySelector('a[href]') || child.tagName === 'A';
        }).length;
        
        if (itemsWithLinks >= minItems) {
          candidates.push({
            selector: getUniqueSelector(container),
            itemCount: itemsWithLinks,
            tag: container.tagName,
            className: container.className,
            hasLinks: true
          });
        }
      }
    });
    
    return candidates.sort((a, b) => b.itemCount - a.itemCount).slice(0, 5);
  });
  
  function getUniqueSelector(el) {
    if (el.id) return '#' + el.id;
    const path = [];
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      let index = 0;
      let sibling = el.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === el.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      const tagName = el.tagName.toLowerCase();
      if (index > 0) path.unshift(`${tagName}:nth-of-type(${index + 1})`);
      else path.unshift(tagName);
      el = el.parentElement;
    }
    return path.join(' > ');
  }
}

/**
 * Auto-detect common obituary field patterns
 */
async function autoDetectFields(page, containerSelector) {
  return await page.evaluate((selector) => {
    const container = document.querySelector(selector);
    if (!container) return {};
    
    const firstItem = container.querySelector('[class*="item"], [class*="card"], li, article, div[role="listitem"]') 
                      || container.firstElementChild;
    if (!firstItem) return {};
    
    const fields = {};
    const text = firstItem.textContent;
    
    // Detect Name (usually first line, longer text, no numbers)
    const nameEl = firstItem.querySelector('[class*="name"], [class*="title"], strong, h2, h3, h4');
    if (nameEl) fields.Name = getUniqueSelector(nameEl);
    
    // Detect Birth Date (format: MMM DD, YYYY or similar)
    const dateElements = firstItem.querySelectorAll('span, p, div');
    dateElements.forEach(el => {
      const txt = el.textContent;
      if (/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}/i.test(txt)) {
        if (!fields.BirthDate) fields.BirthDate = getUniqueSelector(el);
      }
    });
    
    // Detect Image
    const imgEl = firstItem.querySelector('img');
    if (imgEl) fields.Image = getUniqueSelector(imgEl);
    
    // Detect Link/Href
    const linkEl = firstItem.querySelector('a[href]');
    if (linkEl) fields.Hyperlink = getUniqueSelector(linkEl);
    
    return fields;
    
    function getUniqueSelector(el) {
      if (el.id) return '#' + el.id;
      if (el.className) {
        const classes = el.className.split(' ').filter(c => c.length > 0);
        if (classes.length) return '.' + classes.join('.');
      }
      return el.tagName.toLowerCase();
    }
  }, containerSelector);
}

/**
 * Smart extraction with fallback strategies
 */
async function smartExtract(page, fieldConfig) {
  if (typeof fieldConfig === 'string') {
    return await extractOne(page, fieldConfig);
  }
  
  const { selector, fallbacks = [], attribute = null } = fieldConfig;
  
  try {
    // Primary selector
    if (selector) {
      const value = await extractOne(page, selector);
      if (value) return value;
    }
    
    // Try fallback selectors
    for (const fallback of fallbacks) {
      const value = await extractOne(page, fallback);
      if (value) return value;
    }
    
    // Try attribute extraction
    if (attribute && selector) {
      try {
        return await page.$eval(selector, (el, attr) => {
          return el.getAttribute(attr) || '';
        }, attribute);
      } catch {}
    }
  } catch {}
  
  return '';
}

module.exports = {
  normWaitUntil,
  extractFields,
  extractOne,
  autoDetectItemContainers,
  autoDetectFields,
  smartExtract,
};

