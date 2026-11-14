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
