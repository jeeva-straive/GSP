// const { contextBridge, ipcRenderer } = require('electron');

// try {
//   contextBridge.exposeInMainWorld('electronAPI', {
//     openInspector: (args) => ipcRenderer.invoke('inspector:open', args),
//     closeInspector: () => ipcRenderer.invoke('inspector:close'),
//     attachInspector: (sessionId) => ipcRenderer.invoke('attach-inspector', sessionId),
//     pieOpen: (args) => ipcRenderer.invoke('pie:open', args),
//     pieGoHome: () => ipcRenderer.invoke('pie:home'),
//     // New helpers for webview-targeted inspector and result subscription
//     openInspectorOnWebview: (args) => ipcRenderer.invoke('inspector:open', args),
//     onSiblingsReported: (cb) => {
//       if (typeof cb !== 'function') return () => {};
//       const wrapped = (_e, payload) => cb(payload);
//       ipcRenderer.on('siblings-reported', wrapped);
//       return () => ipcRenderer.removeListener('siblings-reported', wrapped);
//     },
//     onInspectorStatus: (cb) => {
//       if (typeof cb !== 'function') return () => {};
//       const wrapped = (_e, payload) => cb(payload);
//       ipcRenderer.on('inspector:status', wrapped);
//       return () => ipcRenderer.removeListener('inspector:status', wrapped);
//     },
//     openWebviewDevTools: (webContentsId) => ipcRenderer.invoke('inspector:devtools', webContentsId),
//     // PIE helpers
//     pieStatus: () => ipcRenderer.invoke('pie:status'),
//     pieReinit: (opts) => ipcRenderer.invoke('pie:reinit', opts),
//     // BrowserView controls
//     bvCreate: (args) => ipcRenderer.invoke('bv:create', args),
//     bvLoad: (args) => ipcRenderer.invoke('bv:load', args),
//     bvOpenInspector: (args) => ipcRenderer.invoke('bv:open-inspector', args),
//     bvClose: () => ipcRenderer.invoke('bv:close'),
//     bvOpenDevTools: () => ipcRenderer.invoke('bv:devtools'),
//     bvGetState: () => ipcRenderer.invoke('bv:get-state'),
//   });
// } catch (e) {
//   // No-op if contextIsolation is off or expose fails
// }

const { contextBridge, ipcRenderer } = require('electron');



// Bridge for Angular UI
contextBridge.exposeInMainWorld('electronAPI', {
    loadUrl: (url) => ipcRenderer.send('load-url', url),
    setBrowserBounds: (bounds) => ipcRenderer.send('set-browser-bounds', bounds),
    onDataReceived: (callback) => ipcRenderer.on('scraped-data-received', (event, data) => callback(data)),
    onExtractStateUpdate: (callback) => {
        if (typeof callback !== 'function') return () => {};
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on('extract-state-updated', listener);
        return () => ipcRenderer.removeListener('extract-state-updated', listener);
    },
    triggerExtractAction: (sessionId, action, payload = {}) =>
        ipcRenderer.invoke('extractor:action', { sessionId, action, payload }),
    getExtractState: (sessionId) =>
        ipcRenderer.invoke('extractor:get-state', { sessionId }),
    crawlSiteLinks: (payload) => ipcRenderer.invoke('search:crawl-links', payload)
});

// Bridge for Target Website (Injected Script)
contextBridge.exposeInMainWorld('ipcBridge', {
    sendData: (payload) => ipcRenderer.send('report-data-from-site', payload)
});
