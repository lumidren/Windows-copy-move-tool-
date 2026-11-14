const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, screen, Notification, powerSaveBlocker, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');
const qrcode = require('qrcode-generator');
const { startServer, cleanStaleParts, sanitizeName, HTTP_PORT } = require('./server');
const { createOutbox } = require('./outbox');
const { filesFromArgv, filesFromHandover, toHandover, SEND_FLAG } = require('./sendargs');
const addresses = require('./addresses');
const { loadOrCreateIdentity, fingerprint, securityCode } = require('./cert');
const { runPreflight } = require('./preflight');
const updates = require('./update');

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', 'assets', 'tray.png');
const EFFECTS = ['comet', 'ripple', 'confetti', 'aurora'];
const MOTION = ['system', 'reduce', 'full'];
const STAGE_EFFECT = 'comet'; // reads best from the back of a room
const STAGE_ZOOM = 1.22;
const SELF_TEST = 'Pre-flight test';
const SLOW_TRANSFER_BYTES = 3 * 1024 * 1024; // show progress on screen for anything larger
const HISTORY_MAX = 200;
const WAIT_MS = 30_000; // how long a cut-off transfer waits for the phone to carry on
const BATCH_GAP_MS = 8_000; // a batch with nothing arriving for this long is over
const PART_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// The About card's links. The window asks for one by name, so it can never open anything else.
const LINKS = {
  website: 'https://lumidren.github.io/Windows-copy-move-tool-/',
  github: 'https://github.com/lumidren',
  linkedin: 'https://www.linkedin.com/in/lumidren',
  source: 'https://github.com/lumidren/Windows-copy-move-tool-',
};
const UPDATE_FIRST_CHECK_MS = 20_000; // after the window is up, so starting stays quick
const UPDATE_EVERY_MS = 12 * 60 * 60 * 1000;
// Opening one of these by double-click would run it, so the app shows it in its folder instead.
const RUNNABLE = /\.(exe|msi|bat|cmd|com|scr|pif|lnk|ps1|vbs|vbe|js|jse|wsf|wsh|hta|jar|reg|cpl|msc|dll|sh|desktop|appimage|run|apk)$/i;
const startHidden = process.argv.includes('--hidden');
// Files to send to a phone, when Flingo was started from Explorer's "Send to" menu. Null otherwise.
const sendAtStart = filesFromArgv(process.argv);
const isLinux = process.platform === 'linux';

// Transparent windows need an ARGB visual on X11 and XWayland (GNOME, Xfce, KDE).
if (isLinux) app.commandLine.appendSwitch('enable-transparent-visuals');
// The arrival sound plays in a window nobody clicks, so it cannot wait for a user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWin = null;
let overlayWin = null;
let tray = null;
let quitting = false;
let framesStarted = false;
let overlayShown = false;
let stateTimer = null;
let historyTimer = null;
let pairCode = newCode();
let settings = null;
let history = [];
let identity = null; // { key, cert } PEM, or null if it could not be created
let receiver = null;
let sleepBlocker = null;
let selfToken = null;
let selfResult = null; // filled in while a pre-flight transfer is running
const lastSeen = new Map(); // device id -> { at, ip }
const outRuns = new Map(); // phone id -> the files being sent to it in one go
const transfers = new Map(); // transfer key -> one file on its way that is not part of a batch
const batches = new Map(); // phone + batch id -> a group of files sent together
const memberOf = new Map(); // transfer key -> the batch it belongs to

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const historyFile = () => path.join(app.getPath('userData'), 'history.json');
const identityFile = () => path.join(app.getPath('userData'), 'identity.json');

function loadSettings() {
  const defaults = {
    deviceId: crypto.randomBytes(8).toString('hex'),
    name: os.hostname(),
    saveDir: path.join(app.getPath('pictures'), 'Flingo'),
    effect: 'comet',
    showOverlay: true,
    sound: false,
    motion: 'system', // 'system' follows this PC's animation setting, 'reduce' and 'full' override it
    stage: false,
    pairingLocked: false,
    overlayDisplay: 'auto', // or a display id
    launchAtLogin: false,
    sendToMenu: true, // Windows: "Phone (Flingo)" in Explorer's Send to menu
    autoUpdate: true, // look for a newer release now and then; nothing installs without a click
    updateDismissed: '', // the version "Later" was pressed on
    devices: [], // {id, name, deviceId, hash, added}
  };
  try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch { settings = defaults; }
  if (!EFFECTS.includes(settings.effect)) settings.effect = 'comet';
  if (!MOTION.includes(settings.motion)) settings.motion = 'system';
  if (!Array.isArray(settings.devices)) settings.devices = [];
  saveSettings();
  try { history = JSON.parse(fs.readFileSync(historyFile(), 'utf8')); } catch { history = []; }
  if (!Array.isArray(history)) history = [];
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* disk full or read-only: keep running */ }
}
function saveHistory() {
  clearTimeout(historyTimer);
  historyTimer = null;
  try { fs.writeFileSync(historyFile(), JSON.stringify(history.slice(0, HISTORY_MAX))); } catch { /* keep running */ }
}
/** For arrivals: a batch of 200 photos writes the list to disk once a second, not 200 times. */
function saveHistorySoon() {
  if (!historyTimer) historyTimer = setTimeout(saveHistory, 1000);
}

function newCode() { return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// The address this PC uses to reach the network, found again every few seconds. It goes
// first in the pairing code, so a phone tries the live address before any other (see addresses.js).
let wayOut = '';
function lanAddresses() {
  return addresses.lanAddresses(os.networkInterfaces(), wayOut);
}
async function refreshWayOut() {
  const found = await addresses.primaryAddress();
  if (found === wayOut) return;
  wayOut = found;
  pushState(); // the QR code is drawn from the list, so it has to be drawn again
}

// ---------- pairing link + QR ----------
// Everything a phone needs to pair without discovery: where the PC is, the one-time
// code, and the certificate fingerprint to pin. Kept as short as possible, because a
// shorter link makes a QR code with bigger squares that scans from further away. The
// PC's name and id are not in it; the phone learns them when it pairs.
function pairUri() {
  const port = receiver ? receiver.port : HTTP_PORT;
  let uri = `flingo://pair?h=${lanAddresses().slice(0, addresses.MAX_IN_LINK).join(',')}&c=${pairCode}`;
  if (port !== HTTP_PORT) uri += `&p=${port}`;
  if (identity) uri += `&fp=${fingerprint(identity.cert).toString('base64url')}`;
  return uri;
}

function qrRows(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    let row = '';
    for (let c = 0; c < n; c++) row += qr.isDark(r, c) ? '1' : '0';
    rows.push(row);
  }
  return rows;
}

// ---------- displays ----------
function displayList() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    index: i + 1,
    primary: d.id === primary,
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    scale: Math.round(d.scaleFactor * 100),
  }));
}

/** The screen arrivals are drawn on: the one chosen, or the main one if it is gone. */
function targetDisplay() {
  return screen.getAllDisplays().find((d) => String(d.id) === settings.overlayDisplay) || screen.getPrimaryDisplay();
}

function devicesState() {
  return settings.devices.map(({ id, name, added }) => ({ id, name, added, lastSeen: lastSeen.get(id)?.at || 0 }));
}

function publicState() {
  const locked = settings.pairingLocked;
  return {
    name: settings.name,
    code: locked ? '' : pairCode,
    qr: locked ? null : qrRows(pairUri()),
    pairingLocked: locked,
    addresses: lanAddresses(),
    port: receiver ? receiver.port : HTTP_PORT,
    secure: !!identity,
    securityCode: identity ? securityCode(identity.cert) : '',
    saveDir: settings.saveDir,
    effect: settings.effect,
    effects: EFFECTS,
    showOverlay: settings.showOverlay,
    sound: settings.sound,
    motion: settings.motion,
    stage: settings.stage,
    launchAtLogin: settings.launchAtLogin,
    sendToMenu: settings.sendToMenu !== false,
    sendToMenuName: SEND_TO_NAME,
    displays: displayList(),
    overlayDisplay: settings.overlayDisplay,
    overlayTarget: String(targetDisplay().id),
    sendTo: defaultPhone()?.id || '',
    devices: devicesState(),
    history: history.filter((h) => fs.existsSync(h.path)).map((h) => ({ ...h, url: pathToFileURL(h.path).href })),
    platform: process.platform,
    version: app.getVersion(),
    update: updateState(),
  };
}
function sendMain(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}
function pushState() {
  clearTimeout(stateTimer);
  stateTimer = null;
  sendMain('state', publicState());
}
/** For bursts: a batch of 200 photos refreshes the window a few times a second, not 200 times. */
function pushStateSoon() {
  if (!stateTimer) stateTimer = setTimeout(pushState, 350);
}

// ---------- windows ----------
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1040, height: 760, minWidth: 760, minHeight: 540,
    show: false,
    backgroundColor: '#0e1016',
    icon: ICON,
    title: 'Flingo',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.once('ready-to-show', () => {
    if (!startHidden) mainWin.show();
    else if (isLinux) { mainWin.show(); mainWin.minimize(); } // no tray to reopen from
  });
  mainWin.webContents.on('did-finish-load', applyStage);
  // Links never navigate the app window.
  mainWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWin.webContents.on('will-navigate', (e) => e.preventDefault());
  if (process.env.FLINGO_DEBUG_MAIN) {
    mainWin.webContents.on('console-message', (_e, _l, msg) => console.log('[renderer]', msg));
    setInterval(async () => {
      try { fs.writeFileSync(process.env.FLINGO_DEBUG_MAIN, (await mainWin.webContents.capturePage()).toPNG()); } catch { /* debug only */ }
    }, 2000);
  }
  mainWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    // GNOME shows no tray icons by default, so a hidden window would be unreachable there.
    if (isLinux) mainWin.minimize();
    else mainWin.hide(); // keep receiving from the tray
  });
}

function createOverlay() {
  const { bounds } = targetDisplay();
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
  if (isLinux) overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
}

/** Moves the overlay onto the arrival screen. Called before every use and whenever screens change. */
function placeOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) createOverlay();
  const { bounds } = targetDisplay();
  overlayWin.setBounds(bounds);
  // Moving between screens with different scaling can land one step off; the second call settles it.
  overlayWin.setBounds(bounds);
}

function whenOverlayReady(fn) {
  placeOverlay();
  if (overlayWin.webContents.isLoading()) overlayWin.webContents.once('did-finish-load', fn);
  else fn();
}

/** Sends something to draw to the arrival screen, showing its window first if it was hidden. */
function toOverlay(channel, payload) {
  const send = () => {
    if (!overlayShown) { overlayWin.showInactive(); overlayShown = true; }
    // Every message says how much movement is wanted, so a change of setting takes effect at once.
    overlayWin.webContents.send(channel, { ...payload, motion: settings.motion });
  };
  // While it is already on screen there is no need to place it again for every progress tick.
  if (overlayShown && overlayWin && !overlayWin.isDestroyed() && !overlayWin.webContents.isLoading()) send();
  else whenOverlayReady(send);
}

function playOverlay(item) {
  whenOverlayReady(() => {
    overlayWin.showInactive();
    overlayShown = true;
    overlayWin.webContents.send('arrive', { ...item, sound: settings.sound, motion: settings.motion });
    const cap = process.env.FLINGO_DEBUG_CAPTURE;
    if (cap) {
      setTimeout(async () => {
        try { fs.writeFileSync(cap, (await overlayWin.webContents.capturePage()).toPNG()); } catch { /* debug only */ }
      }, 1500);
    }
    // Debug: dump the first arrival as numbered frames (used to make the README animation).
    const framesDir = process.env.FLINGO_DEBUG_FRAMES;
    if (framesDir && !framesStarted) {
      framesStarted = true;
      fs.mkdirSync(framesDir, { recursive: true });
      const t0 = Date.now();
      let n = 0;
      const grab = async () => {
        const t = Date.now() - t0;
        if (t > 3500) return;
        try {
          const shot = (await overlayWin.webContents.capturePage()).resize({ width: 960 });
          fs.writeFileSync(path.join(framesDir, `f${String(n++).padStart(3, '0')}_${t}.png`), shot.toPNG());
        } catch { /* debug only */ }
        setTimeout(grab, 15);
      };
      grab();
    }
  });
}

/** Shows a large number on every screen for two seconds, so the arrival screen can be picked by eye. */
function identifyScreens() {
  screen.getAllDisplays().forEach((d, i) => {
    const size = 220;
    const win = new BrowserWindow({
      x: Math.round(d.bounds.x + (d.bounds.width - size) / 2), y: Math.round(d.bounds.y + (d.bounds.height - size) / 2),
      width: size, height: size, frame: false, transparent: true, resizable: false, skipTaskbar: true,
      focusable: false, alwaysOnTop: true, hasShadow: false, show: false,
    });
    win.setIgnoreMouseEvents(true);
    const html = `<body style="margin:0;height:100vh;display:grid;place-items:center;background:rgba(14,16,22,.92);border-radius:36px;color:#fff;font:700 140px 'Segoe UI',sans-serif">${i + 1}</body>`;
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.once('ready-to-show', () => win.showInactive());
    setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 2000);
  });
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  } catch {
    return; // no status-notifier host on this desktop; the window stays reachable from the dock
  }
  tray.setToolTip('Flingo — ready to receive');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Flingo', click: showMain },
    { label: 'Open received folder', click: () => { fs.mkdirSync(settings.saveDir, { recursive: true }); shell.openPath(settings.saveDir); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showMain);
}

// Linux launcher entry, also used for start-at-login (~/.config/autostart).
function desktopEntry(extraArgs = '') {
  const exe = process.env.APPIMAGE || process.execPath;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Flingo',
    'Comment=Flick photos from your phone to this PC',
    `Exec="${exe}"${extraArgs}`,
    `Icon=${ICON}`,
    'Terminal=false',
    'Categories=Utility;Network;FileTransfer;',
    'StartupWMClass=Flingo',
    '',
  ].join('\n');
}

function installShortcuts() {
  if (!app.isPackaged) return;
  if (isLinux) {
    // A .deb install already ships a system-wide launcher.
    if (fs.existsSync('/usr/share/applications/flingo.desktop')) return;
    try {
      const dir = path.join(app.getPath('home'), '.local', 'share', 'applications');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'flingo.desktop'), desktopEntry());
    } catch { /* non-fatal */ }
    return;
  }
  if (process.platform !== 'win32') return;
  const opts = { target: process.execPath, description: 'Flick photos from your phone to this PC', icon: process.execPath, iconIndex: 0 };
  const targets = [
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Flingo.lnk'),
    path.join(app.getPath('desktop'), 'Flingo.lnk'),
  ];
  for (const lnk of targets) {
    try { shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'update' : 'create', opts); } catch { /* non-fatal */ }
  }
}

// ---------- Explorer's "Send to" menu ----------
// Windows shows every shortcut in the SendTo folder under right-click > Send to, and starts
// the shortcut's program with all the selected files on its command line. So one shortcut
// to "Flingo.exe --send" is the whole integration: nothing is added to the registry, and
// deleting the shortcut removes it. The installer creates and removes it too (see
// installer/sendto.nsh); doing it here as well keeps it in step with the setting, points it
// at this copy after an update, and covers a copy that was unpacked instead of installed.
const SEND_TO_NAME = `Phone (${app.getName()})`;

function sendToLink() {
  // A copy run from source leaves Explorer alone, unless a folder to practise in is named.
  if (!app.isPackaged) return process.env.FLINGO_SENDTO_DIR ? path.join(process.env.FLINGO_SENDTO_DIR, `${SEND_TO_NAME}.lnk`) : null;
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', `${SEND_TO_NAME}.lnk`);
}

function syncSendToMenu() {
  if (process.platform !== 'win32') return;
  const lnk = sendToLink();
  if (!lnk) return;
  try {
    if (settings.sendToMenu === false) { fs.rmSync(lnk, { force: true }); return; }
    shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'update' : 'create', {
      target: process.execPath,
      // From source, Electron has to be told which app to run before it is told what to send.
      args: app.isPackaged ? SEND_FLAG : `"${app.getAppPath()}" ${SEND_FLAG}`,
      description: `Send to your phone with ${app.getName()}`,
      icon: app.isPackaged ? process.execPath : path.join(__dirname, '..', 'assets', 'icon.ico'),
      iconIndex: 0,
    });
  } catch { /* non-fatal: dragging onto the window still works */ }
}

function setLaunchAtLogin(enabled) {
  if (!isLinux) {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
    return;
  }
  const file = path.join(app.getPath('home'), '.config', 'autostart', 'flingo.desktop');
  try {
    if (enabled) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, desktopEntry(' --hidden'));
    } else {
      fs.rmSync(file, { force: true });
    }
  } catch { /* non-fatal */ }
}

// ---------- stage mode ----------
// For presenting: the display never sleeps, arrivals are always shown, and pairing
// is locked so nobody in the room can add their own phone.
function applyStage() {
  if (settings.stage && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
  if (!settings.stage && sleepBlocker !== null) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = null; }
  // Enlarge the whole window so it reads from a few steps away.
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.setZoomFactor(settings.stage ? STAGE_ZOOM : 1);
}

function setStage(on) {
  settings.stage = on;
  if (on) {
    settings.showOverlay = true;
    settings.effect = STAGE_EFFECT;
    if (settings.devices.length) settings.pairingLocked = true;
  }
  applyStage();
}

// ---------- receiving ----------
function isImage(mime, name) {
  return /^image\//.test(mime) || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name);
}

function fmtSize(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
const short = (name, max = 30) => (name.length > max ? `${name.slice(0, max - 1)}…` : name);
const files = (n) => `${n} file${n === 1 ? '' : 's'}`;

function notify(body, onClick) {
  if (settings.stage || !Notification.isSupported()) return;
  const n = new Notification({ title: 'Flingo', body, icon: ICON });
  n.on('click', onClick);
  n.show();
}

function remember(file) {
  const entry = {
    path: file.path, name: file.name, size: file.size, from: file.from,
    image: isImage(file.mime, file.name), at: Date.now(),
  };
  history.unshift(entry);
  history = history.slice(0, HISTORY_MAX);
  saveHistorySoon();
  return entry;
}

function fly(entry, x) {
  playOverlay({
    url: entry.image ? pathToFileURL(entry.path).href : null,
    name: entry.name, from: entry.from, x, effect: settings.effect,
  });
}

function handleFile(file) {
  if (file.from === SELF_TEST) {
    // A pre-flight transfer: check it, play it, and leave no trace.
    if (selfResult) selfResult.path = file.path;
    if (settings.showOverlay) playOverlay({ url: pathToFileURL(file.path).href, name: SELF_TEST, from: SELF_TEST, x: 0.5, effect: settings.effect });
    setTimeout(() => fs.rm(file.path, { force: true }, () => {}), 8000);
    return;
  }
  const entry = remember(file);
  const batch = memberOf.get(file.key);
  if (batch) {
    // One of many: no flight of its own unless the phone flicked this very one.
    pushStateSoon();
    if (!file.quiet && settings.showOverlay) fly(entry, file.x);
    batchFileDone(batch, file);
    return;
  }
  pushState();
  const tr = transfers.get(file.key);
  transfers.delete(file.key);
  const flies = settings.showOverlay && !file.quiet;
  // Without a flight, the progress card stays a moment longer to say the file is here.
  post({
    id: file.key, state: 'done', title: `Received ${short(entry.name)}`,
    detail: `from ${entry.from} · ${fmtSize(entry.size)}`, fraction: 1, hold: flies ? 260 : 1700,
  }, flies ? !!tr && tr.onScreen : true);
  if (flies) fly(entry, file.x);
  else if (!settings.showOverlay) notify(`${entry.name} received from ${entry.from}`, () => shell.showItemInFolder(entry.path));
}

// ---------- progress ----------
// A card is one line of progress: shown as a row in the window, and as a pill on the
// arrival screen when it is worth the audience's attention. {pct} in the detail is
// filled in by whoever draws it, so the number can glide instead of jumping.
function post(card, onScreen) {
  sendMain('transfer', card);
  if (onScreen && settings.showOverlay) toOverlay('progress', card);
}

function showTransfer(tr) {
  // Small files finish before a pill could be read; large ones would look frozen without one.
  if (tr.total === null || tr.total > SLOW_TRANSFER_BYTES) tr.onScreen = true;
  if (tr.waiting) {
    post({
      id: tr.key, state: 'waiting', lost: true, title: 'Connection lost',
      detail: `Waiting for ${tr.from} to carry on with ${short(tr.name, 24)}`,
      fraction: tr.total ? tr.received / tr.total : null,
    }, tr.onScreen);
    return;
  }
  post({
    id: tr.key, state: 'active', title: `Receiving ${short(tr.name)}`,
    detail: tr.total ? `from ${tr.from} · {pct}% of ${fmtSize(tr.total)}` : `from ${tr.from} · ${fmtSize(tr.received)}`,
    fraction: tr.total ? tr.received / tr.total : null,
  }, tr.onScreen);
}

function failTransfer(tr) {
  clearTimeout(tr.timer);
  transfers.delete(tr.key);
  post({
    id: tr.key, state: 'failed', title: 'Transfer interrupted',
    detail: `${short(tr.name, 24)} from ${tr.from} did not finish. Send it again.`, hold: 2400,
  }, tr.onScreen);
}

function transferStarted(t) {
  if (t.from === SELF_TEST) return;
  if (t.batch) { batchFileStarted(t); return; }
  // The same key again means the phone is carrying on with a transfer that was cut off.
  const old = transfers.get(t.key);
  if (old) clearTimeout(old.timer);
  const tr = {
    key: t.key, name: t.name, from: t.from, total: t.total, received: t.received,
    waiting: false, timer: null, onScreen: !!old && old.onScreen,
  };
  transfers.set(t.key, tr);
  showTransfer(tr);
}

function transferProgress(p) {
  const batch = memberOf.get(p.key);
  if (batch) {
    const cur = batch.current.get(p.key);
    if (cur) cur.received = p.received;
    showBatch(batch);
    return;
  }
  const tr = transfers.get(p.key);
  if (!tr) return;
  tr.received = p.received;
  showTransfer(tr);
}

function transferEnded({ key, ok, waiting }) {
  if (ok) return; // the file itself follows, and handleFile closes the card
  const batch = memberOf.get(key);
  if (batch) { batchFileFailed(batch, key, waiting); return; }
  const tr = transfers.get(key);
  if (!tr) return;
  if (!waiting) { failTransfer(tr); return; }
  tr.waiting = true;
  tr.timer = setTimeout(() => failTransfer(tr), WAIT_MS);
  showTransfer(tr);
}

/** The phone's owner pressed Cancel. Say so, instead of waiting for a phone that is not coming back. */
function transferCancelled({ key }) {
  const batch = memberOf.get(key);
  if (batch) { batch.stopped = true; closeBatch(batch); return; }
  const tr = transfers.get(key);
  if (!tr) return;
  clearTimeout(tr.timer);
  transfers.delete(key);
  post({
    id: key, state: 'failed', title: 'Stopped on the phone',
    detail: `${short(tr.name, 24)} from ${tr.from} was cancelled.`, hold: 1900,
  }, tr.onScreen);
}

// ---------- batches ----------
// Many files sent in one go share a single card ("12 of 40") instead of forty flights.
function batchFileStarted(t) {
  const key = `${t.from}|${t.batch.id}`;
  let b = batches.get(key);
  if (!b) {
    b = {
      key, id: `batch-${t.batch.id}`, from: t.from, count: t.batch.count, bytes: t.batch.bytes,
      done: 0, doneBytes: 0, index: 0, waiting: false, timer: null, lastPath: null, last: false, ended: false, stopped: false,
      current: new Map(), // transfer key -> { received, total } for files on their way
    };
    batches.set(key, b);
  }
  clearTimeout(b.timer);
  b.waiting = false;
  b.index = Math.max(b.index, t.batch.index);
  b.current.set(t.key, { received: t.received, total: t.total });
  memberOf.set(t.key, b);
  showBatch(b);
}

function showBatch(b) {
  let inFlight = 0;
  let partFiles = 0;
  for (const c of b.current.values()) {
    inFlight += c.received;
    if (c.total) partFiles += c.received / c.total;
  }
  const fraction = Math.min(1, b.bytes ? (b.doneBytes + inFlight) / b.bytes : (b.done + partFiles) / b.count);
  const at = Math.min(b.count, Math.max(b.index, b.done + 1));
  post(b.waiting ? {
    id: b.id, state: 'waiting', lost: true, title: 'Connection lost',
    detail: `Waiting for ${b.from} to carry on · ${b.done} of ${b.count} received`, fraction,
  } : {
    id: b.id, state: 'active', title: `Receiving ${files(b.count)}`,
    detail: `from ${b.from} · ${at} of ${b.count} · {pct}%`, fraction,
  }, true);
}

function batchFileDone(b, file) {
  memberOf.delete(file.key);
  b.current.delete(file.key);
  b.done++;
  b.doneBytes += file.size;
  b.lastPath = file.path;
  // The last file of a batch ends it even when the count falls short: the phone leaves out
  // files it cannot open, and a PC app restarted mid-batch only sees the second half. A phone
  // sends several files at once, so the last one may land while others are still on their way.
  if (file.batch && file.batch.index >= b.count) b.last = true;
  if (b.last && b.current.size === 0) b.ended = true;
  if (b.done >= b.count || b.ended) { closeBatch(b); return; }
  showBatch(b);
  clearTimeout(b.timer);
  b.timer = setTimeout(() => closeBatch(b), BATCH_GAP_MS);
}

function batchFileFailed(b, key, waiting) {
  // A file that was cut off stays counted at what arrived, so the bar does not jump back.
  if (!waiting) { b.current.delete(key); memberOf.delete(key); }
  b.waiting = true;
  showBatch(b);
  clearTimeout(b.timer);
  b.timer = setTimeout(() => closeBatch(b), WAIT_MS);
}

function closeBatch(b) {
  clearTimeout(b.timer);
  batches.delete(b.key);
  for (const [key, owner] of memberOf) if (owner === b) memberOf.delete(key);
  const all = b.done >= b.count || b.ended;
  post(all ? {
    id: b.id, state: 'done', title: `${files(b.done)} received`,
    detail: `from ${b.from} · ${fmtSize(b.doneBytes)}`, fraction: 1, hold: 1900,
  } : b.stopped ? {
    id: b.id, state: 'failed', title: 'Stopped on the phone',
    detail: `${b.done} of ${files(b.count)} received from ${b.from}.`, hold: 2400,
  } : {
    id: b.id, state: 'failed', title: `${b.done} of ${files(b.count)} received`,
    detail: `The rest did not arrive from ${b.from}. Send them again.`, hold: 3400,
  }, true);
  pushState();
  if (!settings.showOverlay && b.done) {
    notify(`${files(b.done)} received from ${b.from}`, () => {
      if (b.done === 1 && b.lastPath) shell.showItemInFolder(b.lastPath); else shell.openPath(settings.saveDir);
    });
  }
}

// ---------- sending to a phone ----------
// Files for a phone go into the outbox, and the phone collects them (see outbox.js). The
// window shows one card per phone for everything sent to it in one go.
const outbox = createOutbox({ cleanName: sanitizeName, onChange: outboxChanged });
const ONLINE_MS = 15_000;
const STALLED_MS = 5_000; // no bytes for this long means the phone has gone quiet

/** The phone files go to when none is named: the chosen one, else the one heard from last. */
function defaultPhone() {
  const paired = settings.devices;
  if (!paired.length) return null;
  const chosen = paired.find((d) => d.id === settings.sendTo);
  if (chosen) return chosen;
  const heard = (d) => lastSeen.get(d.id)?.at || 0;
  return [...paired].sort((a, b) => heard(b) - heard(a) || b.added - a.added)[0];
}

async function sendToPhone(paths, phoneId) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p).slice(0, 500);
  if (!list.length) return;
  const phone = settings.devices.find((d) => d.id === phoneId) || defaultPhone();
  if (!phone) {
    sendMain('transfer', { id: 'out|none', state: 'failed', title: 'No phone to send to', detail: 'Pair a phone first.', fraction: 1 });
    return;
  }
  // The phone files were last sent to stays the choice, so the list beside the button agrees.
  if (settings.sendTo !== phone.id) { settings.sendTo = phone.id; saveSettings(); pushStateSoon(); }
  let run = outRuns.get(phone.id);
  if (!run) {
    run = { name: phone.name, total: 0, ids: new Set(), ended: new Map(), refused: [], timer: null, watch: null };
    // A Wi-Fi link that dies says nothing, so look again now and then while files are going out.
    run.watch = setInterval(() => showOut(phone.id), 2000);
    outRuns.set(phone.id, run);
  }
  run.total += list.length;
  showOut(phone.id);
  // Each file is read once for its checksum, one after another, and all of them are offered
  // together, so the phone sees one batch and says "3 of 50", not fifty separate arrivals.
  for (const file of list) {
    const item = await outbox.add(phone.id, phone.name, file, { hold: true });
    if (item.error && !item.id) run.refused.push(item.error);
    showOut(phone.id);
  }
  outbox.release(phone.id);
}

function outboxChanged(item) {
  const run = outRuns.get(item.deviceId);
  if (!run) return;
  run.ids.add(item.id);
  const over = item.state === 'done' || item.state === 'failed' || item.state === 'cancelled';
  if (over) run.ended.set(item.id, { state: item.state, size: item.size, error: item.error });
  if (over) { clearTimeout(run.timer); run.timer = null; showOut(item.deviceId); }
  else if (!run.timer) run.timer = setTimeout(() => { run.timer = null; showOut(item.deviceId); }, 120);
}

function showOut(phoneId) {
  const run = outRuns.get(phoneId);
  if (!run) return;
  const id = `out|${phoneId}`;
  const open = [...run.ids].filter((i) => !run.ended.has(i)).map((i) => outbox.get(i)).filter(Boolean);
  const done = [...run.ended.values()].filter((e) => e.state === 'done');
  const settled = run.ended.size + run.refused.length;
  const base = { id, out: true, phone: phoneId };

  if (settled < run.total) {
    const bytes = open.reduce((n, i) => n + i.size, 0) + done.reduce((n, e) => n + e.size, 0);
    const sent = open.reduce((n, i) => n + Math.min(i.sent, i.size), 0) + done.reduce((n, e) => n + e.size, 0);
    const moving = open.some((i) => i.state === 'sending') || done.length > 0;
    const ready = open.filter((i) => i.state === 'queued').length;
    const going = open.filter((i) => i.state === 'sending');
    if (going.length && going.every((i) => i.stalled || Date.now() - i.movedAt > STALLED_MS)) {
      sendMain('transfer', {
        ...base, cancel: true, state: 'waiting', lost: true, title: 'Connection lost',
        detail: `Waiting for ${run.name} to carry on · ${done.length} of ${run.total} · {pct}%`, fraction: bytes ? sent / bytes : 0,
      });
    } else if (moving) {
      sendMain('transfer', {
        ...base, cancel: true, state: 'active', title: `Sending ${files(run.total)} to ${run.name}`,
        detail: `${done.length} of ${run.total} · {pct}%`, fraction: bytes ? sent / bytes : 0,
      });
    } else if (ready) {
      const online = Date.now() - (lastSeen.get(phoneId)?.at || 0) < ONLINE_MS;
      sendMain('transfer', {
        ...base, cancel: true, state: 'waiting', title: `Waiting for ${run.name}`,
        detail: online ? `${files(ready)} ready to go` : `${files(ready)} ready. Open Flingo on the phone and ${ready === 1 ? 'it' : 'they'} will arrive.`,
        fraction: 1,
      });
    } else {
      sendMain('transfer', { ...base, cancel: true, state: 'active', title: `Getting ${files(run.total)} ready for ${run.name}`, detail: '', fraction: null });
    }
    return;
  }

  // Everything is settled one way or the other.
  outRuns.delete(phoneId);
  clearTimeout(run.timer);
  clearInterval(run.watch);
  if (done.length === run.total) {
    sendMain('transfer', { ...base, state: 'done', title: `Sent ${files(run.total)} to ${run.name}`, detail: fmtSize(done.reduce((n, e) => n + e.size, 0)), fraction: 1 });
    return;
  }
  const cancelled = [...run.ended.values()].filter((e) => e.state === 'cancelled').length;
  const why = run.refused[0] || [...run.ended.values()].find((e) => e.state === 'failed')?.error
    || (cancelled ? 'Cancelled.' : 'Something went wrong.');
  sendMain('transfer', {
    ...base, state: 'failed', fraction: 1,
    title: done.length ? `${done.length} of ${run.total} sent to ${run.name}` : `Not sent to ${run.name}`,
    detail: why,
  });
}

function cancelSend(phoneId) {
  const run = outRuns.get(phoneId);
  if (!run) return;
  for (const id of run.ids) if (!run.ended.has(id)) outbox.cancel(id);
}

/**
 * Files that arrived from outside the window: Explorer's "Send to" menu, either as this
 * copy's own command line or handed over by a second copy that then left.
 */
function sendFromOutside(files) {
  showMain();
  const go = () => {
    sendMain('show-tab', 'home'); // the card for these files is on Home
    if (files.length) sendToPhone(files);
  };
  // A window that is still loading would miss the card.
  if (mainWin.webContents.isLoading()) mainWin.webContents.once('did-finish-load', go); else go();
}

// ---------- updates ----------
// Flingo asks GitHub which release is the newest, and says so in the window when it is
// not this one. A copy put in place by the Windows installer can fetch the new installer,
// check it and hand over to it. Every other copy gets a link to the download page.
let update = { state: 'idle', version: '', fraction: 0, message: '' }; // state: idle, checking, current, available, downloading, ready, failed
let found = null; // the newer release, as update.js describes it
let installer = ''; // the downloaded and checked installer
let announced = ''; // the version a notification was already shown for

// Only for working on Flingo itself, never in a packaged copy: a stand-in release list,
// and a dry run that stops short of starting the installer.
const updateDev = app.isPackaged ? {} : { feed: process.env.FLINGO_UPDATE_FEED, dryRun: process.env.FLINGO_UPDATE_DRY_RUN === '1' };
const updatesDir = () => path.join(app.getPath('userData'), 'updates');
const netFetch = (url, init) => net.fetch(url, init);

function canSelfUpdate() {
  if (updateDev.dryRun) return true;
  return process.platform === 'win32' && app.isPackaged
    && fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall Flingo.exe'));
}

function updateState() {
  return {
    ...update,
    auto: settings.autoUpdate,
    selfUpdate: !!(found && found.asset) && canSelfUpdate(),
    dismissed: !!found && settings.updateDismissed === found.version,
  };
}
function setUpdate(patch) {
  update = { ...update, ...patch };
  sendMain('update', updateState());
}

/** [manual] is a click on "Check now": it runs even on stage, and it reports failure. */
async function checkForUpdate(manual = false) {
  if (['checking', 'downloading', 'ready'].includes(update.state)) return;
  // On stage nothing may pop up, and nothing goes on the network that does not have to.
  if (!manual && (settings.stage || !settings.autoUpdate)) return;
  setUpdate({ state: 'checking', message: '' });
  try {
    const origin = updateDev.feed ? new URL('.', updateDev.feed).href : '';
    found = await updates.checkLatest({
      fetch: netFetch,
      current: app.getVersion(),
      platform: process.platform,
      ...(origin ? { feed: updateDev.feed, downloads: origin, releases: origin } : {}),
    });
  } catch {
    // Being offline is normal for Flingo, so only a check somebody asked for says it failed.
    found = null;
    setUpdate({ state: manual ? 'failed' : 'idle', version: '', message: manual ? 'Could not reach GitHub. Is this PC online?' : '' });
    return;
  }
  if (!found) { setUpdate({ state: 'current', version: '' }); return; }
  if (manual && settings.updateDismissed) { settings.updateDismissed = ''; saveSettings(); } // asking brings it back
  setUpdate({ state: 'available', version: found.version });
  const unseen = !mainWin || mainWin.isDestroyed() || !mainWin.isVisible();
  if (unseen && announced !== found.version && settings.updateDismissed !== found.version) {
    announced = found.version;
    notify(`Flingo ${found.version} is available.`, showMain);
  }
}

async function downloadUpdate() {
  if (update.state !== 'available' || !found) return;
  if (!(found.asset && canSelfUpdate())) { shell.openExternal(found.page); return; }
  setUpdate({ state: 'downloading', fraction: 0, message: '' });
  let shown = 0;
  try {
    installer = await updates.download(found, updatesDir(), {
      fetch: netFetch,
      onProgress: (got, of) => {
        const now = Date.now();
        if (now - shown < 200 && got !== of) return;
        shown = now;
        setUpdate({ fraction: got / of });
      },
    });
    setUpdate({ state: 'ready', fraction: 1 });
  } catch (err) {
    const tampered = /checksum|larger/.test(String(err && err.message));
    setUpdate({
      state: 'available',
      message: tampered ? 'The download did not match the release, so it was thrown away. Try again.' : 'The download did not finish. Try again.',
    });
  }
}

function installUpdate() {
  if (update.state !== 'ready' || !installer) return;
  if (transfers.size || batches.size) { setUpdate({ message: 'A file is arriving. Install when it has finished.' }); return; }
  if (updateDev.dryRun) {
    setUpdate({ message: `Dry run: ${path.basename(installer)} was checked but not started.` });
    return;
  }
  // The installer replaces this copy and starts the new one, so this one steps aside.
  const child = spawn(installer, ['--updated'], { detached: true, stdio: 'ignore' });
  child.once('error', () => setUpdate({ message: 'The installer could not be started. Use "What\'s new" to download it by hand.' }));
  child.once('spawn', () => { child.unref(); quitting = true; app.quit(); });
}

function dismissUpdate() {
  if (!found) return;
  settings.updateDismissed = found.version;
  saveSettings();
  setUpdate({});
}

// ---------- pre-flight ----------
/** Sends a real file through the real receiver from this PC, checks it byte for byte, and times the animation. */
function selfTest() {
  return new Promise((resolve) => {
    const body = fs.readFileSync(ICON);
    const started = Date.now();
    selfToken = crypto.randomBytes(32).toString('hex');
    selfResult = { path: null, stats: null };
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      selfToken = null;
      const stats = selfResult ? selfResult.stats : null;
      selfResult = null;
      resolve({ ms: Date.now() - started, ...(stats || {}), ...r });
    };
    const req = (identity ? https : http).request({
      host: '127.0.0.1', port: receiver.port, path: '/send?x=0.5', method: 'POST', agent: false, rejectUnauthorized: false,
      headers: {
        Authorization: `Bearer ${selfToken}`, 'X-Filename': 'Flingo pre-flight test.png',
        'Content-Type': 'image/png', 'Content-Length': body.length,
      },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode !== 200) return finish({ ok: false, error: `The receiver answered with error ${res.statusCode}.` });
        let same = false;
        try { same = fs.readFileSync(selfResult.path).equals(body); } catch { /* not saved */ }
        if (!same) return finish({ ok: false, error: 'The test file was not saved intact. Check the save folder.' });
        const ms = Date.now() - started;
        if (!settings.showOverlay) return finish({ ok: true, ms });
        // Let the arrival play so its frame rate can be reported.
        const wait = (left) => {
          if (selfResult && selfResult.stats) return finish({ ok: true, ms });
          if (left <= 0) return finish({ ok: true, ms });
          setTimeout(() => wait(left - 1), 200);
        };
        wait(30);
      });
    });
    if (identity) {
      req.on('socket', (sock) => sock.on('secureConnect', () => {
        const seen = crypto.createHash('sha256').update(sock.getPeerCertificate().raw).digest();
        if (!seen.equals(fingerprint(identity.cert))) req.destroy(new Error('certificate mismatch'));
      }));
    }
    req.setTimeout(6000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => finish({ ok: false, error: e.message === 'timeout'
      ? 'The receiver did not answer within 6 seconds.'
      : `Could not talk to the receiver (${e.message}).` }));
    req.end(body);
  });
}

async function overlayProbe() {
  await new Promise((resolve) => whenOverlayReady(resolve));
  const d = targetDisplay();
  const renderer = await overlayWin.webContents.executeJavaScript('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
  const b = overlayWin.getBounds();
  return {
    screen: screen.getAllDisplays().findIndex((x) => x.id === d.id) + 1,
    display: { width: d.bounds.width, height: d.bounds.height },
    window: { width: b.width, height: b.height },
    renderer,
    pixels: { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) },
    scale: Math.round(d.scaleFactor * 100),
  };
}

function preflight() {
  return runPreflight({
    platform: process.platform,
    exePath: process.execPath,
    port: receiver.port,
    addresses: lanAddresses(),
    secure: !!identity,
    securityCode: identity ? securityCode(identity.cert) : '',
    saveDir: settings.saveDir,
    stage: settings.stage,
    pairingLocked: settings.pairingLocked,
    showOverlay: settings.showOverlay,
    server: receiver.status(),
    devices: settings.devices.map((d) => ({ name: d.name, lastSeen: lastSeen.get(d.id)?.at || 0, ip: lastSeen.get(d.id)?.ip || '' })),
    overlay: overlayProbe,
    selfTest,
  });
}

// ---------- app ----------
// Only one Flingo runs. A second copy hands over what it was asked to send, then leaves.
if (!app.requestSingleInstanceLock(toHandover(sendAtStart))) {
  app.quit();
} else {
  app.on('second-instance', (_e, _argv, _cwd, data) => {
    const files = filesFromHandover(data);
    if (files) sendFromOutside(files); else showMain();
  });
  app.setAppUserModelId('com.lumidren.flingo');

  app.whenReady().then(() => {
    loadSettings();
    try { identity = loadOrCreateIdentity(identityFile(), 'Flingo'); } catch { identity = null; }
    // Recent partial files stay: a phone may still be waiting to carry on with one.
    cleanStaleParts(settings.saveDir, PART_MAX_AGE_MS);
    updates.cleanDownloads(updatesDir()); // the installer that put this copy here is no longer needed
    applyStage();
    createMainWindow();
    // On Linux the compositor needs a moment before it hands out a transparent visual.
    if (isLinux) setTimeout(createOverlay, 400);
    else createOverlay();
    createTray();
    installShortcuts();
    syncSendToMenu();
    refreshWayOut();
    setInterval(refreshWayOut, 5000).unref(); // Wi-Fi comes and goes; the best address follows it

    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(ev, () => { if (overlayWin && !overlayWin.isDestroyed()) placeOverlay(); pushState(); });
    }

    receiver = startServer({
      info: () => ({ id: settings.deviceId, name: settings.name, ...(identity ? { fp: fingerprint(identity.cert).toString('base64url') } : {}) }),
      pair: ({ code, deviceName, deviceId }) => {
        if (settings.pairingLocked) return { error: 'locked' };
        const a = Buffer.from(sha(code)); const b = Buffer.from(sha(pairCode));
        if (!crypto.timingSafeEqual(a, b)) return { error: 'wrong' };
        const token = crypto.randomBytes(32).toString('hex');
        // One entry per phone: pairing the same phone again replaces its old entry.
        if (deviceId) settings.devices = settings.devices.filter((d) => d.deviceId !== deviceId);
        settings.devices.push({ id: crypto.randomBytes(6).toString('hex'), name: deviceName, deviceId, hash: sha(token), added: Date.now() });
        settings.devices = settings.devices.slice(-20);
        if (settings.stage) settings.pairingLocked = true; // on stage, one phone in and the door shuts
        saveSettings();
        pairCode = newCode(); // one code, one phone
        pushState();
        return { token };
      },
      rotateCode: () => { pairCode = newCode(); pushState(); },
      checkToken: (token) => {
        if (selfToken && token === selfToken) return { id: 'self', name: SELF_TEST };
        const h = sha(token);
        const d = settings.devices.find((x) => x.hash === h);
        return d ? { id: d.id, name: d.name } : null;
      },
      seen: (device, ip) => {
        if (device.id === 'self') return;
        lastSeen.set(device.id, { at: Date.now(), ip });
        sendMain('devices', devicesState());
      },
      saveDir: () => settings.saveDir,
      onStart: transferStarted,
      onProgress: transferProgress,
      onEnd: transferEnded,
      onCancel: transferCancelled,
      onFile: handleFile,
      outbox,
    }, {
      tls: identity,
      // Only for working on Flingo itself: a test copy on another port, next to the one you really use.
      ...(!app.isPackaged && Number(process.env.FLINGO_PORT) ? { port: Number(process.env.FLINGO_PORT) } : {}),
    });
    receiver.ready.then(pushState);

    ipcMain.handle('get-state', () => publicState());
    ipcMain.handle('set', (_e, patch) => {
      if (typeof patch.name === 'string' && patch.name.trim()) settings.name = patch.name.trim().slice(0, 40);
      if (EFFECTS.includes(patch.effect)) settings.effect = patch.effect;
      if (typeof patch.showOverlay === 'boolean') settings.showOverlay = patch.showOverlay || settings.stage;
      if (typeof patch.sound === 'boolean') settings.sound = patch.sound;
      if (MOTION.includes(patch.motion)) settings.motion = patch.motion;
      if (typeof patch.pairingLocked === 'boolean') settings.pairingLocked = patch.pairingLocked;
      if (typeof patch.autoUpdate === 'boolean') settings.autoUpdate = patch.autoUpdate;
      if (typeof patch.sendTo === 'string' && settings.devices.some((d) => d.id === patch.sendTo)) settings.sendTo = patch.sendTo;
      if (typeof patch.stage === 'boolean') setStage(patch.stage);
      if (typeof patch.overlayDisplay === 'string') {
        settings.overlayDisplay = patch.overlayDisplay === 'auto' || screen.getAllDisplays().some((d) => String(d.id) === patch.overlayDisplay)
          ? patch.overlayDisplay : 'auto';
        placeOverlay();
      }
      if (typeof patch.launchAtLogin === 'boolean') {
        settings.launchAtLogin = patch.launchAtLogin;
        setLaunchAtLogin(patch.launchAtLogin);
      }
      if (typeof patch.sendToMenu === 'boolean') {
        settings.sendToMenu = patch.sendToMenu;
        syncSendToMenu();
      }
      saveSettings();
      pushState(); // keep the window right even when the change did not come from a click in it
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
      lastSeen.delete(id);
      saveSettings();
      return publicState();
    });
    ipcMain.handle('clear-history', () => { history = []; saveHistory(); return publicState(); });
    ipcMain.handle('preflight', () => preflight());
    ipcMain.on('open-folder', () => { fs.mkdirSync(settings.saveDir, { recursive: true }); shell.openPath(settings.saveDir); });
    ipcMain.on('open-file', (_e, p) => {
      if (!history.some((h) => h.path === p)) return;
      if (RUNNABLE.test(p)) shell.showItemInFolder(p); else shell.openPath(p);
    });
    ipcMain.on('reveal-file', (_e, p) => { if (history.some((h) => h.path === p)) shell.showItemInFolder(p); });
    ipcMain.on('preview-effect', (_e, effect) => {
      playOverlay({ url: null, name: 'Preview', from: 'Preview', x: 0.5, effect: EFFECTS.includes(effect) ? effect : settings.effect });
    });
    ipcMain.on('identify-screens', identifyScreens);
    ipcMain.on('send-files', (_e, paths, phoneId) => { sendToPhone(paths, phoneId); });
    ipcMain.on('pick-and-send', async (_e, phoneId) => {
      const picked = await dialog.showOpenDialog(mainWin, { title: 'Send to phone', buttonLabel: 'Send', properties: ['openFile', 'multiSelections'] });
      if (!picked.canceled) sendToPhone(picked.filePaths, phoneId);
    });
    ipcMain.on('cancel-send', (_e, phoneId) => cancelSend(String(phoneId)));
    ipcMain.on('open-link', (_e, which) => { if (Object.hasOwn(LINKS, which)) shell.openExternal(LINKS[which]); });
    ipcMain.on('open-settings', (_e, what) => {
      if (what === 'folder') { fs.mkdirSync(settings.saveDir, { recursive: true }); shell.openPath(settings.saveDir); }
      if (process.platform !== 'win32') return;
      if (what === 'firewall') execFile('control.exe', ['firewall.cpl'], () => {});
      if (what === 'notifications') shell.openExternal('ms-settings:notifications');
    });
    ipcMain.on('drag-file', (e, p) => {
      if (!history.some((h) => h.path === p) || !fs.existsSync(p)) return;
      let icon = nativeImage.createFromPath(p);
      icon = icon.isEmpty() ? nativeImage.createFromPath(ICON).resize({ width: 64 }) : icon.resize({ width: 96 });
      e.sender.startDrag({ file: p, icon });
    });
    ipcMain.on('update', (_e, what) => {
      if (what === 'check') checkForUpdate(true);
      if (what === 'download') downloadUpdate();
      if (what === 'install') installUpdate();
      if (what === 'later') dismissUpdate();
      if (what === 'notes' && found) shell.openExternal(found.page);
    });
    // Started from Explorer's "Send to" menu with nothing running yet: send what it named.
    if (sendAtStart) sendFromOutside(sendAtStart);
    setTimeout(checkForUpdate, UPDATE_FIRST_CHECK_MS);
    setInterval(checkForUpdate, UPDATE_EVERY_MS);

    ipcMain.on('overlay-idle', (_e, stats) => {
      if (selfResult && stats && stats.frames > 20) selfResult.stats = { fps: stats.fps, worstMs: stats.worstMs };
      if (process.env.FLINGO_DEBUG_PERF && stats) console.log('[overlay]', JSON.stringify(stats));
      // Stay up while something is still on its way: its next progress tick is already coming.
      if (batches.size || [...transfers.values()].some((t) => t.onScreen)) return;
      overlayShown = false;
      if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
    });
  });

  app.on('window-all-closed', () => { /* stay alive in the tray */ });
  app.on('before-quit', () => {
    quitting = true;
    if (historyTimer) saveHistory(); // the last arrivals have not been written yet
  });
}
