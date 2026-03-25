  /* ---------------- SELECTOR GENERATOR ---------------- */
  function makeSelector(el) {
    if (!el || el.nodeType !== 1) return '';

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
        selector += '#' + CSS.escape(node.id);
        parts.unshift(selector);
        break;
      }

      if (node.classList.length) {
        selector +=
          '.' +
          Array.from(node.classList)
            .map(c => CSS.escape(c))
            .join('.');
      }

      let nth = 1;
      let sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (sib.nodeName === node.nodeName) nth++;
      }
      selector += `:nth-of-type(${nth})`;

      parts.unshift(selector);
      node = node.parentElement;
    }

    return parts.join(' > ');
  }
(function () {
  if (window.__hoverInspectorInstalled__) return;
  window.__hoverInspectorInstalled__ = true;

  let lastAnchor = null;



  /* ---------------- GENERALIZE SELECTOR ---------------- */
  function generalizeSelector(selector) {
    // remove nth-of-type so it matches all similar items
    return selector.replace(/:nth-of-type\(\d+\)/g, '');
  }

  function toAbs(a) {
    try {
      return new URL(a.getAttribute('href'), location.href).href;
    } catch {
      return '';
    }
  }

  /* ---------------- UI ---------------- */
  const popup = document.createElement('div');
  popup.style.cssText = `
    position:absolute;
    z-index:2147483647;
    background:#111;
    color:#fff;
    font:12px Arial;
    padding:8px;
    border-radius:6px;
    display:none;
    max-width:500px;
  `;

  const label = document.createElement('div');
  label.style.marginBottom = '6px';

  const btn = document.createElement('button');
  btn.textContent = 'List Page Siblings';
  btn.style.cssText = `
    background:#4a90e2;
    border:0;
    color:#fff;
    padding:6px 10px;
    border-radius:4px;
    cursor:pointer;
  `;

  const resultBox = document.createElement('div');
  resultBox.style.cssText = `
    margin-top:8px;
    max-height:250px;
    overflow:auto;
    border-top:1px solid rgba(255,255,255,0.2);
    padding-top:6px;
  `;

  popup.appendChild(label);
  popup.appendChild(btn);
  popup.appendChild(resultBox);
  document.body.appendChild(popup);

  /* ---------------- HIGHLIGHT ---------------- */
  const highlight = document.createElement('div');
  highlight.style.cssText = `
    position:absolute;
    z-index:2147483646;
    border:2px solid #4a90e2;
    pointer-events:none;
    display:none;
  `;
  document.body.appendChild(highlight);

  /* ---------------- HOVER DETECTION ---------------- */
  document.addEventListener(
    'mouseover',
    e => {
      const anchor = e.target.closest?.('a[href]');
      if (!anchor) return;

      if (popup.contains(e.target)) return;

      lastAnchor = anchor;

      const sel = makeSelector(anchor);
      popup.dataset.selector = sel;
      label.textContent = sel;

      const r = anchor.getBoundingClientRect();

      popup.style.display = 'block';
      popup.style.left = window.scrollX + r.right + 8 + 'px';
      popup.style.top = window.scrollY + r.top + 'px';

      highlight.style.display = 'block';
      highlight.style.left = window.scrollX + r.left - 2 + 'px';
      highlight.style.top = window.scrollY + r.top - 2 + 'px';
      highlight.style.width = r.width + 4 + 'px';
      highlight.style.height = r.height + 4 + 'px';
    },
    true
  );

  /* ---------------- MAIN LOGIC ---------------- */
  btn.addEventListener('click', () => {
    if (!lastAnchor) return;

    // Simple rule: use parent container; if it has <2 links, try grandparent
    let container = lastAnchor.parentElement || document.body;
    try {
      const linkCount = container.querySelectorAll ? container.querySelectorAll('a[href]').length : 0;
      if (linkCount < 2 && container.parentElement) {
        container = container.parentElement;
      }
    } catch {}

    // Build a container-based selector for visibility/debugging
    let containerSelector = '';
    try { containerSelector = makeSelector(container); } catch {}
    const selector = containerSelector ? (containerSelector + ' a[href]') : 'a[href]';

    const anchors = Array.from(container.querySelectorAll('a[href]'));
    const unique = [];
    const seen = new Set();
    anchors.forEach(a => {
      const href = toAbs(a);
      if (href && !seen.has(href)) {
        seen.add(href);
        unique.push({ href, text: (a.textContent || '').trim() });
      }
    });

    resultBox.innerHTML =
      `<div style="margin-bottom:6px">Found ${unique.length} siblings</div>`;

    unique.forEach(item => {
      const row = document.createElement('div');
      row.innerHTML =
        `<a href="${item.href}" target="_blank" style="color:#9bd1ff">
          ${item.text || item.href}
        </a>`;
      resultBox.appendChild(row);
    });

    // send back to Electron
    if (window.reportSiblings) {
      window.reportSiblings({
        selector,
        siblings: unique,
        pageUrl: location.href
      });
    }

    console.log('Container Selector:', selector);
    console.log('Siblings:', unique);
  });

  console.log('Page-wide Sibling Inspector Installed');
})();

(function () {
  if (window.__visualExtractorInstalled__) return;
  window.__visualExtractorInstalled__ = true;

  window.__extractConfig = {
    baseSelector: '',
    fields: []
  };

 /* ---------------- CONTEXT MENU ---------------- */
  const ctxMenu = document.createElement('div');
  ctxMenu.id = 'customCtxMenu';
  ctxMenu.style.cssText = `
    position:absolute;
    background:#1e1e1e;
    color:#fff;
    font:13px Arial;
    padding:10px;
    border-radius:6px;
    z-index:2147483647;
    display:none;
    min-width:220px;
  `;

  ctxMenu.innerHTML = `
    <div style="margin-bottom:6px;font-weight:bold">Add Field</div>
    <input id="fieldNameInput" placeholder="Field Name" 
           style="width:100%;margin-bottom:6px;padding:4px"/>
    <button id="addFieldBtn"
            style="width:100%;padding:6px;background:#4a90e2;color:#fff;border:0;border-radius:4px">
      Add Field
    </button>
  `;

  document.body.appendChild(ctxMenu);

  let lastPicked = null;

  document.addEventListener('mouseover', e => {
    const a = e.target.closest?.('a[href]');
    if (a) currentHovered = a;
  }, true);

  /* ---------------- RIGHT CLICK ---------------- */
  document.addEventListener('contextmenu', function (e) {

    // Prefer true anchors, but fall back to common clickable/link-like targets
    let targetEl = (e.target && e.target.closest) ? e.target.closest('a[href], [role="link"], button, [onclick], [data-href], [data-url]') : null;
    if (!targetEl && typeof currentHovered !== 'undefined') targetEl = currentHovered;
    if (!targetEl) return;
    try { lastPicked = targetEl; } catch {}

    // Prevent browser menu
    e.preventDefault();

    // DO NOT stop propagation unless required
    // e.stopPropagation(); ❌ remove this

    try {
      lastPicked = targetEl;
      alert(targetEl); // Debugging line
    //   const selector = makeSelector(targetEl);
    //   const generalized = selector.replace(/:nth-of-type\(\d+\)/g, '');
    // alert('sessionStorage detected'); // Debugging line
    //   sessionStorage.setItem(
    //     '__selectedElement',
    //     JSON.stringify({
    //       selector: generalized,
    //       originalSelector: selector
    //     })
      // );

      console.log('Stored selector:', generalized);

    } catch (err) {
      console.error('Selector generation failed:', err);
    }

    // Show your custom menu
    const ctxMenu = document.getElementById('customCtxMenu');
    if (!ctxMenu) {
      console.warn('Context menu element not found');
      return;
    }

    ctxMenu.style.display = 'block';
    ctxMenu.style.left = e.pageX + 'px';
    ctxMenu.style.top = e.pageY + 'px';

  }, true); // 👈 use capture phase for reliability

document.addEventListener('click', (e) => {
  // If click is inside context menu → do nothing
  if (ctxMenu.contains(e.target)) return;

  ctxMenu.style.display = 'none';
});

  /* ---------------- ADD FIELD ---------------- */
document.addEventListener('click', function (e) {
  const isAddBtn = (e.target && (e.target.id === 'addFieldBtn' || (e.target.closest && e.target.closest('#addFieldBtn'))));
  if (!isAddBtn) return;

  try { e.preventDefault(); } catch {}
  try { e.stopImmediatePropagation(); } catch {}
  try { e.stopPropagation(); } catch {}

  const input = document.getElementById('fieldNameInput');
  const fieldName = (input && input.value ? input.value : '').trim();
  if (!fieldName) { alert('Enter Field Name'); return; }
  let stored1 = makeSelector(lastPicked);
  const stored = stored1.replace(/:nth-of-type\(\d+\)/g, '');
  if (!stored) {
    try {
      const fallbackEl = lastPicked || ((typeof currentHovered !== 'undefined' && currentHovered) ? currentHovered : null);
      if (fallbackEl) {
        const sel = makeSelector(fallbackEl);
        const generalized = sel.replace(/:nth-of-type\(\d+\)/g, '');
        const obj = { selector: generalized, originalSelector: sel };
        sessionStorage.setItem('__selectedElement', JSON.stringify(obj));
        stored = JSON.stringify(obj);
      }
    } catch {}
  }

  if (!stored) { alert('No element selected'); return; }

  let parsed;
  try { parsed = JSON.parse(stored); } catch { parsed = null; }
  if (!parsed || !parsed.selector) { alert('No element selected'); return; }

  const columnName = prompt('Enter Column Mapping Name:');
  if (!columnName) return;

  const type = fieldName.toLowerCase().includes('url') ? 'href' : 'text';
  window.__extractConfig.baseSelector = parsed.selector;
  window.__extractConfig.fields.push({ fieldName, columnName, type });
  createTableIfNotExists();
  addColumn(columnName);
  try { extractAll(); } catch {}

  if (input) input.value = '';
  try { document.getElementById('customCtxMenu').style.display = 'none'; } catch {}
  console.log('Field successfully added');
}, true);

  /* ---------------- TABLE ---------------- */
  let tableContainer = null;
  let table = null;

  function createTableIfNotExists() {
    if (tableContainer) return;

    tableContainer = document.createElement('div');
    tableContainer.style.cssText = `
      position:fixed;
      bottom:20px;
      right:20px;
      background:#fff;
      border:1px solid #ccc;
      padding:10px;
      z-index:2147483647;
      max-height:400px;
      overflow:auto;
    `;

    const extractBtn = document.createElement('button');
    extractBtn.textContent = 'Extract All';
    extractBtn.style.cssText = `
      margin-bottom:8px;
      padding:6px 10px;
      background:#28a745;
      color:#fff;
      border:0;
      border-radius:4px;
      cursor:pointer;
    `;

    extractBtn.onclick = extractAll;

    table = document.createElement('table');
    table.border = '1';
    table.style.borderCollapse = 'collapse';

    tableContainer.appendChild(extractBtn);
    tableContainer.appendChild(table);
    document.body.appendChild(tableContainer);
  }

  function addColumn(columnName) {
    if (!table.querySelector('thead')) {
      const thead = document.createElement('thead');
      const row = document.createElement('tr');
      thead.appendChild(row);
      table.appendChild(thead);
    }

    const headerRow = table.querySelector('thead tr');
    const th = document.createElement('th');
    th.textContent = columnName;
    headerRow.appendChild(th);
  }

  /* ---------------- EXTRACT LOGIC ---------------- */
function extractAll() {
  const selector = window.__extractConfig.baseSelector;
  if (!selector) return;

  const elements = Array.from(document.querySelectorAll(selector));

  const tbody = document.createElement('tbody');

  elements.forEach(el => {
    const tr = document.createElement('tr');

    window.__extractConfig.fields.forEach(field => {
      const td = document.createElement('td');

      let value = '';
      if (field.type === 'href') {
        value = el.href || '';
      } else {
        value = el.textContent.trim();
      }

      td.textContent = value;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  const old = table.querySelector('tbody');
  if (old) old.remove();

  table.appendChild(tbody);
}

  /* fallback selector */
  function generateSimpleSelector(el) {
    if (el.id) return `#${el.id}`;
    if (el.className) return `${el.tagName.toLowerCase()}.${el.className.split(' ').join('.')}`;
    return el.tagName.toLowerCase();
  }

})();

document.addEventListener('click', function (e) {
  const menu = document.getElementById('customCtxMenu');
  if (!menu) return;

  if (e.target.id === 'addFieldBtn') return; // allow button click
  if (menu.contains(e.target)) return; // allow input typing

  menu.style.display = 'none';
});

