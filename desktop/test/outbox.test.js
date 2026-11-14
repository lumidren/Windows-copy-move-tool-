const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { startServer, sanitizeName } = require('../src/server');
const { createOutbox, typeOf, MAX_WAITING } = require('../src/outbox');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const PHONES = { 'token-one': { id: 'd1', name: 'Phone one' }, 'token-two': { id: 'd2', name: 'Phone two' } };

/** A PC with an outbox, and a folder of files to send from. */
async function boot(t, { maxBytes = () => 1024 ** 3 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flingo-outbox-'));
  const changes = [];
  const outbox = createOutbox({ cleanName: sanitizeName, maxBytes, onChange: (i) => changes.push([i.id, i.state, i.sent]) });
  const s = startServer({
    info: () => ({ id: 'pc1', name: 'Test PC' }),
    pair: () => ({ error: 'locked' }),
    checkToken: (token) => PHONES[token] || null,
    saveDir: () => dir,
    outbox,
  }, { port: 0, discoveryPort: null, host: '127.0.0.1' });
  assert.equal(await s.ready, true);
  t.after(() => { s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${s.port}`;
  const as = (token) => ({ Authorization: `Bearer ${token}` });
  return {
    dir, outbox, changes, base, port: s.port,
    file(name, body) { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; },
    ask: (token, query = '') => fetch(`${base}/outbox${query}`, { headers: as(token) }).then(async (r) => ({ status: r.status, ...(await r.json()) })),
    fetchFile: (token, id, headers = {}) => fetch(`${base}/outbox/${id}`, { headers: { ...as(token), ...headers } }),
    done: (token, id, verdict) => fetch(`${base}/outbox/${id}/done`, { method: 'POST', headers: as(token), body: JSON.stringify(verdict) }),
  };
}

test('a file is offered to the phone it is for, and to no other', async (t) => {
  const pc = await boot(t);
  const body = crypto.randomBytes(5000);
  const item = await pc.outbox.add('d1', 'Phone one', pc.file('holiday.jpg', body));
  assert.equal(item.state, 'queued');

  const mine = await pc.ask('token-one');
  assert.deepEqual(mine.items, [{ id: item.id, name: 'holiday.jpg', size: 5000, mime: 'image/jpeg', sha256: sha256(body) }]);
  assert.deepEqual((await pc.ask('token-two')).items, []);
  assert.equal((await pc.fetchFile('token-two', item.id)).status, 404, "another phone's file looks like one that does not exist");
  assert.equal((await pc.ask('nonsense')).status, 401);
  assert.equal((await fetch(`${pc.base}/outbox/${item.id}`)).status, 401);
});

test('the phone downloads the whole file, checks it and says so', async (t) => {
  const pc = await boot(t);
  const body = crypto.randomBytes(3 * 1024 * 1024 + 17);
  const item = await pc.outbox.add('d1', 'Phone one', pc.file('clip.mp4', body));
  const res = await pc.fetchFile('token-one', item.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-sha256'), sha256(body));
  assert.equal(Number(res.headers.get('content-length')), body.length);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), body);
  assert.equal(pc.outbox.get(item.id).state, 'sending', 'not sent until the phone confirms');

  assert.equal((await pc.done('token-one', item.id, { ok: true })).status, 200);
  assert.equal(pc.outbox.get(item.id).state, 'done');
  assert.deepEqual((await pc.ask('token-one', '?all=1')).items, []);
  assert.equal((await pc.fetchFile('token-one', item.id)).status, 404, 'a finished file cannot be fetched again');
});

test('a phone that is waiting hears about a new file at once', async (t) => {
  const pc = await boot(t);
  const started = Date.now();
  const waiting = pc.ask('token-one', '?wait=20');
  await new Promise((r) => setTimeout(r, 150));
  const item = await pc.outbox.add('d1', 'Phone one', pc.file('note.txt', 'hello'));
  const answer = await waiting;
  assert.deepEqual(answer.items.map((i) => i.id), [item.id]);
  assert.ok(Date.now() - started < 5000, 'did not wait for the timeout');
});

test('files sent together are offered together', async (t) => {
  const pc = await boot(t);
  const waiting = pc.ask('token-one', '?wait=20');
  const held = [];
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) held.push(await pc.outbox.add('d1', 'Phone one', pc.file(name, name), { hold: true }));
  assert.deepEqual(held.map((i) => i.state), ['preparing', 'preparing', 'preparing']);
  assert.deepEqual((await pc.ask('token-one', '?all=1')).items, [], 'nothing is offered while the batch is being read');
  pc.outbox.release('d1');
  assert.deepEqual((await waiting).items.map((i) => i.name), ['a.jpg', 'b.jpg', 'c.jpg']);
  assert.equal(pc.outbox.cancel(held[0].id), true);
  pc.outbox.release('d2'); // another phone's release changes nothing here
  assert.deepEqual((await pc.ask('token-one')).items.map((i) => i.name), ['b.jpg', 'c.jpg']);
});

test('a wait with nothing to collect ends empty', async (t) => {
  const pc = await boot(t);
  const started = Date.now();
  assert.deepEqual((await pc.ask('token-one', '?wait=1')).items, []);
  assert.ok(Date.now() - started >= 900);
  assert.deepEqual((await pc.ask('token-one', '?wait=nonsense')).items, [], 'a bad wait is no wait');
});

test('a download that was cut off carries on from where it stopped', async (t) => {
  const pc = await boot(t);
  const body = crypto.randomBytes(8 * 1024 * 1024);
  const item = await pc.outbox.add('d1', 'Phone one', pc.file('film.mkv', body));

  // Take the first part, then drop the connection the way a Wi-Fi blip would.
  const first = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: pc.port, path: `/outbox/${item.id}`, headers: { Authorization: 'Bearer token-one' } }, (res) => {
      const got = [];
      let size = 0;
      res.on('data', (c) => {
        got.push(c);
        size += c.length;
        if (size >= 2 * 1024 * 1024) { req.destroy(); resolve(Buffer.concat(got)); }
      });
      res.on('error', () => {});
    });
    req.on('error', reject);
  });
  assert.ok(first.length >= 2 * 1024 * 1024 && first.length < body.length);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pc.outbox.get(item.id).stalled, true, 'the PC knows the download was interrupted');
  assert.deepEqual((await pc.ask('token-one', '?all=1')).items.map((i) => i.id), [item.id], 'still there after a restart of the phone app');

  const rest = await pc.fetchFile('token-one', item.id, { Range: `bytes=${first.length}-` });
  assert.equal(rest.status, 206);
  assert.equal(rest.headers.get('content-range'), `bytes ${first.length}-${body.length - 1}/${body.length}`);
  assert.equal(pc.outbox.get(item.id).stalled, false);
  const whole = Buffer.concat([first, Buffer.from(await rest.arrayBuffer())]);
  assert.equal(sha256(whole), rest.headers.get('x-sha256'));
  assert.deepEqual(whole, body);
});

test('a range that makes no sense is refused', async (t) => {
  const pc = await boot(t);
  const item = await pc.outbox.add('d1', 'Phone one', pc.file('a.bin', Buffer.alloc(100)));
  for (const range of ['bytes=101-', 'bytes=5-9', 'bytes=-5', 'lines=1-', 'bytes=abc-']) {
    assert.equal((await pc.fetchFile('token-one', item.id, { Range: range })).status, 416, range);
  }
  const end = await pc.fetchFile('token-one', item.id, { Range: 'bytes=100-' });
  assert.equal(end.status, 206, 'asking from the very end is an empty answer, not an error');
  assert.equal((await end.arrayBuffer()).byteLength, 0);
});

test('only an id opens a file: paths and guesses lead nowhere', async (t) => {
  const pc = await boot(t);
  pc.file('secret.txt', 'not for sending');
  await pc.outbox.add('d1', 'Phone one', pc.file('a.txt', 'a'));
  for (const p of ['/outbox/secret.txt', '/outbox/..%2Fsecret.txt', '/outbox/../secret.txt', `/outbox/${'0'.repeat(32)}`, `/outbox/${'g'.repeat(32)}`, '/outbox/abc/done']) {
    const res = await fetch(pc.base + p, { headers: { Authorization: 'Bearer token-one' } });
    assert.equal(res.status, 404, p);
  }
});

test('a file that changed after it was queued is not sent', async (t) => {
  const pc = await boot(t);
  const file = pc.file('draft.txt', 'first version');
  const item = await pc.outbox.add('d1', 'Phone one', file);
  fs.writeFileSync(file, 'a second, longer version');
  assert.equal((await pc.fetchFile('token-one', item.id)).status, 409);
  assert.equal(pc.outbox.get(item.id).state, 'failed');
});

test('a file can be taken back from the PC, or declined by the phone', async (t) => {
  const pc = await boot(t);
  const one = await pc.outbox.add('d1', 'Phone one', pc.file('one.bin', Buffer.alloc(10)));
  assert.equal(pc.outbox.cancel(one.id), true);
  assert.equal((await pc.fetchFile('token-one', one.id)).status, 410, 'the phone is told it is gone');
  assert.deepEqual((await pc.ask('token-one')).items, []);
  assert.equal(pc.outbox.cancel(one.id), false, 'only once');

  const two = await pc.outbox.add('d1', 'Phone one', pc.file('two.bin', Buffer.alloc(10)));
  const res = await fetch(`${pc.base}/outbox/${two.id}/cancel`, { method: 'POST', headers: { Authorization: 'Bearer token-one' } });
  assert.equal(res.status, 200);
  assert.equal(pc.outbox.get(two.id).state, 'cancelled');
});

test('the phone can say a file did not arrive intact', async (t) => {
  const pc = await boot(t);
  const item = await pc.outbox.add('d1', 'Phone one', pc.file('x.bin', Buffer.alloc(10)));
  await pc.done('token-one', item.id, { ok: false, error: 'Checksum did not match\u0007' });
  assert.equal(pc.outbox.get(item.id).state, 'failed');
  assert.equal(pc.outbox.get(item.id).error, 'Checksum did not match');

  const other = await pc.outbox.add('d1', 'Phone one', pc.file('y.bin', Buffer.alloc(10)));
  await fetch(`${pc.base}/outbox/${other.id}/done`, { method: 'POST', headers: { Authorization: 'Bearer token-one' }, body: 'not json' });
  assert.equal(pc.outbox.get(other.id).state, 'failed', 'an unreadable verdict is not a success');
});

test('what cannot be sent is refused with a reason', async (t) => {
  const pc = await boot(t, { maxBytes: () => 1000 });
  assert.match((await pc.outbox.add('d1', 'Phone one', path.join(pc.dir, 'missing.jpg'))).error, /cannot be read/);
  assert.match((await pc.outbox.add('d1', 'Phone one', pc.dir)).error, /Folders/);
  assert.match((await pc.outbox.add('d1', 'Phone one', pc.file('big.bin', Buffer.alloc(1001)))).error, /too large/);
  const empty = await pc.outbox.add('d1', 'Phone one', pc.file('empty.txt', ''));
  assert.equal(empty.state, 'queued', 'an empty file is still a file');
  assert.deepEqual(pc.outbox.list().map((i) => i.name), ['empty.txt']);
});

test('names are made safe before they leave the PC', async (t) => {
  const pc = await boot(t);
  const item = await pc.outbox.add('d1', 'Phone one', pc.file('report ..', 'x'));
  assert.equal(item.name, sanitizeName('report ..'));
  assert.ok(!/[\\/]/.test(item.name));
  assert.equal(typeOf('PHOTO.JPG'), 'image/jpeg');
  assert.equal(typeOf('archive.7z'), 'application/octet-stream');
});

test('one phone cannot have an endless queue', async (t) => {
  const pc = await boot(t);
  const file = pc.file('tiny.txt', 'x');
  await Promise.all(Array.from({ length: MAX_WAITING }, () => pc.outbox.add('d1', 'Phone one', file)));
  assert.match((await pc.outbox.add('d1', 'Phone one', file)).error, /Too many/);
  assert.equal((await pc.outbox.add('d2', 'Phone two', file)).state, 'queued', 'the limit is per phone');
});

test('progress is reported while a file goes out', async (t) => {
  const pc = await boot(t);
  const body = crypto.randomBytes(4 * 1024 * 1024);
  const item = await pc.outbox.add('d1', 'Phone one', pc.file('p.bin', body));
  await (await pc.fetchFile('token-one', item.id)).arrayBuffer();
  const sent = pc.changes.filter(([id, state]) => id === item.id && state === 'sending').map(([, , n]) => n);
  assert.ok(sent.length >= 2);
  assert.equal(sent.at(-1), body.length);
  assert.deepEqual(pc.changes.filter(([id]) => id === item.id).map(([, state]) => state).slice(0, 2), ['preparing', 'queued']);
});
