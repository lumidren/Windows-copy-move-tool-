const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const EFFECTS = ['comet', 'ripple', 'confetti', 'aurora'];
const startHidden = process.argv.includes('--hidden');

let mainWin = null;
let quitting = false;
let pairCode = newCode();
let settings = null;

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

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
}
function saveSettings() { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); }

function newCode() { return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
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

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  mainWin.show();
  mainWin.focus();
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

  });

  app.on('window-all-closed', () => { /* stay alive in the tray */ });
  app.on('before-quit', () => { quitting = true; });
}
