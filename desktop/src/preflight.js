// Pre-flight check: everything that has to be true before a phone flicks a photo
// at this PC in front of people. Each item is { id, title, status, detail, action }
// with status 'ok' | 'warn' | 'fail' | 'manual'.
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ONLINE_MS = 15_000;

function tcpReachable(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * Reads Windows Firewall without changing it: the rules for this program, the kind
 * of network the PC is on, and whether the firewall is on for that kind.
 * Returns { state: 'allowed' | 'blocked' | 'none' | 'off' | 'unknown', network }.
 */
function windowsFirewall(exePath) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$p='${exePath.replace(/'/g, "''")}'`,
    "$rules=@(Get-NetFirewallApplicationFilter -Program $p | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' } | ForEach-Object { @{ action=\"$($_.Action)\"; profile=\"$($_.Profile)\" } })",
    "$cats=@(Get-NetConnectionProfile | ForEach-Object { \"$($_.NetworkCategory)\" })",
    "$on=@(Get-NetFirewallProfile | ForEach-Object { @{ name=\"$($_.Name)\"; enabled=\"$($_.Enabled)\" } })",
    '@{ rules=$rules; categories=$cats; profiles=$on } | ConvertTo-Json -Compress -Depth 4',
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ state: 'unknown', network: '' });
      try { resolve(judgeFirewall(JSON.parse(stdout))); } catch { resolve({ state: 'unknown', network: '' }); }
    });
  });
}

/** Pure decision, kept separate so it can be tested without Windows. */
function judgeFirewall(raw) {
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const categories = list(raw.categories).map((c) => (c === 'DomainAuthenticated' ? 'Domain' : c));
  const network = categories.join(', ');
  if (!categories.length) return { state: 'unknown', network };
  const enabled = (name) => list(raw.profiles).some((p) => p.name === name && String(p.enabled) === 'True');
  let worst = 'off';
  for (const cat of categories) {
    if (!enabled(cat)) continue;
    const rules = list(raw.rules).filter((r) => r.profile === 'Any' || String(r.profile).split(',').map((s) => s.trim()).includes(cat));
    // Windows applies a block rule ahead of an allow rule.
    if (rules.some((r) => r.action === 'Block')) return { state: 'blocked', network };
    if (!rules.some((r) => r.action === 'Allow')) worst = 'none';
    else if (worst === 'off') worst = 'allowed';
  }
  return { state: worst, network };
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function gb(bytes) { return `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`; }

/**
 * ctx: {
 *   platform, exePath, port, addresses, secure, securityCode, saveDir, stage, pairingLocked, showOverlay,
 *   server: { listening, httpError, udpBound, udpError },
 *   devices: [{ name, lastSeen, ip }],
 *   overlay(): Promise<{ screen, display: {width,height}, window: {width,height}, renderer: {w,h,dpr}, pixels, scale } | null>,
 *   selfTest(): Promise<{ ok, ms, error, fps, worstMs }>,
 *   firewall?: injected for tests
 * }
 */
async function runPreflight(ctx) {
  const items = [];
  const add = (id, title, status, detail, action) => items.push({ id, title, status, detail, action: action || null });
  const now = Date.now();
  // Proof that the firewall is open: a paired phone was heard from another machine's address.
  const own = new Set(['::1', '127.0.0.1', ...ctx.addresses]);
  const remote = ctx.devices.filter((d) => d.lastSeen && now - d.lastSeen < ONLINE_MS && d.ip && !own.has(d.ip.replace(/^::ffff:/, '')));

  // 1. receiver
  if (ctx.server.listening) add('server', 'Receiver is running', 'ok', `Listening on port ${ctx.port}.`);
  else add('server', 'Receiver is not running', 'fail', ctx.server.httpError === 'EADDRINUSE'
    ? `Another program is using port ${ctx.port}. Close the other copy of Flingo, then restart this one.`
    : `Flingo could not open port ${ctx.port} (${ctx.server.httpError || 'unknown reason'}). Restart Flingo.`);

  // 2. network + 3. port answers on every address
  if (!ctx.addresses.length) {
    add('network', 'No network', 'fail', 'This PC is not connected to Wi-Fi or a cable. Connect it to the same network as the phone, or to the phone\'s hotspot.');
  } else {
    const results = await Promise.all(ctx.addresses.map((a) => tcpReachable(a, ctx.port)));
    const dead = ctx.addresses.filter((_, i) => !results[i]);
    if (dead.length) add('network', 'Port does not answer', 'fail', `Nothing answers on ${dead.join(', ')} port ${ctx.port}. Restart Flingo.`);
    else add('network', 'Network address ready', 'ok', `The phone can use ${ctx.addresses.join(' or ')}, port ${ctx.port}.`);
  }
