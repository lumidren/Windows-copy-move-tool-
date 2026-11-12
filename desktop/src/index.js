const $ = (id) => document.getElementById(id);
const api = window.flingo;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

function render(s) {
  $('code').textContent = `${s.code.slice(0, 3)} ${s.code.slice(3)}`;
  $('addr').textContent = s.addresses.length ? `Manual address: ${s.addresses.join(', ')}` : 'Not connected to a network';
  $('status-text').textContent = s.addresses.length ? `Ready to receive as “${s.name}”` : 'No network';

}

$('new-code').onclick = async () => render(await api.newCode());

api.onState(render);
api.getState().then(render);
