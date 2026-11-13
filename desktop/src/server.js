// LAN receiver: UDP discovery + a small HTTP API the phone talks to.
const http = require('http');
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

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function sanitizeName(raw) {
  let name = path.basename(String(raw || '').replace(/\\/g, '/'));
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!name) name = 'file';
  if (RESERVED.test(name)) name = '_' + name;
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
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
 *   info(): {id, name},
 *   pair(code, deviceName): token | null,
 *   checkToken(token): deviceName | null,
 *   saveDir(): string,
 *   onFile({path, name, size, mime, from, x})
 * }
 */
function startServer(hooks) {
  const fails = new Map(); // ip -> [timestamps]

  function tooManyFails(ip) {
    const now = Date.now();
    const list = (fails.get(ip) || []).filter((t) => now - t < 60_000);
    fails.set(ip, list);
    return list.length >= MAX_PAIR_FAILS;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const ip = req.socket.remoteAddress || '';
    try {
      if (req.method === 'GET' && url.pathname === '/info') {
        return json(res, 200, { app: 'flingo', version: 1, ...hooks.info() });
      }

      if (req.method === 'POST' && url.pathname === '/pair') {
        if (tooManyFails(ip)) return json(res, 429, { error: 'Too many attempts. Wait a minute.' });
        let body;
        try { body = JSON.parse(await readSmallBody(req)); } catch { return json(res, 400, { error: 'Bad request' }); }
        const token = hooks.pair(String(body.code || ''), String(body.deviceName || 'Phone').slice(0, 60));
        if (!token) {
          fails.get(ip).push(Date.now());
          return json(res, 403, { error: 'Wrong code' });
        }
        return json(res, 200, { token, ...hooks.info() });
      }

      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const from = token ? hooks.checkToken(token) : null;

      if (req.method === 'GET' && url.pathname === '/ping') {
        return from ? json(res, 200, { ok: true, ...hooks.info() }) : json(res, 401, { error: 'Not paired' });
      }

      if (req.method === 'POST' && url.pathname === '/send') {
        if (!from) { req.resume(); return json(res, 401, { error: 'Not paired' }); }
        let rawName = req.headers['x-filename'] || 'file';
        try { rawName = decodeURIComponent(rawName); } catch { /* keep raw */ }
        const name = sanitizeName(rawName);
        const dir = hooks.saveDir();
        fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, `.flingo-${crypto.randomBytes(6).toString('hex')}.part`);
        const out = fs.createWriteStream(tmp);
        let size = 0;
        let failed = false;
        const fail = () => {
          if (failed) return;
          failed = true;
          out.destroy();
          fs.rm(tmp, { force: true }, () => {});
        };
        req.on('data', (c) => { size += c.length; });
        req.on('aborted', fail);
        req.on('error', fail);
        out.on('error', () => { fail(); if (!res.headersSent) json(res, 500, { error: 'Could not save file' }); });
        out.on('finish', () => {
          if (failed) return;
          const finalPath = uniquePath(dir, name);
          fs.rename(tmp, finalPath, (err) => {
            if (err) { fs.rm(tmp, { force: true }, () => {}); return json(res, 500, { error: 'Could not save file' }); }
            const x = Math.min(1, Math.max(0, parseFloat(url.searchParams.get('x')) || 0.5));
            hooks.onFile({
              path: finalPath,
              name: path.basename(finalPath),
              size,
              mime: String(req.headers['content-type'] || 'application/octet-stream'),
              from,
              x,
            });
            json(res, 200, { ok: true, name: path.basename(finalPath) });
          });
        });
        req.pipe(out);
        return;
      }

      req.resume();
      json(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: 'Server error' });
    }
  });
  server.listen(HTTP_PORT, '0.0.0.0');

  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (msg, rinfo) => {
    if (msg.toString('utf8').trim() !== DISCOVERY_MAGIC) return;
    const reply = Buffer.from(JSON.stringify({ app: 'flingo', port: HTTP_PORT, ...hooks.info() }));
    udp.send(reply, rinfo.port, rinfo.address);
  });
  udp.on('error', () => {});
  udp.bind(DISCOVERY_PORT);

  return {
    server,
    close() { server.close(); try { udp.close(); } catch { /* already closed */ } },
  };
}

module.exports = { startServer, sanitizeName, HTTP_PORT, DISCOVERY_PORT };
