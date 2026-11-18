const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('flingo', {
  getState: () => ipcRenderer.invoke('get-state'),
  set: (patch) => ipcRenderer.invoke('set', patch),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  newCode: () => ipcRenderer.invoke('new-code'),
  removeDevice: (id) => ipcRenderer.invoke('remove-device', id),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  preflight: () => ipcRenderer.invoke('preflight'),
  openFolder: () => ipcRenderer.send('open-folder'),
  openFile: (p) => ipcRenderer.send('open-file', p),
  revealFile: (p) => ipcRenderer.send('reveal-file', p),
  dragFile: (p) => ipcRenderer.send('drag-file', p),
  previewEffect: (effect) => ipcRenderer.send('preview-effect', effect),
  identifyScreens: () => ipcRenderer.send('identify-screens'),
  openSettings: (what) => ipcRenderer.send('open-settings', what),
  update: (what) => ipcRenderer.send('update', what),
  openLink: (which) => ipcRenderer.send('open-link', which),
  // Sending to a phone. The page hands over the files a person dropped on it, never a path:
  // where each one is on disk is worked out here, where the page's own code cannot reach, so
  // nothing running in the page can ask for a file the person did not drop. Returns how many.
  sendDropped: (files, phoneId) => {
    const paths = [...(files || [])].map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean);
    if (paths.length) ipcRenderer.send('send-files', paths, phoneId);
    return paths.length;
  },
  // For working on Flingo itself: the app ignores this unless it is run from source.
  sendFiles: (paths, phoneId) => ipcRenderer.send('send-paths', paths, phoneId),
  pickAndSend: (phoneId) => ipcRenderer.send('pick-and-send', phoneId),
  cancelSend: (phoneId) => ipcRenderer.send('cancel-send', phoneId),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onDevices: (fn) => ipcRenderer.on('devices', (_e, d) => fn(d)),
  onTransfer: (fn) => ipcRenderer.on('transfer', (_e, t) => fn(t)),
  onUpdate: (fn) => ipcRenderer.on('update', (_e, u) => fn(u)),
  onShowTab: (fn) => ipcRenderer.on('show-tab', (_e, name) => fn(name)),
});
