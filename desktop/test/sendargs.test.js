// Tests for reading "send these files" from a command line. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { filesFromArgv, filesFromHandover, toHandover, MAX_FILES } = require('../src/sendargs');

const win = process.platform === 'win32';
const root = win ? 'C:\\Photos' : '/home/me/Photos';
const file = (name) => path.join(root, name);

test('a normal start asks for nothing', () => {
  assert.equal(filesFromArgv(['Flingo.exe']), null);
  assert.equal(filesFromArgv(['Flingo.exe', '--hidden']), null);
  assert.equal(filesFromArgv(['Flingo.exe', file('a.jpg')]), null, 'a file with no --send is not a request to send');
  assert.equal(filesFromArgv(undefined), null);
});

test('everything after --send is a file to send, in the order given', () => {
  const argv = ['Flingo.exe', '--send', file('a.jpg'), file('b with spaces.png'), file('c.mp4')];
  assert.deepEqual(filesFromArgv(argv), [file('a.jpg'), file('b with spaces.png'), file('c.mp4')]);
});

test('a copy run from source has its folder before --send, and that is not a file', () => {
  const argv = ['electron.exe', '.', '--user-data-dir=x', '--send', file('a.jpg')];
  assert.deepEqual(filesFromArgv(argv), [file('a.jpg')]);
});

test('switches that Chromium or Windows add are not files', () => {
  const argv = ['Flingo.exe', '--send', file('a.jpg'), '--allow-file-access-from-files', '/prefetch:1', file('b.jpg'), '--original-process-start-time=1'];
  assert.deepEqual(filesFromArgv(argv), [file('a.jpg'), file('b.jpg')]);
});

test('--send with nothing after it is an empty list, not "no request"', () => {
  assert.deepEqual(filesFromArgv(['Flingo.exe', '--send']), []);
});

test('a name without a folder is taken from where Flingo was started', () => {
  assert.deepEqual(filesFromArgv(['Flingo.exe', '--send', 'a.jpg', path.join('sub', 'b.jpg')], root), [file('a.jpg'), path.join(root, 'sub', 'b.jpg')]);
});

test('the same file twice is sent once', () => {
  const argv = ['Flingo.exe', '--send', file('a.jpg'), file('b.jpg'), file('a.jpg')];
  assert.deepEqual(filesFromArgv(argv), [file('a.jpg'), file('b.jpg')]);
  if (win) assert.deepEqual(filesFromArgv(['Flingo.exe', '--send', 'C:\\Photos\\A.JPG', 'c:\\photos\\a.jpg']), ['C:\\Photos\\A.JPG']);
});

test('a stray quote Windows leaves on a quoted folder is removed', () => {
  assert.deepEqual(filesFromArgv(['Flingo.exe', '--send', `${file('Trip')}"`]), [file('Trip')]);
});

test('no more files than the outbox holds for one phone', () => {
  const many = Array.from({ length: MAX_FILES + 40 }, (_, i) => file(`p${i}.jpg`));
  const got = filesFromArgv(['Flingo.exe', '--send', ...many]);
  assert.equal(got.length, MAX_FILES);
  assert.equal(got[0], file('p0.jpg'));
});

test('what a second copy hands over comes out the same at the other end', () => {
  const files = [file('a.jpg'), file('b.jpg')];
  assert.deepEqual(filesFromHandover(toHandover(files)), files);
  assert.deepEqual(filesFromHandover(toHandover([])), []);
  assert.equal(filesFromHandover(toHandover(null)), null, 'a copy that was not asked to send hands over nothing');
});

test('a request with no files is handed over without an empty list', () => {
  // Electron delivers null in place of a message that holds an empty list (seen with Electron 33).
  assert.deepEqual(toHandover([]), { send: true });
  assert.deepEqual(filesFromHandover({ send: true }), []);
});

test('a hand-over that does not ask to send is nothing', () => {
  for (const data of [undefined, null, {}, 'send', 7, { send: 'a.jpg' }, { send: null }, { send: [file('a.jpg')] }, { files: [file('a.jpg')] }]) {
    assert.equal(filesFromHandover(data), null, JSON.stringify(data));
  }
});

test('a hand-over keeps only full, plain paths', () => {
  const got = filesFromHandover({ send: true, files: [file('a.jpg'), 'relative.jpg', path.join('..', 'x.jpg'), 42, null, '', {}, `${file('bad')}\0.jpg`, file('b.jpg')] });
  assert.deepEqual(got, [file('a.jpg'), file('b.jpg')]);
  assert.deepEqual(filesFromHandover({ send: true, files: 'a.jpg' }), []);
});

test('a hand-over cannot name more files than the outbox holds', () => {
  const many = Array.from({ length: MAX_FILES * 3 }, (_, i) => file(`p${i}.jpg`));
  assert.equal(filesFromHandover({ send: true, files: many }).length, MAX_FILES);
});
