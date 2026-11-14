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
function createOutbox({ cleanName = (n) => n, maxBytes = () => Infinity, onChange = () => {} } = {}) {
  const items = new Map(); // id -> item
  const waiters = new Map(); // phone id -> callbacks of phones waiting for something to arrive
  const streams = new Map(); // id -> the read stream of a download in progress

  const view = (item) => ({ id: item.id, name: item.name, size: item.size, mime: item.mime, sha256: item.sha256 });
  const changed = (item) => { try { onChange(item); } catch { /* the window is not our problem */ } };

  function set(item, state, error = '') {
    item.state = state;
    item.error = error;
    if (!OPEN.has(state)) {
      item.endedAt = Date.now();
      setTimeout(() => items.delete(item.id), KEEP_FINISHED_MS).unref();
    }
    changed(item);
  }

  function wake(deviceId) {
    const waiting = waiters.get(deviceId);
    if (!waiting) return;
    waiters.delete(deviceId);
    for (const fn of waiting) fn();
  }

  /** What is ready for this phone. With `all`, also what it had started: it is asking after a restart. */
  function pending(deviceId, all = false) {
    return [...items.values()]
      .filter((i) => i.deviceId === deviceId && (i.state === 'queued' || (all && i.state === 'sending')))
      .map(view);
  }

  /**
   * Puts a file in the outbox for one phone. Resolves to the item, or to { error } when the
   * file cannot be sent. The file is read once here to take its SHA-256; it is offered to the
   * phone only after that, so the phone can always check what it received.
   */
  async function add(deviceId, deviceName, file) {
    let stat;
    try { stat = fs.statSync(file); } catch { return { error: 'That file cannot be read.' }; }
    if (!stat.isFile()) return { error: 'Folders cannot be sent yet. Send the files inside it.' };
    if (stat.size > maxBytes()) return { error: 'That file is too large to send.' };
    const waiting = [...items.values()].filter((i) => i.deviceId === deviceId && OPEN.has(i.state)).length;
    if (waiting >= MAX_WAITING) return { error: 'Too many files are already waiting for that phone.' };

    const name = cleanName(path.basename(file));
    const item = {
      id: crypto.randomBytes(16).toString('hex'),
      deviceId, deviceName, path: file, name, size: stat.size, mtimeMs: stat.mtimeMs, mime: typeOf(name),
      sha256: '', state: 'preparing', error: '', sent: 0, addedAt: Date.now(), endedAt: 0,
    };
    items.set(item.id, item);
    changed(item);
    try {
      item.sha256 = await hashFile(file);
    } catch {
      set(item, 'failed', 'That file could not be read.');
      return item;
    }
    if (item.state !== 'preparing') return item; // cancelled while it was being read
    set(item, 'queued');
    wake(deviceId);
    return item;
  }

  /**
   * Resolves to what is ready for this phone: at once if there is something, otherwise when
   * something arrives or after `ms`, whichever is first. `signal` ends the wait early.
   */
  function wait(deviceId, ms, signal) {
    const ready = pending(deviceId);
    if (ready.length || ms <= 0) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters.get(deviceId)?.delete(done);
        resolve(pending(deviceId));
      };
      const timer = setTimeout(done, ms);
      if (!waiters.has(deviceId)) waiters.set(deviceId, new Set());
      waiters.get(deviceId).add(done);
      if (signal) signal.addEventListener('abort', done, { once: true });
    });
  }

  /** The file with this id, if it is this phone's and still to be collected. */
  function find(id, deviceId) {
    const item = items.get(id);
    return item && item.deviceId === deviceId ? item : null;
  }

  /**
   * Opens the file for reading from `offset`. Throws if it has changed since it was put in
   * the outbox: the checksum the phone was promised would no longer match.
   */
  function open(item, offset) {
    let stat;
    try { stat = fs.statSync(item.path); } catch { stat = null; }
    if (!stat || stat.size !== item.size || stat.mtimeMs !== item.mtimeMs) {
      set(item, 'failed', 'The file changed or was removed before it was sent.');
      throw new Error('changed');
    }
    streams.get(item.id)?.destroy(); // the phone is asking again, so the old download is dead
    const stream = fs.createReadStream(item.path, { start: offset, highWaterMark: 1024 * 1024 });
    streams.set(item.id, stream);
    item.sent = offset;
    item.state = 'sending';
    stream.on('data', (c) => { item.sent += c.length; changed(item); });
    stream.on('close', () => { if (streams.get(item.id) === stream) streams.delete(item.id); });
    changed(item);
    return stream;
  }
