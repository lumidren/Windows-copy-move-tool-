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
function readRelease(release, { current, platform, downloads = DOWNLOADS, releases = RELEASES } = {}) {
  if (!release || typeof release !== 'object' || release.draft || release.prerelease) return null;
  const numbers = parseVersion(release.tag_name);
  if (!numbers) return null;
  const version = numbers.join('.');
  if (!isNewer(version, current)) return null;

  const page = typeof release.html_url === 'string' && release.html_url.startsWith(releases) ? release.html_url : LATEST_PAGE;
  const wanted = ASSETS[platform];
  const found = wanted && Array.isArray(release.assets) ? release.assets.find((a) => a && a.name === wanted) : null;
  let asset = null;
  if (found) {
    const sha256 = /^sha256:([0-9a-f]{64})$/.exec(String(found.digest || ''));
    const url = String(found.browser_download_url || '');
    const size = Number(found.size);
    // An installer is only used when it comes from this project's releases and its checksum is known.
    if (sha256 && url.startsWith(downloads) && Number.isSafeInteger(size) && size > 0 && size <= MAX_BYTES) {
      asset = { name: wanted, url, size, sha256: sha256[1] };
    }
  }
  return { version, page, asset };
}

/** Asks for the newest release. Resolves to an update (see readRelease) or null; rejects when it cannot find out. */
async function checkLatest({ fetch, current, platform, feed = FEED, downloads, releases, timeoutMs = 15000 }) {
  const res = await fetch(feed, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Flingo' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`The release list answered ${res.status}`);
  return readRelease(await res.json(), { current, platform, downloads, releases });
}

function remove(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

/** Deletes installers left in `dir` by earlier updates, except `keep`. */
function cleanDownloads(dir, keep = '') {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) if (name !== keep) remove(path.join(dir, name));
}

async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Downloads an update's installer into `dir` and checks it against the size and checksum
 * the release declared. Resolves to the file's path. A file that does not match is deleted.
 */
async function download(update, dir, { fetch, onProgress = () => {}, signal } = {}) {
  const { asset, version } = update;
  if (!asset) throw new Error('This release has no installer for this PC');
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(asset.name);
  const name = `${path.basename(asset.name, ext)}-${version}${ext}`;
  const file = path.join(dir, name);
  cleanDownloads(dir, name);

  // Already here from an earlier try: use it if it is intact.
  try {
    if (fs.statSync(file).size === asset.size && (await sha256Of(file)) === asset.sha256) return file;
  } catch { /* not there */ }
  remove(file);

  const part = `${file}.part`;
  const res = await fetch(asset.url, { headers: { 'User-Agent': 'Flingo' }, signal });
  if (!res.ok || !res.body) throw new Error(`The download answered ${res.status}`);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let received = 0;
  let diskError = null; // a full disk must not take the app down with it
  out.on('error', (err) => { diskError = err; });
  try {
    for await (const chunk of res.body) {
      if (diskError) throw diskError;
      received += chunk.length;
      if (received > asset.size) throw new Error('The download is larger than the release says');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      onProgress(received, asset.size);
    }
    await new Promise((resolve) => out.end(resolve));
    if (diskError) throw diskError;
    if (received !== asset.size) throw new Error('The download stopped early');
    if (hash.digest('hex') !== asset.sha256) throw new Error('The download does not match the release checksum');
    fs.renameSync(part, file);
    return file;
  } catch (err) {
    out.destroy();
    remove(part);
    throw err;
  }
}

module.exports = { FEED, DOWNLOADS, RELEASES, LATEST_PAGE, parseVersion, isNewer, readRelease, checkLatest, download, cleanDownloads };
