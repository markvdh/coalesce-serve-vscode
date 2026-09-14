const vscode = require('vscode');
const coaconfig = require('./coaconfig');
const workspaceyml = require('./workspaceyml');
const { detectCoa } = require('./serve');
const { CLOUD_FIELDS, SECRET_KEYS, fieldsFor } = require('./platforms');
const { showProfileForm } = require('./profileForm');

const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * @typedef {{
 *   folder: () => string|null,
 *   refresh: () => void,
 *   session: () => object|null,
 * }} Deps
 */

/** Read, mutate, back up, write. Every write to ~/.coa/config goes through here. */
function commit(mutate) {
  const { configPath, sections, eol } = coaconfig.read();
  const result = mutate(sections);
  coaconfig.backup(configPath);
  coaconfig.write(configPath, sections, eol);
  return result;
}

// -------------------------------------------------------- workspace readiness

/**
 * The folder to act on, or null after telling the user to initialise it.
 * Selecting a profile means writing `profile:` into workspace.yml, so without
 * that file there is nowhere to record the choice.
 */
function requireWorkspace(deps) {
  const dir = deps.folder();
  if (!dir) {
    vscode.window.showErrorMessage('Open a Coalesce workspace folder first.');
    return null;
  }
  if (!workspaceyml.exists(dir)) {
    reportUninitialised(dir);
    return null;
  }
  return dir;
}

function reportUninitialised(dir) {
  vscode.window
    .showErrorMessage(
      `\`${dir}\` has no ${workspaceyml.FILENAME}, so it is not set up for local development. Run \`coa init\` there first.`,
      'Run coa init',
    )
    .then((choice) => choice === 'Run coa init' && runInit(dir));
}

/**
 * Quote a command line for whatever shell VS Code opens the terminal in.
 *
 * The default shell is PowerShell on Windows and it will not run a quoted path
 * without the call operator, while cmd.exe has no escape for a quote at all —
 * so each of the three gets its own spelling rather than one POSIX guess.
 */
function terminalCommand(parts) {
  const shell = (vscode.env.shell || '').toLowerCase();
  if (/(^|[\\/])(pwsh|powershell)(\.exe)?$/.test(shell)) {
    return `& ${parts.map((p) => `'${p.replace(/'/g, "''")}'`).join(' ')}`;
  }
  if (/(^|[\\/])cmd(\.exe)?$/.test(shell)) {
    return parts.map((p) => (/[\s&|<>^()]/.test(p) ? `"${p}"` : p)).join(' ');
  }
  return parts.map((p) => (/[^A-Za-z0-9._\/:=-]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p)).join(' ');
}

/** `coa init` is interactive, so hand it to a terminal rather than spawning it headless. */
function runInit(dir) {
  const coa = detectCoa(vscode.workspace.getConfiguration('coalesceServe').get('coaPath'));
  const terminal = vscode.window.createTerminal({ name: 'coa init', cwd: dir || undefined });
  terminal.show();
  terminal.sendText(terminalCommand([coa, 'init']));
}

/**
 * Write (or, with a null name, clear) workspace.yml's `profile:` key.
 * @returns {string|null} an error to report, or null on success.
 */
function setWorkspaceProfile(dir, name) {
  try {
    workspaceyml.writeProfile(dir, name);
    return null;
  } catch (err) {
    return `Could not update ${workspaceyml.workspacePath(dir)}: ${err.message}`;
  }
}

// ------------------------------------------------------------------ commands

/**
 * Record a profile as this workspace's in workspace.yml. Nothing in
 * ~/.coa/config changes — `coa` resolves `profile:` from the repo.
 */
async function activateProfile(node, deps) {
  const name = node?.profileName;
  if (!name) return;

  const dir = requireWorkspace(deps);
  if (!dir) return;

  let current = null;
  try {
    current = workspaceyml.readProfile(dir);
  } catch {
    /* unreadable — the write below reports the real problem */
  }
  if (current === name) {
    vscode.window.showInformationMessage(`'${name}' is already this workspace's profile.`);
    return;
  }

  const failure = setWorkspaceProfile(dir, name);
  if (failure) {
    vscode.window.showErrorMessage(failure);
    return;
  }

  deps.refresh();
  await offerRestart(deps, `'${name}' is now this workspace's profile.`);
}

/** `coa serve` resolves the profile once at startup, so a running server is stale. */
async function offerRestart(deps, message) {
  if (!deps.session()) {
    vscode.window.showInformationMessage(message);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `${message} \`coa serve\` reads it at startup — restart it to pick this up?`,
    'Restart',
    'Later',
  );
  if (choice === 'Restart') vscode.commands.executeCommand('coalesceServe.restart');
}

function validateName(value, sections, currentName) {
  const name = (value || '').trim();
  if (!name) return 'Enter a name.';
  if (name === 'default') return "'default' is coa's base section — pick another name.";
  if (!NAME_RE.test(name)) return 'Use letters, digits, dot, dash or underscore only.';
  if (name !== currentName && coaconfig.namedProfiles(sections).includes(name)) {
    return `A profile named '${name}' already exists.`;
  }
  return null;
}

function openProfileForm(context, node, deps) {
  const { sections } = coaconfig.read();
  const name = node?.profileName;
  const section = name ? coaconfig.findSection(sections, name) : null;
  const entries = section ? coaconfig.entriesOf(section) : {};

  const dir = deps.folder();
  const workspaceReady = workspaceyml.exists(dir);
  const selected = workspaceReady ? workspaceyml.readProfile(dir) : null;

  showProfileForm(
    context,
    {
      name,
      entries,
      existingNames: coaconfig.namedProfiles(sections),
      // The checkbox is a live view of workspace.yml: ticked means "this repo's
      // profile", and clearing it on an already-selected profile unsets it.
      active: !!name && selected === name,
      workspaceReady,
      workspaceFile: dir ? workspaceyml.workspacePath(dir) : null,
    },
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
      });

      let note = `Saved profile '${target}'.`;
      if (workspaceReady) {
        const current = workspaceyml.readProfile(dir);
        let failure = null;
        if (payload.active && current !== target) {
          failure = setWorkspaceProfile(dir, target);
          note = `Saved '${target}' and made it this workspace's profile.`;
        } else if (!payload.active && current === target) {
          failure = setWorkspaceProfile(dir, null);
          note = `Saved '${target}' and cleared this workspace's profile.`;
        }
        // The section is already written, so report the rest and keep the form open.
        if (failure) {
          deps.refresh();
          return failure;
        }
      }

      deps.refresh();
      vscode.window.showInformationMessage(note);
    },
  );
}

async function editCloudField(node, deps) {
  const field = CLOUD_FIELDS.find((f) => f.key === node?.fieldKey);
  if (!field || !node.profileName) return;

  const { sections } = coaconfig.read();
  const section = coaconfig.findSection(sections, node.profileName);
  if (!section) return;
  const entries = coaconfig.entriesOf(section);
  // With no profile selected the sidebar shows [default], so an edit lands there.
  const where = node.profileName === 'default' ? '[default]' : `profile '${node.profileName}'`;

  const value = await vscode.window.showInputBox({
    title: `${field.label} — ${where}`,
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
  });

  deps.refresh();
  vscode.window.showInformationMessage(
    value.trim() === '' ? `Cleared ${field.label} on ${where}.` : `Updated ${field.label} on ${where}.`,
  );
}

async function deleteProfile(node, deps) {
  const name = node?.profileName;
  if (!name) return;

  const dir = deps.folder();
  const wasSelected = workspaceyml.exists(dir) && workspaceyml.readProfile(dir) === name;
  const detail = wasSelected
    ? `It is this workspace's profile, so \`profile: ${name}\` is removed from ${workspaceyml.FILENAME} too.`
    : 'A timestamped backup of ~/.coa/config is written first.';

  const choice = await vscode.window.showWarningMessage(`Delete profile '${name}'?`, { modal: true, detail }, 'Delete');
  if (choice !== 'Delete') return;

  commit((s) => coaconfig.deleteProfile(s, name));
  const failure = wasSelected ? setWorkspaceProfile(dir, null) : null;
  deps.refresh();
  if (failure) vscode.window.showErrorMessage(`Deleted profile '${name}', but ${failure}`);
  else vscode.window.showInformationMessage(`Deleted profile '${name}'.`);
}

function revealConfig() {
  return vscode.window.showTextDocument(vscode.Uri.file(coaconfig.defaultConfigPath()), { preview: false });
}

function revealWorkspaceFile(deps) {
  const dir = requireWorkspace(deps);
  if (!dir) return;
  return vscode.window.showTextDocument(vscode.Uri.file(workspaceyml.workspacePath(dir)), { preview: false });
}

module.exports = {
  activateProfile,
  openProfileForm,
  editCloudField,
  deleteProfile,
  revealConfig,
  revealWorkspaceFile,
  reportUninitialised,
  runInit,
  terminalCommand,
  validateName,
  SECRET_KEYS,
};
