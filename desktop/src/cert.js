// This PC's TLS identity: an EC P-256 key and a self-signed certificate, made once
// and kept in the app's data folder. Phones do not trust it through a certificate
// authority. They remember ("pin") its SHA-256 fingerprint when they pair, so the
// certificate only needs to be well-formed X.509. It is built here by hand because
// Node can sign and parse certificates but has no API to create one.
const crypto = require('crypto');
const fs = require('fs');

// ---- minimal DER encoder ----
function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
const SEQUENCE = 0x30, SET = 0x31, INTEGER = 0x02, BIT_STRING = 0x03, UTF8_STRING = 0x0c;
const OID_ECDSA_WITH_SHA256 = Buffer.from('06082a8648ce3d040302', 'hex'); // 1.2.840.10045.4.3.2
const OID_COMMON_NAME = Buffer.from('0603550403', 'hex'); // 2.5.4.3

function derName(commonName) {
  return der(SEQUENCE, der(SET, der(SEQUENCE, OID_COMMON_NAME, der(UTF8_STRING, Buffer.from(commonName, 'utf8')))));
}

function derTime(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const tail = p(date.getUTCMonth() + 1) + p(date.getUTCDate()) + p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z';
  const year = date.getUTCFullYear();
  // X.509 uses the two-digit UTCTime form up to 2049 and GeneralizedTime after that.
  return year < 2050
    ? der(0x17, Buffer.from(p(year % 100) + tail, 'ascii'))
    : der(0x18, Buffer.from(p(year, 4) + tail, 'ascii'));
}

function pem(label, buf) {
  const b64 = buf.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** Returns { key, cert } as PEM strings. */
function createIdentity(commonName = 'Flingo', now = new Date()) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01; // positive and non-zero
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000); // tolerate a phone clock that runs behind
  const notAfter = new Date(now.getTime() + 20 * 365 * 24 * 3600 * 1000);
  const name = derName(commonName);
  const tbs = der(SEQUENCE,
    der(0xa0, der(INTEGER, Buffer.from([2]))), // version 3
    der(INTEGER, serial),
    der(SEQUENCE, OID_ECDSA_WITH_SHA256),
    name, // issuer
    der(SEQUENCE, derTime(notBefore), derTime(notAfter)),
    name, // subject: self-signed
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const cert = der(SEQUENCE, tbs, der(SEQUENCE, OID_ECDSA_WITH_SHA256), der(BIT_STRING, Buffer.from([0]), signature));
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: pem('CERTIFICATE', cert),
  };
}

/** SHA-256 of the certificate, the value a phone pins. */
function fingerprint(certPem) {
  return crypto.createHash('sha256').update(new crypto.X509Certificate(certPem).raw).digest();
}

/** A short form people can compare by eye, e.g. "4F2A 91C3". */
function securityCode(certPem) {
  const hex = fingerprint(certPem).toString('hex').toUpperCase();
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)}`;
}

/** Loads the saved identity, or creates and saves one. */
function loadOrCreateIdentity(file, commonName) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const x509 = new crypto.X509Certificate(saved.cert);
    const key = crypto.createPrivateKey(saved.key);
    if (x509.checkPrivateKey(key) && new Date(x509.validTo) > new Date()) return { key: saved.key, cert: saved.cert };
  } catch { /* missing or damaged: make a new one */ }
  const identity = createIdentity(commonName);
  fs.writeFileSync(file, JSON.stringify(identity), { mode: 0o600 });
  return identity;
}

module.exports = { createIdentity, loadOrCreateIdentity, fingerprint, securityCode };
