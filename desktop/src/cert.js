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
