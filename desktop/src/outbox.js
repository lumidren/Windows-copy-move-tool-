// The PC's outbox: files waiting for a paired phone to collect them.
//
// A phone cannot be reached reliably. It sleeps, its address changes, and many Wi-Fi networks
// stop one device from connecting to another. So the PC never calls the phone. It keeps what
// it has for each phone here, and the phone asks for it over the same pinned TLS connection
// it already uses to send. A file is fetched by a random id, never by a path, and only by the
// phone it was put here for.
//
// No Electron and no network in here: server.js is the only caller, so it runs under `node --test`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_WAITING = 500; // files waiting for one phone
const KEEP_FINISHED_MS = 10 * 60 * 1000; // how long a sent or failed file stays in the list
const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  avif: 'image/avif', bmp: 'image/bmp', mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
  webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', pdf: 'application/pdf',
  txt: 'text/plain', zip: 'application/zip',
};
const OPEN = new Set(['preparing', 'queued', 'sending']);

function typeOf(name) {
  return TYPES[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * options:
 *   cleanName(name)  makes a file name safe to hand to another device
 *   maxBytes()       the largest file that may be sent
 *   onChange(item)   called whenever a file's state or progress changes
 */
