const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('telaAPI', {
  onPickSource: (handler) => {
    const listener = (_e, sources) => handler(sources);
    ipcRenderer.on('tela:pick-source', listener);
    return () => ipcRenderer.removeListener('tela:pick-source', listener);
  },
  respondPickSource: (sourceId) => {
    ipcRenderer.send('tela:pick-source-response', sourceId ?? null);
  },
});
