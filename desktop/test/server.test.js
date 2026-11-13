// Receiver tests. Run with: npm test   (plain Node, no Electron needed)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { startServer, sanitizeName, cleanStaleParts } = require('../src/server');

const CODE = '123456';
const TOKEN = 'a'.repeat(64);

async function boot(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flingo-test-'));
  const events = [];
  const files = [];
  const hooks = {
    info: () => ({ id: 'pc1', name: 'Test PC' }),
    pair: ({ code }) => (extra.locked ? { error: 'locked' } : code === CODE ? { token: TOKEN } : { error: 'wrong' }),
    checkToken: (t) => (t === TOKEN ? { id: 'd1', name: 'Test Phone' } : null),
    saveDir: () => dir,
    maxBytes: () => extra.maxBytes ?? 1024 ** 3,
    onStart: (e) => events.push(['start', e]),
    onProgress: (e) => events.push(['progress', e]),
    onEnd: (e) => events.push(['end', e]),
    onFile: (f) => files.push(f),
  };
  const s = startServer(hooks, { port: 0, discoveryPort: null, host: '127.0.0.1' });
  assert.equal(await s.ready, true);
  const base = `http://127.0.0.1:${s.port}`;
  return {
    dir, events, files, base, s,
    send: (name, body, token = TOKEN) => fetch(`${base}/send?x=0.25`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Filename': encodeURIComponent(name), 'Content-Type': 'image/jpeg' },
      body,
    }),
    close() { s.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const parts = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.part'));

test('file names are made safe', () => {
  assert.equal(sanitizeName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeName('..\\..\\Windows\\System32\\evil.dll'), 'evil.dll');
  assert.equal(sanitizeName('C:\\Users\\me\\a.jpg'), 'a.jpg');
  assert.equal(sanitizeName('con.txt'), '_con.txt');
  assert.equal(sanitizeName('a<b>:c?.jpg'), 'a_b__c_.jpg');
  assert.equal(sanitizeName('.bashrc'), '_bashrc');
  assert.equal(sanitizeName('photo\u202Egpj.exe'), 'photogpj.exe');
  assert.equal(sanitizeName(''), 'file');
  assert.equal(sanitizeName('trailing. . '), 'trailing');
  assert.ok(sanitizeName('x'.repeat(400) + '.jpeg').length <= 180);
  assert.ok(sanitizeName('x'.repeat(400) + '.jpeg').endsWith('.jpeg'));
});

test('info identifies the receiver', async () => {
  const t = await boot();
  try {
    const r = await fetch(`${t.base}/info`).then((x) => x.json());
    assert.equal(r.app, 'flingo');
    assert.equal(r.version, 2);
    assert.equal(r.name, 'Test PC');
  } finally { t.close(); }
});

test('pairing: wrong code refused, right code gives a token, then lockout', async () => {
  const t = await boot();
  const pair = (code) => fetch(`${t.base}/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: 'P' }) });
  try {
    assert.equal((await pair('000000')).status, 403);
    const ok = await pair(CODE);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).token, TOKEN);
    for (let i = 0; i < 4; i++) assert.equal((await pair('999999')).status, 403);
    assert.equal((await pair(CODE)).status, 429, 'sixth attempt inside a minute is locked out, even with the right code');
    assert.equal((await fetch(`${t.base}/pair`, { method: 'POST', body: 'not json' })).status, 429);
  } finally { t.close(); }
});

test('pairing can be locked', async () => {
  const t = await boot({ locked: true });
  try {
    const r = await fetch(`${t.base}/pair`, { method: 'POST', body: JSON.stringify({ code: CODE }) });
    assert.equal(r.status, 423);
  } finally { t.close(); }
});

test('unpaired phones cannot ping or send', async () => {
  const t = await boot();
  try {
    assert.equal((await fetch(`${t.base}/ping`)).status, 401);
    assert.equal((await t.send('a.jpg', Buffer.from('x'), 'wrong')).status, 401);
    assert.deepEqual(fs.readdirSync(t.dir), []);
    assert.equal((await fetch(`${t.base}/ping`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
  } finally { t.close(); }
});

test('a file is saved byte for byte, with progress, and duplicates get a new name', async () => {
  const t = await boot();
  try {
    const body = crypto.randomBytes(3 * 1024 * 1024);
    const r = await t.send('IMG 1.jpg', body);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, name: 'IMG 1.jpg' });
    assert.ok(fs.readFileSync(path.join(t.dir, 'IMG 1.jpg')).equals(body));
    assert.equal(t.files[0].x, 0.25);
    assert.equal(t.files[0].from, 'Test Phone');
    assert.equal(t.files[0].size, body.length);

    const kinds = t.events.map((e) => e[0]);
    assert.equal(kinds[0], 'start');
    assert.equal(kinds.at(-1), 'end');
    assert.equal(t.events[0][1].total, body.length);
    assert.equal(t.events.at(-1)[1].ok, true);
    const seen = t.events.filter((e) => e[0] === 'progress').map((e) => e[1].received);
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'progress only goes up');

    assert.equal((await (await t.send('IMG 1.jpg', body)).json()).name, 'IMG 1 (1).jpg');
    assert.deepEqual(parts(t.dir), []);
  } finally { t.close(); }
});

test('a hostile file name stays inside the save folder', async () => {
  const t = await boot();
  try {
    const r = await t.send('..\\..\\..\\outside.txt', Buffer.from('x'));
    assert.equal((await r.json()).name, 'outside.txt');
    assert.ok(fs.existsSync(path.join(t.dir, 'outside.txt')));
    assert.ok(!fs.existsSync(path.join(t.dir, '..', 'outside.txt')));
  } finally { t.close(); }
});

test('an oversized file is refused and leaves nothing behind', async () => {
  const t = await boot({ maxBytes: 1000 });
  try {
    const r = await t.send('big.bin', Buffer.alloc(5000));
    assert.equal(r.status, 413);
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(fs.readdirSync(t.dir), []);
  } finally { t.close(); }
});

test('an upload that is cut off leaves no partial file', async () => {
  const t = await boot();
  try {
    await new Promise((resolve) => {
      const req = http.request(`${t.base}/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'X-Filename': 'cut.jpg', 'Content-Length': 5_000_000 },
      });
      req.on('error', () => {});
      req.write(Buffer.alloc(200_000), () => setTimeout(() => { req.destroy(); resolve(); }, 150));
    });
    await new Promise((res) => setTimeout(res, 300));
    assert.deepEqual(fs.readdirSync(t.dir), []);
    assert.equal(t.files.length, 0);
    assert.deepEqual(t.events.at(-1), ['end', { id: t.events[0][1].id, ok: false }]);
    assert.equal(t.s.status().uploads, 0);
  } finally { t.close(); }
});

test('stale partial files are cleaned up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flingo-test-'));
  fs.writeFileSync(path.join(dir, '.flingo-0123456789ab.part'), 'x');
  fs.writeFileSync(path.join(dir, 'keep.jpg'), 'x');
  fs.writeFileSync(path.join(dir, '.flingo-a1b2c3-0123abcd.part'), 'x');
  assert.equal(cleanStaleParts(dir, 60_000), 0, 'recent parts are kept when asked');
  assert.equal(cleanStaleParts(dir), 2);
  assert.deepEqual(fs.readdirSync(dir), ['keep.jpg']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('soak: 100 transfers in a row, then 40 overlapping, all intact', async () => {
  const t = await boot();
  try {
    const want = new Map();
    for (let i = 0; i < 100; i++) {
      const body = crypto.randomBytes(1 + ((i * 7919) % 300_000));
      const r = await t.send(`row-${i}.jpg`, body);
      assert.equal(r.status, 200, `transfer ${i}`);
      want.set(`row-${i}.jpg`, body);
    }
    for (let batch = 0; batch < 10; batch++) {
      await Promise.all([0, 1, 2, 3].map(async (k) => {
        const name = `burst-${batch}-${k}.jpg`;
        const body = crypto.randomBytes(50_000 + k);
        want.set(name, body);
        assert.equal((await t.send(name, body)).status, 200);
      }));
    }
    assert.equal(t.files.length, 140);
    for (const [name, body] of want) assert.ok(fs.readFileSync(path.join(t.dir, name)).equals(body), name);
    assert.deepEqual(parts(t.dir), []);
    assert.equal(t.s.status().uploads, 0);
  } finally { t.close(); }
});
