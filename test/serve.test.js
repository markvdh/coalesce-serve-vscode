/**
 * End-to-end check of the non-vscode half of the extension against a real
 * `coa` binary. Run it from a Coalesce workspace:
 *
 *   node test/serve.test.js [workspace-dir]
 *
 * It starts `coa serve --no-open`, asserts the COA_SERVE_READY handshake, GETs
 * the served page (checking it is framable), then kills the process and asserts
 * the port is released.
 */
const assert = require('assert');
const http = require('http');
const { detectCoa, findFreePort, isPortFree, startServe, killTree } = require('../serve');

const dir = process.argv[2] || process.cwd();

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const coa = detectCoa();
  const port = await findFreePort(18082);
  console.log(`coa      : ${coa}`);
  console.log(`workspace: ${dir}`);
  console.log(`port     : ${port}\n`);

  let exited = null;
  const { proc, ready } = startServe({
    coa,
    dir,
    port,
    onExit: (code, signal) => {
      exited = { code, signal };
    },
  });

  const info = await ready;
  console.log('READY payload:', info);
  assert.ok(info.url, 'readiness payload has a url');
  assert.strictEqual(info.port, port, 'readiness payload reports the requested port');
  assert.ok(info.nonce && info.url.includes(`#nonce=${info.nonce}`), 'url carries the auth nonce in its fragment');
  assert.strictEqual(exited, null, 'server is still alive after readiness');

  const res = await get(`http://127.0.0.1:${port}/`);
  assert.strictEqual(res.statusCode, 200, 'served page responds 200');
  assert.strictEqual(res.headers['x-frame-options'], undefined, 'no X-Frame-Options (webview can frame it)');
  assert.ok(
    !/frame-ancestors/i.test(res.headers['content-security-policy'] || ''),
    'no CSP frame-ancestors (webview can frame it)',
  );
  console.log('served page: 200, framable');

  killTree(proc);
  for (let i = 0; i < 50 && exited === null; i++) await wait(100);
  assert.ok(exited, 'server exited after killTree');
  console.log('after kill :', exited);

  for (let i = 0; i < 50 && !(await isPortFree(port)); i++) await wait(100);
  assert.ok(await isPortFree(port), 'port released after kill');
  console.log('port released\n');

  console.log('all assertions passed');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
