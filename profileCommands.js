const vscode = require('vscode');
const coaconfig = require('./coaconfig');
const { CLOUD_FIELDS, SECRET_KEYS, fieldsFor } = require('./platforms');
const { showProfileForm } = require('./profileForm');

const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Read, mutate, back up, write. Every write to ~/.coa/config goes through here. */
function commit(mutate) {
  const { configPath, sections } = coaconfig.read();
  const result = mutate(sections);
  coaconfig.backup(configPath);
  coaconfig.write(configPath, sections);
  return result;
}

/** Keep [default] a byte-for-byte copy of the profile it was copied from. */
function resyncDefault(sections, name) {
  if (coaconfig.activeProfile(sections) === name) coaconfig.setActive(sections, name);
}

/**
 * Copy a profile into [default]. If [default] currently holds bespoke settings,
 * save them under a name first so activation cannot lose them.
 */
async function activateProfile(node, refresh, session) {
  const name = node?.profileName;
  if (!name) return;

  const { sections } = coaconfig.read();
  if (coaconfig.activeProfile(sections) === name) {
    vscode.window.showInformationMessage(`'${name}' is already the active profile.`);
    return;
  }

  if (coaconfig.defaultIsOrphan(sections)) {
    const suggestion = uniqueName(sections, 'saved-default');
    const preserveAs = await vscode.window.showInputBox({
      title: 'Preserve the current [default] section',
      prompt: `[default] does not match any saved profile. Save its current settings as a named profile before overwriting it.`,
      value: suggestion,
      validateInput: (value) => validateName(value, sections, null),
    });
    if (!preserveAs) return; // cancelled — do not touch the file
    commit((s) => coaconfig.preserveDefaultAs(s, preserveAs.trim()));
    vscode.window.showInformationMessage(`Saved the previous [default] as '${preserveAs.trim()}'.`);
  }

  commit((s) => coaconfig.setActive(s, name));
  refresh();

  if (!session()) {
    vscode.window.showInformationMessage(`'${name}' is now the active profile.`);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `'${name}' is now the active profile. \`coa serve\` reads the config at startup — restart it to pick this up?`,
    'Restart',
    'Later',
  );
  if (choice === 'Restart') vscode.commands.executeCommand('coalesceServe.restart');
}

function uniqueName(sections, base) {
  const taken = new Set(coaconfig.namedProfiles(sections));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

function validateName(value, sections, currentName) {
  const name = (value || '').trim();
  if (!name) return 'Enter a name.';
  if (name === 'default') return "'default' is managed for you — pick another name.";
  if (!NAME_RE.test(name)) return 'Use letters, digits, dot, dash or underscore only.';
  if (name !== currentName && coaconfig.namedProfiles(sections).includes(name)) {
    return `A profile named '${name}' already exists.`;
  }
  return null;
}

function openProfileForm(context, node, refresh) {
  const { sections } = coaconfig.read();
  const name = node?.profileName;
  const section = name ? coaconfig.findSection(sections, name) : null;
  const entries = section ? coaconfig.entriesOf(section) : {};

  showProfileForm(
    context,
    { name, entries, existingNames: coaconfig.namedProfiles(sections) },
    async (payload) => {
      const fresh = coaconfig.read().sections;
      const error = validateName(payload.name, fresh, name);
      if (error) return error;

      const target = (payload.name || '').trim();
      const existing = coaconfig.findSection(fresh, target)
        ? coaconfig.entriesOf(coaconfig.findSection(fresh, target))
        : {};

      // A blank secret input means "keep what is on disk", not "clear it".
      for (const field of fieldsFor(payload.platformKind, payload.authType).concat(CLOUD_FIELDS)) {
        if (field.secret && !(field.key in payload.fields) && existing[field.key]) {
          payload.fields[field.key] = existing[field.key];
        }
      }

      commit((s) => {
        const current = coaconfig.findSection(s, target) ? coaconfig.entriesOf(coaconfig.findSection(s, target)) : {};
        coaconfig.upsertSection(s, target, coaconfig.applyFields(current, payload.fields));
        if (payload.activate) coaconfig.setActive(s, target);
        else resyncDefault(s, target);
      });

      refresh();
      vscode.window.showInformationMessage(
        payload.activate ? `Saved '${target}' and made it the active profile.` : `Saved profile '${target}'.`,
      );
    },
  );
}

async function editCloudField(node, refresh) {
  const field = CLOUD_FIELDS.find((f) => f.key === node?.fieldKey);
  if (!field || !node.profileName) return;

  const { sections } = coaconfig.read();
  const section = coaconfig.findSection(sections, node.profileName);
  if (!section) return;
  const entries = coaconfig.entriesOf(section);

  const value = await vscode.window.showInputBox({
    title: `${field.label} — profile '${node.profileName}'`,
    prompt: field.help,
    password: !!field.secret,
    value: field.secret ? '' : entries[field.key] || '',
    placeHolder: field.secret && entries[field.key] ? 'unchanged — type to replace' : field.placeholder,
    ignoreFocusOut: true,
  });
  if (value === undefined) return;

  commit((s) => {
    const target = coaconfig.findSection(s, node.profileName);
    const current = coaconfig.entriesOf(target);
    if (value.trim() === '') delete current[field.key];
    else current[field.key] = value.trim();
    coaconfig.upsertSection(s, node.profileName, current);
    resyncDefault(s, node.profileName);
  });

  refresh();
  vscode.window.showInformationMessage(
    value.trim() === ''
      ? `Cleared ${field.label} on '${node.profileName}'.`
      : `Updated ${field.label} on '${node.profileName}'.`,
  );
}

async function deleteProfile(node, refresh) {
  const name = node?.profileName;
  if (!name) return;

  const { sections } = coaconfig.read();
  const wasActive = coaconfig.activeProfile(sections) === name;
  const detail = wasActive
    ? `It is the active profile. The copy in [default] is left in place, so coa keeps working — but nothing will be marked active.`
    : 'A timestamped backup of ~/.coa/config is written first.';

  const choice = await vscode.window.showWarningMessage(`Delete profile '${name}'?`, { modal: true, detail }, 'Delete');
  if (choice !== 'Delete') return;

  commit((s) => coaconfig.deleteProfile(s, name));
  refresh();
  vscode.window.showInformationMessage(`Deleted profile '${name}'.`);
}

function revealConfig() {
  const uri = vscode.Uri.file(coaconfig.defaultConfigPath());
  return vscode.window.showTextDocument(uri, { preview: false });
}

module.exports = { activateProfile, openProfileForm, editCloudField, deleteProfile, revealConfig, validateName, SECRET_KEYS };
