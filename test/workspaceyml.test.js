/**
 * Unit tests for the workspace.yml model. No vscode, no real repo:
 *
 *   node test/workspaceyml.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ws = require('../workspaceyml');

const SAMPLE = `# local mappings — not committed
profile: mark_demo
locations:
  TARGET:
    database: DEV_DB
    schema: MARK
`;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const tmpdir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coaws-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
};

// ------------------------------------------------------------------ reading

test('reads the top-level profile key', () => {
  assert.strictEqual(ws.profileOf(SAMPLE), 'mark_demo');
});

test('reports null when there is no profile key', () => {
  assert.strictEqual(ws.profileOf('locations:\n  TARGET:\n    database: D\n    schema: S\n'), null);
  assert.strictEqual(ws.profileOf(''), null);
  assert.strictEqual(ws.profileOf('profile:\n'), null, 'an empty value is "unset"');
});

test('ignores a nested or commented profile key', () => {
  assert.strictEqual(ws.profileOf('locations:\n  TARGET:\n    profile: nope\n'), null);
  assert.strictEqual(ws.profileOf('#profile: nope\nlocations: {}\n'), null);
});

test('ignores a profile: line inside a block scalar', () => {
  assert.strictEqual(ws.profileOf('note: |\n  profile: nope\nlocations: {}\n'), null);
  assert.strictEqual(ws.profileOf('note: >-\n  profile: nope\nprofile: real\n'), 'real');
});

test('strips quotes and trailing comments from the value', () => {
  assert.strictEqual(ws.profileOf('profile: "mark_demo"\n'), 'mark_demo');
  assert.strictEqual(ws.profileOf("profile: 'mark_demo'\n"), 'mark_demo');
  assert.strictEqual(ws.profileOf('profile: mark_demo # the demo tenant\n'), 'mark_demo');
});

// ------------------------------------------------------------------ writing

test('replaces an existing profile key in place, leaving everything else byte for byte', () => {
  const out = ws.setProfile(SAMPLE, 'dela-poc');
  assert.strictEqual(out, SAMPLE.replace('profile: mark_demo', 'profile: dela-poc'));
});

test('inserts a new key below the leading comment block', () => {
  const text = '# local mappings\n# not committed\nlocations:\n  TARGET:\n    database: D\n    schema: S\n';
  const out = ws.setProfile(text, 'mark_demo');
  assert.strictEqual(out, text.replace('locations:', 'profile: mark_demo\nlocations:'));
});

test('clearing removes the line and nothing else', () => {
  const out = ws.setProfile(SAMPLE, null);
  assert.strictEqual(out, SAMPLE.replace('profile: mark_demo\n', ''));
  assert.strictEqual(ws.profileOf(out), null);
});

test('clearing a file that has no profile key is a no-op', () => {
  const text = 'locations: {}\n';
  assert.strictEqual(ws.setProfile(text, null), text);
});

test('round-trips: set, read, clear, read', () => {
  const set = ws.setProfile('locations: {}\n', 'a.b-c_1');
  assert.strictEqual(ws.profileOf(set), 'a.b-c_1');
  assert.strictEqual(ws.profileOf(ws.setProfile(set, null)), null);
});

test('keeps a file that ends without a newline from growing one silently', () => {
  assert.strictEqual(ws.setProfile('locations: {}', 'x'), 'profile: x\nlocations: {}\n');
});

test('keeps CRLF line endings, so a Windows checkout is not a whole-file diff', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  assert.strictEqual(ws.profileOf(crlf), 'mark_demo', 'reading is oblivious to the line ending');
  assert.strictEqual(ws.setProfile(crlf, 'dela-poc'), crlf.replace('profile: mark_demo', 'profile: dela-poc'));
  assert.strictEqual(ws.setProfile(crlf, null), crlf.replace('profile: mark_demo\r\n', ''));
  assert.strictEqual(
    ws.setProfile('locations: {}\r\n', 'x'),
    'profile: x\r\nlocations: {}\r\n',
    'an inserted key uses the file’s own ending',
  );
});

// ---------------------------------------------------------------------- i/o

test('exists() is the "initialised for local development" check', () => {
  const bare = tmpdir({ 'data.yml': 'fileVersion: 1\n' });
  assert.strictEqual(ws.exists(bare), false, 'data.yml alone is not enough');
  fs.writeFileSync(path.join(bare, ws.FILENAME), 'locations: {}\n');
  assert.strictEqual(ws.exists(bare), true);
  assert.strictEqual(ws.exists(null), false);
  fs.rmSync(bare, { recursive: true, force: true });
});

test('writeProfile edits in place and preserves the file mode', () => {
  const dir = tmpdir();
  const file = path.join(dir, ws.FILENAME);
  fs.writeFileSync(file, SAMPLE, { mode: 0o640 });

  assert.strictEqual(ws.writeProfile(dir, 'dela-poc'), true);
  assert.strictEqual(ws.readProfile(dir), 'dela-poc');
  // Windows has no POSIX mode to preserve — chmod there only toggles read-only.
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o640, 'mode survives the rename');
  }
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.tmp.')), 'no temp file left behind');

  assert.strictEqual(ws.writeProfile(dir, 'dela-poc'), false, 'an unchanged write does not touch the file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeProfile refuses to create a missing workspace.yml', () => {
  const dir = tmpdir();
  assert.throws(() => ws.writeProfile(dir, 'x'), /coa init/);
  assert.strictEqual(fs.existsSync(path.join(dir, ws.FILENAME)), false);
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
