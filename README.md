# Coalesce Local UI (VS Code)

A tiny, dependency-free VS Code extension that adds a **Coalesce** icon to the
primary side bar with one button. Pressing it:

1. starts `coa serve --no-open` in the background for the current workspace
   (reusing the tab if it is already running);
2. opens the served UI in a **VS Code editor tab** instead of an external
   browser;
3. **stops the server** again when you close that tab.

It also manages the profiles in `~/.coa/config`: list them, switch the active
one, edit them in a form, and set the Coalesce API key.

## Profiles

`coa serve` accepts no `--profile` flag and ignores `--config` — its option set
is literally `{dir, port, open}`, and the profile is resolved from
`~/.coa/config` alone. So "switch profile" here means **copy the chosen profile
into `[default]`**, which makes the composite profile exactly that profile with
nothing inherited from whatever `[default]` used to hold.

The sidebar shows:

```
LOCAL UI
  ▶ Open Coalesce UI
COALESCE CLOUD                    (of the active profile)
  Coalesce domain    https://mark-sandbox…        ✎
  Coalesce API key   ••••••••                     ✎
  Environment ID     12                           ✎
PROFILES
  ✔ dela-poc         Databricks · active     ✓ ✎ 🗑
  ○ mark_demo        Snowflake               ✓ ✎ 🗑
  + New profile…
```

Safety rules the code follows:

- Every write takes a timestamped `~/.coa/config.bak.<iso>` first, last 10 kept.
- Writes are atomic (temp file + rename in the same directory) and the file
  stays `0600`.
- Sections the form did not touch are carried through **verbatim**, comments
  included — the parser is line-based rather than a lossy round-trip.
- If `[default]` matches no saved profile, activating anything first prompts you
  to save those settings under a name. Cancel the prompt and nothing is written.
- Existing secrets are never sent into the webview. Their inputs render empty
  with an "unchanged" placeholder; a blank secret on save keeps the stored
  value. To *clear* one, edit `~/.coa/config` directly.
- Changing a profile's platform drops the previous platform's keys, so a
  Snowflake→Databricks switch leaves no stranded `snowflake*` entries.

Platform fields come from `coa describe config` (CLI 7.41): Snowflake
(Basic / KeyPair), Databricks (Token / OAuth M2M), BigQuery (service account).

Because `coa serve` reads the config once at startup, switching profiles while
the server runs offers to restart it.

## Why `--no-open` instead of intercepting the browser

`coa serve` prints a machine-readable readiness line on startup:

```
COA_SERVE_READY {"url":"http://localhost:8082#nonce=…","port":8082,"nonce":"…"}
```

So there is nothing to intercept: `--no-open` suppresses the external browser,
the extension reads that line (the URL carries the auth nonce in its fragment)
and loads the URL into a webview itself. Trying to hijack the browser launch via
`$BROWSER` only works for CLIs that honour it, and would not give you a handle
on the resulting tab to hang the shutdown off.

The extension builds its own webview rather than calling the built-in
`simpleBrowser.show`, for the same reason: it needs the `onDidDispose` event of
the panel to know when to kill the server.

## Install

No build step — it is plain JavaScript with no dependencies.

```sh
ln -s ~/GitHub/coalesce-serve-vscode ~/.vscode/extensions/coalesce-serve-vscode
```

Then reload the window (`Developer: Reload Window`). For VS Code Insiders use
`~/.vscode-insiders/extensions/`.

To hack on it instead, open this folder in VS Code and press `F5` for an
Extension Development Host.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `coalesceServe.coaPath` | `""` | Path to `coa`. Empty auto-detects the Coalesce Desktop shim (`~/.coalesce/desktop/coa`), else `coa` from `PATH`. |
| `coalesceServe.port` | `8082` | Preferred port. If taken, the next free port up to +49 is used. |
| `coalesceServe.workspaceFolder` | `""` | Folder to serve. Empty picks the folder containing `data.yml`, else the first folder. |
| `coalesceServe.showStatusBarItem` | `true` | Show a status bar item while the server runs. |

## Commands

- `Coalesce: Open Local UI` — start + show the tab
- `Coalesce: Stop Local UI Server`
- `Coalesce: Restart Local UI Server`
- `Coalesce: Show Local UI Server Log`
- `Coalesce: New Profile…`
- `Coalesce: Reload Profiles`
- `Coalesce: Open ~/.coa/config`

Activate / edit / delete act on a sidebar row, so they are inline buttons
rather than palette entries.

## Tests

```sh
npm test        # ~/.coa/config model, plus coa resolution and failure messages
npm run test:e2e   # spawns a real `coa serve`, asserts the handshake and the kill
```

## Notes and limits

- Uses activity-bar container id `coalesceServe`, so it coexists with the
  separate `coalesce-vscode-extension` (which claims `coalesce`).
- Coalesce Desktop installs its shim on launch, and the CLI behind it reports
  version `0.0.0-ci`. Run on its own it tries to download
  `coa-ui-0.0.0-ci.zip`, gets an HTTP 404 and exits — so `coa serve` breaks
  once Desktop has been started. The app ships the matching UI next to its CLI
  entry point, so the extension sets `COALESCE_UI_PATH` to that directory
  whenever it resolves to the shim. If the app has no usable copy, the
  notification suggests quitting Coalesce Desktop and the log has the detail.
- The UI is framed in a webview. That works because `coa serve` sends no
  `X-Frame-Options` and no CSP `frame-ancestors`. If a future CLI build adds
  either, the frame will go blank and you would need `simpleBrowser`/external
  browser instead.
- `asExternalUri` + `portMapping` are used so the tab also works over Remote
  SSH / Codespaces; the `#nonce=` fragment is re-attached if the rewrite drops
  it.
- On Windows the process is stopped with `taskkill /T /F` because `SIGTERM`
  does not pass through the `.cmd` shim.
- If the server exits on its own, the tab is closed and the error is surfaced
  with a link to the log.

## Icons

The Coalesce mark in `media/` is borrowed from
[`coalesce-vscode-extension`](https://github.com/jessemarshall/coalesce-vscode-extension)
(MIT, Jesse Marshall):

| File | Source | Used for |
| --- | --- | --- |
| `icon.svg` | `media/icons/coalesce.svg` | activity bar (`fill="currentColor"`, VS Code masks it) |
| `logo-light-theme.svg` | `media/icons/coalesce-icon-dark.svg` | editor tab icon, light themes (`#1B1B1F` ink) |
| `logo-dark-theme.svg` | `media/icons/coalesce-icon-light.svg` | editor tab icon, dark themes (white ink) |
| `icon.png` | `media/icon.png` | extension gallery icon (256×256) |

Note the swap in the two tab icons: upstream names them after the ink colour,
VS Code's `iconPath` names them after the theme they are shown in.

## License

MIT
