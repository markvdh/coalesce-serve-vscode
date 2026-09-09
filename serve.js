// Everything in here is plain Node with no `vscode` import, so it can be
// exercised from a normal `node` process (see test/serve.test.js).
const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const READY_RE = /COA_SERVE_READY\s+(\{.*?\})\s*$/m;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const DEFAULT_TIMEOUT_MS = 180_000; // the first run may download the UI bundle

const DESKTOP_DIR = path.join(os.homedir(), '.coalesce', 'desktop');
const UI_PATH_ENV = 'COALESCE_UI_PATH';

// The CLI's own one-line complaints, most user-facing first.
const SERVE_FAILED_RE = /^\s*[✖x]\s*Serve failed:\s*(.+)$/gm;
const CLI_ERROR_RE = /\|error:(?:\[[^\]]*\])?\s*(.+)$/gm;
// Both mean the same thing: this build has no UI to serve and none to download.
const UI_BUNDLE_MISSING_RE = /UI bundle was not found at \S+ \(HTTP \d+\)|No release version is baked into this CLI/;

function desktopShimPath() {
  return path.join(DESKTOP_DIR, process.platform === 'win32' ? 'coa.cmd' : 'coa');
}

function isDesktopShim(coa) {
  return path.resolve(coa) === desktopShimPath();
}

/**
 * Resolve the `coa` executable: an explicit override wins, then the Coalesce
 * Desktop shim (whose CLI build matches the app), then `coa` from PATH.
 */
function detectCoa(configured) {
  if (configured) return configured;
  const shim = desktopShimPath();
  try {
    fs.accessSync(shim, fs.constants.X_OK);
    return shim;
  } catch {
    return 'coa';
  }
}

/**
 * Coalesce Desktop installs its shim on launch, and the CLI behind it is an
 * unreleased build (`0.0.0-ci`). Run standalone it tries to download a UI
 * bundle that was never published and dies on an HTTP 404 — which is why
 * `coa serve` breaks once Desktop has been started. The app carries the
 * matching UI next to its CLI entry point, so serve that instead.
 *
 * @returns {string|null} the app's bundled UI directory, or null if `coa` is
 *   not the Desktop shim or the app has no usable copy.
 */
function desktopUiPath(coa) {
  if (!isDesktopShim(coa)) return null;
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'agent.json'), 'utf8'))?.coa?.coaEntry;
  } catch {
    return null;
  }
  if (!entry) return null;
  const ui = path.join(path.dirname(entry), 'web-ui');
  return fs.existsSync(path.join(ui, 'index.html')) ? ui : null;
}

/** `process.env` plus the UI override the Desktop shim needs to work at all. */
function serveEnv(coa, base = process.env) {
  const env = { ...base };
  if (env[UI_PATH_ENV]) return env; // the user knows better
  const ui = desktopUiPath(coa);
  if (ui) env[UI_PATH_ENV] = ui;
  return env;
}

function lastMatch(re, text) {
  let last = null;
  for (const match of text.matchAll(re)) last = match;
  return last ? last[1].trim() : null;
}

/** The most specific thing `coa` said about why it gave up, if anything. */
function lastCliError(output) {
  return lastMatch(SERVE_FAILED_RE, output) ?? lastMatch(CLI_ERROR_RE, output);
}

/**
 * Turn an early exit into a message worth showing a human: the CLI's own
 * reason where it has one, and a way out for the Desktop-shim failure.
 */
function explainExit({ output = '', code, signal, coa }) {
  const detail = lastCliError(output.replace(ANSI_RE, ''));

  if (detail && UI_BUNDLE_MISSING_RE.test(detail)) {
    // The full story is in the log; the notification only needs the way out.
    return isDesktopShim(coa)
      ? 'Coalesce Desktop may be interfering with the `coa` CLI. Try quitting Coalesce Desktop and starting again.'
      : 'This `coa` has no Coalesce UI to serve.';
  }

  const because = detail ? `: ${detail}` : ` (code ${code}, signal ${signal})`;
  return `\`coa serve\` exited before it was ready${because}`;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort(preferred, span = 50) {
  for (let port = preferred; port < preferred + span; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in ${preferred}-${preferred + span - 1}`);
}

/**
 * Spawn `coa serve --no-open` and resolve once it prints its COA_SERVE_READY
 * line, which carries the URL including the auth nonce.
 *
 * Returns the child immediately plus a promise for the parsed readiness
 * payload, so the caller can cancel by killing the child.
 *
 * @returns {{ proc: import('child_process').ChildProcess, ready: Promise<{url: string, port: number, nonce?: string}> }}
 */
function startServe({ coa, dir, port, onOutput, onExit, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const args = ['--no-color', 'serve', '--no-open', '--port', String(port), '--dir', dir];
  const env = serveEnv(coa);
  onOutput?.(`$ ${coa} ${args.join(' ')}\n  (cwd: ${dir})\n`);
  if (env[UI_PATH_ENV] !== process.env[UI_PATH_ENV]) {
    onOutput?.(`  (${UI_PATH_ENV}: ${env[UI_PATH_ENV]} — Coalesce Desktop's CLI has no downloadable UI bundle)\n`);
  }

  const proc = cp.spawn(coa, args, { cwd: dir, env, shell: false });

  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`\`coa serve\` did not report readiness within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );

    const onData = (chunk) => {
      const text = chunk.toString();
      onOutput?.(text);
      buffer += text.replace(ANSI_RE, '');
      const match = buffer.match(READY_RE);
      if (!match) return;
      try {
        finish(resolve, JSON.parse(match[1]));
      } catch (err) {
        finish(reject, new Error(`Could not parse COA_SERVE_READY: ${err.message}`));
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => finish(reject, err));
    proc.on('exit', (code, signal) => {
      finish(reject, new Error(explainExit({ output: buffer, code, signal, coa })));
      onExit?.(code, signal);
    });
  });

  return { proc, ready };
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') {
    // SIGTERM does not reach the node process behind the .cmd shim on Windows.
    cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  const pid = proc.pid;
  proc.kill('SIGTERM');
  setTimeout(() => {
    try {
      process.kill(pid, 0); // still alive?
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 3000).unref?.();
}

module.exports = {
  READY_RE,
  ANSI_RE,
  DEFAULT_TIMEOUT_MS,
  UI_PATH_ENV,
  detectCoa,
  desktopShimPath,
  isDesktopShim,
  desktopUiPath,
  serveEnv,
  lastCliError,
  explainExit,
  isPortFree,
  findFreePort,
  startServe,
  killTree,
};
