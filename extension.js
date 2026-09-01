const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { detectCoa, findFreePort, startServe, killTree } = require('./serve');

/** @type {{ proc: import('child_process').ChildProcess, panel: vscode.WebviewPanel, url: string, port: number } | null} */
let session = null;
/** @type {vscode.OutputChannel} */
let log;
/** @type {vscode.StatusBarItem} */
let status;

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

  const withDataYml = folders.find((f) => fs.existsSync(path.join(f.uri.fsPath, 'data.yml')));
  return (withDataYml || folders[0]).uri.fsPath;
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
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
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

  const coa = detectCoa(config().get('coaPath'));
  const preferred = config().get('port') || 8082;

  let cancelled = false;
  try {
    const started = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Starting the local Coalesce UI…', cancellable: true },
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
    const choice = await vscode.window.showErrorMessage(
      `Local Coalesce UI failed to start: ${err.message}.${hint}`,
      'Show log',
    );
    if (choice) log.show(true);
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

function activate(context) {
  log = vscode.window.createOutputChannel('Coalesce Local UI');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  setRunning(false);

  const emptyTree = { getChildren: () => [], getTreeItem: (item) => item };

  context.subscriptions.push(
    log,
    status,
    vscode.window.registerTreeDataProvider('coalesceServe.control', emptyTree),
    vscode.commands.registerCommand('coalesceServe.open', () => open(context)),
    vscode.commands.registerCommand('coalesceServe.stop', () => stop()),
    vscode.commands.registerCommand('coalesceServe.restart', () => restart(context)),
    vscode.commands.registerCommand('coalesceServe.showLog', () => log.show(true)),
    { dispose: () => session && killTree(session.proc) },
  );
}

function deactivate() {
  if (session) killTree(session.proc);
}

module.exports = { activate, deactivate };
