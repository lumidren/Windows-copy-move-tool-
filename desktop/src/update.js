// Finds out whether a newer Flingo has been released, and fetches it.
//
// The only thing this talks to is the public list of releases on GitHub. It sends
// nothing about this PC or its files. Nothing is installed without a click.
//
// No Electron in here, so it runs under `node --test`: the caller hands in `fetch`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'lumidren/Windows-copy-move-tool-';
const FEED = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOADS = `https://github.com/${REPO}/releases/download/`;
const RELEASES = `https://github.com/${REPO}/releases/`;
const LATEST_PAGE = `${RELEASES}latest`;
const MAX_BYTES = 600 * 1024 * 1024; // far above any real installer; stops a runaway download

/** The file an installed copy can update itself with, per platform. Linux packages need root, so there is none. */
const ASSETS = { win32: 'Flingo-Setup.exe' };

/** "v1.2.3" or "1.2.3" -> [1, 2, 3]. Anything else (a beta, a typo) -> null. */
function parseVersion(text) {
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(String(text || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when version `a` is newer than version `b`. Unreadable versions are never newer. */
function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * Reads GitHub's description of a release. Returns null when it is not a newer, finished
 * release; otherwise { version, page, asset }, where asset is null if this platform has
 * no installer or the release does not describe it well enough to trust.
 */
