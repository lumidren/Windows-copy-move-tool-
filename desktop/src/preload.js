const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flingo', {
  getState: () => ipcRenderer.invoke('get-state'),
  set: (patch) => ipcRenderer.invoke('set', patch),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  newCode: () => ipcRenderer.invoke('new-code'),
  removeDevice: (id) => ipcRenderer.invoke('remove-device', id),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  openFolder: () => ipcRenderer.send('open-folder'),
  openFile: (p) => ipcRenderer.send('open-file', p),
  revealFile: (p) => ipcRenderer.send('reveal-file', p),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
});
