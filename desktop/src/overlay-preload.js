// What the arrival screen may do, and nothing else. It shows pictures that came from a phone,
// so it is given no way to read settings, pick files, or send anything anywhere: only to be
// told what has arrived and to say when it has finished showing it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flingo', {
  overlayIdle: (stats) => ipcRenderer.send('overlay-idle', stats),
  onArrive: (fn) => ipcRenderer.on('arrive', (_e, item) => fn(item)),
  onProgress: (fn) => ipcRenderer.on('progress', (_e, p) => fn(p)),
});
