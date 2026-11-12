const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flingo', {
  getState: () => ipcRenderer.invoke('get-state'),
  set: (patch) => ipcRenderer.invoke('set', patch),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
});
