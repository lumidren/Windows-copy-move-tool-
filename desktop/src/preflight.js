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
