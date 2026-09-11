const vscode = require('vscode');
const { CLOUD_FIELDS } = require('./platforms');
const coaconfig = require('./coaconfig');
const workspaceyml = require('./workspaceyml');

const item = (label, collapsible = vscode.TreeItemCollapsibleState.None) => new vscode.TreeItem(label, collapsible);

/**
 * Sidebar contents: the local UI server, the Coalesce Cloud settings of the
 * selected profile, and the profile list from ~/.coa/config.
 *
 * The profile rows behave as radio buttons — the circle on the left shows which
 * one workspace.yml names, and clicking a row selects it. Editing and deleting
 * are the inline buttons.
 */
class CoalesceTreeProvider {
  /**
   * @param {() => ({port: number, url: string}|null)} getSession
   * @param {() => string|null} getFolder the folder that would be served
   */
  constructor(getSession, getFolder) {
    this.getSession = getSession;
    this.getFolder = getFolder;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (!element) return this.groups();
    if (element.groupId === 'server') return this.serverItems();
    if (element.groupId === 'cloud') return this.cloudItems();
    if (element.groupId === 'profiles') return this.profileItems();
    return [];
  }

  groups() {
    const expanded = vscode.TreeItemCollapsibleState.Expanded;
    const make = (id, label) => {
      const node = item(label, expanded);
      node.groupId = id;
      node.contextValue = `group.${id}`;
      return node;
    };
    const cloud = make('cloud', 'Coalesce Cloud');
    // Say which section the settings below come from — it is not always the
    // profile the workspace selects.
    const source = this.cloudSource();
    if (source.section) cloud.description = source.fallback ? '[default]' : source.name;

    return [make('server', 'Local UI'), cloud, make('profiles', 'Profiles')];
  }

  /** The folder to serve, and whether `coa init` has been run in it. */
  workspace() {
    const dir = this.getFolder();
    const ready = workspaceyml.exists(dir);
    let profile = null;
    if (ready) {
      try {
        profile = workspaceyml.readProfile(dir);
      } catch {
        /* unreadable — treat as unset */
      }
    }
    return { dir, ready, profile };
  }

  readSections() {
    try {
      return coaconfig.read(coaconfig.defaultConfigPath()).sections;
    } catch {
      return [];
    }
  }

  serverItems() {
    const { dir, ready, profile } = this.workspace();

    if (!ready) {
      const blocked = item(dir ? 'Workspace not initialised' : 'No folder open');
      blocked.iconPath = new vscode.ThemeIcon('warning');
      blocked.description = dir ? `no ${workspaceyml.FILENAME}` : '';
      blocked.tooltip = dir
        ? `\`${dir}\` has no ${workspaceyml.FILENAME}. Run \`coa init\` there to set it up for local development.`
        : 'Open a Coalesce workspace folder first.';
      if (!dir) return [blocked];

      const init = item('Run `coa init`…');
      init.iconPath = new vscode.ThemeIcon('terminal');
      init.command = { command: 'coalesceServe.initWorkspace', title: 'Run coa init' };
      init.tooltip = `Opens a terminal in ${dir}`;
      return [blocked, init];
    }

    const session = this.getSession();
    if (!session) {
      const start = item('Open Coalesce UI');
      start.iconPath = new vscode.ThemeIcon('play');
      start.command = { command: 'coalesceServe.open', title: 'Open Coalesce UI' };
      start.description = profile || 'no profile selected';
      start.tooltip = 'Run `coa serve` and open the UI in an editor tab';
      return [start];
    }

    const running = item(`Running on port ${session.port}`);
    running.iconPath = new vscode.ThemeIcon('server-process');
    running.description = profile || 'no profile selected';
    running.command = { command: 'coalesceServe.open', title: 'Show tab' };
    running.tooltip = session.url;

    const stop = item('Stop server');
    stop.iconPath = new vscode.ThemeIcon('debug-stop');
    stop.command = { command: 'coalesceServe.stop', title: 'Stop' };
    return [running, stop];
  }

  /**
   * Which ~/.coa/config section the Coalesce Cloud settings come from.
   *
   * These live in the profiles file, not in workspace.yml, so they are worth
   * showing before `coa init` too. With no profile selected we show what `coa`
   * itself falls back to: `[default]`.
   *
   * @returns {{ name: string, section: object|null, fallback: boolean, missing: boolean }}
   */
  cloudSource() {
    const sections = this.readSections();
    const { profile } = this.workspace();
    if (profile) {
      const section = coaconfig.findSection(sections, profile);
      return { name: profile, section: section || null, fallback: false, missing: !section };
    }
    const section = coaconfig.findSection(sections, 'default');
    return { name: 'default', section: section || null, fallback: true, missing: false };
  }

  cloudItems() {
    const { ready } = this.workspace();
    const { name, section, fallback, missing } = this.cloudSource();

    if (!section) {
      const none = item(missing ? `Unknown profile '${name}'` : 'No Coalesce Cloud settings');
      none.iconPath = new vscode.ThemeIcon('warning');
      none.description = missing ? 'not in ~/.coa/config' : '~/.coa/config has no [default] section';
      none.tooltip = missing
        ? `${workspaceyml.FILENAME} names '${name}', but ~/.coa/config has no such section.`
        : ready
          ? 'Pick a profile below — the circle on the left marks the one this workspace uses.'
          : 'Pick a profile below, or run `coa init` to store a token.';
      return [none];
    }

    const origin = fallback
      ? `[default] in ~/.coa/config — used when no profile is selected`
      : `Profile: ${name}`;

    const entries = coaconfig.entriesOf(section);
    return CLOUD_FIELDS.map((field) => {
      const value = entries[field.key];
      const node = item(field.label);
      node.description = field.secret ? (value ? '••••••••' : 'not set') : value || 'not set';
      node.iconPath = new vscode.ThemeIcon(field.secret ? 'key' : 'globe');
      node.tooltip = `${field.help || field.label}\n\n${origin}`;
      node.contextValue = 'cloudField';
      node.fieldKey = field.key;
      node.profileName = name;
      node.command = {
        command: 'coalesceServe.editCloudField',
        title: `Edit ${field.label}`,
        arguments: [node],
      };
      return node;
    });
  }

  profileItems() {
    const { ready, profile } = this.workspace();
    const profiles = coaconfig.listProfiles(this.readSections(), profile);

    const nodes = profiles.map((entry) => {
      const node = item(entry.name);
      node.description = entry.active ? `${entry.platformKind} · active` : entry.platformKind;
      node.iconPath = new vscode.ThemeIcon(entry.active ? 'pass-filled' : 'circle-large-outline');
      node.contextValue = entry.active ? 'profile.active' : 'profile';
      node.profileName = entry.name;
      node.tooltip = entry.active
        ? `${workspaceyml.FILENAME} has \`profile: ${entry.name}\`. Edit it to clear that.`
        : ready
          ? `Click to write \`profile: ${entry.name}\` into ${workspaceyml.FILENAME}.`
          : `Run \`coa init\` first — there is no ${workspaceyml.FILENAME} to record the choice in.`;
      node.command = { command: 'coalesceServe.activateProfile', title: 'Use this profile', arguments: [node] };
      return node;
    });

    // workspace.yml names a profile that no longer exists in ~/.coa/config.
    if (profile && !profiles.some((p) => p.name === profile)) {
      const missing = item(profile);
      missing.iconPath = new vscode.ThemeIcon('warning');
      missing.description = 'not in ~/.coa/config';
      missing.tooltip = `${workspaceyml.FILENAME} selects '${profile}', but there is no such section. Pick another profile, or create one with this name.`;
      nodes.unshift(missing);
    }

    const add = item('New profile…');
    add.iconPath = new vscode.ThemeIcon('add');
    add.command = { command: 'coalesceServe.newProfile', title: 'New profile' };
    nodes.push(add);
    return nodes;
  }
}

module.exports = { CoalesceTreeProvider };
