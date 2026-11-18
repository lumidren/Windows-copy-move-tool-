// LAN receiver: UDP discovery + a small HTTP(S) API the phone talks to.
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cleanApp } = require('./phones');
const { markFromElsewhere } = require('./files');

const HTTP_PORT = 47801;
const DISCOVERY_PORT = 47800;
const DISCOVERY_MAGIC = 'FLINGO_DISCOVER';
const PROTOCOL_VERSION = 2;
const MAX_PAIR_FAILS = 5; // wrong codes per IP per minute
const MAX_TOTAL_FAILS = 12; // wrong codes from anyone before the code is replaced
const MAX_PAIRING_AT_ONCE = 3; // codes being checked at one moment, from anyone
const MAX_ROTATIONS = 3; // the code was replaced this often in ROTATION_WINDOW_MS: someone is guessing, so pairing is shut
const ROTATION_WINDOW_MS = 10 * 60 * 1000;
const MAX_UPLOADS = 12; // transfers in flight at once: a phone sends up to four files of a batch together
const MAX_UPLOADS_PER_PHONE = 8; // so one phone cannot take every place and keep the others out
const MAX_KEPT_PARTS = 8; // half-received files kept for one phone to carry on with
const SMALL_BODY_MS = 10_000; // a pairing request or a verdict arrives at once or not at all
const SOCKET_IDLE_MS = 75_000; // longer than the longest wait on the outbox (50 s)
const MAX_CONNECTIONS = 128;
const SPACE_CHECK_BYTES = 64 * 1024 ** 2; // a file of unknown size has the free space checked again this often
const WRITE_BUFFER = 1024 * 1024;
const IDLE_TIMEOUT_MS = 30_000; // a stalled upload is dropped after this long without data
const DEFAULT_MAX_BYTES = 32 * 1024 ** 3;
const SPACE_MARGIN = 64 * 1024 ** 2;
const PROGRESS_EVERY_MS = 80;
const PART_KEEP_MS = 60 * 60 * 1000; // a half-received file waits this long for the phone to carry on
const SAFE_ID = /^[0-9a-zA-Z]{1,32}$/;
const PART_FILE = /^\.flingo-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)?\.part$/;

// Names Windows keeps for devices, with or without an extension, and with spaces before the dot.
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\..*)?$/i;
// Zero-width and direction-override characters can disguise a file's real extension.
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

/** No spaces at the start, no dots or spaces at the end: Windows drops those itself, so "a.exe." would be "a.exe". */
const trimEnds = (name) => name.replace(/^ +/, '').replace(/[. ]+$/, '');

function sanitizeName(raw) {
  let name = path.basename(String(raw || '').replace(/\\/g, '/'));
  name = name.replace(INVISIBLE, '').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_');
  // Every kind of space becomes a plain one first (a no-break space at the end would otherwise
  // survive the trim and hide the dot before it).
  name = trimEnds(name.replace(/\s/gu, ' '));
  name = name.replace(/^\.+/, '_'); // no hidden files
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 20);
    name = trimEnds(name.slice(0, 180 - ext.length) + ext); // the cut may have left a dot or a space at the end
  }
  if (!name) name = 'file';
  if (RESERVED.test(name)) name = '_' + name;
  return name;
}

function uniquePath(dir, name, claimed) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate) || (claimed && claimed.has(candidate)); i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

/**
 * Removes half-received files left behind by a crash or a power cut. With olderThanMs,
 * recent ones are kept, so a phone can still carry on with a transfer after the PC app restarts.
 */
function cleanStaleParts(dir, olderThanMs = 0) {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!PART_FILE.test(f)) continue;
      const file = path.join(dir, f);
      if (olderThanMs && Date.now() - fs.statSync(file).mtimeMs < olderThanMs) continue;
      fs.rmSync(file, { force: true });
      removed++;
    }
  } catch { /* folder does not exist yet */ }
  return removed;
}

/**
 * Deletes a half-received file. On Windows a file that was being written a moment ago can
 * still be held open for an instant, so a refusal is tried again a few times before giving up.
 */
function removeFile(file, triesLeft = 6) {
  fs.rm(file, { force: true }, (err) => {
    if (err && triesLeft > 0 && ['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) setTimeout(() => removeFile(file, triesLeft - 1), 120).unref();
  });
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function wholeNumber(raw, min, max) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function freeBytes(dir) {
  return new Promise((resolve) => {
    if (!fs.statfs) return resolve(null);
    fs.statfs(dir, (err, s) => resolve(err ? null : Number(s.bavail) * Number(s.bsize)));
  });
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

/** Answers and hangs up: used when a request is refused before its body has been read. */
function refuse(req, res, status, error, extra = {}) {
  const data = JSON.stringify({ error, ...extra });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    Connection: 'close',
  });
  res.end(data);
  req.resume();
  setTimeout(() => req.destroy(), 1500).unref();
}

/**
 * Streams one outbox file to the phone that asked for it. "Range: bytes=N-" carries on from
 * byte N after a dropped connection. The checksum of the whole file travels in a header, so
 * the phone can check what it ends up with.
 */
function sendOut(req, res, outbox, item) {
  const header = String(req.headers.range || '');
  const range = /^bytes=(\d{1,15})-$/.exec(header);
  if (header && !range) return json(res, 416, { error: 'Bad range', size: item.size });
  const offset = range ? Number(range[1]) : 0;
  if (offset > item.size) return json(res, 416, { error: 'Bad range', size: item.size });
  let stream;
  try { stream = outbox.open(item, offset); } catch { return json(res, 409, { error: 'The file changed on the PC before it was sent.' }); }
  res.writeHead(offset ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': item.size - offset,
    ...(offset ? { 'Content-Range': `bytes ${offset}-${Math.max(offset, item.size - 1)}/${item.size}` } : {}),
    'X-Sha256': item.sha256,
    'Cache-Control': 'no-store',
  });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function readSmallBody(req, limit = 4096, patienceMs = SMALL_BODY_MS) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // A request that opens and then says nothing must not hold a connection for ever.
    req.setTimeout(patienceMs, () => { reject(new Error('too slow')); req.destroy(); });
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * hooks: {
 *   info(): {id, name, ...},
 *   pair({code, deviceName, deviceId, ip}): {token} | {error: 'wrong' | 'locked'},
 *   rotateCode(): called after too many wrong codes,
 *   guessing(): the code keeps being replaced because of wrong guesses; pairing should be shut,
 *   checkToken(token): {id, name} | null,
 *   seen(device, ip): a paired phone just talked to us,
 *   saveDir(): string,
 *   maxBytes(): largest file accepted,
 *   onStart({id, key, name, from, total, received, quiet, batch}),
 *   onProgress({id, key, received, total}), onEnd({id, key, ok, waiting}),
 *   onFile({id, key, path, name, size, mime, from, x, quiet, batch}),
 *   onCancel({key, from}): the phone's owner stopped that transfer
 * }
 * key is the phone's own name for a transfer when it gave one (so a transfer that is cut
 * off and carried on later keeps one identity), otherwise the same as id.
 * quiet: the phone asked for no arrival animation. batch: {id, index, count, bytes} | null.
 * waiting: the transfer was cut off but its first part is kept for the phone to carry on.
 * options: { tls: {key, cert} | null, port, discoveryPort, host }
 */
function startServer(hooks, options = {}) {
  const tls = options.tls || null;
  const wantedPort = options.port ?? HTTP_PORT;
  const discoveryPort = options.discoveryPort ?? DISCOVERY_PORT;
  // The two limits a test needs to reach without sixty real seconds or forty real senders.
  const maxPairFails = options.maxPairFails ?? MAX_PAIR_FAILS;
  const smallBodyMs = options.smallBodyMs ?? SMALL_BODY_MS;
  const fails = new Map(); // ip -> [timestamps]
  const claimed = new Set(); // final paths picked by transfers that are still finishing
  const active = new Map(); // partial file path -> stop(): that transfer, while it is running
  const expiry = new Map(); // partial file path -> timer that deletes it if the phone never returns
  const owners = new Map(); // partial file path -> id of the phone it belongs to
  const perPhone = new Map(); // phone id -> transfers it has in flight
  let totalFails = 0;
  let uploads = 0;
  let pairing = 0; // codes being checked right now
  let rotations = []; // when the code was last replaced because of wrong guesses

  function tooManyFails(ip) {
    const now = Date.now();
    for (const [k, list] of fails) {
      const recent = list.filter((t) => now - t < 60_000);
      if (recent.length) fails.set(k, recent); else fails.delete(k);
    }
    return (fails.get(ip) || []).length >= maxPairFails;
  }

  /**
   * Counts an attempt against its sender the moment it arrives, before its code has even been
   * read. Counted only afterwards, a thousand requests sent together would all be let in.
   * Returns a function that takes the count back, for the attempt that turns out to be right.
   */
  function noteAttempt(ip) {
    const at = Date.now();
    fails.set(ip, [...(fails.get(ip) || []), at]);
    return () => {
      const list = fails.get(ip) || [];
      const i = list.indexOf(at);
      if (i >= 0) list.splice(i, 1);
    };
  }

  function noteFail() {
    if (++totalFails < MAX_TOTAL_FAILS) return;
    totalFails = 0;
    if (hooks.rotateCode) hooks.rotateCode();
    // A new code every dozen wrong guesses does not stop someone who keeps guessing: each guess
    // is as likely as the last. When it keeps happening, the door is shut until the owner opens it.
    const now = Date.now();
    rotations = [...rotations.filter((t) => now - t < ROTATION_WINDOW_MS), now];
    if (rotations.length >= MAX_ROTATIONS) {
      rotations = [];
      if (hooks.guessing) hooks.guessing();
    }
  }

  /** Where a transfer the phone named is kept while it is incomplete. One per phone and name. */
  function partPath(dir, device, tid) {
    return path.join(dir, `.flingo-${device.id}-${tid}.part`);
  }

  /** What the phone said about this transfer beyond the file itself. */
  function describe(url) {
    const q = (k) => url.searchParams.get(k) || '';
    const count = wholeNumber(q('n'), 1, 100000);
    const index = wholeNumber(q('i'), 1, 100000);
    const batch = SAFE_ID.test(q('batch')) && count && index && index <= count
      ? { id: q('batch'), index, count, bytes: wholeNumber(q('bytes') || 'x', 0, Number.MAX_SAFE_INTEGER) }
      : null;
    return { quiet: q('quiet') === '1', batch };
  }

  async function receive(req, res, url, device) {
    const declared = Number(req.headers['content-length']);
    const body = Number.isFinite(declared) && declared >= 0 ? declared : null;
    // A transfer the phone has named can be carried on from where it stopped.
    const tid = SAFE_ID.test(url.searchParams.get('id') || '') && SAFE_ID.test(device.id) ? url.searchParams.get('id') : null;
    const offset = tid ? wholeNumber(url.searchParams.get('offset') || '0', 0, Number.MAX_SAFE_INTEGER) ?? 0 : 0;
    const total = body === null ? null : offset + body;
    const limit = hooks.maxBytes ? hooks.maxBytes() : DEFAULT_MAX_BYTES;
    if (total !== null && total > limit) return refuse(req, res, 413, 'That file is too large for this PC.');
    const mine = perPhone.get(device.id) || 0;
    if (uploads >= MAX_UPLOADS || mine >= MAX_UPLOADS_PER_PHONE) return refuse(req, res, 429, 'This PC is busy receiving. Try again in a moment.');
    // The place is taken now, before anything is waited for: counted later, requests that
    // arrive together would all see a free place.
    uploads++;
    perPhone.set(device.id, mine + 1);
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      uploads--;
      const left = (perPhone.get(device.id) || 1) - 1;
      if (left > 0) perPhone.set(device.id, left); else perPhone.delete(device.id);
    };
    const turnAway = (status, error, extra) => { release(); return refuse(req, res, status, error, extra); };

    const dir = hooks.saveDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return turnAway(500, 'The save folder on the PC cannot be used.'); }
    req.pause();
    const free = await freeBytes(dir);
    if (free !== null && free < (body ?? 0) + SPACE_MARGIN) {
      return turnAway(507, 'Not enough free space on the PC.');
    }

    let rawName = req.headers['x-filename'] || 'file';
    try { rawName = decodeURIComponent(rawName); } catch { /* keep raw */ }
    const name = sanitizeName(rawName);
    const id = crypto.randomBytes(6).toString('hex');
    const key = tid || id;
    const tmp = tid ? partPath(dir, device, tid) : path.join(dir, `.flingo-${id}.part`);
    if (active.has(tmp)) return turnAway(409, 'That file is already on its way.');
    // Carrying on only works from exactly where the saved part ends.
    if (offset > 0 && fileSize(tmp) !== offset) {
      return turnAway(409, 'The PC has a different amount of that file.', { received: fileSize(tmp) });
    }
    clearTimeout(expiry.get(tmp));
    expiry.delete(tmp);

    const { quiet, batch } = describe(url);
    // Gathering a megabyte before each write to disk, instead of Node's 16 KB, makes a large file about 40% faster.
    const out = fs.createWriteStream(tmp, { flags: offset > 0 ? 'a' : 'w', highWaterMark: WRITE_BUFFER });
    let size = offset;
    let done = false;
    let lastTick = 0;
    let dropped = false; // stopped on purpose: nothing is kept for later
    let checkedAt = offset; // how much had arrived when the free space was last looked at
    active.set(tmp, (drop = false) => { dropped = drop; fail(); req.destroy(); });
    owners.set(tmp, device.id);

    const finish = (ok, waiting = false) => {
      if (done) return false;
      done = true;
      release();
      active.delete(tmp);
      owners.delete(tmp);
      if (hooks.onEnd) hooks.onEnd({ id, key, ok, waiting });
      return true;
    };
    const fail = (status, error) => {
      // A dropped connection keeps what arrived, so the phone can carry on. A refusal does not.
      const keep = !!tid && !status && size > 0 && !dropped;
      if (!finish(false, keep)) return;
      out.destroy();
      if (keep) {
        const timer = setTimeout(() => { expiry.delete(tmp); if (!active.has(tmp)) removeFile(tmp); }, PART_KEEP_MS);
        timer.unref();
        expiry.set(tmp, timer);
        // One phone may leave only so many halves behind; beyond that the oldest goes.
        const kept = [...expiry.keys()].filter((p) => path.basename(p).startsWith(`.flingo-${device.id}-`));
        for (const old of kept.slice(0, Math.max(0, kept.length - MAX_KEPT_PARTS))) {
          clearTimeout(expiry.get(old));
          expiry.delete(old);
          if (!active.has(old)) removeFile(old);
        }
      } else {
        removeFile(tmp);
      }
      if (status && !res.headersSent) refuse(req, res, status, error);
    };

    if (hooks.onStart) hooks.onStart({ id, key, name, from: device.name, total, received: offset, quiet, batch });
    req.setTimeout(IDLE_TIMEOUT_MS, () => { fail(); req.destroy(); });
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { fail(413, 'That file is too large for this PC.'); return; }
      // A file that did not say how large it is could not be checked against the free space
      // at the start, so the disk is looked at again as it grows.
      if (body === null && size - checkedAt >= SPACE_CHECK_BYTES) {
        checkedAt = size;
        freeBytes(dir).then((left) => { if (left !== null && left < SPACE_MARGIN) fail(507, 'Not enough free space on the PC.'); });
      }
      const now = Date.now();
      if (hooks.onProgress && now - lastTick >= PROGRESS_EVERY_MS) {
        lastTick = now;
        hooks.onProgress({ id, key, received: size, total });
      }
    });
    req.on('aborted', () => fail());
    req.on('error', () => fail());
    req.on('close', () => { if (!req.complete) fail(); });
    out.on('error', () => fail(500, 'The PC could not save the file.'));
    out.on('finish', () => {
      if (done) return;
      if (total !== null && size !== total) return fail(400, 'The file arrived incomplete.');
      const finalPath = uniquePath(dir, name, claimed);
      claimed.add(finalPath);
      fs.rename(tmp, finalPath, (err) => {
        claimed.delete(finalPath);
        if (err) return fail(500, 'The PC could not save the file.');
        markFromElsewhere(finalPath); // Windows then treats it as it would a download
        if (!finish(true)) return;
        const x = Math.min(1, Math.max(0, parseFloat(url.searchParams.get('x')) || 0.5));
        hooks.onFile({
          id,
          key,
          quiet,
          batch,
          path: finalPath,
          name: path.basename(finalPath),
          size,
          mime: String(req.headers['content-type'] || 'application/octet-stream'),
          from: device.name,
          x,
        });
        json(res, 200, { ok: true, name: path.basename(finalPath) });
      });
    });
    req.pipe(out);
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const ip = req.socket.remoteAddress || '';
    try {
      if (req.method === 'GET' && url.pathname === '/info') {
        return json(res, 200, { app: 'flingo', version: PROTOCOL_VERSION, ...hooks.info() });
      }

      if (req.method === 'POST' && url.pathname === '/pair') {
        if (tooManyFails(ip) || pairing >= MAX_PAIRING_AT_ONCE) return refuse(req, res, 429, 'Too many attempts. Wait a minute.');
        const forgive = noteAttempt(ip);
        pairing++;
        try {
          let body;
          try { body = JSON.parse(await readSmallBody(req, 4096, smallBodyMs)); } catch { return json(res, 400, { error: 'Bad request' }); }
          if (!body || typeof body !== 'object') return json(res, 400, { error: 'Bad request' });
          const result = hooks.pair({
            code: String(body.code || ''),
            deviceName: String(body.deviceName || 'Phone').replace(INVISIBLE, '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60) || 'Phone',
            deviceId: String(body.deviceId || '').replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 64),
            ip,
          }) || { error: 'wrong' };
          if (result.error === 'locked') { forgive(); return json(res, 423, { error: 'Pairing is locked on this PC.' }); }
          if (!result.token) {
            noteFail();
            return json(res, 403, { error: 'Wrong code' });
          }
          forgive();
          totalFails = 0;
          return json(res, 200, { token: result.token, ...hooks.info() });
        } finally {
          pairing--;
        }
      }

      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const device = token ? hooks.checkToken(token) : null;
      // Besides being here, the phone may say which Flingo it runs, and asking for its files
      // shows that it can receive them. An older Flingo does neither (see phones.js).
      if (device && hooks.seen) {
        hooks.seen(device, ip, {
          app: cleanApp(req.headers['x-flingo-app']),
          asks: url.pathname === '/outbox' || url.pathname.startsWith('/outbox/'),
        });
      }

      if (req.method === 'GET' && url.pathname === '/ping') {
        return device ? json(res, 200, { ok: true, ...hooks.info() }) : json(res, 401, { error: 'Not paired' });
      }

      // How much of a named transfer this PC already has, so the phone can send only the rest.
      if (req.method === 'GET' && url.pathname === '/resume') {
        if (!device) return json(res, 401, { error: 'Not paired' });
        const tid = url.searchParams.get('id') || '';
        if (!SAFE_ID.test(tid) || !SAFE_ID.test(device.id)) return json(res, 200, { received: 0 });
        const part = partPath(hooks.saveDir(), device, tid);
        // The phone is asking, so the old connection is dead even if this side has not noticed yet.
        const stop = active.get(part);
        if (stop) { stop(); await new Promise((r) => setTimeout(r, 150)); }
        return json(res, 200, { received: fileSize(part) });
      }

      // The phone's owner pressed Cancel: stop the transfer and keep nothing of it.
      if (req.method === 'POST' && url.pathname === '/cancel') {
        req.resume();
        if (!device) return json(res, 401, { error: 'Not paired' });
        const tid = url.searchParams.get('id') || '';
        if (SAFE_ID.test(tid) && SAFE_ID.test(device.id)) {
          const part = partPath(hooks.saveDir(), device, tid);
          if (hooks.onCancel) hooks.onCancel({ key: tid, from: device.name });
          const stop = active.get(part);
          if (stop) stop(true);
          else {
            clearTimeout(expiry.get(part));
            expiry.delete(part);
            removeFile(part);
          }
        }
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/send') {
        if (!device) return refuse(req, res, 401, 'Not paired');
        return await receive(req, res, url, device);
      }

      // ---------- PC to phone ----------
      // The phone collects what this PC has put aside for it (see outbox.js). It asks what
      // is waiting, fetches each file by its id, and says how it went.
      const outbox = hooks.outbox;
      if (outbox && req.method === 'GET' && url.pathname === '/outbox') {
        if (!device) return json(res, 401, { error: 'Not paired' });
        // After a restart the phone asks for everything, including what it had begun.
        if (url.searchParams.get('all') === '1') return json(res, 200, { items: outbox.pending(device.id, true) });
        // Otherwise it waits here, so a file put in the outbox reaches it within a moment.
        const seconds = wholeNumber(url.searchParams.get('wait') || '0', 0, 50) ?? 0;
        const gone = new AbortController();
        res.on('close', () => gone.abort());
        const ready = await outbox.wait(device.id, seconds * 1000, gone.signal);
        if (!res.destroyed && !res.writableEnded) json(res, 200, { items: ready });
        return;
      }
      const out = outbox ? /^\/outbox\/([0-9a-f]{32})(\/done|\/cancel)?$/.exec(url.pathname) : null;
      if (out) {
        if (req.method === 'POST' && out[2] !== '/done') req.resume();
        if (!device) return json(res, 401, { error: 'Not paired' });
        // Another phone's file looks exactly like one that does not exist.
        const item = outbox.find(out[1], device.id);
        if (!item || (item.state !== 'queued' && item.state !== 'sending')) {
          if (req.method === 'POST' && out[2] === '/done') req.resume();
          return json(res, item && item.state === 'cancelled' ? 410 : 404, { error: 'Not in the outbox' });
        }
        if (req.method === 'GET' && !out[2]) return sendOut(req, res, outbox, item);
        if (req.method === 'POST' && out[2] === '/done') {
          let verdict = {};
          try { verdict = JSON.parse(await readSmallBody(req)) || {}; } catch { /* treated as a failure */ }
          outbox.finish(item, verdict.ok === true, String(verdict.error || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200));
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && out[2] === '/cancel') {
          outbox.cancel(item.id);
          return json(res, 200, { ok: true });
        }
      }

      req.resume();
      json(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: 'Server error' });
    }
  };

  const server = tls
    ? https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, handler)
    : http.createServer(handler);
  server.requestTimeout = 0; // a large video may take longer than Node's default five minutes
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 8_000;
  // A connection that carries nothing either way for this long is closed, and there is a limit
  // to how many are open at once: nobody on the Wi-Fi can use them all up by opening and waiting.
  server.timeout = SOCKET_IDLE_MS;
  server.maxConnections = MAX_CONNECTIONS;
  server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* already gone */ } });
  server.on('tlsClientError', () => { /* a probe that is not TLS; nothing to do */ });

  const state = { httpError: null, udpError: null, udpBound: false };
  const ready = new Promise((resolve) => {
    server.once('error', (err) => { state.httpError = err.code || String(err); resolve(false); });
    server.listen(wantedPort, options.host || '0.0.0.0', () => resolve(true));
  });

  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (msg, rinfo) => {
    if (msg.toString('utf8').trim() !== DISCOVERY_MAGIC) return;
    const port = server.address() ? server.address().port : wantedPort;
    const reply = Buffer.from(JSON.stringify({ app: 'flingo', port, tls: !!tls, ...hooks.info() }));
    udp.send(reply, rinfo.port, rinfo.address);
  });
  udp.on('error', (err) => { state.udpError = err.code || String(err); });
  udp.on('listening', () => { state.udpBound = true; });
  if (discoveryPort !== null) udp.bind(discoveryPort);

  return {
    server,
    ready,
    /** Stops every transfer this phone has in flight and keeps nothing of them: it has been removed. */
    stopDevice(id) {
      for (const [part, owner] of [...owners]) if (owner === id) { const stop = active.get(part); if (stop) stop(true); }
      for (const part of [...expiry.keys()]) {
        if (!path.basename(part).startsWith(`.flingo-${id}-`)) continue;
        clearTimeout(expiry.get(part));
        expiry.delete(part);
        removeFile(part);
      }
    },
    tls: !!tls,
    get port() { return server.address() ? server.address().port : wantedPort; },
    status: () => ({ listening: server.listening, ...state, uploads }),
    close() { server.close(); server.closeAllConnections?.(); try { udp.close(); } catch { /* already closed */ } },
  };
}

module.exports = { startServer, sanitizeName, cleanStaleParts, HTTP_PORT, DISCOVERY_PORT, PROTOCOL_VERSION };
