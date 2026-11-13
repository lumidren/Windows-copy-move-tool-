const $ = (id) => document.getElementById(id);
const api = window.flingo;
const LABELS = { comet: 'Comet', ripple: 'Ripple', confetti: 'Confetti', aurora: 'Aurora' };

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

function render(s) {
  $('code').textContent = `${s.code.slice(0, 3)} ${s.code.slice(3)}`;
  $('addr').textContent = s.addresses.length ? `Manual address: ${s.addresses.join(', ')}` : 'Not connected to a network';
  $('status-text').textContent = s.addresses.length ? `Ready to receive as “${s.name}”` : 'No network';
  if (document.activeElement !== $('name')) $('name').value = s.name;
  $('save-dir').textContent = s.saveDir;
  $('save-dir').title = s.saveDir;
  $('show-overlay').checked = s.showOverlay;
  $('launch').checked = s.launchAtLogin;

  $('effects').replaceChildren(...s.effects.map((name) => {
    const b = el('button', { className: `effect${name === s.effect ? ' active' : ''}`, textContent: LABELS[name] || name });
    b.dataset.effect = name;
    b.setAttribute('aria-pressed', String(name === s.effect));
    b.onclick = async () => { render(await api.set({ effect: name })); api.previewEffect(name); };
    return b;
  }));

  $('devices').replaceChildren(...(s.devices.length ? s.devices.map((d) => {
    const rm = el('button', { className: 'ghost', textContent: 'Remove' });
    rm.onclick = async () => render(await api.removeDevice(d.id));
    return el('li', {}, [el('span', { textContent: d.name }), rm]);
  }) : [el('li', { className: 'none', textContent: 'No phones paired yet.' })]));

  $('empty').classList.toggle('show', s.history.length === 0);
  $('history').style.display = s.history.length ? '' : 'none';
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
$('choose-folder').onclick = async () => render(await api.chooseFolder());
$('open-folder').onclick = () => api.openFolder();
$('clear').onclick = async () => render(await api.clearHistory());
$('show-overlay').onchange = async (e) => render(await api.set({ showOverlay: e.target.checked }));
$('launch').onchange = async (e) => render(await api.set({ launchAtLogin: e.target.checked }));
$('name').onchange = async (e) => render(await api.set({ name: e.target.value }));

api.onState(render);
api.getState().then(render);
$('screen').onchange = async (e) => render(await api.set({ overlayDisplay: e.target.value }));
$('identify').onclick = () => api.identifyScreens();
$('test-arrival').onclick = () => api.previewEffect(state ? state.effect : 'comet');
$('preflight').onclick = runPreflight;
$('preflight-again').onclick = runPreflight;
$('preflight-close').onclick = () => { $('preflight-card').hidden = true; };
