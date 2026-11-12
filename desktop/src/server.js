// LAN receiver: UDP discovery + a small HTTP API the phone talks to.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HTTP_PORT = 47801;

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
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/info') {
        return json(res, 200, { app: 'flingo', version: 1, ...hooks.info() });
      }

      req.resume();
      json(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: 'Server error' });
    }
  });
  server.listen(HTTP_PORT, '0.0.0.0');

  return {
    server,
  };
}

