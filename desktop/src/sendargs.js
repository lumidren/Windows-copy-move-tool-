// Files named on Flingo's command line, to be sent to a phone.
//
// Explorer's "Send to" menu starts Flingo as
//     Flingo.exe --send "C:\Photos\a.jpg" "C:\Photos\b.jpg"
// with every selected file in that one command. If Flingo is already running, the new copy
// hands the list to it and leaves (see main.js). Nothing is opened in here: the names go to
// the outbox, which decides what can be sent.
//
// No Electron in this file, so it runs under `node --test`.
const path = require('path');

const SEND_FLAG = '--send';
const MAX_FILES = 500; // the outbox holds this many for one phone
const MAX_PATH_CHARS = 32767; // the longest path Windows has

/** Tidies a list of paths: full, plain, each once, and no more than the outbox takes. */
function clean(list, cwd) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    // Windows turns a quoted folder ending in a backslash ("D:\") into D:" on the way in.
    const name = raw.replace(/"+$/, '');
    if (!name || name.length > MAX_PATH_CHARS || name.includes('\0')) continue;
    if (cwd === null && !path.isAbsolute(name)) continue;
    const full = cwd === null ? path.normalize(name) : path.resolve(cwd, name);
    const key = process.platform === 'win32' ? full.toLowerCase() : full;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(full);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

/**
 * The files a command line asks to send: everything after --send that is not a switch.
 * Null when it does not ask to send at all; an empty list when it asks but names nothing.
 */
function filesFromArgv(argv, cwd = process.cwd()) {
  const at = Array.isArray(argv) ? argv.indexOf(SEND_FLAG) : -1;
  if (at < 0) return null;
  // Chromium and Windows add switches of their own; a file never starts like one.
  const names = argv.slice(at + 1).filter((a) => typeof a === 'string' && !a.startsWith('--') && !/^\/prefetch:\d+$/.test(a));
  return clean(names, cwd);
}

/**
 * What a second copy of Flingo hands to the one already running. The request is a flag of
 * its own and an empty list is left out, because Electron delivers nothing at all when the
 * message holds an empty list, and "send, but nothing was named" must still arrive as a
 * request. Null in means nothing to hand over.
 */
function toHandover(files) {
  if (!files) return {};
  return files.length ? { send: true, files } : { send: true };
}

/**
 * The list as it arrives in the running copy. The other copy has already made the paths
 * full, so anything else in here did not come from Flingo and is dropped. Null when the
 * other copy was not asked to send.
 */
function filesFromHandover(data) {
  if (!data || typeof data !== 'object' || data.send !== true) return null;
  return clean(Array.isArray(data.files) ? data.files : [], null);
}

module.exports = { filesFromArgv, filesFromHandover, toHandover, SEND_FLAG, MAX_FILES };
