const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { startServer, HTTP_PORT } = require('./server');

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', 'assets', 'tray.png');
const EFFECTS = ['comet', 'ripple', 'confetti', 'aurora'];
const startHidden = process.argv.includes('--hidden');

let mainWin = null;
let overlayWin = null;
let tray = null;
let quitting = false;
let pairCode = newCode();
let settings = null;
let history = [];

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const historyFile = () => path.join(app.getPath('userData'), 'history.json');

function loadSettings() {
  const defaults = {
    deviceId: crypto.randomBytes(8).toString('hex'),
    name: os.hostname(),
    saveDir: path.join(app.getPath('pictures'), 'Flingo'),
    effect: 'comet',
    showOverlay: true,
    launchAtLogin: false,
    devices: [], // {id, name, hash, added}
  };
  try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch { settings = defaults; }
  if (!EFFECTS.includes(settings.effect)) settings.effect = 'comet';
  saveSettings();
  try { history = JSON.parse(fs.readFileSync(historyFile(), 'utf8')); } catch { history = []; }
}
function saveSettings() { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); }
function saveHistory() { fs.writeFileSync(historyFile(), JSON.stringify(history.slice(0, 60))); }

function newCode() { return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function publicState() {
  return {
    name: settings.name,
    code: pairCode,
    addresses: lanAddresses(),
    port: HTTP_PORT,
    saveDir: settings.saveDir,
    effect: settings.effect,
    effects: EFFECTS,
    showOverlay: settings.showOverlay,
    launchAtLogin: settings.launchAtLogin,
    devices: settings.devices.map(({ id, name, added }) => ({ id, name, added })),
    history: history.filter((h) => fs.existsSync(h.path)).map((h) => ({ ...h, url: pathToFileURL(h.path).href })),
  };
}
function pushState() {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state', publicState());
}

// ---------- windows ----------
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 940, height: 680, minWidth: 720, minHeight: 520,
    show: false,
    backgroundColor: '#0e1016',
    icon: ICON,
    title: 'Flingo',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.once('ready-to-show', () => { if (!startHidden) mainWin.show(); });
  mainWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWin.hide(); // keep receiving from the tray
  });
}

function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlayWin = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    show: false, frame: false, transparent: true, resizable: false, movable: false,
    skipTaskbar: true, focusable: false, hasShadow: false, alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
}

function playOverlay(item) {
  if (!overlayWin || overlayWin.isDestroyed()) createOverlay();
  const { bounds } = screen.getPrimaryDisplay();
  overlayWin.setBounds(bounds);
  const send = () => {
    overlayWin.showInactive();
    overlayWin.webContents.send('arrive', item);
  };
  if (overlayWin.webContents.isLoading()) overlayWin.webContents.once('did-finish-load', send);
  else send();
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  mainWin.show();
  mainWin.focus();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  tray.setToolTip('Flingo — ready to receive');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Flingo', click: showMain },
    { label: 'Open received folder', click: () => { fs.mkdirSync(settings.saveDir, { recursive: true }); shell.openPath(settings.saveDir); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showMain);
}

// ---------- receiving ----------
function isImage(mime, name) {
  return /^image\//.test(mime) || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name);
}

function handleFile(file) {
  const entry = {
    path: file.path, name: file.name, size: file.size, from: file.from,
    image: isImage(file.mime, file.name), at: Date.now(),
  };
  history.unshift(entry);
  history = history.slice(0, 60);
  saveHistory();
  pushState();
  if (settings.showOverlay) {
    playOverlay({
      url: entry.image ? pathToFileURL(entry.path).href : null,
      name: entry.name, from: entry.from, x: file.x, effect: settings.effect,
    });
  } else if (Notification.isSupported()) {
    const n = new Notification({ title: 'Flingo', body: `${entry.name} received from ${entry.from}`, icon: ICON });
    n.on('click', () => shell.showItemInFolder(entry.path));
    n.show();
  }
}

// ---------- app ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  app.setAppUserModelId('com.lumidren.flingo');

  app.whenReady().then(() => {
    loadSettings();
    createMainWindow();
    createOverlay();
    createTray();

    startServer({
      info: () => ({ id: settings.deviceId, name: settings.name }),
      pair: (code, deviceName) => {
        const a = Buffer.from(sha(code)); const b = Buffer.from(sha(pairCode));
        if (!crypto.timingSafeEqual(a, b)) return null;
        const token = crypto.randomBytes(32).toString('hex');
        settings.devices.push({ id: crypto.randomBytes(6).toString('hex'), name: deviceName, hash: sha(token), added: Date.now() });
        saveSettings();
        pairCode = newCode(); // one code, one phone
        pushState();
        return token;
      },
      checkToken: (token) => {
        const h = sha(token);
        const d = settings.devices.find((x) => x.hash === h);
        return d ? d.name : null;
      },
      saveDir: () => settings.saveDir,
      onFile: handleFile,
    });

    ipcMain.handle('get-state', () => publicState());
    ipcMain.handle('set', (_e, patch) => {
      if (typeof patch.name === 'string' && patch.name.trim()) settings.name = patch.name.trim().slice(0, 40);
      if (EFFECTS.includes(patch.effect)) settings.effect = patch.effect;
      if (typeof patch.showOverlay === 'boolean') settings.showOverlay = patch.showOverlay;
      if (typeof patch.launchAtLogin === 'boolean') {
        settings.launchAtLogin = patch.launchAtLogin;
        app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin, args: ['--hidden'] });
      }
      saveSettings();
      return publicState();
    });
    ipcMain.handle('choose-folder', async () => {
      const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.saveDir });
      if (!r.canceled && r.filePaths[0]) { settings.saveDir = r.filePaths[0]; saveSettings(); }
      return publicState();
    });
    ipcMain.handle('new-code', () => { pairCode = newCode(); return publicState(); });
    ipcMain.handle('remove-device', (_e, id) => {
      settings.devices = settings.devices.filter((d) => d.id !== id);
      saveSettings();
      return publicState();
    });
    ipcMain.handle('clear-history', () => { history = []; saveHistory(); return publicState(); });
    ipcMain.on('open-folder', () => { fs.mkdirSync(settings.saveDir, { recursive: true }); shell.openPath(settings.saveDir); });
    ipcMain.on('open-file', (_e, p) => { if (history.some((h) => h.path === p)) shell.openPath(p); });
    ipcMain.on('reveal-file', (_e, p) => { if (history.some((h) => h.path === p)) shell.showItemInFolder(p); });
    ipcMain.on('preview-effect', (_e, effect) => {
      playOverlay({ url: null, name: 'Preview', from: 'Preview', x: 0.5, effect: EFFECTS.includes(effect) ? effect : settings.effect });
    });
    ipcMain.on('drag-file', (e, p) => {
      if (!history.some((h) => h.path === p) || !fs.existsSync(p)) return;
      let icon = nativeImage.createFromPath(p);
      icon = icon.isEmpty() ? nativeImage.createFromPath(ICON).resize({ width: 64 }) : icon.resize({ width: 96 });
      e.sender.startDrag({ file: p, icon });
    });
    ipcMain.on('overlay-idle', () => { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide(); });
  });

  app.on('window-all-closed', () => { /* stay alive in the tray */ });
  app.on('before-quit', () => { quitting = true; });
}
