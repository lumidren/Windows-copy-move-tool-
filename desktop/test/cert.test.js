// TLS identity tests: the hand-built certificate must be real X.509, and the
// receiver must serve it so a phone can pin its fingerprint.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const tls = require('tls');
const { createIdentity, loadOrCreateIdentity, fingerprint, securityCode } = require('../src/cert');
const { startServer } = require('../src/server');

test('the certificate is valid, self-signed X.509 that matches its key', () => {
  const id = createIdentity('Flingo test');
  const x = new crypto.X509Certificate(id.cert);
  assert.equal(x.subject, 'CN=Flingo test');
  assert.equal(x.issuer, 'CN=Flingo test');
  assert.ok(x.verify(x.publicKey), 'signature verifies with its own key');
  assert.ok(x.checkPrivateKey(crypto.createPrivateKey(id.key)));
  assert.ok(new Date(x.validFrom) < new Date());
  assert.ok(new Date(x.validTo) > new Date(Date.now() + 19 * 365 * 24 * 3600 * 1000));
  assert.equal(fingerprint(id.cert).length, 32);
  assert.match(securityCode(id.cert), /^[0-9A-F]{4} [0-9A-F]{4}$/);
});

test('dates after 2049 use the long time form and still parse', () => {
  const id = createIdentity('Flingo', new Date('2035-06-01T00:00:00Z'));
  const x = new crypto.X509Certificate(id.cert);
  assert.equal(new Date(x.validTo).getUTCFullYear(), 2055);
});

test('the identity is created once and then reused', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flingo-id-')), 'identity.json');
  const a = loadOrCreateIdentity(file, 'Flingo');
  const b = loadOrCreateIdentity(file, 'Flingo');
  assert.equal(a.cert, b.cert);
  fs.writeFileSync(file, '{"broken":');
  const c = loadOrCreateIdentity(file, 'Flingo');
  assert.notEqual(c.cert, a.cert, 'a damaged file is replaced');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('the receiver serves TLS with that certificate, and plain HTTP is refused', async () => {
  const id = createIdentity('Flingo');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flingo-tls-'));
  const files = [];
  const s = startServer({
    info: () => ({ id: 'pc', name: 'PC' }),
    pair: () => ({ error: 'wrong' }),
    checkToken: (t) => (t === 'tok' ? { id: 'd', name: 'Phone' } : null),
    saveDir: () => dir,
    onFile: (f) => files.push(f),
  }, { tls: id, port: 0, discoveryPort: null, host: '127.0.0.1' });
  assert.equal(await s.ready, true);
  try {
    // What the phone does: accept only the pinned fingerprint.
    const pinned = fingerprint(id.cert);
    const request = (pin, body) => new Promise((resolve, reject) => {
      const req = https.request({
        host: '127.0.0.1', port: s.port, path: '/send', method: 'POST', rejectUnauthorized: false, agent: false,
        headers: { Authorization: 'Bearer tok', 'X-Filename': 'tls.bin', 'Content-Length': body.length },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('socket', (sock) => sock.on('secureConnect', () => {
        const seen = crypto.createHash('sha256').update(sock.getPeerCertificate().raw).digest();
        if (!seen.equals(pin)) req.destroy(new Error('pin mismatch'));
        else req.end(body);
      }));
      req.on('error', reject);
    });
    const body = crypto.randomBytes(500_000);
    assert.equal(await request(pinned, body), 200);
    assert.ok(fs.readFileSync(path.join(dir, 'tls.bin')).equals(body));
    await assert.rejects(request(crypto.randomBytes(32), body), /pin mismatch/);
    assert.equal(files.length, 1, 'nothing is sent when the pin does not match');

    const proto = await new Promise((resolve) => {
      const sock = tls.connect({ host: '127.0.0.1', port: s.port, rejectUnauthorized: false }, () => { resolve(sock.getProtocol()); sock.end(); });
    });
    assert.match(proto, /^TLSv1\.[23]$/);
    await assert.rejects(fetch(`http://127.0.0.1:${s.port}/info`), 'plain HTTP gets no answer');
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
