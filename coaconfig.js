/**
 * Read/write model for ~/.coa/config (INI: one [section] per profile).
 *
 * Line-based on purpose: the file holds credentials, so an unrecognised line is
 * carried through untouched rather than dropped by a round-trip through a
 * generic parser. No `vscode` import — see test/coaconfig.test.js.
 *
 * Which profile is *selected* is not recorded here: it lives in the repo's
 * workspace.yml (see workspaceyml.js). [default] is coa's own fallback section,
 * never a copy of a named profile — it is only written when the user edits a
 * field the sidebar is showing from it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ALL_PLATFORM_KEYS, platformKindOf } = require('./platforms');

const MAX_BACKUPS = 10;
const FILE_MODE = 0o600;

function defaultConfigPath() {
  return path.join(os.homedir(), '.coa', 'config');
}

/**
 * @typedef {{ name: string|null, lines: string[] }} Section
 * `name === null` is the preamble before the first [section] header.
 */

/** @returns {Section[]} */
function parse(text) {
  const sections = [];
  let current = { name: null, lines: [] };
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      sections.push(current);
      current = { name: header[1].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

function serialize(sections) {
  const out = [];
  for (const section of sections) {
    if (section.name !== null) out.push(`[${section.name}]`);
    out.push(...section.lines);
  }
  let text = out.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  return text;
}

const isBlankOrComment = (line) => /^\s*([;#].*)?$/.test(line);

/** @returns {Record<string,string>} */
function entriesOf(section) {
  const entries = {};
  for (const line of section.lines) {
    if (isBlankOrComment(line)) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    entries[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return entries;
}

/** Rewrite a section's key=value lines, keeping any comment block at its top. */
function setEntries(section, entries) {
  const lead = [];
  for (const line of section.lines) {
    if (isBlankOrComment(line) && line.trim() !== '') lead.push(line);
    else break;
  }
  section.lines = [...lead, ...Object.entries(entries).map(([k, v]) => `${k}=${v}`), ''];
}

function findSection(sections, name) {
  return sections.find((s) => s.name === name);
}

function namedProfiles(sections) {
  return sections.filter((s) => s.name !== null && s.name !== 'default').map((s) => s.name);
}

// ------------------------------------------------------------------ file i/o

function read(configPath = defaultConfigPath()) {
  let text = '';
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { configPath, sections: parse(text), existed: text !== '' };
}

function backup(configPath) {
  if (!fs.existsSync(configPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Two writes in the same millisecond must not clobber each other's backup.
  let target = `${configPath}.bak.${stamp}`;
  for (let n = 1; fs.existsSync(target); n++) target = `${configPath}.bak.${stamp}-${String(n).padStart(3, '0')}`;
  fs.copyFileSync(configPath, target);
  fs.chmodSync(target, FILE_MODE);
  pruneBackups(configPath);
  return target;
}

function pruneBackups(configPath) {
  const dir = path.dirname(configPath);
  const prefix = `${path.basename(configPath)}.bak.`;
  const mine = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .sort();
  for (const stale of mine.slice(0, Math.max(0, mine.length - MAX_BACKUPS))) {
    try {
      fs.unlinkSync(path.join(dir, stale));
    } catch {
      /* best effort */
    }
  }
}

/** Atomic within the same directory, so the 0600 mode is never widened. */
function write(configPath, sections) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, serialize(sections), { mode: FILE_MODE });
  fs.chmodSync(tmp, FILE_MODE);
  fs.renameSync(tmp, configPath);
}

// ----------------------------------------------------------------- profiles

/** @param {string|null} active the profile named in workspace.yml */
function listProfiles(sections, active = null) {
  return namedProfiles(sections).map((name) => {
    const entries = entriesOf(findSection(sections, name));
    return { name, entries, platformKind: platformKindOf(entries), active: name === active };
  });
}

function upsertSection(sections, name, entries) {
  let section = findSection(sections, name);
  if (!section) {
    section = { name, lines: [] };
    sections.push(section);
  }
  setEntries(section, entries);
  return section;
}

function deleteProfile(sections, name) {
  const index = sections.findIndex((s) => s.name === name);
  if (index !== -1) sections.splice(index, 1);
}

/**
 * Merge form output into a profile, dropping platform keys that the newly
 * chosen platform does not use (so switching Snowflake -> Databricks does not
 * strand snowflake* keys in the section).
 */
function applyFields(existing, fields) {
  const result = {};
  for (const [key, value] of Object.entries(existing)) {
    if (ALL_PLATFORM_KEYS.has(key) && !(key in fields)) continue; // stale platform key
    result[key] = value;
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value === '' || value === undefined || value === null) delete result[key];
    else result[key] = String(value);
  }
  return result;
}

module.exports = {
  defaultConfigPath,
  parse,
  serialize,
  entriesOf,
  setEntries,
  findSection,
  namedProfiles,
  read,
  write,
  backup,
  listProfiles,
  upsertSection,
  deleteProfile,
  applyFields,
};
