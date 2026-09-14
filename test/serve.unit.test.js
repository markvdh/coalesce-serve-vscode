/**
 * Unit checks for the parts of serve.js that need no `coa` binary:
 *
 *   node test/serve.unit.test.js
 *
 * The fixtures below are real output captured from the Coalesce Desktop shim,
 * which serves an unreleased CLI build with no downloadable UI bundle.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// DESKTOP_DIR is derived from the home directory at require time, so point the
// module at a scratch home before loading it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coalesce-serve-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const serve = require('../serve');

const desktop = path.join(home, '.coalesce', 'desktop');
const app = path.join(home, 'Coalesce.app', 'Contents', 'Resources', 'coa');
const shim = serve.desktopShimPath();

function installDesktop({ withUi }) {
  fs.mkdirSync(desktop, { recursive: true });
  fs.writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(desktop, 'agent.json'), JSON.stringify({ coa: { coaEntry: path.join(app, 'coa.js') } }));
  if (withUi) {
    fs.mkdirSync(path.join(app, 'web-ui'), { recursive: true });
    fs.writeFileSync(path.join(app, 'web-ui', 'index.html'), '<!DOCTYPE html>');
  }
}

const UI_404 =
  '|2026-09-09T07:23:52.463Z|[CLI]|info:[UiBundle] Downloading Coalesce UI (first run for this version)\n' +
  '  ✖ Serve failed: The Coalesce UI bundle was not found at ' +
  'https://storage.googleapis.com/coalesce-coa/ui/coa-ui-0.0.0-ci.zip (HTTP 404). This CLI version may be newer ' +
  'or older than the published UI, or the bundle has not been published yet.\n' +
  '|2026-09-09T07:23:52.723Z|[CLI_INTERNAL]|warn:Unexpected active resources during graceful CLI shutdown\n';

// ------------------------------------------------------------- lastCliError

assert.ok(serve.lastCliError(UI_404).startsWith('The Coalesce UI bundle was not found'), 'reads the ✖ line');
assert.strictEqual(
  serve.lastCliError('|2026-01-01T00:00:00.000Z|[CLI]|error:[ServeCommand] Failed to start: port in use'),
  'Failed to start: port in use',
  'falls back to a logged error line',
);
assert.strictEqual(serve.lastCliError('|[CLI]|info:[WatchServer] Starting server\n'), null, 'no error, no detail');

// --------------------------------------------------------------- explainExit

assert.strictEqual(
  serve.explainExit({ output: UI_404, code: 1, signal: null, coa: shim }),
  'Coalesce Desktop may be interfering with the `coa` CLI. Try quitting Coalesce Desktop and starting again.',
  'points at Desktop without the technical detail',
);
assert.strictEqual(
  serve.explainExit({ output: UI_404, code: 1, signal: null, coa: 'coa' }),
  'This `coa` has no Coalesce UI to serve.',
  'does not blame Desktop for a PATH `coa`',
);

assert.strictEqual(
  serve.explainExit({ output: '|[CLI]|info:[WatchServer] Starting server\n', code: 3, signal: null, coa: 'coa' }),
  '`coa serve` exited before it was ready (code 3, signal null)',
  'unrecognised failures keep the exit code',
);
assert.strictEqual(
  serve.explainExit({ output: '\x1b[31m  ✖ Serve failed: bad profile\x1b[0m\n', code: 1, coa: 'coa' }),
  '`coa serve` exited before it was ready: bad profile',
  'strips ANSI and surfaces the CLI reason',
);

// -------------------------------------------------- desktopUiPath / serveEnv

assert.strictEqual(serve.desktopUiPath('coa'), null, 'a PATH `coa` never gets the override');
assert.strictEqual(serve.desktopUiPath(shim), null, 'no override before Desktop is installed');

installDesktop({ withUi: false });
assert.strictEqual(serve.desktopUiPath(shim), null, 'no override when the app has no bundled UI');

installDesktop({ withUi: true });
assert.strictEqual(serve.desktopUiPath(shim), path.join(app, 'web-ui'), 'finds the UI beside the app CLI entry');
assert.strictEqual(serve.detectCoa(), shim, 'the shim still wins auto-detection');
assert.strictEqual(serve.detectCoa('/usr/local/bin/coa'), '/usr/local/bin/coa', 'an explicit path still wins');

assert.strictEqual(serve.serveEnv(shim, {})[serve.UI_PATH_ENV], path.join(app, 'web-ui'), 'shim gets the override');
assert.strictEqual(serve.serveEnv('coa', {})[serve.UI_PATH_ENV], undefined, 'PATH `coa` is left alone');
assert.strictEqual(
  serve.serveEnv(shim, { [serve.UI_PATH_ENV]: '/my/ui' })[serve.UI_PATH_ENV],
  '/my/ui',
  'an existing override is respected',
);

// ------------------------------------------------------------------- windows
// These run on every host: the helpers are pure, and the Windows-only spawn
// path is the one nobody developing on a Mac would otherwise exercise.

assert.strictEqual(serve.quoteForCmd('serve'), 'serve', 'a plain argument is left bare');
assert.strictEqual(serve.quoteForCmd(''), '""', 'an empty argument still needs to be an argument');
assert.strictEqual(serve.quoteForCmd('C:\\R&D\\repo'), '"C:\\R&D\\repo"', 'quotes neutralise cmd metacharacters');
assert.strictEqual(serve.quoteForCmd('C:\\my repo\\'), '"C:\\my repo\\\\"', 'a trailing backslash is doubled');
assert.strictEqual(serve.quoteForCmd('say "hi"'), '"say \\"hi\\""', 'embedded quotes are escaped');

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coabin-'));
fs.writeFileSync(path.join(binDir, 'coa.cmd'), '@echo off\n', { mode: 0o755 });
// Lower-case PATHEXT so the lookup is the same on a case-sensitive filesystem.
const winEnv = { PATH: binDir, PATHEXT: '.exe;.cmd' };

assert.strictEqual(
  serve.resolveWindowsExecutable('coa', winEnv),
  path.join(binDir, 'coa.cmd'),
  'a bare `coa` on PATH resolves to the .cmd shim CreateProcess would miss',
);
assert.strictEqual(
  serve.resolveWindowsExecutable(path.join(binDir, 'coa'), winEnv),
  path.join(binDir, 'coa.cmd'),
  'an extensionless explicit path gets the same treatment',
);
assert.strictEqual(
  serve.resolveWindowsExecutable(path.join(binDir, 'coa.cmd'), winEnv),
  path.join(binDir, 'coa.cmd'),
  'a spelled-out path is taken as given',
);
assert.strictEqual(serve.resolveWindowsExecutable('nope', winEnv), null, 'nothing on PATH, nothing resolved');
fs.rmSync(binDir, { recursive: true, force: true });

fs.rmSync(home, { recursive: true, force: true });
console.log('all assertions passed');
