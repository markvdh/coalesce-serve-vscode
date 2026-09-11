# Coalesce Local UI (VS Code)

A tiny, dependency-free VS Code extension that adds a **Coalesce** icon to the
primary side bar with one button. Pressing it:

1. starts `coa serve --no-open` in the background for the current workspace
   (reusing the tab if it is already running);
2. opens the served UI in a **VS Code editor tab** instead of an external
   browser;
3. **stops the server** again when you close that tab.

It also manages the profiles in `~/.coa/config`: list them, pick the one this
repo uses, edit them in a form, and set the Coalesce API key.

## The workspace must be initialised

The local UI only starts in a folder that has a **`workspace.yml`** — the
per-repo file holding the local location→database/schema mappings that
`coa serve` renders against. Without it the sidebar shows

```
LOCAL UI
  ⚠ Workspace not initialised     no workspace.yml
  ▷ Run `coa init`…
```

and pressing the run button explains the same thing with a **Run coa init**
button, which opens a terminal in that folder (`coa init` is interactive, so it
is handed to a terminal rather than spawned headless). Multi-root workspaces
prefer the folder that has a `workspace.yml`, then one with `data.yml`, then the
first folder — `coalesceServe.workspaceFolder` overrides that.

## Profiles

The selected profile is recorded **in the repo's `workspace.yml`**, as a
top-level key:

```yaml
profile: mark_demo
locations:
  TARGET:
    database: DEV_DB
    schema: MARK
```

`coa` resolves it from there (`coa doctor` reports `profile: mark_demo
(workspace.yml)`), so switching profile is a one-line edit to that file and
different repos can use different profiles at the same time. Nothing is ever
copied into `[default]` — that section is coa's own fallback, not a mirror of
the selected profile.

The sidebar shows:

```
LOCAL UI
  ▶ Open Coalesce UI                          mark_demo
COALESCE CLOUD                                mark_demo
  Coalesce domain    https://mark-sandbox…        ✎
  Coalesce API key   ••••••••                     ✎
  Environment ID     12                           ✎
PROFILES
  ● mark_demo        Snowflake · active        ✎ 🗑
  ○ dela-poc         Databricks                ✎ 🗑
  + New profile…
```

The **Coalesce Cloud** settings come from `~/.coa/config`, not from the repo, so
they show up even outside an initialised workspace — with no profile selected
the section falls back to what `coa` itself uses, `[default]`, and says so in
the group's label. Editing a field there writes to `[default]`; that is the only
time this extension touches that section.

The circles are radio buttons: **click a row to select that profile**, which
writes `profile: <name>` into `workspace.yml`. The inline buttons edit and
delete. To *clear* the selection, open the profile and untick **Use this profile
for this workspace** — that checkbox is a live view of the key, so it is ticked
on the profile `workspace.yml` names and disabled when there is no
`workspace.yml` to record a choice in.

Safety rules the code follows:

- Every write to `~/.coa/config` takes a timestamped `.bak.<iso>` first, last 10
  kept. Writes are atomic (temp file + rename in the same directory) and the
  file stays `0600`.
- `workspace.yml` is edited **line by line**: only the `profile:` line is
  touched, the file's mode is preserved, and comments and mappings survive byte
  for byte. A missing `workspace.yml` is never created — that is `coa init`'s
  job.
- Sections the form did not touch are carried through **verbatim**, comments
  included — the `~/.coa/config` parser is line-based rather than a lossy
  round-trip.
- Deleting the selected profile removes the `profile:` key too, so the repo is
  never left pointing at a section that does not exist. If it happens anyway
  (a hand edit, a colleague's name), the sidebar flags it rather than silently
  falling back.
- Existing secrets are never sent into the webview. Their inputs render empty
  with an "unchanged" placeholder; a blank secret on save keeps the stored
  value. To *clear* one, edit `~/.coa/config` directly.
- Changing a profile's platform drops the previous platform's keys, so a
  Snowflake→Databricks switch leaves no stranded `snowflake*` entries.

Platform fields come from `coa describe config` (CLI 7.41): Snowflake
(Basic / KeyPair), Databricks (Token / OAuth M2M), BigQuery (service account).

Because `coa serve` resolves the profile once at startup, switching profiles
while the server runs offers to restart it.

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
| `coalesceServe.workspaceFolder` | `""` | Folder to serve. Empty picks the folder containing `workspace.yml`, else `data.yml`, else the first folder. |
| `coalesceServe.showStatusBarItem` | `true` | Show a status bar item while the server runs. |

## Commands

- `Coalesce: Open Local UI` — start + show the tab
- `Coalesce: Stop Local UI Server`
- `Coalesce: Restart Local UI Server`
- `Coalesce: Show Local UI Server Log`
- `Coalesce: New Profile…`
- `Coalesce: Reload Profiles`
- `Coalesce: Initialise Workspace (coa init)`
- `Coalesce: Open ~/.coa/config`
- `Coalesce: Open workspace.yml`

Select / edit / delete act on a sidebar row: selecting is the row click, edit
and delete are inline buttons, so none of them are palette entries.

## Tests

```sh
npm test        # ~/.coa/config and workspace.yml models, coa resolution, failure messages
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
