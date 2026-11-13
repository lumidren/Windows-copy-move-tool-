const $ = (id) => document.getElementById(id);
const api = window.flingo;
const LABELS = { comet: 'Comet', ripple: 'Ripple', confetti: 'Confetti', aurora: 'Aurora' };
const ONLINE_MS = 15000;

let state = null;
let devices = [];
let historyKey = '';
let qrKey = '';
let devicesKey = null;

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

const isOnline = (d) => d.lastSeen && Date.now() - d.lastSeen < ONLINE_MS;

// ---------- pairing QR ----------
function drawQr(rows) {
  const key = rows.join('');
  if (key === qrKey) return;
  qrKey = key;
  const canvas = $('qr');
  const quiet = 3; // light margin, in modules
  const n = rows.length + quiet * 2;
  const px = Math.max(3, Math.ceil(520 / n)); // drawn large, shown smaller, so it stays sharp
  canvas.width = canvas.height = n * px;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#0e1016';
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) if (row[c] === '1') g.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
  });
}

// ---------- status line + phone list ----------
function renderDevices() {
  if (!state) return;
  const online = devices.filter(isOnline);
  const dot = $('dot');
  let text;
  if (!state.addresses.length) { text = 'No network'; dot.className = 'dot bad'; }
  else if (online.length) { text = `${online.map((d) => d.name).join(' and ')} connected`; dot.className = 'dot'; }
  else if (devices.length) { text = 'Waiting for your phone. Open Flingo on it.'; dot.className = 'dot wait'; }
  else { text = `Ready to pair as “${state.name}”`; dot.className = 'dot wait'; }
  $('status-text').textContent = text;

  const key = devices.map((d) => `${d.id}:${d.name}:${isOnline(d)}:${!!d.lastSeen}`).join('|');
  if (key === devicesKey) return;
  devicesKey = key;
  $('devices').replaceChildren(...(devices.length ? devices.map((d) => {
    const rm = el('button', { className: 'ghost', textContent: 'Remove' });
    rm.onclick = async () => render(await api.removeDevice(d.id));
    const on = isOnline(d);
    return el('li', {}, [
      el('span', { className: 'who' }, [
        el('span', { className: `dot ${on ? '' : 'off'}` }),
        el('span', {}, [
          el('span', { textContent: d.name }),
          el('small', { className: 'muted', textContent: on ? 'Connected' : d.lastSeen ? 'Not connected right now' : 'Not seen since Flingo started' }),
        ]),
      ]),
      rm,
    ]);
  }) : [el('li', { className: 'none', textContent: 'No phones paired yet.' })]));
}

function render(s) {
  state = s;
  devices = s.devices;
  document.body.classList.toggle('stage', s.stage);
  $('stage-badge').hidden = !s.stage;
  $('stage').checked = s.stage;

  // pairing
  if (s.pairingLocked) $('qr').classList.remove('big');
  $('pair-open').hidden = s.pairingLocked;
  $('pair-locked').hidden = !s.pairingLocked;
  if (!s.pairingLocked) {
    $('code').textContent = `${s.code.slice(0, 3)} ${s.code.slice(3)}`;
    $('addr').textContent = s.addresses.length ? s.addresses.join('\n') : 'Not connected';
    if (s.qr) drawQr(s.qr);
  }
  $('secure').textContent = s.secure
    ? `Transfers are encrypted. Security code ${s.securityCode}`
    : 'Encryption is unavailable: restart Flingo.';

  // settings
  if (document.activeElement !== $('name')) $('name').value = s.name;
  $('save-dir').textContent = s.saveDir;
  $('save-dir').title = s.saveDir;
  $('show-overlay').checked = s.showOverlay;
  $('show-overlay').disabled = s.stage;
  $('sound').checked = s.sound;
  $('launch').checked = s.launchAtLogin;
  $('launch-label').textContent = s.platform === 'win32' ? 'Start with Windows' : 'Start when I log in';

  $('effects').replaceChildren(...s.effects.map((name) => {
    const b = el('button', { className: `effect${name === s.effect ? ' active' : ''}`, textContent: LABELS[name] || name });
    b.dataset.effect = name;
    b.setAttribute('aria-pressed', String(name === s.effect));
    b.onclick = async () => { render(await api.set({ effect: name })); api.previewEffect(name); };
    return b;
  }));

  // arrival screen: only worth showing when there is a choice
  $('screen-field').hidden = s.displays.length < 2;
  $('screen').replaceChildren(
    el('option', { value: 'auto', textContent: 'Main screen (automatic)' }),
    ...s.displays.map((d) => el('option', {
      value: d.id,
      textContent: `Screen ${d.index} · ${d.width}×${d.height}${d.primary ? ' · main' : ''}`,
    })),
  );
  $('screen').value = s.overlayDisplay;

  renderDevices();

  // received: rebuilt only when it changed, so thumbnails do not flicker
  const key = s.history.map((h) => h.path + h.at).join('|');
  $('empty').classList.toggle('show', s.history.length === 0);
  $('history').style.display = s.history.length ? '' : 'none';
  $('history-hint').hidden = s.history.length === 0;
  if (key === historyKey) return;
  historyKey = key;
  $('history').replaceChildren(...s.history.map((h) => {
    const thumb = h.image
      ? el('img', { src: h.url, alt: '', loading: 'lazy' })
      : el('div', { className: 'thumb', textContent: (h.name.split('.').pop() || 'file').slice(0, 5).toUpperCase() });
    const tile = el('button', { className: 'tile', draggable: true, title: `${h.name}\nRight-click to show in folder` }, [
      thumb,
      el('div', { className: 'meta' }, [
        el('div', { className: 'name', textContent: h.name }),
        el('div', { className: 'sub', textContent: `${fmtSize(h.size)} · ${h.from}` }),
      ]),
    ]);
    tile.onclick = () => api.openFile(h.path);
    tile.oncontextmenu = (e) => { e.preventDefault(); api.revealFile(h.path); };
    tile.ondragstart = (e) => { e.preventDefault(); api.dragFile(h.path); };
    return tile;
  }));
}

// ---------- transfers in progress ----------
// One row per card from the app: a single large file, or a whole batch.
// ---------- updates ----------
// A bar under the header when a newer Flingo exists, and one line in "This PC" that
// always says where things stand. The bar stays away in stage mode.
function renderUpdate(u) {
  if (!state) return;
  state.update = u;
  const busy = u.state === 'downloading';
  const pct = Math.round((u.fraction || 0) * 100);
  const offered = u.state === 'available' && !u.dismissed;
  $('update-bar').hidden = state.stage || !(offered || busy || u.state === 'ready');
  $('update-title').textContent = busy ? `Downloading Flingo ${u.version}… ${pct}%`
    : u.state === 'ready' ? `Flingo ${u.version} is ready to install.`
      : `Flingo ${u.version} is available.`;
  $('update-note').textContent = u.message
    || (u.state === 'ready' ? 'Flingo closes, updates and opens again.'
      : busy ? '' : u.selfUpdate ? `You have ${state.version}.` : `You have ${state.version}. The download page opens in your browser.`);
  $('update-track').hidden = !busy;
  $('update-fill').style.width = `${pct}%`;
  $('update-later').hidden = u.state !== 'available';
  $('update-go').hidden = busy;
  $('update-go').textContent = u.state === 'ready' ? 'Restart and install' : u.selfUpdate ? 'Update now' : 'Get the update';

  const line = {
    checking: 'Checking for updates…',
    current: 'You have the newest version.',
    available: `Version ${u.version} is available.`,
    downloading: `Downloading version ${u.version}…`,
    ready: `Version ${u.version} is ready to install.`,
    failed: u.message,
  }[u.state];
  $('version').textContent = `Version ${state.version}${line ? ` · ${line}` : ''}`;
  $('check-update').disabled = u.state === 'checking' || busy || u.state === 'ready';
}

const rows = new Map();
function onTransfer(card) {
  let row = rows.get(card.id);
  if (card.state === 'done') {
    // The files themselves appear in the list below, so the row has nothing left to say.
    if (row) { rows.delete(card.id); row.node.remove(); }
    return;
  }
  if (!row) {
    const title = el('b');
    const detail = el('span');
    const bar = el('div', { className: 'bar' });
    const node = el('div', { className: 'transfer' }, [el('div', { className: 'label' }, [title, ' ', detail]), el('div', { className: 'track' }, [bar])]);
    row = { node, title, detail, bar };
    rows.set(card.id, row);
    $('transfers').append(node);
  }
  const known = card.fraction !== null && card.fraction !== undefined;
  const pct = known ? Math.round(card.fraction * 100) : 0;
  row.title.textContent = card.title;
  row.detail.textContent = card.detail.replace('{pct}', pct);
  row.node.classList.toggle('failed', card.state === 'failed');
  row.node.classList.toggle('waiting', card.state === 'waiting');
  row.node.classList.toggle('unknown', !known && card.state === 'active');
  row.bar.style.width = `${card.state === 'failed' || !known ? 100 : pct}%`;
  if (card.state === 'failed') {
    rows.delete(card.id);
    setTimeout(() => row.node.remove(), 6000);
  }
}

// ---------- pre-flight ----------
const MARK = { ok: '✓', warn: '!', fail: '✕', manual: '☐' };
const ACTIONS = { firewall: 'Open firewall settings', notifications: 'Open notification settings', folder: 'Open folder' };

async function runPreflight() {
  $('preflight-card').hidden = false;
  $('preflight').disabled = $('preflight-again').disabled = true;
  $('preflight-summary').className = 'summary running';
  $('preflight-summary').textContent = 'Checking… a test photo will fly across the arrival screen.';
  $('preflight-list').replaceChildren();
  let r;
  try { r = await api.preflight(); }
  catch { r = { items: [], fail: 1, warn: 0 }; }
  $('preflight').disabled = $('preflight-again').disabled = false;
  const manual = r.items.filter((i) => i.status === 'manual').length;
  const summary = $('preflight-summary');
  if (!r.items.length) { summary.className = 'summary fail'; summary.textContent = 'The check could not run. Restart Flingo and try again.'; return; }
  if (r.fail) { summary.className = 'summary fail'; summary.textContent = `Not ready: ${r.fail} thing${r.fail > 1 ? 's' : ''} must be fixed.`; }
  else if (r.warn) { summary.className = 'summary warn'; summary.textContent = `Nearly ready: ${r.warn} thing${r.warn > 1 ? 's' : ''} to look at.`; }
  else { summary.className = 'summary ok'; summary.textContent = `Ready. ${manual ? `${manual} thing${manual > 1 ? 's' : ''} only you can check.` : ''}`; }
  const order = { fail: 0, warn: 1, manual: 2, ok: 3 };
  $('preflight-list').replaceChildren(...[...r.items].sort((a, b) => order[a.status] - order[b.status]).map((i) => {
    const body = el('div', { className: 'check-body' }, [
      el('div', { className: 'check-title', textContent: i.title }),
      el('div', { className: 'muted', textContent: i.detail }),
    ]);
    if (i.action && ACTIONS[i.action]) {
      const b = el('button', { className: 'ghost', textContent: ACTIONS[i.action] });
      b.onclick = () => api.openSettings(i.action);
      body.append(b);
    }
    return el('li', { className: `check ${i.status}` }, [el('span', { className: 'mark', textContent: MARK[i.status] }), body]);
  }));
}

// Click the QR code to fill the window with it, for scanning from a few steps away.
$('qr').onclick = () => $('qr').classList.toggle('big');
$('qr').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') $('qr').classList.toggle('big', e.key !== 'Escape' && !$('qr').classList.contains('big')); };
$('new-code').onclick = async () => render(await api.newCode());
$('lock').onclick = async () => render(await api.set({ pairingLocked: true }));
$('unlock').onclick = async () => render(await api.set({ pairingLocked: false }));
$('stage').onchange = async (e) => render(await api.set({ stage: e.target.checked }));
$('choose-folder').onclick = async () => render(await api.chooseFolder());
$('open-folder').onclick = () => api.openFolder();
$('clear').onclick = async () => render(await api.clearHistory());
$('show-overlay').onchange = async (e) => render(await api.set({ showOverlay: e.target.checked }));
$('sound').onchange = async (e) => render(await api.set({ sound: e.target.checked }));
$('launch').onchange = async (e) => render(await api.set({ launchAtLogin: e.target.checked }));
$('name').onchange = async (e) => render(await api.set({ name: e.target.value }));
$('screen').onchange = async (e) => render(await api.set({ overlayDisplay: e.target.value }));
$('identify').onclick = () => api.identifyScreens();
$('test-arrival').onclick = () => api.previewEffect(state ? state.effect : 'comet');
$('preflight').onclick = runPreflight;
$('preflight-again').onclick = runPreflight;
$('preflight-close').onclick = () => { $('preflight-card').hidden = true; };

api.onState(render);
api.onDevices((d) => { devices = d; renderDevices(); });
api.onTransfer(onTransfer);
api.getState().then(render);
setInterval(renderDevices, 2000); // a phone that goes quiet turns grey without waiting for an event
