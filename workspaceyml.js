/**
 * Read/write model for a repo's `workspace.yml`.
 *
 * Only the top-level `profile:` key is ever touched, and the file is edited
 * line by line: workspace.yml is hand-authored (comments, location mappings),
 * so a round-trip through a generic YAML dumper would reformat work that is
 * not ours. No `vscode` import — see test/workspaceyml.test.js.
 *
 * `coa serve`/`coa doctor` resolve the profile from this key ("profile: X
 * (workspace.yml)"), so writing it here is all it takes to switch profile.
 */
const fs = require('fs');
const path = require('path');

const { detectEol, writeAtomic } = require('./fsutil');

const FILENAME = 'workspace.yml';

const PROFILE_RE = /^profile\s*:(.*)$/;
/** A key whose value opens a block scalar: `key: |`, `key: >-`, `key: |2` … */
const BLOCK_SCALAR_RE = /:\s*[|>][+-]?\d*\s*$/;

function workspacePath(dir) {
  return path.join(dir, FILENAME);
}

/** True when the folder is a Coalesce workspace initialised for local development. */
function exists(dir) {
  return !!dir && fs.existsSync(workspacePath(dir));
}

function readText(dir) {
  try {
    return fs.readFileSync(workspacePath(dir), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Index of the top-level `profile:` line, or -1.
 * Indented lines are skipped so `locations: { profile: … }` cannot match, and
 * block scalars are skipped so a `profile:` inside a multi-line string cannot.
 */
function profileLineIndex(lines) {
  let inBlockScalar = false;
  for (let i = 0; i < lines.length; i++) {
    const indent = lines[i].search(/\S/);
    if (indent === -1) continue; // blank
    if (inBlockScalar && indent > 0) continue;
    inBlockScalar = false;
    if (indent > 0) continue; // nested key
    if (lines[i].startsWith('#')) continue;
    if (PROFILE_RE.test(lines[i])) return i;
    if (BLOCK_SCALAR_RE.test(lines[i])) inBlockScalar = true;
  }
  return -1;
}

function unquote(raw) {
  const value = raw.trim();
  const quoted = value.match(/^"(.*)"$|^'(.*)'$/);
  if (quoted) return quoted[1] !== undefined ? quoted[1] : quoted[2];
  return value.replace(/\s+#.*$/, '').trim();
}

/** @returns {string|null} the profile named in the text, or null when unset. */
function profileOf(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const index = profileLineIndex(lines);
  if (index === -1) return null;
  return unquote(lines[index].match(PROFILE_RE)[1]) || null;
}

/**
 * Set (or, with a falsy name, clear) the top-level `profile:` key.
 * A new key is inserted below any leading comment block, so a file header
 * stays a header, and the file's own line ending is kept so a CRLF checkout
 * does not come back as a whole-file diff.
 */
function setProfile(text, name) {
  const eol = detectEol(text);
  const trailingNewline = text === '' || text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (trailingNewline && lines[lines.length - 1] === '') lines.pop();

  const index = profileLineIndex(lines);
  if (!name) {
    if (index !== -1) lines.splice(index, 1);
  } else if (index !== -1) {
    lines[index] = `profile: ${name}`;
  } else {
    let at = 0;
    while (at < lines.length && (lines[at].startsWith('#') || lines[at].trim() === '')) at++;
    lines.splice(at, 0, `profile: ${name}`);
  }

  const out = lines.join(eol);
  return out === '' ? '' : `${out}${eol}`;
}

/** @returns {string|null} */
function readProfile(dir) {
  return profileOf(readText(dir));
}

/**
 * Write the profile into an existing workspace.yml.
 * Atomic within the directory, and the file's mode is preserved.
 * @throws when the folder has no workspace.yml — `coa init` creates that.
 */
function writeProfile(dir, name) {
  const file = workspacePath(dir);
  const text = readText(dir);
  if (text === null) throw new Error(`${file} does not exist — run \`coa init\` first.`);

  const updated = setProfile(text, name);
  if (updated === text) return false;

  const mode = fs.statSync(file).mode & 0o777;
  writeAtomic(file, updated, mode);
  return true;
}

module.exports = { FILENAME, workspacePath, exists, readText, profileOf, setProfile, readProfile, writeProfile };
