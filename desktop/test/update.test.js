const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { DOWNLOADS, LATEST_PAGE, parseVersion, isNewer, readRelease, checkLatest, download, cleanDownloads } = require('../src/update');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flingo-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A release the way GitHub describes one, with a Windows installer of the given bytes. */
function release(tag, body = Buffer.from('installer'), over = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/lumidren/Windows-copy-move-tool-/releases/tag/${tag}`,
    assets: [
      { name: 'flingo.apk', size: 5, digest: `sha256:${'0'.repeat(64)}`, browser_download_url: `${DOWNLOADS}${tag}/flingo.apk` },
      { name: 'Flingo-Setup.exe', size: body.length, digest: `sha256:${sha256(body)}`, browser_download_url: `${DOWNLOADS}${tag}/Flingo-Setup.exe` },
    ],
    ...over,
  };
}

/** A stand-in for GitHub on this machine: serves one release and its installer. */
async function fakeGitHub(t, tag, body, { served = body, feedStatus = 200 } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/latest') {
      const origin = `http://127.0.0.1:${server.address().port}/`;
      const r = release(tag, body);
      r.html_url = `${origin}notes`;
      r.assets[1].browser_download_url = `${origin}files/Flingo-Setup.exe`;
      res.writeHead(feedStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } else if (req.url === '/files/Flingo-Setup.exe') {
      res.writeHead(200, { 'Content-Length': served.length });
      res.end(served);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}/`;
  return { feed: `${origin}latest`, downloads: `${origin}files/`, releases: origin };
}

test('versions are read strictly', () => {
  assert.deepEqual(parseVersion('v0.3.0'), [0, 3, 0]);
  assert.deepEqual(parseVersion('1.20.3'), [1, 20, 3]);
  for (const bad of ['', 'v1', '1.2', '1.2.3-beta', 'latest', '1.2.3.4', null, undefined]) assert.equal(parseVersion(bad), null);
});

test('newer means newer, number by number', () => {
  assert.equal(isNewer('0.4.0', '0.3.0'), true);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.3.0', '0.3.0'), false);
  assert.equal(isNewer('0.2.9', '0.3.0'), false);
  assert.equal(isNewer('nonsense', '0.3.0'), false);
  assert.equal(isNewer('0.4.0', 'nonsense'), false);
});

test('a newer release is offered with its installer', () => {
  const body = Buffer.from('a real installer');
  const u = readRelease(release('v0.4.0', body), { current: '0.3.0', platform: 'win32' });
  assert.equal(u.version, '0.4.0');
  assert.equal(u.page, 'https://github.com/lumidren/Windows-copy-move-tool-/releases/tag/v0.4.0');
  assert.deepEqual(u.asset, { name: 'Flingo-Setup.exe', url: `${DOWNLOADS}v0.4.0/Flingo-Setup.exe`, size: body.length, sha256: sha256(body) });
});

test('the same, an older, an unfinished or an unreadable release is not offered', () => {
  const at = { current: '0.4.0', platform: 'win32' };
  assert.equal(readRelease(release('v0.4.0'), at), null);
  assert.equal(readRelease(release('v0.3.0'), at), null);
  assert.equal(readRelease(release('v0.5.0', undefined, { draft: true }), at), null);
  assert.equal(readRelease(release('v0.5.0', undefined, { prerelease: true }), at), null);
  assert.equal(readRelease(release('v0.5.0-beta'), at), null);
  assert.equal(readRelease(null, at), null);
  assert.equal(readRelease('<html>', at), null);
});

test('Linux hears about the release but gets no installer to run', () => {
  const u = readRelease(release('v0.4.0'), { current: '0.3.0', platform: 'linux' });
  assert.equal(u.version, '0.4.0');
  assert.equal(u.asset, null);
});

test('an installer from somewhere else, or without a checksum, is not used', () => {
  const at = { current: '0.3.0', platform: 'win32' };
  const elsewhere = release('v0.4.0');
  elsewhere.assets[1].browser_download_url = 'https://example.com/Flingo-Setup.exe';
  assert.equal(readRelease(elsewhere, at).asset, null);

  const lookalike = release('v0.4.0');
  lookalike.assets[1].browser_download_url = 'https://github.com/someone-else/Windows-copy-move-tool-/releases/download/v0.4.0/Flingo-Setup.exe';
  assert.equal(readRelease(lookalike, at).asset, null);

  const unsummed = release('v0.4.0');
  delete unsummed.assets[1].digest;
  assert.equal(readRelease(unsummed, at).asset, null);

  const empty = release('v0.4.0');
  empty.assets[1].size = 0;
  assert.equal(readRelease(empty, at).asset, null);

  const odd = release('v0.4.0', undefined, { html_url: 'https://example.com/notes' });
  assert.equal(readRelease(odd, at).page, LATEST_PAGE);
});

test('checks a release list over the network', async (t) => {
  const body = crypto.randomBytes(2000);
  const hub = await fakeGitHub(t, 'v9.9.9', body);
  const u = await checkLatest({ fetch, current: '0.3.0', platform: 'win32', ...hub });
  assert.equal(u.version, '9.9.9');
  assert.equal(u.asset.size, body.length);
  assert.equal(await checkLatest({ fetch, current: '9.9.9', platform: 'win32', ...hub }), null);
});

test('a release list that fails is an error, not "no update"', async (t) => {
  const hub = await fakeGitHub(t, 'v9.9.9', Buffer.from('x'), { feedStatus: 403 });
  await assert.rejects(checkLatest({ fetch, current: '0.3.0', platform: 'win32', ...hub }), /403/);
});

test('downloads the installer and checks it', async (t) => {
  const body = crypto.randomBytes(300 * 1024);
  const hub = await fakeGitHub(t, 'v9.9.9', body);
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'Flingo-Setup-0.0.1.exe'), 'an older download');
  const u = await checkLatest({ fetch, current: '0.3.0', platform: 'win32', ...hub });
  const seen = [];
  const file = await download(u, dir, { fetch, onProgress: (got, of) => seen.push([got, of]) });
  assert.equal(path.basename(file), 'Flingo-Setup-9.9.9.exe');
  assert.deepEqual(fs.readFileSync(file), body);
  assert.deepEqual(seen.at(-1), [body.length, body.length]);
  assert.deepEqual(fs.readdirSync(dir), ['Flingo-Setup-9.9.9.exe'], 'the older download is cleared away');

  // Asking again does not fetch it twice.
  const again = await download(u, dir, { fetch: () => { throw new Error('should not fetch'); } });
  assert.equal(again, file);
});

test('an installer that was tampered with is thrown away', async (t) => {
  const body = crypto.randomBytes(4000);
  const swapped = Buffer.from(body);
  swapped[100] ^= 0xff;
  const hub = await fakeGitHub(t, 'v9.9.9', body, { served: swapped });
  const dir = tmp(t);
  const u = await checkLatest({ fetch, current: '0.3.0', platform: 'win32', ...hub });
  await assert.rejects(download(u, dir, { fetch }), /checksum/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('an installer of the wrong length is thrown away', async (t) => {
  const body = crypto.randomBytes(4000);
  const dir = tmp(t);
  const longer = await fakeGitHub(t, 'v9.9.9', body, { served: Buffer.concat([body, Buffer.from('extra')]) });
  await assert.rejects(download(await checkLatest({ fetch, current: '0.3.0', platform: 'win32', ...longer }), dir, { fetch }), /larger/);
  const shorter = await fakeGitHub(t, 'v9.9.9', body, { served: body.subarray(0, 1000) });
  await assert.rejects(download(await checkLatest({ fetch, current: '0.3.0', platform: 'win32', ...shorter }), dir, { fetch }), /early/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a release without an installer for this PC cannot be downloaded', async (t) => {
  const u = readRelease(release('v0.4.0'), { current: '0.3.0', platform: 'linux' });
  await assert.rejects(download(u, tmp(t), { fetch }), /no installer/);
});

test('old downloads are cleared', (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'a.exe'), '1');
  fs.writeFileSync(path.join(dir, 'b.exe.part'), '2');
  cleanDownloads(dir, 'a.exe');
  assert.deepEqual(fs.readdirSync(dir), ['a.exe']);
  cleanDownloads(dir);
  assert.deepEqual(fs.readdirSync(dir), []);
  cleanDownloads(path.join(dir, 'missing')); // no folder is fine
});
