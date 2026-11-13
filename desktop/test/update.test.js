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
