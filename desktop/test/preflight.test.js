// Pre-flight logic tests: the firewall verdict and the checklist as a whole.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { runPreflight, judgeFirewall } = require('../src/preflight');

const on = (...names) => ['Domain', 'Private', 'Public'].map((name) => ({ name, enabled: names.includes(name) ? 'True' : 'False' }));

test('firewall verdicts', () => {
  assert.equal(judgeFirewall({ categories: ['Public'], profiles: on(), rules: [] }).state, 'off');
  assert.equal(judgeFirewall({ categories: ['Public'], profiles: on('Public'), rules: [] }).state, 'none');
  assert.equal(judgeFirewall({ categories: ['Public'], profiles: on('Public'), rules: [{ action: 'Allow', profile: 'Private' }] }).state, 'none',
    'allowed on Private only does not help on a Public network');
  assert.equal(judgeFirewall({ categories: ['Public'], profiles: on('Public'), rules: [{ action: 'Allow', profile: 'Private, Public' }] }).state, 'allowed');
  assert.equal(judgeFirewall({ categories: ['Private'], profiles: on('Private'), rules: [{ action: 'Allow', profile: 'Any' }] }).state, 'allowed');
  assert.equal(judgeFirewall({ categories: ['Public'], profiles: on('Public'), rules: [{ action: 'Allow', profile: 'Any' }, { action: 'Block', profile: 'Public' }] }).state, 'blocked',
    'a block rule wins over an allow rule');
  assert.equal(judgeFirewall({ categories: 'DomainAuthenticated', profiles: on('Domain'), rules: { action: 'Allow', profile: 'Domain' } }).state, 'allowed',
    'single values arrive unwrapped from PowerShell');
  assert.equal(judgeFirewall({ categories: [], profiles: on('Public'), rules: [] }).state, 'unknown');
});

async function check(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flingo-pf-'));
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const ctx = {
    platform: 'win32', exePath: 'C:\\Flingo\\Flingo.exe', port: server.address().port, addresses: ['127.0.0.1'],
    secure: true, securityCode: 'AB12 CD34', saveDir: dir, stage: true, pairingLocked: true, showOverlay: true,
    server: { listening: true, httpError: null, udpBound: true, udpError: null },
    devices: [{ name: 'Pixel 8', lastSeen: Date.now() - 2000, ip: '::ffff:192.168.1.50' }],
    overlay: async () => ({ screen: 2, display: { width: 1920, height: 1080 }, window: { width: 1920, height: 1080 }, renderer: { w: 1920, h: 1080, dpr: 1 }, pixels: { width: 1920, height: 1080 }, scale: 100 }),
    selfTest: async () => ({ ok: true, ms: 20, fps: 60, worstMs: 18 }),
    firewall: { state: 'allowed', network: 'Private' },
    ...overrides,
  };
  try { return await runPreflight(ctx); } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const status = (r, id) => r.items.find((i) => i.id === id)?.status;

test('a ready stage machine passes with nothing to fix', async () => {
  const r = await check();
  assert.equal(r.fail, 0);
  assert.equal(r.warn, 0);
  assert.equal(status(r, 'firewall'), 'ok');
  assert.match(r.items.find((i) => i.id === 'firewall').detail, /Pixel 8 reached this PC/);
  assert.equal(status(r, 'quiet'), 'manual');
});

test('each problem is reported as its own item', async () => {
  const none = await check({ devices: [] });
  assert.equal(status(none, 'phone'), 'fail');

  const silent = await check({ devices: [{ name: 'Pixel 8', lastSeen: 0, ip: '' }], firewall: { state: 'blocked', network: 'Public' } });
  assert.equal(status(silent, 'phone'), 'warn');
  assert.equal(status(silent, 'firewall'), 'fail');

  // A ping from this PC's own address proves nothing about the firewall.
  const self = await check({ devices: [{ name: 'Pixel 8', lastSeen: Date.now(), ip: '127.0.0.1' }], firewall: { state: 'none', network: 'Public' } });
  assert.equal(status(self, 'firewall'), 'warn');

  const open = await check({ pairingLocked: false, stage: false });
  assert.equal(status(open, 'lock'), 'warn');
  assert.equal(status(open, 'awake'), 'warn');

  const wrongScreen = await check({ overlay: async () => ({ screen: 1, display: { width: 1920, height: 1080 }, window: { width: 1536, height: 864 }, renderer: { w: 1536, h: 864, dpr: 1.25 }, pixels: { width: 1920, height: 1080 }, scale: 100 }) });
  assert.equal(status(wrongScreen, 'overlay'), 'fail');

  const broken = await check({ selfTest: async () => ({ ok: false, error: 'The receiver did not answer within 6 seconds.' }) });
  assert.equal(status(broken, 'transfer'), 'fail');

  const slow = await check({ selfTest: async () => ({ ok: true, ms: 30, fps: 24, worstMs: 90 }) });
  assert.equal(status(slow, 'smooth'), 'warn');

  const down = await check({ server: { listening: false, httpError: 'EADDRINUSE', udpBound: false, udpError: null } });
  assert.equal(status(down, 'server'), 'fail');
  assert.equal(status(down, 'discovery'), 'warn');
  assert.equal(status(down, 'transfer'), undefined, 'no transfer is attempted when the receiver is down');

  const offline = await check({ addresses: [] });
  assert.equal(status(offline, 'network'), 'fail');

  const crowd = await check({ devices: [1, 2, 3].map((n) => ({ name: `Phone ${n}`, lastSeen: Date.now(), ip: '10.0.0.9' })) });
  assert.equal(status(crowd, 'phones'), 'warn');
});
