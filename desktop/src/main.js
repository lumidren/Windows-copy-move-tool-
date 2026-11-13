const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, screen, Notification, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const qrcode = require('qrcode-generator');
const { startServer, cleanStaleParts, HTTP_PORT } = require('./server');
const { loadOrCreateIdentity, fingerprint, securityCode } = require('./cert');
const { runPreflight } = require('./preflight');

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', 'assets', 'tray.png');
const EFFECTS = ['comet', 'ripple', 'confetti', 'aurora'];
const STAGE_EFFECT = 'comet'; // reads best from the back of a room
const STAGE_ZOOM = 1.22;
const SELF_TEST = 'Pre-flight test';
const SLOW_TRANSFER_BYTES = 3 * 1024 * 1024; // show progress on screen for anything larger
const HISTORY_MAX = 200;
const WAIT_MS = 30_000; // how long a cut-off transfer waits for the phone to carry on
const BATCH_GAP_MS = 8_000; // a batch with nothing arriving for this long is over
const PART_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Opening one of these by double-click would run it, so the app shows it in its folder instead.
const RUNNABLE = /\.(exe|msi|bat|cmd|com|scr|pif|lnk|ps1|vbs|vbe|js|jse|wsf|wsh|hta|jar|reg|cpl|msc|dll|sh|desktop|appimage|run|apk)$/i;
const startHidden = process.argv.includes('--hidden');
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
let pairCode = newCode();
let settings = null;
let history = [];
let identity = null; // { key, cert } PEM, or null if it could not be created
let receiver = null;
let sleepBlocker = null;
let selfToken = null;
let selfResult = null; // filled in while a pre-flight transfer is running
const lastSeen = new Map(); // device id -> { at, ip }
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
    stage: false,
    pairingLocked: false,
    overlayDisplay: 'auto', // or a display id
    launchAtLogin: false,
    devices: [], // {id, name, deviceId, hash, added}
  };
  try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch { settings = defaults; }
  if (!EFFECTS.includes(settings.effect)) settings.effect = 'comet';
  if (!Array.isArray(settings.devices)) settings.devices = [];
  saveSettings();
  try { history = JSON.parse(fs.readFileSync(historyFile(), 'utf8')); } catch { history = []; }
  if (!Array.isArray(history)) history = [];
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* disk full or read-only: keep running */ }
}
function saveHistory() {
  try { fs.writeFileSync(historyFile(), JSON.stringify(history.slice(0, HISTORY_MAX))); } catch { /* keep running */ }
}

function newCode() { return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function lanAddresses() {
  const out = [];
  // Virtual adapters (VM hosts, WSL, VPNs) are never the address a phone can reach.
  const virtual = /vmware|virtualbox|vethernet|hyper-v|wsl|docker|loopback|tailscale|zerotier/i;
  // VirtualBox, VMware and Hyper-V host adapters, by MAC vendor prefix.
  const virtualMac = /^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:15:5d)/i;
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (virtual.test(name)) continue;
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !virtualMac.test(a.mac || '')) out.push(a.address);
    }
  }
  return out;
}

// ---------- pairing link + QR ----------
// Everything a phone needs to pair without discovery: where the PC is, the one-time
// code, and the certificate fingerprint to pin. Kept as short as possible, because a
// shorter link makes a QR code with bigger squares that scans from further away. The
// PC's name and id are not in it; the phone learns them when it pairs.
function pairUri() {
  const port = receiver ? receiver.port : HTTP_PORT;
  let uri = `flingo://pair?h=${lanAddresses().slice(0, 3).join(',')}&c=${pairCode}`;
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
    stage: settings.stage,
    launchAtLogin: settings.launchAtLogin,
    displays: displayList(),
    overlayDisplay: settings.overlayDisplay,
    overlayTarget: String(targetDisplay().id),
    devices: devicesState(),
    history: history.filter((h) => fs.existsSync(h.path)).map((h) => ({ ...h, url: pathToFileURL(h.path).href })),
    platform: process.platform,
    version: app.getVersion(),
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

function playOverlay(item) {
  whenOverlayReady(() => {
    overlayWin.showInactive();
    overlayWin.webContents.send('arrive', { ...item, sound: settings.sound });
    const cap = process.env.FLINGO_DEBUG_CAPTURE;
    if (cap) {
      setTimeout(async () => {
        try { fs.writeFileSync(cap, (await overlayWin.webContents.capturePage()).toPNG()); } catch { /* debug only */ }
/** Sends something to draw to the arrival screen, showing its window first if it was hidden. */
function toOverlay(channel, payload) {
  const send = () => {
    if (!overlayShown) { overlayWin.showInactive(); overlayShown = true; }
    overlayWin.webContents.send(channel, payload);
  };
  // While it is already on screen there is no need to place it again for every progress tick.
  if (overlayShown && overlayWin && !overlayWin.isDestroyed() && !overlayWin.webContents.isLoading()) send();
  else whenOverlayReady(send);
}

      }, 1500);
    }
    // Debug: dump the first arrival as numbered frames (used to make the README animation).
    overlayShown = true;
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

function handleFile(file) {
  if (file.from === SELF_TEST) {
    // A pre-flight transfer: check it, play it, and leave no trace.
    if (selfResult) selfResult.path = file.path;
    if (settings.showOverlay) playOverlay({ url: pathToFileURL(file.path).href, name: SELF_TEST, from: SELF_TEST, x: 0.5, effect: settings.effect });
    setTimeout(() => fs.rm(file.path, { force: true }, () => {}), 8000);
    return;
  }
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
  } else if (!settings.stage && Notification.isSupported()) {
    const n = new Notification({ title: 'Flingo', body: `${entry.name} received from ${entry.from}`, icon: ICON });
    n.on('click', () => shell.showItemInFolder(entry.path));
    n.show();
  }
}

// Progress for transfers that take long enough to look frozen otherwise.
function showProgress(t) {
  sendMain('transfer', { id: t.id, name: t.name, from: t.from, received: t.received, total: t.total });
  const slow = t.total === null || t.total > SLOW_TRANSFER_BYTES;
  if (!slow || !settings.showOverlay) return;
  whenOverlayReady(() => {
    if (!t.shown) { t.shown = true; overlayWin.showInactive(); }
    overlayWin.webContents.send('progress', { id: t.id, name: t.name, from: t.from, received: t.received, total: t.total });
  });
}

function endProgress(id, ok) {
  const t = transfers.get(id);
  transfers.delete(id);
  if (!t) return;
  sendMain('transfer', { id, done: true, ok, name: t.name, from: t.from });
  if (t.shown && overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('progress', { id, done: true, ok });
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
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  app.setAppUserModelId('com.lumidren.flingo');

  app.whenReady().then(() => {
    loadSettings();
    try { identity = loadOrCreateIdentity(identityFile(), 'Flingo'); } catch { identity = null; }
    // Recent partial files stay: a phone may still be waiting to carry on with one.
    cleanStaleParts(settings.saveDir, PART_MAX_AGE_MS);
    applyStage();
    createMainWindow();
    // On Linux the compositor needs a moment before it hands out a transparent visual.
    if (isLinux) setTimeout(createOverlay, 400);
    else createOverlay();
    createTray();
    installShortcuts();

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
      onStart: (t) => {
        if (t.from === SELF_TEST) return;
        transfers.set(t.id, { ...t, received: 0, shown: false });
        showProgress(transfers.get(t.id));
      },
      onProgress: (p) => {
        const t = transfers.get(p.id);
        if (!t) return;
        t.received = p.received;
        showProgress(t);
      },
      onEnd: ({ id, ok }) => endProgress(id, ok),
      onFile: handleFile,
    }, { tls: identity });
    receiver.ready.then(pushState);

    ipcMain.handle('get-state', () => publicState());
    ipcMain.handle('set', (_e, patch) => {
      if (typeof patch.name === 'string' && patch.name.trim()) settings.name = patch.name.trim().slice(0, 40);
      if (EFFECTS.includes(patch.effect)) settings.effect = patch.effect;
      if (typeof patch.showOverlay === 'boolean') settings.showOverlay = patch.showOverlay || settings.stage;
      if (typeof patch.sound === 'boolean') settings.sound = patch.sound;
      if (typeof patch.pairingLocked === 'boolean') settings.pairingLocked = patch.pairingLocked;
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
    ipcMain.on('overlay-idle', (_e, stats) => {
      if (selfResult && stats && stats.frames > 20) selfResult.stats = { fps: stats.fps, worstMs: stats.worstMs };
      if (process.env.FLINGO_DEBUG_PERF && stats) console.log('[overlay]', JSON.stringify(stats));
      if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
    });
  });

  app.on('window-all-closed', () => { /* stay alive in the tray */ });
  app.on('before-quit', () => { quitting = true; });
}
      // Stay up while something is still on its way: its next progress tick is already coming.
      if (batches.size || [...transfers.values()].some((t) => t.onScreen)) return;
      overlayShown = false;
