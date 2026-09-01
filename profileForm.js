const vscode = require('vscode');
const { CLOUD_FIELDS, PLATFORMS, PLATFORM_NAMES, SECRET_KEYS, platformKindOf, authTypeOf } = require('./platforms');

/**
 * Open the add/edit profile form.
 *
 * Existing secrets are never sent to the webview: their inputs render empty
 * with a "leave blank to keep" placeholder, and a blank secret on save means
 * "unchanged" rather than "clear".
 *
 * @param {vscode.ExtensionContext} context
 * @param {{ name?: string, entries?: Record<string,string>, existingNames: string[] }} options
 * @param {(result: {name: string, platformKind: string, authType: string, fields: Record<string,string>, activate: boolean}) => Promise<string|void>} onSave
 *        Return a string to report a validation error back into the form.
 */
function showProfileForm(context, options, onSave) {
  const isNew = !options.name;
  const entries = options.entries || {};
  const platformKind = platformKindOf(entries);

  const panel = vscode.window.createWebviewPanel(
    'coalesceServe.profileForm',
    isNew ? 'New Coalesce profile' : `Profile: ${options.name}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, enableForms: true, retainContextWhenHidden: true },
  );
  panel.iconPath = {
    light: vscode.Uri.joinPath(context.extensionUri, 'media', 'logo-light-theme.svg'),
    dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'logo-dark-theme.svg'),
  };

  const values = {};
  const secretsPresent = {};
  for (const [key, value] of Object.entries(entries)) {
    if (SECRET_KEYS.has(key)) secretsPresent[key] = true;
    else values[key] = value;
  }

  const model = {
    isNew,
    name: options.name || '',
    platformKind,
    authType: authTypeOf(entries, platformKind),
    values,
    secretsPresent,
    existingNames: options.existingNames,
    platforms: PLATFORMS,
    platformNames: PLATFORM_NAMES,
    cloudFields: CLOUD_FIELDS,
  };

  panel.webview.html = html(panel.webview, model);

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.type === 'cancel') {
      panel.dispose();
      return;
    }
    if (message.type !== 'save') return;
    try {
      const error = await onSave(message.payload);
      if (error) panel.webview.postMessage({ type: 'error', message: error });
      else panel.dispose();
    } catch (err) {
      panel.webview.postMessage({ type: 'error', message: err.message });
    }
  });

  return panel;
}

function html(webview, model) {
  const nonce = Buffer.from(String(Math.random())).toString('base64').slice(0, 24);
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  body {
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
    padding: 24px; max-width: 640px; margin: 0 auto;
  }
  h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 4px; }
  .subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 24px; }
  fieldset { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin: 0 0 20px; padding: 12px 16px 16px; }
  legend { padding: 0 6px; font-weight: 600; text-transform: uppercase; font-size: 0.85em; letter-spacing: 0.04em;
           color: var(--vscode-descriptionForeground); }
  .field { margin: 12px 0 0; }
  .field:first-of-type { margin-top: 4px; }
  label { display: block; margin-bottom: 4px; }
  .req { color: var(--vscode-errorForeground); }
  .help { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 3px; }
  input, select {
    width: 100%; box-sizing: border-box; padding: 5px 8px; border-radius: 2px;
    font-family: inherit; font-size: inherit;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
           border-color: var(--vscode-dropdown-border, transparent); }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  input.invalid { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
  .secret-row { display: flex; gap: 6px; align-items: center; }
  .reveal {
    flex: 0 0 auto; width: auto; padding: 4px 8px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: none; border-radius: 2px; font-size: 0.9em;
  }
  .actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: 20px; }
  .actions .spacer { flex: 1; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .actions button { padding: 6px 16px; border: none; border-radius: 2px; cursor: pointer; font-family: inherit; font-size: inherit; }
  .checkline { display: flex; gap: 6px; align-items: center; color: var(--vscode-descriptionForeground); }
  .checkline input { width: auto; }
  #error {
    display: none; margin-bottom: 16px; padding: 8px 12px; border-radius: 3px;
    background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1));
    border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
  }
</style>
</head>
<body>
  <h1 id="title"></h1>
  <p class="subtitle" id="subtitle"></p>
  <div id="error"></div>

  <fieldset>
    <legend>Profile</legend>
    <div class="field">
      <label for="name">Profile name <span class="req">*</span></label>
      <input id="name" type="text" placeholder="dela-poc" />
      <div class="help">The <code>[section]</code> name in ~/.coa/config.</div>
    </div>
    <div class="field">
      <label for="platform">Platform</label>
      <select id="platform"></select>
    </div>
    <div class="field" id="auth-field">
      <label for="auth">Authentication</label>
      <select id="auth"></select>
    </div>
  </fieldset>

  <fieldset>
    <legend id="platform-legend">Connection</legend>
    <div id="platform-fields"></div>
  </fieldset>

  <fieldset>
    <legend>Coalesce Cloud</legend>
    <div id="cloud-fields"></div>
  </fieldset>

  <div class="actions">
    <label class="checkline spacer"><input type="checkbox" id="activate" /> Set as active profile after saving</label>
    <button class="secondary" id="cancel">Cancel</button>
    <button class="primary" id="save">Save</button>
  </div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const model = ${JSON.stringify(model).replace(/</g, '\\u003c')};
const state = { values: { ...model.values }, secrets: {}, platform: model.platformKind, auth: model.authType };

const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

el('title').textContent = model.isNew ? 'New Coalesce profile' : 'Edit profile: ' + model.name;
el('subtitle').textContent = model.isNew
  ? 'Adds a [section] to ~/.coa/config.'
  : 'Blank password fields keep the value already in ~/.coa/config.';
el('name').value = model.name;
if (!model.isNew) el('name').readOnly = true;
el('activate').checked = model.isNew;

el('platform').innerHTML = model.platformNames
  .map((p) => '<option value="' + p + '">' + esc(model.platforms[p].label) + '</option>').join('');
el('platform').value = state.platform;

function renderAuth() {
  const auths = Object.keys(model.platforms[state.platform].auths);
  if (!auths.includes(state.auth)) state.auth = auths[0];
  el('auth').innerHTML = auths
    .map((a) => '<option value="' + a + '">' + esc(model.platforms[state.platform].auths[a].label) + '</option>').join('');
  el('auth').value = state.auth;
  el('auth-field').style.display = auths.length > 1 ? '' : 'none';
}

function fieldHtml(f) {
  const id = 'f_' + f.key;
  const label = '<label for="' + id + '">' + esc(f.label) + (f.required ? ' <span class="req">*</span>' : '') + '</label>';
  const help = f.help ? '<div class="help">' + esc(f.help) + '</div>' : '';
  const placeholder = f.secret && model.secretsPresent[f.key]
    ? 'unchanged — type to replace'
    : (f.placeholder || '');
  const value = f.secret ? (state.secrets[f.key] || '') : (state.values[f.key] || '');
  const input = '<input id="' + id + '" data-key="' + f.key + '" data-secret="' + !!f.secret + '"'
    + ' type="' + (f.secret ? 'password' : 'text') + '"'
    + ' placeholder="' + esc(placeholder) + '" value="' + esc(value) + '" />';
  const body = f.secret
    ? '<div class="secret-row">' + input + '<button class="reveal" data-for="' + id + '" type="button">Show</button></div>'
    : input;
  return '<div class="field">' + label + body + help + '</div>';
}

function renderFields() {
  const platform = model.platforms[state.platform];
  el('platform-legend').textContent = platform.label + ' connection';
  el('platform-fields').innerHTML = platform.auths[state.auth].fields.map(fieldHtml).join('');
  el('cloud-fields').innerHTML = model.cloudFields.map(fieldHtml).join('');

  for (const input of document.querySelectorAll('#platform-fields input, #cloud-fields input')) {
    input.addEventListener('input', (e) => {
      const key = e.target.dataset.key;
      if (e.target.dataset.secret === 'true') state.secrets[key] = e.target.value;
      else state.values[key] = e.target.value;
      e.target.classList.remove('invalid');
    });
  }
  for (const button of document.querySelectorAll('.reveal')) {
    button.addEventListener('click', () => {
      const input = el(button.dataset.for);
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      button.textContent = hidden ? 'Hide' : 'Show';
    });
  }
}

el('platform').addEventListener('change', () => {
  state.platform = el('platform').value;
  renderAuth();
  renderFields();
});
el('auth').addEventListener('change', () => {
  state.auth = el('auth').value;
  renderFields();
});

function showError(message) {
  const box = el('error');
  box.textContent = message;
  box.style.display = message ? 'block' : 'none';
}

el('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

el('save').addEventListener('click', () => {
  showError('');
  const name = el('name').value.trim();
  if (!name) return showError('Give the profile a name.');

  const fields = {};
  let missing = null;
  for (const f of model.platforms[state.platform].auths[state.auth].fields.concat(model.cloudFields)) {
    const raw = f.secret ? (state.secrets[f.key] || '') : (state.values[f.key] || '');
    const value = raw.trim();
    if (f.required && !value && !(f.secret && model.secretsPresent[f.key])) {
      missing = missing || f;
      const input = el('f_' + f.key);
      if (input) input.classList.add('invalid');
      continue;
    }
    if (value) fields[f.key] = value;
  }
  if (missing) return showError('"' + missing.label + '" is required.');

  fields.platformKind = state.platform;
  fields[model.platforms[state.platform].authKey] = state.auth;

  vscode.postMessage({
    type: 'save',
    payload: { name, platformKind: state.platform, authType: state.auth, fields, activate: el('activate').checked },
  });
});

window.addEventListener('message', (event) => {
  if (event.data.type === 'error') showError(event.data.message);
});

renderAuth();
renderFields();
</script>
</body>
</html>`;
}

module.exports = { showProfileForm };
