// Which received files a click may open, and the mark Windows reads. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { opensDirectly, effectiveExt, markFromElsewhere } = require('../src/files');

test('photos, videos, music and documents to read open with a click', () => {
  for (const name of ['IMG_2041.jpg', 'holiday.HEIC', 'clip.mp4', 'song.m4a', 'Boarding pass.pdf', 'notes.txt', 'report.docx', 'C:\\Users\\me\\Pictures\\Flingo\\a.png']) {
    assert.equal(opensDirectly(name), true, name);
  }
});

test('anything that could run, install or script is shown in its folder instead', () => {
  const runs = [
    'setup.exe', 'tool.msi', 'run.bat', 'run.cmd', 'x.com', 'saver.scr', 'link.lnk', 'script.ps1', 'a.vbs', 'a.js', 'app.hta', 'tool.jar', 'keys.reg',
    // Kinds a list of "dangerous extensions" tends to miss.
    'site.url', 'help.chm', 'app.msix', 'app.appinstaller', 'click.application', 'tool.py', 'addin.xll', 'macro.docm', 'macro.xlsm',
    'disc.iso', 'disk.vhd', 'fix.diagcab', 'x.settingcontent-ms', 'a.wsc', 'a.sct', 'mod.psm1', 'patch.msp', 'driver.inf', 'lib.library-ms',
    'page.html', 'picture.svg', 'archive.zip', 'app.apk', 'noextension', '',
  ];
  for (const name of runs) assert.equal(opensDirectly(name), false, name);
});

test('a dot or a space at the end does not hide what a file is', () => {
  // Windows drops these from the end of a name, so each of these runs as photo.exe.
  for (const name of ['photo.exe.', 'photo.exe ', 'photo.exe. .', 'photo.exe\u00a0', 'photo.jpg.exe', 'photo.exe.\u3000']) {
    assert.equal(effectiveExt(name), 'exe', JSON.stringify(name));
    assert.equal(opensDirectly(name), false, JSON.stringify(name));
  }
  assert.equal(effectiveExt('photo.jpg.'), 'jpg');
  assert.equal(opensDirectly('photo.exe.jpg'), true); // really a picture: the last extension is what counts
});

test('a received file is marked as coming from another device, on Windows only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flingo-mark-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'hello');
  try {
    assert.equal(markFromElsewhere(file, 'linux'), false);
    assert.equal(markFromElsewhere(path.join(dir, 'missing', 'b.txt'), 'win32'), false, 'a file that cannot be marked is not an error');
    if (process.platform === 'win32') {
      assert.equal(markFromElsewhere(file), true);
      assert.match(fs.readFileSync(`${file}:Zone.Identifier`, 'utf8'), /^\[ZoneTransfer\]\r\nZoneId=3\r\n$/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'hello', 'the file itself is untouched');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
