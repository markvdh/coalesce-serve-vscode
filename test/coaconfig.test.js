/**
 * Unit tests for the ~/.coa/config model. No vscode, no real config file:
 *
 *   node test/coaconfig.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('../coaconfig');
const { platformKindOf, authTypeOf, fieldsFor } = require('../platforms');

const SAMPLE = `# my coa config
[default]
snowflakeAccount=acct
snowflakeAuthType=Basic
snowflakePassword=pw
domain=https://demo.example.com
environmentID=65

[mark_demo]
snowflakeAccount=acct
snowflakeAuthType=Basic
snowflakePassword=pw
domain=https://demo.example.com
environmentID=65

[dela-poc]
platformKind=Databricks
databricksAuthType=Token
databricksHost=https://dbc.example.com
databricksPath=/sql/1.0/warehouses/abc
databricksToken=dbtok
domain=https://sandbox.example.com
environmentID=12
`;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------------ parsing

test('round-trips an unmodified file byte for byte', () => {
  assert.strictEqual(cfg.serialize(cfg.parse(SAMPLE)), SAMPLE);
});

test('keeps comments and unknown lines outside the sections it rewrites', () => {
  const sections = cfg.parse(SAMPLE);
  cfg.upsertSection(sections, 'dela-poc', { platformKind: 'Databricks', databricksHost: 'https://new.example.com' });
  const out = cfg.serialize(sections);
  assert.ok(out.startsWith('# my coa config\n'), 'preamble comment survives');
  assert.ok(out.includes('[mark_demo]\nsnowflakeAccount=acct'), 'untouched section survives verbatim');
  assert.ok(out.includes('databricksHost=https://new.example.com'));
  assert.ok(!out.includes('databricksToken=dbtok'), 'keys absent from the new entries are gone');
});

test('reads values containing = and : intact', () => {
  const sections = cfg.parse('[p]\nsnowflakeKeyPairKey=-----BEGIN KEY-----abc=def==\ndomain=https://x.example.com:8443\n');
  const entries = cfg.entriesOf(cfg.findSection(sections, 'p'));
  assert.strictEqual(entries.snowflakeKeyPairKey, '-----BEGIN KEY-----abc=def==');
  assert.strictEqual(entries.domain, 'https://x.example.com:8443');
});

// --------------------------------------------------------------- activation

test('detects which profile [default] is a copy of', () => {
  assert.strictEqual(cfg.activeProfile(cfg.parse(SAMPLE)), 'mark_demo');
  assert.strictEqual(cfg.defaultIsOrphan(cfg.parse(SAMPLE)), false);
});

test('flags a bespoke [default] as an orphan', () => {
  const sections = cfg.parse(SAMPLE.replace('[default]\nsnowflakeAccount=acct', '[default]\nsnowflakeAccount=other'));
  assert.strictEqual(cfg.activeProfile(sections), null);
  assert.strictEqual(cfg.defaultIsOrphan(sections), true);
});

test('activating copies the profile into [default] verbatim', () => {
  const sections = cfg.parse(SAMPLE);
  cfg.setActive(sections, 'dela-poc');
  const def = cfg.entriesOf(cfg.findSection(sections, 'default'));
  assert.deepStrictEqual(def, cfg.entriesOf(cfg.findSection(sections, 'dela-poc')));
  assert.strictEqual(cfg.activeProfile(sections), 'dela-poc');
  assert.ok(!('snowflakeAccount' in def), 'no Snowflake key survives from the old default');
  assert.strictEqual(def.environmentID, '12', 'no environmentID leak from the old default');
});

test('a profile can be preserved before it is overwritten', () => {
  const sections = cfg.parse(SAMPLE.replace('snowflakeAccount=acct\nsnowflakeAuthType=Basic\nsnowflakePassword=pw\ndomain=https://demo.example.com\nenvironmentID=65\n\n[mark_demo]', 'snowflakeAccount=bespoke\n\n[mark_demo]'));
  assert.strictEqual(cfg.defaultIsOrphan(sections), true);
  cfg.preserveDefaultAs(sections, 'saved-default');
  assert.strictEqual(cfg.entriesOf(cfg.findSection(sections, 'saved-default')).snowflakeAccount, 'bespoke');
  cfg.setActive(sections, 'dela-poc');
  assert.strictEqual(cfg.activeProfile(sections), 'dela-poc');
  assert.strictEqual(cfg.entriesOf(cfg.findSection(sections, 'saved-default')).snowflakeAccount, 'bespoke');
});

test('listProfiles reports platform and active flag, and excludes default', () => {
  const list = cfg.listProfiles(cfg.parse(SAMPLE));
  assert.deepStrictEqual(list.map((p) => p.name), ['mark_demo', 'dela-poc']);
  assert.deepStrictEqual(list.map((p) => p.platformKind), ['Snowflake', 'Databricks']);
  assert.deepStrictEqual(list.map((p) => p.active), [true, false]);
});

// --------------------------------------------------------------- form merge

test('switching platform drops the previous platform keys but keeps cloud keys', () => {
  const existing = cfg.entriesOf(cfg.findSection(cfg.parse(SAMPLE), 'mark_demo'));
  const merged = cfg.applyFields(existing, {
    platformKind: 'Databricks',
    databricksAuthType: 'Token',
    databricksHost: 'https://dbc.example.com',
    databricksPath: '/sql/1.0/warehouses/abc',
    databricksToken: 'tok',
    domain: 'https://demo.example.com',
    environmentID: '65',
  });
  assert.ok(!('snowflakeAccount' in merged) && !('snowflakePassword' in merged), 'snowflake keys dropped');
  assert.strictEqual(merged.databricksHost, 'https://dbc.example.com');
  assert.strictEqual(merged.environmentID, '65');
});

test('an empty value removes the key', () => {
  const merged = cfg.applyFields({ snowflakeRole: 'SYSADMIN', domain: 'x' }, { snowflakeRole: '', domain: 'y' });
  assert.ok(!('snowflakeRole' in merged));
  assert.strictEqual(merged.domain, 'y');
});

test('a blank secret keeps the stored value (the rule the form relies on)', () => {
  const existing = { databricksToken: 'keepme', databricksHost: 'https://dbc.example.com', platformKind: 'Databricks' };
  const submitted = { platformKind: 'Databricks', databricksAuthType: 'Token', databricksHost: 'https://dbc.example.com' };
  for (const field of fieldsFor('Databricks', 'Token')) {
    if (field.secret && !(field.key in submitted) && existing[field.key]) submitted[field.key] = existing[field.key];
  }
  assert.strictEqual(cfg.applyFields(existing, submitted).databricksToken, 'keepme');
});

// ---------------------------------------------------------------- platforms

test('infers the platform of a legacy Snowflake profile with no platformKind', () => {
  assert.strictEqual(platformKindOf({ snowflakeAccount: 'a' }), 'Snowflake');
  assert.strictEqual(platformKindOf({ databricksHost: 'h' }), 'Databricks');
  assert.strictEqual(platformKindOf({ bigQueryServiceAccountKey: 'k' }), 'BigQuery');
  assert.strictEqual(platformKindOf({}), 'Snowflake');
});

test('falls back to the first auth type when the stored one is unknown', () => {
  assert.strictEqual(authTypeOf({ snowflakeAuthType: 'KeyPair' }, 'Snowflake'), 'KeyPair');
  assert.strictEqual(authTypeOf({ snowflakeAuthType: 'Nonsense' }, 'Snowflake'), 'Basic');
});

// --------------------------------------------------------------------- i/o

test('writes atomically at mode 0600 and backs up the previous file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coacfg-'));
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, SAMPLE, { mode: 0o600 });

  const { sections } = cfg.read(file);
  cfg.setActive(sections, 'dela-poc');
  const backupPath = cfg.backup(file);
  cfg.write(file, sections);

  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'config stays owner-only');
  assert.strictEqual(fs.statSync(backupPath).mode & 0o777, 0o600, 'backup is owner-only too');
  assert.strictEqual(fs.readFileSync(backupPath, 'utf8'), SAMPLE, 'backup holds the pre-write content');
  assert.strictEqual(cfg.activeProfile(cfg.read(file).sections), 'dela-poc');
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.tmp.')), 'no temp file left behind');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('keeps at most 10 backups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coacfg-'));
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, SAMPLE, { mode: 0o600 });
  for (let i = 0; i < 14; i++) {
    fs.writeFileSync(file, `${SAMPLE}# run ${i}\n`, { mode: 0o600 });
    cfg.backup(file);
  }
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.bak.'));
  assert.strictEqual(backups.length, 10, `expected 10 backups, found ${backups.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reading a missing file yields an empty, writable model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coacfg-'));
  const file = path.join(dir, 'nested', 'config');
  const { sections, existed } = cfg.read(file);
  assert.strictEqual(existed, false);
  assert.deepStrictEqual(cfg.namedProfiles(sections), []);
  cfg.upsertSection(sections, 'first', { platformKind: 'BigQuery', bigQueryServiceAccountKey: '/k.json' });
  cfg.write(file, sections);
  assert.strictEqual(cfg.listProfiles(cfg.read(file).sections)[0].platformKind, 'BigQuery');
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
