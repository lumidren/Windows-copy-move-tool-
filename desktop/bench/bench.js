// Measures how fast the PC takes files from a phone, and hands them to one.
//
//   node bench/bench.js                     one 1 GB file, then 500 photos of 3 MB, both ways
//   node bench/bench.js --big=200 --count=100 --size=3 --parallel=4 --keepalive
//   node bench/bench.js --no-down           phone to PC only
//
// It starts the real receiver (src/server.js, with TLS) in a second process, so the phone
// and the PC do not share one event loop, and plays the phone from this one. Both run on
// this computer: the numbers show what the software costs, not what a Wi-Fi link allows.
// The files the PC received are then put in its outbox and collected again, which is the
// PC to phone direction. Everything is written to a temporary folder and deleted afterwards.
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
  const { createOutbox } = require('../src/outbox');
  const dir = process.argv[process.argv.indexOf('--serve') + 1];
  const tls = loadOrCreateIdentity(path.join(dir, 'identity.json'), 'Bench');
  const saved = path.join(dir, 'saved');
  fs.mkdirSync(saved, { recursive: true });
  const outbox = createOutbox();
  const s = startServer({
    info: () => ({ id: 'bench', name: 'Bench PC' }),
    pair: () => ({ error: 'locked' }),
    checkToken: (t) => (t === TOKEN ? { id: 'phone', name: 'Bench phone' } : null),
    saveDir: () => saved,
    onFile: () => {},
    outbox,
  }, { port: 0, discoveryPort: null, host: '127.0.0.1', tls });
  s.ready.then(() => process.stdout.write(`${JSON.stringify({ port: s.port })}\n`));
  // A line naming a prefix puts every received file that starts with it in the outbox.
  require('readline').createInterface({ input: process.stdin }).on('line', async (prefix) => {
    const names = fs.readdirSync(saved).filter((f) => f.startsWith(prefix));
    for (const name of names) await outbox.add('phone', 'Bench phone', path.join(saved, name), { hold: true });
    outbox.release('phone');
    process.stdout.write(`${JSON.stringify({ queued: names.length })}\n`);
  });
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

// ---------- the phone, collecting ----------
function ask(port, agent, method, where, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port, method, path: where, agent, rejectUnauthorized: false,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(agent ? {} : { Connection: 'close' }),
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`${where}: status ${res.statusCode}`))));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Fetches one outbox file to disk, as the phone does, then tells the PC it arrived. */
function fetchFile(port, agent, item, dir) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port, method: 'GET', path: `/outbox/${item.id}`, agent, rejectUnauthorized: false,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(agent ? {} : { Connection: 'close' }) },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${item.name}: status ${res.statusCode}`)); return; }
      const out = fs.createWriteStream(path.join(dir, item.name), { highWaterMark: MB });
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => {
        if (out.bytesWritten !== item.size) { reject(new Error(`${item.name}: came short`)); return; }
        ask(port, agent, 'POST', `/outbox/${item.id}/done`, JSON.stringify({ ok: true })).then(resolve, reject);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Collects everything in the outbox, at most `parallel` files at a time. Returns seconds taken. */
async function collect(port, dir, { parallel, keepalive }) {
  const agent = keepalive ? new https.Agent({ keepAlive: true, maxSockets: parallel }) : false;
  const started = process.hrtime.bigint();
  const { items } = await ask(port, agent, 'GET', '/outbox?all=1');
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fetchFile(port, agent, items[next++], dir);
  };
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, worker));
  if (agent) agent.destroy();
  return Number(process.hrtime.bigint() - started) / 1e9;
}

async function main() {
  const big = option('big', 1024);
  const count = option('count', 500);
  const size = option('size', 3);
  const parallel = option('parallel', 1);
  const keepalive = !!option('keepalive', false);

  const down = !process.argv.includes('--no-down');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flingo-bench-'));
  const got = path.join(dir, 'got');
  fs.mkdirSync(got);
  const server = spawn(process.execPath, [__filename, '--serve', dir], { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const lines = require('readline').createInterface({ input: server.stdout });
    const said = () => new Promise((resolve, reject) => {
      server.once('exit', () => reject(new Error('the receiver stopped')));
      lines.once('line', (l) => resolve(JSON.parse(l)));
    });
    const { port } = await said();
    const how = `${parallel} at a time, ${keepalive ? 'connections reused' : 'a new connection per file'}`;
    console.log(`Flingo benchmark (${how}; Node ${process.version}, ${os.cpus()[0].model.trim()})`);

    const results = [];
    const run = async (label, what, mb, n, opts) => {
      const up = await sendMany(port, { count: n, bytes: (mb / n) * MB, label, ...opts });
      results.push(['phone to PC', what, mb, up]);
      if (!down) return;
      server.stdin.write(`${label}-\n`);
      await said(); // read and checksummed, as the PC does before it offers a file
      results.push(['PC to phone', what, mb, await collect(port, got, opts)]);
    };
    if (big > 0) await run('big', `one ${big} MB file`, big, 1, { parallel: 1, keepalive });
    if (count > 0) await run('photo', `${count} files of ${size} MB`, count * size, count, { parallel, keepalive });
    for (const [way, what, mb, s] of results) {
      console.log(`  ${way.padEnd(12)} ${what.padEnd(22)} ${s.toFixed(1).padStart(7)} s   ${(mb / s).toFixed(0).padStart(5)} MB/s`);
    }
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
