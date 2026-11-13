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

  // 4. discovery
  if (ctx.server.udpBound) add('discovery', 'Automatic discovery is on', 'ok', 'Phones on the same network can find this PC by name. If the venue network blocks that, the QR code still works.');
  else add('discovery', 'Automatic discovery is off', 'warn', 'Port 47800 could not be opened, so phones cannot find this PC by name. Pair with the QR code instead.');

  // 5. firewall
  if (remote.length) {
    add('firewall', 'Firewall lets Flingo through', 'ok', `${remote[0].name} reached this PC over the network ${ago(now - remote[0].lastSeen)}, so nothing is blocking it.`);
  } else if (ctx.platform === 'win32') {
    const fw = ctx.firewall || await windowsFirewall(ctx.exePath);
    const where = fw.network ? ` (this is a ${fw.network} network)` : '';
    if (fw.state === 'blocked') add('firewall', 'Windows Firewall is blocking Flingo', 'fail', `Open "Allow an app through Windows Firewall", find Flingo, and tick both Private and Public${where}.`, 'firewall');
    else if (fw.state === 'none') add('firewall', 'Windows Firewall has no rule for Flingo', 'warn', `Windows may still be waiting for you to press "Allow". If no prompt is on screen, allow Flingo by hand for Private and Public networks${where}. This turns green once a phone gets through.`, 'firewall');
    else if (fw.state === 'allowed') add('firewall', 'Windows Firewall allows Flingo', 'ok', `Allowed on this network${where}. Open Flingo on the phone to prove it end to end.`);
    else if (fw.state === 'off') add('firewall', 'Windows Firewall is off here', 'ok', `Nothing from Windows is blocking Flingo${where}. If another security program runs on this PC, open Flingo on the phone to prove it gets through.`);
    else add('firewall', 'Firewall could not be read', 'warn', 'Open Flingo on the phone. If it shows this PC as connected, the firewall is fine.');
  } else {
    add('firewall', 'Firewall not checked on this system', 'manual', `If a firewall is on, allow UDP 47800 and TCP ${ctx.port}. Open Flingo on the phone to prove it gets through.`);
  }
