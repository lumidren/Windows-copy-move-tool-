// What Flingo does with a file once it is on this PC: which ones a click may open, and how
// Windows is told that a file came from another device.
//
// No Electron in here, so it runs under `node --test`.
const fs = require('fs');
const path = require('path');

// A click in the list opens only kinds of file that are looked at, listened to or read. Anything
// else is shown in its folder, where Windows applies its own checks before running it. The list
// says what is allowed, not what is forbidden: Windows keeps adding kinds of file that run when
// opened (.url, .chm, .msix, .iso, .settingcontent-ms…), and a list of those is never complete.
const OPENS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff',
  'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', '3gp',
  'mp3', 'm4a', 'wav', 'flac', 'ogg', 'aac', 'opus',
  'pdf', 'txt', 'csv', 'log', 'md', 'json',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub',
]);

/**
 * The extension Windows will act on. Windows drops dots and spaces from the end of a name
 * before deciding what a file is, so "photo.exe." and "photo.exe " are both "photo.exe".
 */
function effectiveExt(file) {
  const name = path.basename(String(file || '')).replace(/[.\s]+$/u, '');
  return path.extname(name).slice(1).toLowerCase();
}

/** True if a click on this file in the list may open it; otherwise it is shown in its folder. */
function opensDirectly(file) {
  return OPENS.has(effectiveExt(file));
}

/**
 * Marks a file as having come from another device, the way a browser marks a download. Windows
 * then asks before running it, and Office opens it in Protected View. Only Windows and NTFS
 * have the mark; anywhere else this does nothing. Never throws.
 */
function markFromElsewhere(file, platform = process.platform) {
  if (platform !== 'win32') return false;
  try {
    fs.writeFileSync(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
    return true;
  } catch {
    return false; // a drive without alternate streams (FAT, a network share): nothing to do
  }
}

module.exports = { opensDirectly, effectiveExt, markFromElsewhere, OPENS };
