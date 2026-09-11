const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { detectCoa, findFreePort, startServe, killTree } = require('./serve');
const { CoalesceTreeProvider } = require('./profilesTree');
const coaconfig = require('./coaconfig');
const workspaceyml = require('./workspaceyml');
const profiles = require('./profileCommands');

/** @type {{ proc: import('child_process').ChildProcess, panel: vscode.WebviewPanel, url: string, port: number } | null} */
let session = null;
/** @type {vscode.OutputChannel} */
let log;
/** @type {vscode.StatusBarItem} */
let status;
/** @type {CoalesceTreeProvider} */
let tree;

const config = () => vscode.workspace.getConfiguration('coalesceServe');

// ---------------------------------------------------------------- resolution

function resolveFolder() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) return null;

  const configured = config().get('workspaceFolder');
  if (configured) {
    const match = folders.find((f) => f.name === configured || f.uri.fsPath === configured);
    return match ? match.uri.fsPath : configured; // else treat as a literal path
  }

  // Prefer a folder that is actually set up for local development, then any
  // Coalesce repo, then whatever is open.
  const initialised = folders.find((f) => workspaceyml.exists(f.uri.fsPath));
  const withDataYml = folders.find((f) => fs.existsSync(path.join(f.uri.fsPath, 'data.yml')));
  return (initialised || withDataYml || folders[0]).uri.fsPath;
}

// -------------------------------------------------------------------- webview

function panelHtml(src) {
  const escaped = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  // No CSP meta tag on purpose: the frame source is a localhost URL that VS Code
  // rewrites per host (asExternalUri + portMapping), so a fixed frame-src would
  // break under Remote SSH / Codespaces.
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
      iframe { display: block; border: 0; width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <iframe src="${escaped}" allow="clipboard-read; clipboard-write; downloads"></iframe>
  </body>
</html>`;
}

async function createPanel(context, rawUrl, port) {
  const parsed = vscode.Uri.parse(rawUrl);
  let external = await vscode.env.asExternalUri(parsed);
  if (parsed.fragment && !external.fragment) {
    external = external.with({ fragment: parsed.fragment }); // keep the auth nonce
  }

  const panel = vscode.window.createWebviewPanel('coalesceServe.ui', 'Coalesce', vscode.ViewColumn.Active, {
    enableScripts: true,
    enableForms: true,
    retainContextWhenHidden: true,
    localResourceRoots: [],
    portMapping: [{ webviewPort: port, extensionHostPort: port }],
  });
  // Panel icons are drawn as-is (not masked like activity bar icons), so give
  // each theme the variant with the right ink colour.
  panel.iconPath = {
    light: vscode.Uri.joinPath(context.extensionUri, 'media', 'logo-light-theme.svg'),
    dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'logo-dark-theme.svg'),
  };
  panel.webview.html = panelHtml(external.toString(true));
  return panel;
}

// ------------------------------------------------------------------- session

function setRunning(running) {
  vscode.commands.executeCommand('setContext', 'coalesceServe.running', running);
  if (running && session && config().get('showStatusBarItem')) {
    status.text = `$(server-process) Coalesce :${session.port}`;
    status.tooltip = `Local Coalesce UI on ${session.url}`;
    status.command = 'coalesceServe.open';
    status.show();
  } else {
    status.hide();
  }
  tree?.refresh();
}

/** The server died on its own — tear the tab down so the two never disagree. */
function onServerExit(proc, code, signal) {
  if (!session || session.proc !== proc) return;
  const panel = session.panel;
  session = null;
  setRunning(false);
  panel.dispose();
  if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
    vscode.window
      .showErrorMessage(`\`coa serve\` stopped unexpectedly (code ${code}).`, 'Show log')
      .then((choice) => choice && log.show(true));
  }
}

async function open(context) {
  if (session) {
    session.panel.reveal(session.panel.viewColumn ?? vscode.ViewColumn.Active);
    return;
  }

  const dir = resolveFolder();
  if (!dir) {
    vscode.window.showErrorMessage('Open a Coalesce workspace folder first.');
    return;
  }
  // `coa serve` needs the local mappings in workspace.yml, and that is also
  // where the profile is recorded. Without it the repo is not initialised.
  if (!workspaceyml.exists(dir)) {
    profiles.reportUninitialised(dir);
    return;
  }

  const coa = detectCoa(config().get('coaPath'));
  const preferred = config().get('port') || 8082;

  let active = null;
  try {
    active = workspaceyml.readProfile(dir);
  } catch {
    /* unreadable — coa will complain with a better message than we can */
  }

  let cancelled = false;
  try {
    const started = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Starting the local Coalesce UI${active ? ` (profile: ${active})` : ''}…`,
        cancellable: true,
      },
      async (progress, token) => {
        const port = await findFreePort(preferred);
        if (port !== preferred) progress.report({ message: `port ${preferred} is taken, using ${port}` });

        log.appendLine('');
        let child;
        const { proc, ready } = startServe({
          coa,
          dir,
          port,
          onOutput: (text) => log.append(text),
          onExit: (code, signal) => onServerExit(child, code, signal),
        });
        child = proc;
        token.onCancellationRequested(() => {
          cancelled = true;
          killTree(proc);
        });

        return { proc, info: await ready, port };
      },
    );

    const port = started.info.port || started.port;
    const panel = await createPanel(context, started.info.url, port);
    session = { proc: started.proc, panel, url: started.info.url, port };
    setRunning(true);

    panel.onDidDispose(() => {
      if (!session || session.panel !== panel) return;
      const { proc } = session;
      session = null;
      setRunning(false);
      log.appendLine('\n[coalesce-serve] tab closed — stopping the server');
      killTree(proc);
    });
  } catch (err) {
    if (cancelled) return;
    const hint = err.code === 'ENOENT' ? ` Could not run "${coa}" — set \`coalesceServe.coaPath\`.` : '';
    const message = `Local Coalesce UI failed to start: ${err.message.replace(/\.$/, '')}.${hint}`;
    // Only offer the settings shortcut when the message actually asks for it.
    const actions = message.includes('coalesceServe.coaPath') ? ['Open settings', 'Show log'] : ['Show log'];
    const choice = await vscode.window.showErrorMessage(message, ...actions);
    if (choice === 'Open settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'coalesceServe.coaPath');
    } else if (choice === 'Show log') {
      log.show(true);
    }
  }
}

function stop() {
  if (session) session.panel.dispose(); // onDidDispose kills the process
}

async function restart(context) {
  stop();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await open(context);
}

// ----------------------------------------------------------------- lifecycle

/** Pick up profile edits made outside VS Code (or by `coa` itself). */
function watchConfig() {
  const configPath = coaconfig.defaultConfigPath();
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  let timer;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Watch the directory, not the file: an atomic write replaces the inode.
    const watcher = fs.watch(dir, (_event, filename) => {
      if (filename && filename !== base) return;
      clearTimeout(timer);
      timer = setTimeout(() => tree?.refresh(), 200);
    });
    return { dispose: () => { clearTimeout(timer); watcher.close(); } };
  } catch {
    return { dispose: () => {} };
  }
}

/** `coa init`, `coa doctor --fix` and hand edits all change which profile is selected. */
function watchWorkspaceFile() {
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${workspaceyml.FILENAME}`);
  const refresh = () => tree?.refresh();
  watcher.onDidCreate(refresh);
  watcher.onDidChange(refresh);
  watcher.onDidDelete(refresh);
  return watcher;
}

function activate(context) {
  log = vscode.window.createOutputChannel('Coalesce Local UI');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  tree = new CoalesceTreeProvider(() => session, resolveFolder);
  setRunning(false);

  const refresh = () => tree.refresh();
  const command = (name, handler) => vscode.commands.registerCommand(name, handler);
  /** @type {import('./profileCommands').Deps} */
  const deps = { folder: resolveFolder, refresh, session: () => session };

  context.subscriptions.push(
    log,
    status,
    watchConfig(),
    watchWorkspaceFile(),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.window.registerTreeDataProvider('coalesceServe.control', tree),

    command('coalesceServe.open', () => open(context)),
    command('coalesceServe.stop', () => stop()),
    command('coalesceServe.restart', () => restart(context)),
    command('coalesceServe.showLog', () => log.show(true)),
    command('coalesceServe.initWorkspace', () => profiles.runInit(resolveFolder())),

    command('coalesceServe.refresh', refresh),
    command('coalesceServe.newProfile', () => profiles.openProfileForm(context, null, deps)),
    command('coalesceServe.editProfile', (node) => profiles.openProfileForm(context, node, deps)),
    command('coalesceServe.activateProfile', (node) => profiles.activateProfile(node, deps)),
    command('coalesceServe.deleteProfile', (node) => profiles.deleteProfile(node, deps)),
    command('coalesceServe.editCloudField', (node) => profiles.editCloudField(node, deps)),
    command('coalesceServe.openConfigFile', () => profiles.revealConfig()),
    command('coalesceServe.openWorkspaceFile', () => profiles.revealWorkspaceFile(deps)),

    { dispose: () => session && killTree(session.proc) },
  );
}

function deactivate() {
  if (session) killTree(session.proc);
}

module.exports = { activate, deactivate };
