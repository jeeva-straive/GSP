const { contextBridge, ipcRenderer } = require('electron');

// Page (inspected site) cannot call Node directly; provide a bridge
try {
  const report = (data) => ipcRenderer.invoke('inspector:report', data);
  contextBridge.exposeInMainWorld('__rdInspector', { report });
  // Also provide a Puppeteer-compatible function name expected by the existing overlay
  contextBridge.exposeInMainWorld('reportSiblings', (payload) => report(payload));
} catch {}
