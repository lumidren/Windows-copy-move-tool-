const $ = (id) => document.getElementById(id);
const api = window.flingo;
const LABELS = { comet: 'Comet', ripple: 'Ripple', confetti: 'Confetti', aurora: 'Aurora' };

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

}

$('new-code').onclick = async () => render(await api.newCode());
$('choose-folder').onclick = async () => render(await api.chooseFolder());
$('show-overlay').onchange = async (e) => render(await api.set({ showOverlay: e.target.checked }));
$('launch').onchange = async (e) => render(await api.set({ launchAtLogin: e.target.checked }));
$('name').onchange = async (e) => render(await api.set({ name: e.target.value }));

api.onState(render);
api.getState().then(render);
