// What this PC has learned about a paired phone from the requests the phone makes.
//
// Flingo 0.3.0 and older on a phone can only send. It still checks in every few seconds, so it
// looks connected, but it never asks this PC for files: one put aside for it would wait for
// ever, with nothing on either screen to say why. This is how the PC tells, so it can say so.
//
// No Electron and no network in here, so it runs under `node --test`.

const GRACE_MS = 8000; // a Flingo that can receive asks for its files within a moment of checking in
const QUIET_MS = 15000; // longer than this without a word and the phone has gone; the next word starts afresh

/** The version a phone says its Flingo is, or '' for anything that does not look like one. */
function cleanApp(value) {
  const v = String(value || '').trim();
  return /^\d{1,4}(\.\d{1,4}){1,3}(-[0-9A-Za-z.]{1,20})?$/.test(v) ? v : '';
}

/**
 * What is known about a phone after one more request from it, given what was known `before`.
 * `app` is the version it gave, if any; `asks` is true when it was asking for its files.
 * Both are remembered: a phone that could receive a minute ago still can.
 */
function note(before, { at, ip = '', app = '', asks = false }) {
  const still = before && at - before.at < QUIET_MS;
  return {
    at,
    ip,
    since: still ? before.since : at, // when this stretch of being connected began
    app: app || (before ? before.app : ''),
    asks: asks || !!(before && before.asks),
  };
}

/**
 * Can files be sent to this phone? 'yes' once it has said its version or asked for its files.
 * 'no' when it has been checking in for a while and done neither: an older Flingo. 'unknown'
 * until then, and for a phone that has not been heard from.
 */
function receives(known, now) {
  if (!known) return 'unknown';
  if (known.app || known.asks) return 'yes';
  if (now - known.at >= QUIET_MS) return 'unknown'; // gone quiet; it may come back as something newer
  return now - known.since >= GRACE_MS ? 'no' : 'unknown';
}

// ---------- one phone, paired more than once ----------
// Installing Flingo again on a phone gives it a new identity, so pairing it again adds a
// second entry with the same name, and the first can never be used again. Files sent to that
// first entry would wait for a phone that no longer exists.

const MAX_PAIRED = 20;

/**
 * The list of paired phones after `added` has paired. It replaces its own older entry: the same
 * install (the same deviceId), or one of the same name last heard from the same address, which
 * is the same phone with Flingo installed again.
 */
function withPaired(devices, added) {
  const same = (d) => (added.deviceId && d.deviceId === added.deviceId)
    || (d.name === added.name && !!d.ip && d.ip === added.ip);
  return [...devices.filter((d) => !same(d)), added].slice(-MAX_PAIRED);
}

/**
 * True for an entry that a later pairing of the same name has taken over from: nothing has
 * been heard from it since that pairing. Two real phones of one model are both heard from,
 * so neither is taken for the other. It is only passed over, never removed: if it does speak
 * again, it counts again.
 */
function superseded(devices, device) {
  const heard = device.heard || device.added || 0;
  return devices.some((d) => d !== device && d.name === device.name && d.added > device.added && heard < d.added);
}

/**
 * The phone that files meant for `wantedId` should go to: that one, unless it has been
 * superseded and is not here now, in which case the pairing that took over from it.
 */
function target(devices, wantedId, isOnline = () => false) {
  const wanted = devices.find((d) => d.id === wantedId);
  if (!wanted) return null;
  if (isOnline(wanted) || !superseded(devices, wanted)) return wanted;
  const heirs = devices.filter((d) => d.name === wanted.name && !superseded(devices, d));
  return heirs.sort((a, b) => b.added - a.added)[0] || wanted;
}

module.exports = { cleanApp, note, receives, withPaired, superseded, target, GRACE_MS, QUIET_MS, MAX_PAIRED };
