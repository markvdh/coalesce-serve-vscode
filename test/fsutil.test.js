/**
 * Unit tests for the cross-platform path/file helpers:
 *
 *   node test/fsutil.test.js
 *
 * The Windows-only behaviours (case-insensitive paths, the rename retry) cannot
 * be provoked from POSIX, so what is asserted here is the shape both hosts
 * share plus the host's own answer for the rest.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { WINDOWS, samePath, detectEol, writeAtomic } = require('../fsutil');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coafs-'));

// ----------------------------------------------------------------- samePath

test('samePath normalises before comparing', () => {
  assert.strictEqual(samePath('/a/b', '/a/./b'), true);
  assert.strictEqual(samePath('/a/b', '/a/c/../b'), true);
  assert.strictEqual(samePath('/a/b', '/a/c'), false);
  assert.strictEqual(samePath('', '/a'), false);
  assert.strictEqual(samePath('/a', null), false);
});

test('samePath follows the host filesystem on case', () => {
  assert.strictEqual(samePath('/a/Coa.CMD', '/a/coa.cmd'), WINDOWS);
});

// ---------------------------------------------------------------- detectEol

test('detectEol reports the line ending in use', () => {
  assert.strictEqual(detectEol('a\nb\n'), '\n');
  assert.strictEqual(detectEol('a\r\nb\r\n'), '\r\n');
  assert.strictEqual(detectEol('a\r\nb\r\nc\n'), '\r\n', 'the majority wins a mixed file');
  assert.strictEqual(detectEol('a\nb\nc\r\n'), '\n');
});

test('detectEol falls back to LF for a file with no newline yet', () => {
  assert.strictEqual(detectEol(''), '\n');
  assert.strictEqual(detectEol('locations: {}'), '\n');
  assert.strictEqual(detectEol('', '\r\n'), '\r\n', 'the caller can ask for another default');
});

// --------------------------------------------------------------- writeAtomic

test('writeAtomic replaces the file and leaves no temp behind', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, 'old\n');

  writeAtomic(file, 'new\n', 0o600);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new\n');
  assert.deepStrictEqual(fs.readdirSync(dir), ['config'], 'nothing but the target survives');
  if (!WINDOWS) assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeAtomic creates a file that is not there yet', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'fresh');
  writeAtomic(file, 'hello\n');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'hello\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeAtomic cleans up its temp file when the rename cannot happen', () => {
  const dir = tmpdir();
  // A directory in the target's place: rename over it fails on every host.
  const file = path.join(dir, 'blocked');
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, 'occupied'), 'x');

  assert.throws(() => writeAtomic(file, 'nope\n'));
  assert.deepStrictEqual(fs.readdirSync(dir), ['blocked'], 'the temp file was removed');

  fs.rmSync(dir, { recursive: true, force: true });
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
