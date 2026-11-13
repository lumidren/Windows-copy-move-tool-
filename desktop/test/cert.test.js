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
