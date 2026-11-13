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

function render(s) {
  state = s;
  devices = s.devices;
  document.body.classList.toggle('stage', s.stage);
  $('stage-badge').hidden = !s.stage;
  $('stage').checked = s.stage;

  // pairing
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
