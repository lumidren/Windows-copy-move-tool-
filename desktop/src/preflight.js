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
