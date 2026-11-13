// LAN receiver: UDP discovery + a small HTTP(S) API the phone talks to.
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HTTP_PORT = 47801;
const DISCOVERY_PORT = 47800;
const DISCOVERY_MAGIC = 'FLINGO_DISCOVER';
const PROTOCOL_VERSION = 2;
const MAX_PAIR_FAILS = 5; // wrong codes per IP per minute
const MAX_TOTAL_FAILS = 12; // wrong codes from anyone before the code is replaced
const MAX_UPLOADS = 4; // transfers in flight at once
const IDLE_TIMEOUT_MS = 30_000; // a stalled upload is dropped after this long without data
const DEFAULT_MAX_BYTES = 32 * 1024 ** 3;
const SPACE_MARGIN = 64 * 1024 ** 2;
const PROGRESS_EVERY_MS = 80;
const PART_KEEP_MS = 60 * 60 * 1000; // a half-received file waits this long for the phone to carry on
const SAFE_ID = /^[0-9a-zA-Z]{1,32}$/;
const PART_FILE = /^\.flingo-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)?\.part$/;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Zero-width and direction-override characters can disguise a file's real extension.
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

function sanitizeName(raw) {
  let name = path.basename(String(raw || '').replace(/\\/g, '/'));
  name = name.replace(INVISIBLE, '').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/, '').trim();
  name = name.replace(/^\.+/, '_'); // no hidden files
  if (!name) name = 'file';
  if (RESERVED.test(name)) name = '_' + name;
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 180 - ext.length) + ext;
  }
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

function readSmallBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
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
 *   checkToken(token): {id, name} | null,
 *   seen(device, ip): a paired phone just talked to us,
 *   saveDir(): string,
 *   maxBytes(): largest file accepted,
 *   onStart({id, name, from, total}), onProgress({id, received, total}), onEnd({id, ok}),
 *   onFile({id, path, name, size, mime, from, x})
 * }
 * options: { tls: {key, cert} | null, port, discoveryPort, host }
 */
function startServer(hooks, options = {}) {
  const tls = options.tls || null;
  const wantedPort = options.port ?? HTTP_PORT;
  const discoveryPort = options.discoveryPort ?? DISCOVERY_PORT;
  const fails = new Map(); // ip -> [timestamps]
  const claimed = new Set(); // final paths picked by transfers that are still finishing
  let totalFails = 0;
  let uploads = 0;

  function tooManyFails(ip) {
    const now = Date.now();
    for (const [k, list] of fails) {
      const recent = list.filter((t) => now - t < 60_000);
      if (recent.length) fails.set(k, recent); else fails.delete(k);
    }
    return (fails.get(ip) || []).length >= MAX_PAIR_FAILS;
  }

  function noteFail(ip) {
    fails.set(ip, [...(fails.get(ip) || []), Date.now()]);
    if (++totalFails >= MAX_TOTAL_FAILS) {
      totalFails = 0;
      if (hooks.rotateCode) hooks.rotateCode();
    }
  }

  async function receive(req, res, url, device) {
    const declared = Number(req.headers['content-length']);
    const total = Number.isFinite(declared) && declared >= 0 ? declared : null;
    const limit = hooks.maxBytes ? hooks.maxBytes() : DEFAULT_MAX_BYTES;
    if (total !== null && total > limit) return refuse(req, res, 413, 'That file is too large for this PC.');
    if (uploads >= MAX_UPLOADS) return refuse(req, res, 429, 'This PC is busy receiving. Try again in a moment.');

    const dir = hooks.saveDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return refuse(req, res, 500, 'The save folder on the PC cannot be used.'); }
    req.pause();
    const free = await freeBytes(dir);
    if (free !== null && total !== null && free < total + SPACE_MARGIN) {
      return refuse(req, res, 507, 'Not enough free space on the PC.');
    }

    let rawName = req.headers['x-filename'] || 'file';
    try { rawName = decodeURIComponent(rawName); } catch { /* keep raw */ }
    const name = sanitizeName(rawName);
    const id = crypto.randomBytes(6).toString('hex');
    const tmp = path.join(dir, `.flingo-${id}.part`);
    const out = fs.createWriteStream(tmp);
    let size = 0;
    let done = false;
    let lastTick = 0;
    uploads++;

    const finish = (ok) => {
      if (done) return false;
      done = true;
      uploads--;
      if (hooks.onEnd) hooks.onEnd({ id, ok });
      return true;
    };
    const fail = (status, error) => {
      if (!finish(false)) return;
      out.destroy();
      fs.rm(tmp, { force: true }, () => {});
      if (status && !res.headersSent) refuse(req, res, status, error);
    };

    if (hooks.onStart) hooks.onStart({ id, name, from: device.name, total });
    req.setTimeout(IDLE_TIMEOUT_MS, () => { fail(); req.destroy(); });
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { fail(413, 'That file is too large for this PC.'); return; }
      const now = Date.now();
      if (hooks.onProgress && now - lastTick >= PROGRESS_EVERY_MS) {
        lastTick = now;
        hooks.onProgress({ id, received: size, total });
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
        if (!finish(true)) return;
        const x = Math.min(1, Math.max(0, parseFloat(url.searchParams.get('x')) || 0.5));
        hooks.onFile({
          id,
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
        if (tooManyFails(ip)) return json(res, 429, { error: 'Too many attempts. Wait a minute.' });
        let body;
        try { body = JSON.parse(await readSmallBody(req)); } catch { return json(res, 400, { error: 'Bad request' }); }
        if (!body || typeof body !== 'object') return json(res, 400, { error: 'Bad request' });
        const result = hooks.pair({
          code: String(body.code || ''),
          deviceName: String(body.deviceName || 'Phone').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 60) || 'Phone',
          deviceId: String(body.deviceId || '').replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 64),
          ip,
        }) || { error: 'wrong' };
        if (result.error === 'locked') return json(res, 423, { error: 'Pairing is locked on this PC.' });
        if (!result.token) {
          noteFail(ip);
          return json(res, 403, { error: 'Wrong code' });
        }
        totalFails = 0;
        return json(res, 200, { token: result.token, ...hooks.info() });
      }

      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const device = token ? hooks.checkToken(token) : null;
      if (device && hooks.seen) hooks.seen(device, ip);

      if (req.method === 'GET' && url.pathname === '/ping') {
        return device ? json(res, 200, { ok: true, ...hooks.info() }) : json(res, 401, { error: 'Not paired' });
      }

      if (req.method === 'POST' && url.pathname === '/send') {
        if (!device) return refuse(req, res, 401, 'Not paired');
        return await receive(req, res, url, device);
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
    tls: !!tls,
    get port() { return server.address() ? server.address().port : wantedPort; },
    status: () => ({ listening: server.listening, ...state, uploads }),
    close() { server.close(); server.closeAllConnections?.(); try { udp.close(); } catch { /* already closed */ } },
  };
}

module.exports = { startServer, sanitizeName, cleanStaleParts, HTTP_PORT, DISCOVERY_PORT, PROTOCOL_VERSION };
