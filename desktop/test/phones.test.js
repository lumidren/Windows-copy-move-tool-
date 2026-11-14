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

// ---------- one phone, paired more than once ----------
const { withPaired, superseded, target, MAX_PAIRED } = require('../src/phones');
const phone = (id, name, added, more = {}) => ({ id, name, deviceId: `install-${id}`, added, ...more });

test('pairing the same install again replaces its entry', () => {
  const before = [phone('a', 'Pixel 8', 100), phone('b', 'Galaxy', 200)];
  const again = { ...phone('c', 'Pixel 8', 300), deviceId: 'install-a' };
  assert.deepEqual(withPaired(before, again).map((d) => d.id), ['b', 'c']);
});

test('the same phone with Flingo installed again replaces its entry: same name, same address', () => {
  const before = [phone('a', 'Pixel 8', 100, { ip: '10.0.0.7' }), phone('b', 'Galaxy', 200, { ip: '10.0.0.8' })];
  assert.deepEqual(withPaired(before, phone('c', 'Pixel 8', 300, { ip: '10.0.0.7' })).map((d) => d.id), ['b', 'c']);
});

test('another phone of the same model is kept: same name, another address or none known', () => {
  const before = [phone('a', 'Pixel 8', 100, { ip: '10.0.0.7' }), phone('b', 'Pixel 8', 150)];
  assert.deepEqual(withPaired(before, phone('c', 'Pixel 8', 300, { ip: '10.0.0.9' })).map((d) => d.id), ['a', 'b', 'c']);
  // A phone with no deviceId (a very old Flingo) is not taken for every other one without.
  const bare = [{ id: 'x', name: 'Old', added: 1 }];
  assert.deepEqual(withPaired(bare, { id: 'y', name: 'Other', added: 2, deviceId: '', ip: '' }).map((d) => d.id), ['x', 'y']);
});

test('the list of paired phones stays bounded, newest kept', () => {
  let list = [];
  for (let i = 0; i < MAX_PAIRED + 5; i++) list = withPaired(list, phone(`p${i}`, `Phone ${i}`, i));
  assert.equal(list.length, MAX_PAIRED);
  assert.equal(list[list.length - 1].id, `p${MAX_PAIRED + 4}`);
});

test('an entry is superseded when the same name paired later and it was not heard from since', () => {
  const old = phone('a', '21121210G', 100);
  const fresh = phone('b', '21121210G', 300);
  assert.equal(superseded([old, fresh], old), true);
  assert.equal(superseded([old, fresh], fresh), false);
  // Heard from before the new pairing: still superseded. After it: a second real phone.
  assert.equal(superseded([{ ...old, heard: 250 }, fresh], { ...old, heard: 250 }), true);
  const alive = { ...old, heard: 350 };
  assert.equal(superseded([alive, fresh], alive), false);
  assert.equal(superseded([old, phone('c', 'Another', 300)], old), false);
});

test('files meant for a superseded entry go to the pairing that took over', () => {
  const old = phone('a', '21121210G', 100);
  const fresh = phone('b', '21121210G', 300);
  const other = phone('c', 'Galaxy', 200);
  const list = [old, other, fresh];
  assert.equal(target(list, 'a').id, 'b', 'the phone that is not coming back is passed over');
  assert.equal(target(list, 'b').id, 'b');
  assert.equal(target(list, 'c').id, 'c', 'a phone with a name of its own is left alone, connected or not');
  assert.equal(target(list, 'gone'), null);
  // If the old entry is talking to this PC right now, it is a real phone and it gets its files.
  assert.equal(target(list, 'a', (d) => d.id === 'a').id, 'a');
  // Three pairings of one phone: the newest is the one.
  assert.equal(target([old, fresh, phone('d', '21121210G', 500)], 'a').id, 'd');
});

test('two real phones of one model each keep their own files', () => {
  const first = phone('a', 'Pixel 8', 100, { heard: 900 });
  const second = phone('b', 'Pixel 8', 300, { heard: 800 });
  assert.equal(target([first, second], 'a').id, 'a');
  assert.equal(target([first, second], 'b').id, 'b');
});
