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

module.exports = { cleanApp, note, receives, GRACE_MS, QUIET_MS };
