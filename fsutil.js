/**
 * Cross-platform path and file helpers shared by the ~/.coa/config and
 * workspace.yml models. No `vscode` import — see test/fsutil.test.js.
 *
 * Windows differs from POSIX in three ways both models care about: paths
 * compare case-insensitively, `rename` over an existing file fails while
 * another process still has the target open, and text files are often CRLF.
 */
const fs = require('fs');
const path = require('path');

const WINDOWS = process.platform === 'win32';

/** A search indexer or virus scanner holding the target for a moment. */
const RENAME_RETRY_DELAYS_MS = [0, 20, 50, 100, 250];
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Compare two paths the way the host filesystem does. */
function samePath(a, b) {
  if (!a || !b) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return WINDOWS ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * The line ending a text file already uses, so rewriting one line does not
 * turn every other line into a diff. Falls back to LF for a file with no
 * newline in it yet — `coa` reads both, and LF keeps new files stable across
 * the colleagues sharing the repo.
 */
function detectEol(text, fallback = '\n') {
  if (!text) return fallback;
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  if (crlf === 0 && lf === 0) return fallback;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * chmod is advisory on Windows — it only toggles the read-only bit, and on some
 * filesystems it fails outright — so a POSIX mode is a best effort there.
 */
function chmodQuietly(file, mode) {
  try {
    fs.chmodSync(file, mode);
  } catch (err) {
    if (!WINDOWS) throw err;
  }
}

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameSyncWithRetry(from, to) {
  let last;
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    sleepSync(delay);
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      // POSIX rename cannot fail because the target is open, so never spin there.
      if (!WINDOWS || !RENAME_RETRY_CODES.has(err.code)) throw err;
      last = err;
    }
  }
  throw last;
}

/**
 * Write through a temp file in the same directory, so the target is never seen
 * half-written and its mode is never widened on the way.
 */
function writeAtomic(file, text, mode) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodQuietly(tmp, mode);
  try {
    renameSyncWithRetry(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

module.exports = { WINDOWS, samePath, detectEol, chmodQuietly, renameSyncWithRetry, writeAtomic };
