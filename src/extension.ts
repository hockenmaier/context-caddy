import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface Profile {
  selectedFiles: { [key: string]: boolean };
  prePrompt: string;
}

interface Config {
  profiles: { [key: string]: Profile };
  activeProfile: string;
}

let config: Config;
let configFilePath: string | undefined;

function getConfigFilePath(): string | undefined {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    return undefined;
  }
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "contextcaddy-config.json");
}

function loadConfig(): Config {
  const filePath = getConfigFilePath();
  let defaultConfig: Config = { profiles: { "default": { selectedFiles: {}, prePrompt: "" } }, activeProfile: "default" };
  if (!filePath) {
    vscode.window.showErrorMessage("No workspace folder open. Config cannot be loaded.");
    return defaultConfig;
  }
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Config;
      if (!parsed.profiles["default"]) {
        parsed.profiles["default"] = { selectedFiles: {}, prePrompt: "" };
      }
      if (!parsed.activeProfile || !parsed.profiles[parsed.activeProfile]) {
        parsed.activeProfile = "default";
      }
      return parsed;
    } catch (e) {
      vscode.window.showErrorMessage("Error parsing config file. Using default configuration.");
    }
  }
  return defaultConfig;
}

function saveConfig() {
  const filePath = getConfigFilePath();
  if (!filePath) {
    vscode.window.showErrorMessage("No workspace folder open. Config cannot be saved.");
    return;
  }
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
}

// Recursively get all file paths (files only) from a folder.
function getAllFiles(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  });
  return results;
}

// Update the context key "allSelected" based on whether every file in the workspace is selected.
async function updateAllSelectedContext(activeFiles: { [key: string]: boolean }) {
  let allFiles: string[] = [];
  if (vscode.workspace.workspaceFolders) {
    for (const folder of vscode.workspace.workspaceFolders) {
      allFiles = allFiles.concat(getAllFiles(folder.uri.fsPath));
    }
  }
  // Consider only files that are accessible.
  const selectedCount = Object.keys(activeFiles).length;
  const allSelected = allFiles.length > 0 && selectedCount === allFiles.length;
  await vscode.commands.executeCommand('setContext', 'allSelected', allSelected);
}

export function activate(context: vscode.ExtensionContext) {
  configFilePath = getConfigFilePath();
  config = loadConfig();
  let activeProfile = config.profiles[config.activeProfile];
  let prePrompt = activeProfile.prePrompt;

  const projectProvider = new ProjectContextProvider(activeProfile.selectedFiles);
  vscode.window.createTreeView('projectContext', { treeDataProvider: projectProvider });
  const selectedProvider = new SelectedFilesProvider(activeProfile.selectedFiles);
  vscode.window.createTreeView('selectedFilesView', { treeDataProvider: selectedProvider });

  async function refreshViews() {
    projectProvider.refresh();
    selectedProvider.refresh();
    await updateAllSelectedContext(activeProfile.selectedFiles);
  }

  // Toggle file selection: add if not present; remove if already selected.
  context.subscriptions.push(vscode.commands.registerCommand('extension.toggleSelection', (node: FileNode) => {
    const filePath = node.resourceUri.fsPath;
    if (activeProfile.selectedFiles[filePath]) {
      delete activeProfile.selectedFiles[filePath];
    } else {
      activeProfile.selectedFiles[filePath] = true;
    }
    config.profiles[config.activeProfile] = activeProfile;
    saveConfig();
    refreshViews();
  }));

  // Remove file from context.
  context.subscriptions.push(vscode.commands.registerCommand('extension.removeFromContext', (node: SelectedFileNode) => {
    const filePath = node.filePath;
    if (activeProfile.selectedFiles[filePath]) {
      delete activeProfile.selectedFiles[filePath];
      config.profiles[config.activeProfile] = activeProfile;
      saveConfig();
      refreshViews();
    }
  }));

  // Set pre-prompt.
  context.subscriptions.push(vscode.commands.registerCommand('extension.setPrePrompt', async () => {
    const input = await vscode.window.showInputBox({ prompt: "Enter Pre-Prompt", value: prePrompt });
    if (input !== undefined) {
      prePrompt = input;
      activeProfile.prePrompt = prePrompt;
      config.profiles[config.activeProfile] = activeProfile;
      saveConfig();
      vscode.window.showInformationMessage("Pre-Prompt saved for profile: " + config.activeProfile);
    }
  }));

  // Copy context (pre-prompt plus selected files with paths relative to workspace root; token count shown only in notification).
  context.subscriptions.push(vscode.commands.registerCommand('extension.copyContext', async () => {
    let text = prePrompt + "\n\n";
    const selectedPaths = Object.keys(activeProfile.selectedFiles);
    for (let filePath of selectedPaths) {
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          let content = fs.readFileSync(filePath, 'utf8');
          let workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
          let relPath = workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, filePath) : filePath;
          text += `----- ${relPath} -----\n${content}\n\n`;
        }
      } catch (error) {
        console.error("Error reading file: " + filePath, error);
      }
    }
    await vscode.env.clipboard.writeText(text);
    const approxTokens = Math.ceil(text.length / 4.3);
    vscode.window.showInformationMessage(`Context copied. Approx tokens: ${approxTokens}`);
  }));

  // Toggle all: if not all files are selected, select all; otherwise, unselect all.
  context.subscriptions.push(vscode.commands.registerCommand('extension.toggleAll', async () => {
    let allFiles: string[] = [];
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        allFiles = allFiles.concat(getAllFiles(folder.uri.fsPath));
      }
    }
    // Check if all files are already selected.
    const currentlySelected = Object.keys(activeProfile.selectedFiles);
    const allSelected = allFiles.length > 0 && currentlySelected.length === allFiles.length;
    if (allSelected) {
      // Unselect all.
      activeProfile.selectedFiles = {};
      vscode.window.showInformationMessage("Unselected all files.");
    } else {
      // Select all.
      allFiles.forEach(file => activeProfile.selectedFiles[file] = true);
      vscode.window.showInformationMessage("Selected all files.");
    }
    config.profiles[config.activeProfile] = activeProfile;
    saveConfig();
    refreshViews();
  }));

  // Create a new profile.
  context.subscriptions.push(vscode.commands.registerCommand('extension.newProfile', async () => {
    const profileName = await vscode.window.showInputBox({ prompt: "Enter new profile name" });
    if (profileName && !config.profiles[profileName]) {
      config.profiles[profileName] = { selectedFiles: {}, prePrompt: "" };
      config.activeProfile = profileName;
      activeProfile = config.profiles[profileName];
      saveConfig();
      refreshViews();
      vscode.window.showInformationMessage("New profile created and activated: " + profileName);
    } else if (profileName) {
      vscode.window.showErrorMessage("Profile already exists.");
    }
  }));

  // Rename current profile.
  context.subscriptions.push(vscode.commands.registerCommand('extension.renameProfile', async () => {
    const newName = await vscode.window.showInputBox({ prompt: "Enter new name for current profile", value: config.activeProfile });
    if (newName && newName !== config.activeProfile) {
      if (config.profiles[newName]) {
        vscode.window.showErrorMessage("A profile with that name already exists.");
      } else {
        config.profiles[newName] = activeProfile;
        delete config.profiles[config.activeProfile];
        config.activeProfile = newName;
        activeProfile = config.profiles[newName];
        saveConfig();
        refreshViews();
        vscode.window.showInformationMessage("Profile renamed to: " + newName);
      }
    }
  }));

  // Switch active profile.
  context.subscriptions.push(vscode.commands.registerCommand('extension.switchProfile', async () => {
    const profileNames = Object.keys(config.profiles);
    const selected = await vscode.window.showQuickPick(profileNames, { placeHolder: "Select profile" });
    if (selected) {
      config.activeProfile = selected;
      activeProfile = config.profiles[selected];
      prePrompt = activeProfile.prePrompt;
      saveConfig();
      refreshViews();
      vscode.window.showInformationMessage("Switched to profile: " + selected);
    }
  }));

  // Open How To webview.
  context.subscriptions.push(vscode.commands.registerCommand('extension.openHowTo', () => {
    const panel = vscode.window.createWebviewPanel(
      'howTo',
      'Project Context Copier - How To Use',
      vscode.ViewColumn.One,
      { enableScripts: false }
    );
    panel.webview.html = getHowToHtml();
  }));

  // Create a status bar button for Copy Context.
  const copyStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  copyStatusBar.command = 'extension.copyContext';
  copyStatusBar.text = '$(clippy) Copy Project Context';
  copyStatusBar.tooltip = 'Click to copy project context to clipboard';
  copyStatusBar.show();
  context.subscriptions.push(copyStatusBar);

  refreshViews();
}

function getHowToHtml(): string {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>How To Use Project Context Caddy</title>
    <style>
      body { font-family: sans-serif; padding: 20px; }
      h1 { color: #007ACC; }
      h2 { color: #005A9E; }
      ul { margin: 0 0 20px 20px; }
      code { background-color: #f3f3f3; padding: 2px 4px; }
    </style>
  </head>
  <body>
    <h1>What the heck is Context Caddy</h1>
    <p>Context Caddy lets you use Claude, ChatGPT, or any other AI model on the web without having to constantly re-copy the text from the relevant files every time.</p>
    <p>Great for those of us that don't want to pay extra for API keys to plug into tools like Cursor.</p>
    <h2>How to do it</h2>
    <ul>
      <li><strong>Select things:</strong> Use the <em>Project File Selector</em> tree and click on the files you want in context. Selected files are marked with a “[x]”, and they're added to the "Files Selected" area.</li>
      <li><strong>Toggle All:</strong> Use the <em>Select All / Unselect All</em> buttons (in the title bar under the pre-prompt) to quickly add or remove all files.</li>
      <li><strong>Pre-Prompt:</strong> For the files you selected, you can use the "Pre-Prompt" to always prepend the contents of the files you select - use it to give the AI model context you always keep typing.  Also, try adding comments to the top of your files for file specific notes.</li>
      <li><strong>Profiles:</strong> Create, rename, and switch profiles so you can save different file selections and pre-prompts for different parts of your codebase.  Good for keeping token counts down.</li>
      <li><strong>Copy Context:</strong> The <em>Copy Context!</em> buttons on the status bar and title bars copies your pre-prompt along with all text of the selected files AND their names relative to the workspace root so the AI knows what it's looking at.</li>
    </ul>
    <p>If you move, rename, or delete something, it won't appear in your copied context. Reselect those files in the hierarchy.</p>
    <p>Enjoy!</p>
  </body>
  </html>
  `;
}

export function deactivate() { }

class ProjectContextProvider implements vscode.TreeDataProvider<FileNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<FileNode | null> = new vscode.EventEmitter<FileNode | null>();
  public readonly onDidChangeTreeData: vscode.Event<FileNode | null> = this._onDidChangeTreeData.event;
  public selectedFiles: { [key: string]: boolean };

  constructor(selectedFiles: { [key: string]: boolean }) {
    this.selectedFiles = selectedFiles;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(null);
  }

  getTreeItem(element: FileNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FileNode): Thenable<FileNode[]> {
    if (!vscode.workspace.workspaceFolders) {
      vscode.window.showInformationMessage('No workspace folder open');
      return Promise.resolve([]);
    }
    if (element) {
      return Promise.resolve(this.readDir(element.resourceUri.fsPath));
    } else {
      let roots: FileNode[] = [];
      for (const folder of vscode.workspace.workspaceFolders) {
        roots.push(new FileNode(folder.uri, folder.name, true, this.selectedFiles));
      }
      return Promise.resolve(roots);
    }
  }

  private readDir(dir: string): FileNode[] {
    let items: FileNode[] = [];
    try {
      const entries = fs.readdirSync(dir);
      for (let entry of entries) {
        const fullPath = path.join(dir, entry);
        try {
          const stat = fs.statSync(fullPath);
          const isDirectory = stat.isDirectory();
          items.push(new FileNode(vscode.Uri.file(fullPath), entry, isDirectory, this.selectedFiles));
        } catch (err) {
          console.error("Error reading stats for: " + fullPath, err);
        }
      }
    } catch (error) {
      console.error("Error reading directory: " + dir, error);
    }
    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return (a.label as string).localeCompare(b.label as string);
    });
    return items;
  }
}

class FileNode extends vscode.TreeItem {
  public isDirectory: boolean;
  constructor(
    public readonly resourceUri: vscode.Uri,
    label: string,
    isDirectory: boolean,
    private selectedFiles: { [key: string]: boolean }
  ) {
    super(label, isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.isDirectory = isDirectory;
    this.updateLabel();
    if (!this.isDirectory) {
      this.command = {
        command: 'extension.toggleSelection',
        title: 'Toggle File Selection',
        arguments: [this]
      };
    }
  }
  updateLabel() {
    this.label = path.basename(this.resourceUri.fsPath);
    this.description = this.selectedFiles[this.resourceUri.fsPath] ? "[x]" : "";
  }
}

class SelectedFilesProvider implements vscode.TreeDataProvider<SelectedFileNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<SelectedFileNode | null> = new vscode.EventEmitter<SelectedFileNode | null>();
  public readonly onDidChangeTreeData: vscode.Event<SelectedFileNode | null> = this._onDidChangeTreeData.event;
  public selectedFiles: { [key: string]: boolean };

  constructor(selectedFiles: { [key: string]: boolean }) {
    this.selectedFiles = selectedFiles;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(null);
  }

  getTreeItem(element: SelectedFileNode): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<SelectedFileNode[]> {
    let nodes: SelectedFileNode[] = [];
    const filePaths = Object.keys(this.selectedFiles);
    for (let filePath of filePaths) {
      let workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : "";
      let relPath = workspaceFolder ? path.relative(workspaceFolder, filePath) : filePath;
      nodes.push(new SelectedFileNode(filePath, relPath));
    }
    return Promise.resolve(nodes);
  }
}

class SelectedFileNode extends vscode.TreeItem {
  constructor(public filePath: string, label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: 'extension.removeFromContext',
      title: 'Remove from Context',
      arguments: [this]
    };
    this.contextValue = "selectedFile";
  }
}
