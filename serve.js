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

/**
 * Resolve the `coa` executable: an explicit override wins, then the Coalesce
 * Desktop shim (whose CLI build matches the app), then `coa` from PATH.
 */
function detectCoa(configured) {
  if (configured) return configured;
  const shim = path.join(os.homedir(), '.coalesce', 'desktop', process.platform === 'win32' ? 'coa.cmd' : 'coa');
  try {
    fs.accessSync(shim, fs.constants.X_OK);
    return shim;
  } catch {
    return 'coa';
  }
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
  onOutput?.(`$ ${coa} ${args.join(' ')}\n  (cwd: ${dir})\n`);

  const proc = cp.spawn(coa, args, { cwd: dir, env: process.env, shell: false });

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
      finish(reject, new Error(`\`coa serve\` exited before it was ready (code ${code}, signal ${signal})`));
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

module.exports = { READY_RE, ANSI_RE, DEFAULT_TIMEOUT_MS, detectCoa, isPortFree, findFreePort, startServe, killTree };
