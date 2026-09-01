const vscode = require('vscode');
const { CLOUD_FIELDS } = require('./platforms');
const coaconfig = require('./coaconfig');

const item = (label, collapsible = vscode.TreeItemCollapsibleState.None) => new vscode.TreeItem(label, collapsible);

/**
 * Sidebar contents: the local UI server, the Coalesce Cloud settings of the
 * active profile, and the profile list from ~/.coa/config.
 */
class CoalesceTreeProvider {
  /** @param {() => ({port: number, url: string}|null)} getSession */
  constructor(getSession) {
    this.getSession = getSession;
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
    return [make('server', 'Local UI'), make('cloud', 'Coalesce Cloud'), make('profiles', 'Profiles')];
  }

  serverItems() {
    const session = this.getSession();
    if (!session) {
      const start = item('Open Coalesce UI');
      start.iconPath = new vscode.ThemeIcon('play');
      start.command = { command: 'coalesceServe.open', title: 'Open Coalesce UI' };
      start.tooltip = 'Run `coa serve` and open the UI in an editor tab';
      return [start];
    }
    const running = item(`Running on port ${session.port}`);
    running.iconPath = new vscode.ThemeIcon('server-process');
    running.description = coaconfig.activeProfile(this.readSections()) || 'no active profile';
    running.command = { command: 'coalesceServe.open', title: 'Show tab' };
    running.tooltip = session.url;

    const stop = item('Stop server');
    stop.iconPath = new vscode.ThemeIcon('debug-stop');
    stop.command = { command: 'coalesceServe.stop', title: 'Stop' };
    return [running, stop];
  }

  readSections() {
    try {
      return coaconfig.read(coaconfig.defaultConfigPath()).sections;
    } catch {
      return [];
    }
  }

  cloudItems() {
    const sections = this.readSections();
    const active = coaconfig.activeProfile(sections);
    if (!active) {
      const none = item('No active profile');
      none.iconPath = new vscode.ThemeIcon('warning');
      none.description = '[default] is not a copy of any profile';
      none.tooltip = 'Activate a profile below, or edit [default] in ~/.coa/config by hand.';
      return [none];
    }

    const entries = coaconfig.entriesOf(coaconfig.findSection(sections, active));
    return CLOUD_FIELDS.map((field) => {
      const value = entries[field.key];
      const node = item(field.label);
      node.description = field.secret ? (value ? '••••••••' : 'not set') : value || 'not set';
      node.iconPath = new vscode.ThemeIcon(field.secret ? 'key' : 'globe');
      node.tooltip = `${field.help || field.label}\n\nProfile: ${active}`;
      node.contextValue = 'cloudField';
      node.fieldKey = field.key;
      node.profileName = active;
      node.command = {
        command: 'coalesceServe.editCloudField',
        title: `Edit ${field.label}`,
        arguments: [node],
      };
      return node;
    });
  }

  profileItems() {
    const sections = this.readSections();
    const profiles = coaconfig.listProfiles(sections);

    const nodes = profiles.map((profile) => {
      const node = item(profile.name);
      node.description = profile.active ? `${profile.platformKind} · active` : profile.platformKind;
      node.iconPath = new vscode.ThemeIcon(profile.active ? 'pass-filled' : 'circle-large-outline');
      node.contextValue = profile.active ? 'profile.active' : 'profile';
      node.profileName = profile.name;
      node.tooltip = profile.active
        ? `[default] is currently a copy of '${profile.name}'`
        : `Click to edit. Use the ✓ button to copy '${profile.name}' into [default].`;
      node.command = { command: 'coalesceServe.editProfile', title: 'Edit profile', arguments: [node] };
      return node;
    });

    if (coaconfig.defaultIsOrphan(sections)) {
      const orphan = item('[default] is not a saved profile');
      orphan.iconPath = new vscode.ThemeIcon('warning');
      orphan.description = 'will be preserved on first activation';
      orphan.tooltip =
        'The [default] section does not match any named profile. Activating a profile will first save these settings under a name you choose.';
      nodes.unshift(orphan);
    }

    const add = item('New profile…');
    add.iconPath = new vscode.ThemeIcon('add');
    add.command = { command: 'coalesceServe.newProfile', title: 'New profile' };
    nodes.push(add);
    return nodes;
  }
}

module.exports = { CoalesceTreeProvider };
