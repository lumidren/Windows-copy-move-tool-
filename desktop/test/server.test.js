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
const TOKEN_2 = 'b'.repeat(64); // a second paired phone

async function boot(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flingo-test-'));
  const events = [];
  const files = [];
  const hooks = {
    info: () => ({ id: 'pc1', name: 'Test PC' }),
    pair: ({ code }) => (extra.locked ? { error: 'locked' } : code === CODE ? { token: TOKEN } : { error: 'wrong' }),
    checkToken: (t) => (t === TOKEN ? { id: 'd1', name: 'Test Phone' } : t === TOKEN_2 ? { id: 'd2', name: 'Second Phone' } : null),
    rotateCode: extra.rotateCode,
    guessing: extra.guessing,
    unpair: extra.unpair,
    saveDir: () => dir,
    maxBytes: () => extra.maxBytes ?? 1024 ** 3,
    onStart: (e) => events.push(['start', e]),
    onProgress: (e) => events.push(['progress', e]),
    onEnd: (e) => events.push(['end', e]),
    onFile: (f) => files.push(f),
    onCancel: extra.onCancel,
    seen: extra.seen,
  };
  const s = startServer(hooks, { port: 0, discoveryPort: null, host: '127.0.0.1', ...(extra.options || {}) });
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

test('a name cannot end in a way that hides what the file is', () => {
  // Windows drops dots and spaces from the end of a name, so each of these would run as x.exe.
  for (const raw of ['x.exe.', 'x.exe ', 'x.exe. . ', 'x.exe.\u00a0', 'x.exe\u00a0', 'x.exe.\u2028', 'x.exe.\u3000', 'x.exe\u200b.', ' x.exe']) {
    assert.equal(sanitizeName(raw), 'x.exe', JSON.stringify(raw));
  }
  // An over-long name is cut, and the cut must not leave a dot or a space at the end either.
  const long = sanitizeName(`${'a'.repeat(200)}.exe${' '.repeat(18)}x`);
  assert.ok(long.length <= 180);
  assert.doesNotMatch(long, /[. ]$/);
  assert.equal(sanitizeName('  '), 'file');
  assert.equal(sanitizeName('...'), 'file');
});

test('names Windows keeps for devices are never used as they are', () => {
  for (const raw of ['CON', 'con.txt', 'NUL', 'aux.jpg', 'COM1', 'com0.log', 'LPT9', 'lpt0', 'CONIN$', 'conout$.txt', 'con .txt', 'COM\u00b9']) {
    const name = sanitizeName(raw);
    assert.ok(name.startsWith('_'), `${raw} became ${name}`);
  }
  assert.equal(sanitizeName('console.txt'), 'console.txt');
  assert.equal(sanitizeName('community.jpg'), 'community.jpg');
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

test('each request tells the PC what the phone can do: its version, and whether it asks for files', async () => {
  const said = [];
  const t = await boot({ seen: (device, ip, what) => said.push({ id: device.id, ...what }) });
  const get = (p, headers = {}) => fetch(`${t.base}${p}`, { headers: { Authorization: `Bearer ${TOKEN}`, ...headers } });
  try {
    // Flingo 0.3.0: checks in, says nothing about itself, never asks for files.
    await get('/ping');
    assert.deepEqual(said.pop(), { id: 'd1', app: '', asks: false });
    // A newer one says its version with everything it sends.
    await get('/ping', { 'X-Flingo-App': '0.4.0' });
    assert.deepEqual(said.pop(), { id: 'd1', app: '0.4.0', asks: false });
    // Something that is not a version is not passed on.
    await get('/ping', { 'X-Flingo-App': '<img src=x>' });
    assert.deepEqual(said.pop(), { id: 'd1', app: '', asks: false });
    // Asking for its files, in any of the ways a phone does, shows it can receive them.
    for (const p of ['/outbox?all=1', '/outbox?wait=0', `/outbox/${'0'.repeat(32)}`]) {
      await get(p);
      assert.deepEqual(said.pop(), { id: 'd1', app: '', asks: true }, p);
    }
    // A phone that is not paired is not heard at all.
    await fetch(`${t.base}/outbox?all=1`, { headers: { Authorization: 'Bearer wrong', 'X-Flingo-App': '0.4.0' } });
    assert.equal(said.length, 0);
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
    const { id } = t.events[0][1];
    assert.deepEqual(t.events.at(-1), ['end', { id, key: id, deviceId: 'd1', ok: false, waiting: false }]);
    assert.equal(t.s.status().uploads, 0);
  } finally { t.close(); }
});

/** Starts an upload of `body`, sends only its first `cut` bytes, then drops the connection. */
function cutOff(t, query, name, body, cut) {
  return new Promise((resolve) => {
    const req = http.request(`${t.base}/send?${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Filename': name, 'Content-Length': body.length },
    });
    req.on('error', () => {});
    req.write(body.subarray(0, cut), () => setTimeout(() => { req.destroy(); setTimeout(resolve, 300); }, 150));
  });
}

const resumeAt = async (t, id, token = TOKEN) => {
  const r = await fetch(`${t.base}/resume?id=${id}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, ...(await r.json()) };
};

test('a named transfer that is cut off is carried on from where it stopped', async () => {
  const t = await boot();
  try {
    const body = crypto.randomBytes(2_000_000);
    await cutOff(t, 'id=abc123def456', 'big.bin', body, 700_000);
    assert.deepEqual(t.events.at(-1)[1], { id: t.events[0][1].id, key: 'abc123def456', deviceId: 'd1', ok: false, waiting: true });
    assert.equal(t.files.length, 0);
    assert.deepEqual(parts(t.dir), ['.flingo-d1-abc123def456.part']);

    const { status, received } = await resumeAt(t, 'abc123def456');
    assert.equal(status, 200);
    assert.ok(received > 0 && received <= 700_000, `kept ${received} bytes`);

    const r = await fetch(`${t.base}/send?id=abc123def456&offset=${received}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Filename': 'big.bin' },
      body: body.subarray(received),
    });
    assert.equal(r.status, 200);
    assert.ok(fs.readFileSync(path.join(t.dir, 'big.bin')).equals(body), 'joined file is identical');
    assert.equal(t.files[0].size, body.length);
    assert.equal(t.files[0].key, 'abc123def456');
    const second = t.events.filter((e) => e[0] === 'start')[1][1];
    assert.equal(second.received, received);
    assert.equal(second.total, body.length);
    assert.deepEqual(parts(t.dir), []);
    assert.equal(t.s.status().uploads, 0);
  } finally { t.close(); }
});

test('carrying on is refused from the wrong place, and says the right one', async () => {
  const t = await boot();
  try {
    const body = crypto.randomBytes(900_000);
    await cutOff(t, 'id=feed01', 'clip.mp4', body, 300_000);
    const { received } = await resumeAt(t, 'feed01');
    // The PC answers before the body is sent, so the phone wastes nothing on a wrong guess.
    const wrong = await new Promise((resolve, reject) => {
      const req = http.request(`${t.base}/send?id=feed01&offset=${received + 5}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'X-Filename': 'clip.mp4', 'Content-Length': body.length - received - 5 },
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, ...JSON.parse(text) }); });
      });
      req.on('error', reject);
      req.flushHeaders();
    });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.received, received);
    assert.equal(t.files.length, 0);
    assert.equal(fs.statSync(path.join(t.dir, '.flingo-d1-feed01.part')).size, received, 'the kept part is untouched');

    // Starting again from nothing is always allowed and replaces the kept part.
    const again = await fetch(`${t.base}/send?id=feed01`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Filename': 'clip.mp4' },
      body,
    });
    assert.equal(again.status, 200);
    assert.ok(fs.readFileSync(path.join(t.dir, 'clip.mp4')).equals(body));
    assert.deepEqual(parts(t.dir), []);
  } finally { t.close(); }
});

test('asking where to carry on needs pairing, and unknown transfers start at zero', async () => {
  const t = await boot();
  try {
    assert.equal((await resumeAt(t, 'abc', 'nope')).status, 401);
    assert.deepEqual(await resumeAt(t, 'neverseen'), { status: 200, received: 0 });
    assert.deepEqual(await resumeAt(t, '../../etc'), { status: 200, received: 0 });
  } finally { t.close(); }
});

test('asking to carry on ends the old connection, even if it still looks alive', async () => {
  const t = await boot();
  try {
    const body = crypto.randomBytes(1_500_000);
    const req = http.request(`${t.base}/send?id=stuck99`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Filename': 'stuck.bin', 'Content-Length': body.length },
    });
    req.on('error', () => {});
    await new Promise((resolve) => req.write(body.subarray(0, 400_000), () => setTimeout(resolve, 200)));
    // The first connection is still open here: the phone has lost it, the PC has not noticed.
    const { received } = await resumeAt(t, 'stuck99');
    assert.ok(received > 0 && received <= 400_000);
    const r = await fetch(`${t.base}/send?id=stuck99&offset=${received}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Filename': 'stuck.bin' },
      body: body.subarray(received),
    });
    assert.equal(r.status, 200);
    assert.ok(fs.readFileSync(path.join(t.dir, 'stuck.bin')).equals(body));
    assert.equal(t.files.length, 1);
    req.destroy();
  } finally { t.close(); }
});

test('cancelling from the phone stops the transfer and keeps nothing', async () => {
  const cancelled = [];
  const t = await boot({ onCancel: (e) => cancelled.push(e) });
  try {
    const cancel = (id, token = TOKEN) => fetch(`${t.base}/cancel?id=${id}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await cancel('abc', 'nope')).status, 401);

    // While it is still arriving.
    const body = crypto.randomBytes(1_200_000);
    const req = http.request(`${t.base}/send?id=stopme1`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Filename': 'stop.bin', 'Content-Length': body.length },
    });
    req.on('error', () => {});
    await new Promise((resolve) => req.write(body.subarray(0, 300_000), () => setTimeout(resolve, 200)));
    assert.equal((await cancel('stopme1')).status, 200);
    await new Promise((res) => setTimeout(res, 250));
    assert.deepEqual(fs.readdirSync(t.dir), []);
    assert.equal(t.events.at(-1)[1].waiting, false);
    assert.equal(t.s.status().uploads, 0);
    assert.deepEqual(cancelled, [{ key: 'stopme1', deviceId: 'd1', from: 'Test Phone' }]);
    req.destroy();

    // After the connection had already dropped and its first part was being kept.
    await cutOff(t, 'id=stopme2', 'later.bin', body, 300_000);
    assert.deepEqual(parts(t.dir), ['.flingo-d1-stopme2.part']);
    assert.equal((await cancel('stopme2')).status, 200);
    await new Promise((res) => setTimeout(res, 150));
    assert.deepEqual(fs.readdirSync(t.dir), []);
    assert.equal((await resumeAt(t, 'stopme2')).received, 0);
  } finally { t.close(); }
});

test('a batch says which file of how many, and whether to arrive quietly', async () => {
  const t = await boot();
  try {
    const post = (query) => fetch(`${t.base}/send?${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Filename': 'a.jpg' },
      body: Buffer.from('hello'),
    });
    assert.equal((await post('quiet=1&batch=b1b2b3&i=2&n=40&bytes=123456')).status, 200);
    assert.equal(t.files[0].quiet, true);
    assert.deepEqual(t.files[0].batch, { id: 'b1b2b3', index: 2, count: 40, bytes: 123456 });
    assert.deepEqual(t.events[0][1].batch, t.files[0].batch);

    assert.equal((await post('x=0.5')).status, 200);
    assert.equal(t.files[1].quiet, false);
    assert.equal(t.files[1].batch, null);

    // Nonsense is ignored instead of trusted.
    for (const bad of ['batch=../x&i=1&n=2', 'batch=ok&i=9&n=2', 'batch=ok&i=0&n=2', 'batch=ok&i=1&n=1e9', 'batch=ok']) {
      assert.equal((await post(bad)).status, 200);
      assert.equal(t.files.at(-1).batch, null, bad);
    }
  } finally { t.close(); }
});

test('a batch sent four files at a time over connections that stay open arrives intact', async () => {
  const t = await boot();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  let connections = 0;
  t.s.server.on('connection', () => { connections++; });
  try {
    const count = 24;
    const bodies = Array.from({ length: count }, (_, i) => crypto.randomBytes(40_000 + i * 9_973));
    const post = (i) => new Promise((resolve, reject) => {
      const req = http.request(`${t.base}/send?quiet=1&batch=par4&i=${i + 1}&n=${count}&id=f${i}`, {
        method: 'POST', agent,
        headers: { Authorization: `Bearer ${TOKEN}`, 'X-Filename': `p-${i}.jpg`, 'Content-Length': bodies[i].length },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(bodies[i]);
    });
    let next = 0;
    let most = 0;
    const worker = async () => {
      while (next < count) {
        const i = next++;
        assert.equal(await post(i), 200, `file ${i}`);
        most = Math.max(most, t.s.status().uploads);
      }
    };
    await Promise.all([1, 2, 3, 4].map(worker));
    assert.equal(t.files.length, count);
    for (let i = 0; i < count; i++) assert.ok(fs.readFileSync(path.join(t.dir, `p-${i}.jpg`)).equals(bodies[i]), `p-${i}`);
    assert.ok(t.files.every((f) => f.quiet && f.batch.id === 'par4' && f.batch.count === count));
    assert.deepEqual(t.files.map((f) => f.batch.index).sort((a, b) => a - b), bodies.map((_, i) => i + 1));
    assert.ok(connections <= 4, `24 files used ${connections} connections`);
    assert.deepEqual(parts(t.dir), []);
    assert.equal(t.s.status().uploads, 0);
  } finally { agent.destroy(); t.close(); }
});

test('more uploads at once than the PC allows are turned away, and the rest carry on', async () => {
  const t = await boot();
  const open = [];
  try {
    // Twelve uploads that have begun and are holding their place: eight from one phone, which
    // is as many as one phone may hold, and four from another.
    const hold = (i, token) => {
      const req = http.request(`${t.base}/send?id=hold${i}`, {
        method: 'POST', agent: false,
        headers: { Authorization: `Bearer ${token}`, 'X-Filename': `held-${i}.bin`, 'Content-Length': 2000 },
      });
      req.on('error', () => {});
      req.write(Buffer.alloc(1000, i));
      open.push(req);
    };
    const until = async (n) => { for (let i = 0; i < 100 && t.s.status().uploads < n; i++) await new Promise((r) => setTimeout(r, 20)); };
    for (let i = 0; i < 8; i++) hold(i, TOKEN);
    await until(8);
    assert.equal(t.s.status().uploads, 8);
    // One phone cannot take every place: its ninth is turned away while the PC still has room.
    const greedy = await t.send('ninth-from-one-phone.jpg', Buffer.from('x'));
    assert.equal(greedy.status, 429);
    assert.equal((await t.send('the-other-phone.jpg', Buffer.from('x'), TOKEN_2)).status, 200, 'another phone still gets in');
    for (let i = 8; i < 12; i++) hold(i, TOKEN_2);
    await until(12);
    assert.equal(t.s.status().uploads, 12);
    const refused = await t.send('one-too-many.jpg', Buffer.from('x'), TOKEN_2);
    assert.equal(refused.status, 429);
    assert.match((await refused.json()).error, /busy/i);
    // The ones already going are not disturbed by the refusal.
    const answers = open.map((req) => new Promise((resolve) => req.on('response', (res) => { res.resume(); resolve(res.statusCode); })));
    for (const [i, req] of open.entries()) req.end(Buffer.alloc(1000, i));
    assert.deepEqual(await Promise.all(answers), Array(12).fill(200));
    assert.equal(fs.readFileSync(path.join(t.dir, 'held-3.bin')).length, 2000);
    assert.equal((await t.send('after.jpg', Buffer.from('x'))).status, 200);
  } finally { for (const req of open) req.destroy(); t.close(); }
});

test('a burst of guesses sent together is counted as it arrives, not afterwards', async () => {
  const t = await boot();
  const guess = (code) => fetch(`${t.base}/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: 'x' }) }).then((r) => r.status, () => 0);
  try {
    // Sixty wrong codes at the same moment. Counted only once each had been read, all sixty
    // would have been let in; counted on arrival, five at most are even looked at.
    const answers = await Promise.all(Array.from({ length: 60 }, (_, i) => guess(String(100000 + i))));
    const looked = answers.filter((s) => s === 403).length;
    assert.ok(looked >= 1 && looked <= 5, `${looked} guesses were checked`);
    assert.equal(answers.filter((s) => s === 429 || s === 0).length, 60 - looked, 'the rest were turned away unread');
    // And the right code is refused too for the rest of the minute: no way round by being right late.
    assert.equal(await guess(CODE), 429);
  } finally { t.close(); }
});

test('the right code is not counted against the phone that sent it', async () => {
  const t = await boot();
  const pair = () => fetch(`${t.base}/pair`, { method: 'POST', body: JSON.stringify({ code: CODE, deviceName: 'x' }) }).then((r) => r.status);
  try {
    for (let i = 0; i < 12; i++) assert.equal(await pair(), 200, `pairing ${i + 1}`);
  } finally { t.close(); }
});

test('guessing that goes on and on shuts pairing', async () => {
  let rotated = 0;
  let shut = 0;
  const t = await boot({ rotateCode: () => { rotated++; }, guessing: () => { shut++; }, options: { maxPairFails: 1000 } });
  const guess = (i) => fetch(`${t.base}/pair`, { method: 'POST', body: JSON.stringify({ code: String(200000 + i), deviceName: 'x' }) }).then((r) => r.status);
  try {
    // Twelve wrong guesses replace the code. That alone does not stop anyone, so the third
    // time it happens the server asks for pairing to be locked.
    for (let i = 0; i < 35; i++) assert.equal(await guess(i), 403);
    assert.equal(rotated, 2);
    assert.equal(shut, 0);
    assert.equal(await guess(35), 403);
    assert.equal(rotated, 3);
    assert.equal(shut, 1);
  } finally { t.close(); }
});

test('a pairing request that opens and says nothing is dropped', async () => {
  const t = await boot({ options: { smallBodyMs: 300 } });
  try {
    const started = Date.now();
    const outcome = await new Promise((resolve) => {
      const req = http.request(`${t.base}/pair`, { method: 'POST', agent: false, headers: { 'Content-Length': 50 } });
      req.on('response', (res) => { res.resume(); resolve(`answered ${res.statusCode}`); });
      req.on('error', () => resolve('dropped'));
      req.write('{"code":'); // and then nothing, for ever
      setTimeout(() => resolve('still open'), 4000).unref();
    });
    assert.notEqual(outcome, 'still open');
    assert.ok(Date.now() - started < 3000);
    // The server is still there for everyone else.
    assert.equal((await fetch(`${t.base}/info`)).status, 200);
  } finally { t.close(); }
});

test('a phone can ask to be forgotten, and only a paired phone can', async () => {
  const gone = [];
  const t = await boot({ unpair: (d) => gone.push(d.id) });
  const unpair = (token) => fetch(`${t.base}/unpair`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);
  try {
    assert.equal(await unpair('nope'), 401);
    assert.deepEqual(gone, []);
    assert.equal(await unpair(TOKEN), 200);
    assert.deepEqual(gone, ['d1']);
  } finally { t.close(); }
});

test('removing a phone stops what it was sending and keeps nothing of it', async () => {
  const t = await boot();
  try {
    const cut = new Promise((resolve) => {
      const req = http.request(`${t.base}/send?id=going`, {
        method: 'POST', agent: false,
        headers: { Authorization: `Bearer ${TOKEN}`, 'X-Filename': 'half.bin', 'Content-Length': 5000 },
      });
      req.on('error', () => resolve('cut'));
      req.on('response', (res) => { res.resume(); resolve(`answered ${res.statusCode}`); });
      req.write(Buffer.alloc(2000, 1));
    });
    for (let i = 0; i < 100 && t.s.status().uploads < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(parts(t.dir).length, 1);
    t.s.stopDevice('d1');
    assert.equal(await cut, 'cut');
    for (let i = 0; i < 50 && parts(t.dir).length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(fs.readdirSync(t.dir), [], 'not even the half that had arrived');
    assert.equal(t.s.status().uploads, 0);
  } finally { t.close(); }
});

test('a saved file is marked as coming from another device (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const t = await boot();
  try {
    assert.equal((await t.send('holiday.jpg', Buffer.from('jpeg bytes'))).status, 200);
    assert.match(fs.readFileSync(`${path.join(t.dir, 'holiday.jpg')}:Zone.Identifier`, 'utf8'), /ZoneId=3/);
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
