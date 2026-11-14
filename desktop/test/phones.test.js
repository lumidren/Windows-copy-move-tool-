// What the PC works out about a phone from its requests. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanApp, note, receives, GRACE_MS, QUIET_MS } = require('../src/phones');

/** A phone that checks in every five seconds, `times` times, saying `said` each time. */
function checkIns(times, said = {}, start = 1000) {
  let known;
  for (let i = 0; i < times; i++) known = note(known, { at: start + i * 5000, ip: '10.0.0.7', ...said });
  return known;
}

test('a version is kept only if it looks like one', () => {
  assert.equal(cleanApp('0.4.0'), '0.4.0');
  assert.equal(cleanApp(' 1.12.3 '), '1.12.3');
  assert.equal(cleanApp('0.4.0-test'), '0.4.0-test');
  for (const bad of [undefined, null, '', 'latest', '4', '0.4.0 <b>', '1.2.3.4.5', '99999.1', 'a'.repeat(300), ['0.4.0', '0.5.0']]) {
    assert.equal(cleanApp(bad), '', String(bad).slice(0, 20));
  }
});

test('a phone that has not been heard from is not judged', () => {
  assert.equal(receives(undefined, Date.now()), 'unknown');
});

test('a phone that has only just checked in is not judged yet', () => {
  const known = checkIns(1);
  assert.equal(receives(known, known.at), 'unknown');
  assert.equal(receives(known, known.at + GRACE_MS - 1), 'unknown');
});

test('a phone that keeps checking in and never asks for its files cannot receive', () => {
  const known = checkIns(3); // 0 s, 5 s, 10 s
  assert.equal(receives(known, known.at), 'no');
  // One check-in is enough once the moment a newer Flingo would have asked in has passed.
  const once = checkIns(1);
  assert.equal(receives(once, once.at + GRACE_MS), 'no');
});

test('asking for its files once is enough, and is remembered', () => {
  let known = checkIns(1);
  known = note(known, { at: known.at + 300, asks: true });
  assert.equal(receives(known, known.at), 'yes');
  for (let i = 1; i <= 6; i++) known = note(known, { at: known.at + 5000 });
  assert.equal(known.asks, true);
  assert.equal(receives(known, known.at), 'yes');
});

test('saying its version is enough, at the first word and long before it asks', () => {
  const known = checkIns(1, { app: '0.4.0' });
  assert.equal(receives(known, known.at), 'yes');
  const later = note(known, { at: known.at + 5000 }); // a request that does not carry the version
  assert.equal(later.app, '0.4.0');
  assert.equal(receives(later, later.at + 60000), 'yes');
});

test('a phone that went quiet is not judged on what it did before', () => {
  const known = checkIns(3);
  assert.equal(receives(known, known.at + QUIET_MS), 'unknown');
  // It comes back, perhaps updated: the wait starts again from its first word.
  const back = note(known, { at: known.at + 60000 });
  assert.equal(back.since, back.at);
  assert.equal(receives(back, back.at + 1000), 'unknown');
  assert.equal(receives(back, back.at + GRACE_MS), 'no');
});

test('the last address and time are the newest ones', () => {
  let known = note(undefined, { at: 1000, ip: '10.0.0.7' });
  known = note(known, { at: 4000, ip: '10.0.0.9' });
  assert.deepEqual(known, { at: 4000, ip: '10.0.0.9', since: 1000, app: '', asks: false });
});
