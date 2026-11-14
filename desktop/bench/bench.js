// Measures how fast the PC takes files, the way a phone sends them.
//
//   node bench/bench.js                     one 1 GB file, then 500 photos of 3 MB
//   node bench/bench.js --big=200 --count=100 --size=3 --parallel=4 --keepalive
//
// It starts the real receiver (src/server.js, with TLS) in a second process, so the sender
// and the receiver do not share one event loop, and plays the phone from this one. Both run
// on this computer: the numbers show what the software costs, not what a Wi-Fi link allows.
// Everything is written to a temporary folder and deleted afterwards.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TOKEN = 'bench-token';
const MB = 1024 * 1024;

// ---------- the receiver, in its own process ----------
if (process.argv.includes('--serve')) {
  const { startServer } = require('../src/server');
  const { loadOrCreateIdentity } = require('../src/cert');
  const dir = process.argv[process.argv.indexOf('--serve') + 1];
  const tls = loadOrCreateIdentity(path.join(dir, 'identity.json'), 'Bench');
  const saved = path.join(dir, 'saved');
  fs.mkdirSync(saved, { recursive: true });
  const s = startServer({
    info: () => ({ id: 'bench', name: 'Bench PC' }),
    pair: () => ({ error: 'locked' }),
    checkToken: (t) => (t === TOKEN ? { id: 'phone', name: 'Bench phone' } : null),
    saveDir: () => saved,
    onFile: () => {},
  }, { port: 0, discoveryPort: null, host: '127.0.0.1', tls });
  s.ready.then(() => process.stdout.write(`${JSON.stringify({ port: s.port })}\n`));
  return;
}

// ---------- the phone ----------
function option(name, fallback) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? Number(hit.split('=')[1]) : true;
}

const chunk = crypto.randomBytes(MB);

/** Sends one file of `bytes` random bytes. Resolves when the PC has answered. */
function sendFile(port, agent, name, bytes, query = '') {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port, method: 'POST', path: `/send?quiet=1${query}`, agent, rejectUnauthorized: false,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Filename': name,
        'Content-Type': 'application/octet-stream',
        'Content-Length': bytes,
        ...(agent ? {} : { Connection: 'close' }),
      },
    }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(`${name}: status ${res.statusCode}`))));
    });
    req.on('error', reject);
    let left = bytes;
    (function pump() {
      while (left > 0) {
        const piece = left >= chunk.length ? chunk : chunk.subarray(0, left);
        left -= piece.length;
        if (!req.write(piece)) { req.once('drain', pump); return; }
      }
      req.end();
    }());
  });
}

/** Sends `count` files of `bytes` each, at most `parallel` at a time. Returns seconds taken. */
async function sendMany(port, { count, bytes, parallel, keepalive, label }) {
  const agent = keepalive ? new https.Agent({ keepAlive: true, maxSockets: parallel }) : false;
  const batch = crypto.randomBytes(6).toString('hex');
  let next = 0;
  const started = process.hrtime.bigint();
  const worker = async () => {
    while (next < count) {
      const i = ++next;
      const query = count > 1 ? `&batch=${batch}&i=${i}&n=${count}&bytes=${count * bytes}` : '';
      await sendFile(port, agent, `${label}-${i}.bin`, bytes, query);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, count) }, worker));
  if (agent) agent.destroy();
  return Number(process.hrtime.bigint() - started) / 1e9;
}

async function main() {
  const big = option('big', 1024);
  const count = option('count', 500);
  const size = option('size', 3);
  const parallel = option('parallel', 1);
  const keepalive = !!option('keepalive', false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flingo-bench-'));
  const server = spawn(process.execPath, [__filename, '--serve', dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const port = await new Promise((resolve, reject) => {
      server.once('exit', () => reject(new Error('the receiver did not start')));
      server.stdout.once('data', (d) => resolve(JSON.parse(String(d)).port));
    });
    const how = `${parallel} at a time, ${keepalive ? 'connections reused' : 'a new connection per file'}`;
    console.log(`Flingo receive benchmark (${how}; Node ${process.version}, ${os.cpus()[0].model.trim()})`);

    const results = [];
    if (big > 0) {
      const s = await sendMany(port, { count: 1, bytes: big * MB, parallel: 1, keepalive, label: 'big' });
      results.push([`one ${big} MB file`, big, s]);
    }
    if (count > 0) {
      const s = await sendMany(port, { count, bytes: size * MB, parallel, keepalive, label: 'photo' });
      results.push([`${count} files of ${size} MB`, count * size, s]);
    }
    for (const [what, mb, s] of results) {
      console.log(`  ${what.padEnd(24)} ${s.toFixed(1).padStart(7)} s   ${(mb / s).toFixed(0).padStart(5)} MB/s`);
    }
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
