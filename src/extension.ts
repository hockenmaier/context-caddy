import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

interface Profile {
  selectedFiles: { [key: string]: boolean };
  prePrompt: string;
  includeFileTree: boolean;
}

interface Config {
  profiles: { [key: string]: Profile };
  activeProfile: string;
}

let config: Config;
let configFilePath: string | undefined;

function getConfigFilePath(): string | undefined {
  if (
    !vscode.workspace.workspaceFolders ||
    vscode.workspace.workspaceFolders.length === 0
  ) {
    return undefined;
  }
  return path.join(
    vscode.workspace.workspaceFolders[0].uri.fsPath,
    "contextcaddy-config.json"
  );
}

function loadConfig(): Config {
  const filePath = getConfigFilePath();
  let defaultConfig: Config = {
    profiles: {
      default: { selectedFiles: {}, prePrompt: "", includeFileTree: false },
    },
    activeProfile: "default",
  };
  if (!filePath) {
    vscode.window.showErrorMessage(
      "No workspace folder open. Config cannot be loaded."
    );
    return defaultConfig;
  }
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Config;
      if (!parsed.profiles["default"]) {
        parsed.profiles["default"] = {
          selectedFiles: {},
          prePrompt: "",
          includeFileTree: false,
        };
      }
      for (const key in parsed.profiles) {
        if (parsed.profiles[key].includeFileTree === undefined) {
          parsed.profiles[key].includeFileTree = false;
        }
      }
      if (!parsed.activeProfile || !parsed.profiles[parsed.activeProfile]) {
        parsed.activeProfile = "default";
      }
      const workspaceFolderPath =
        vscode.workspace.workspaceFolders &&
        vscode.workspace.workspaceFolders.length > 0
          ? vscode.workspace.workspaceFolders[0].uri.fsPath
          : undefined;
      if (workspaceFolderPath) {
        for (const profileName in parsed.profiles) {
          const profile = parsed.profiles[profileName];
          const newSelectedFiles: { [key: string]: boolean } = {};
          for (const file of Object.keys(profile.selectedFiles)) {
            if (path.isAbsolute(file)) {
              const rel = path.relative(workspaceFolderPath, file);
              newSelectedFiles[rel] = profile.selectedFiles[file];
            } else {
              newSelectedFiles[file] = profile.selectedFiles[file];
            }
          }
          profile.selectedFiles = newSelectedFiles;
        }
      }
      return parsed;
    } catch (e) {
      vscode.window.showErrorMessage(
        "Error parsing config file. Using default configuration."
      );
    }
  }
  return defaultConfig;
}

function saveConfig() {
  const filePath = getConfigFilePath();
  if (!filePath) {
    vscode.window.showErrorMessage(
      "No workspace folder open. Config cannot be saved."
    );
    return;
  }
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
}

async function getAllFilesAsync(dir: string): Promise<string[]> {
  let results: string[] = [];
  let list: string[];
  try {
    list = await fs.promises.readdir(dir);
  } catch (e) {
    return results;
  }
  for (const file of list) {
    const fullPath = path.join(dir, file);
    let stat;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results = results.concat(await getAllFilesAsync(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

async function buildMinimalFileTreeAsync(
  dir: string,
  includePaths: Set<string>,
  indent: string
): Promise<string> {
  let result = "";
  let items: string[];
  try {
    items = await fs.promises.readdir(dir);
  } catch {
    return result;
  }
  items.sort((a, b) => a.localeCompare(b));
  for (const item of items) {
    const fullPath = path.join(dir, item);
    let stat;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      result += indent + item + "/\n";
      if (includePaths.has(fullPath)) {
        result += await buildMinimalFileTreeAsync(
          fullPath,
          includePaths,
          indent + "  "
        );
      }
    } else {
      result += indent + item + "\n";
    }
  }
  return result;
}

async function updateAllSelectedContext(activeFiles: {
  [key: string]: boolean;
}) {
  let allFiles: string[] = [];
  if (vscode.workspace.workspaceFolders) {
    for (const folder of vscode.workspace.workspaceFolders) {
      allFiles = allFiles.concat(await getAllFilesAsync(folder.uri.fsPath));
    }
  }
  const selectedCount = Object.keys(activeFiles).length;
  const allSelected = allFiles.length > 0 && selectedCount === allFiles.length;
  await vscode.commands.executeCommand(
    "setContext",
    "allSelected",
    allSelected
  );
}

export function activate(context: vscode.ExtensionContext) {
  configFilePath = getConfigFilePath();
  config = loadConfig();
  let activeProfile = config.profiles[config.activeProfile];
  let prePrompt = activeProfile.prePrompt;

  const projectProvider = new ProjectContextProvider(
    activeProfile.selectedFiles
  );
  vscode.window.createTreeView("projectContext", {
    treeDataProvider: projectProvider,
  });
  const selectedProvider = new SelectedFilesProvider(
    activeProfile.selectedFiles
  );
  const selectedTreeView = vscode.window.createTreeView("selectedFilesView", {
    treeDataProvider: selectedProvider,
  });

  const toggleStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99
  );
  toggleStatusBar.command = "extension.toggleIncludeFileTree";
  updateToggleStatusBar();
  toggleStatusBar.show();
  context.subscriptions.push(toggleStatusBar);

  function updateToggleStatusBar() {
    toggleStatusBar.text = activeProfile.includeFileTree
      ? "Copy File Tree: On"
      : "Copy File Tree: Off";
    toggleStatusBar.tooltip =
      "Click to toggle inclusion of file tree in Context Caddy copy";
  }

  async function refreshViews() {
    projectProvider.refresh();
    selectedProvider.refresh();
    await updateAllSelectedContext(activeProfile.selectedFiles);
    let text = prePrompt + "\n\n";

    if (activeProfile.includeFileTree && vscode.workspace.workspaceFolders) {
      let fileTreeText = "";
      for (const folder of vscode.workspace.workspaceFolders) {
        const workspacePath = folder.uri.fsPath;
        const includePaths = new Set<string>();
        for (const fileKey of Object.keys(activeProfile.selectedFiles)) {
          const absPath = path.isAbsolute(fileKey)
            ? fileKey
            : path.join(workspacePath, fileKey);
          if (absPath.startsWith(workspacePath)) {
            let current = path.dirname(absPath);
            while (current.startsWith(workspacePath)) {
              includePaths.add(current);
              const parent = path.dirname(current);
              if (parent === current) break;
              current = parent;
            }
          }
        }
        fileTreeText += `Project: ${folder.name}\n`;
        fileTreeText += await buildMinimalFileTreeAsync(
          workspacePath,
          includePaths,
          "  "
        );
      }
      text +=
        "Here is the structure of the project as it relates to the file contents below:\n";
      text += fileTreeText + "\n";
    }

    const selectedKeys = Object.keys(activeProfile.selectedFiles);
    for (const fileKey of selectedKeys) {
      let absPath = fileKey;
      if (
        !path.isAbsolute(fileKey) &&
        vscode.workspace.workspaceFolders &&
        vscode.workspace.workspaceFolders.length > 0
      ) {
        absPath = path.join(
          vscode.workspace.workspaceFolders[0].uri.fsPath,
          fileKey
        );
      }
      try {
        const stat = await fs.promises.stat(absPath);
        if (stat.isFile()) {
          const content = await fs.promises.readFile(absPath, "utf8");
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(
            vscode.Uri.file(absPath)
          );
          const relPath = workspaceFolder
            ? path.relative(workspaceFolder.uri.fsPath, absPath)
            : absPath;
          text += `----- ${relPath} -----\n${content}\n\n`;
        }
      } catch (error) {
        console.error("Error reading file: " + absPath, error);
      }
    }
    const approxTokens = Math.ceil(text.length / 4.3);
    (
      selectedTreeView as any
    ).message = `Profile: ${config.activeProfile} | Approx tokens: ${approxTokens}`;
  }

  const fsWatcher = vscode.workspace.createFileSystemWatcher("**/*");
  fsWatcher.onDidCreate(() => {
    projectProvider.refresh();
    refreshViews();
  });
  fsWatcher.onDidDelete(() => {
    projectProvider.refresh();
    refreshViews();
  });
  fsWatcher.onDidChange(() => {
    projectProvider.refresh();
    refreshViews();
  });
  context.subscriptions.push(fsWatcher);

  if (configFilePath) {
    const configWatcher =
      vscode.workspace.createFileSystemWatcher(configFilePath);
    configWatcher.onDidChange(() => {
      config = loadConfig();
      activeProfile = config.profiles[config.activeProfile];
      prePrompt = activeProfile.prePrompt;
      projectProvider.selectedFiles = activeProfile.selectedFiles;
      selectedProvider.selectedFiles = activeProfile.selectedFiles;
      updateToggleStatusBar();
      refreshViews();
    });
    context.subscriptions.push(configWatcher);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.toggleSelection",
      (node: FileNode) => {
        const fileAbsPath = node.resourceUri.fsPath;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(
          vscode.Uri.file(fileAbsPath)
        );
        const relPath = workspaceFolder
          ? path.relative(workspaceFolder.uri.fsPath, fileAbsPath)
          : fileAbsPath;
        if (activeProfile.selectedFiles[relPath]) {
          delete activeProfile.selectedFiles[relPath];
        } else {
          activeProfile.selectedFiles[relPath] = true;
        }
        config.profiles[config.activeProfile] = activeProfile;
        saveConfig();
        refreshViews();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.removeFromContext",
      (node: SelectedFileNode) => {
        const fileKey = node.filePath;
        if (activeProfile.selectedFiles[fileKey]) {
          delete activeProfile.selectedFiles[fileKey];
          config.profiles[config.activeProfile] = activeProfile;
          saveConfig();
          refreshViews();
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("extension.setPrePrompt", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Enter Pre-Prompt",
        value: prePrompt,
      });
      if (input !== undefined) {
        prePrompt = input;
        activeProfile.prePrompt = prePrompt;
        config.profiles[config.activeProfile] = activeProfile;
        saveConfig();
        vscode.window.showInformationMessage(
          "Pre-Prompt saved for profile: " + config.activeProfile
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("extension.toggleIncludeFileTree", () => {
      activeProfile.includeFileTree = !activeProfile.includeFileTree;
      config.profiles[config.activeProfile] = activeProfile;
      saveConfig();
      updateToggleStatusBar();
      vscode.window.showInformationMessage(
        "Include File Tree " +
          (activeProfile.includeFileTree ? "Enabled" : "Disabled")
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("extension.copyContext", async () => {
      let text = prePrompt + "\n\n";
      if (activeProfile.includeFileTree && vscode.workspace.workspaceFolders) {
        let fileTreeText = "";
        for (const folder of vscode.workspace.workspaceFolders) {
          const workspacePath = folder.uri.fsPath;
          const includePaths = new Set<string>();
          for (const fileKey of Object.keys(activeProfile.selectedFiles)) {
            const absPath = path.isAbsolute(fileKey)
              ? fileKey
              : path.join(workspacePath, fileKey);
            if (absPath.startsWith(workspacePath)) {
              let current = path.dirname(absPath);
              while (current.startsWith(workspacePath)) {
                includePaths.add(current);
                const parent = path.dirname(current);
                if (parent === current) break;
                current = parent;
              }
            }
          }
          fileTreeText += `Project: ${folder.name}\n`;
          fileTreeText += await buildMinimalFileTreeAsync(
            workspacePath,
            includePaths,
            "  "
          );
        }
        text +=
          "Here is the structure of the project as it relates to the file contents below:\n";
        text += fileTreeText + "\n";
      }
      const selectedKeys = Object.keys(activeProfile.selectedFiles);
      for (const fileKey of selectedKeys) {
        let absPath = fileKey;
        if (
          !path.isAbsolute(fileKey) &&
          vscode.workspace.workspaceFolders &&
          vscode.workspace.workspaceFolders.length > 0
        ) {
          absPath = path.join(
            vscode.workspace.workspaceFolders[0].uri.fsPath,
            fileKey
          );
        }
        try {
          const stat = await fs.promises.stat(absPath);
          if (stat.isFile()) {
            const content = await fs.promises.readFile(absPath, "utf8");
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(
              vscode.Uri.file(absPath)
            );
            const relPath = workspaceFolder
              ? path.relative(workspaceFolder.uri.fsPath, absPath)
              : absPath;
            text += `----- ${relPath} -----\n${content}\n\n`;
          }
        } catch (error) {
          console.error("Error reading file: " + absPath, error);
        }
      }
      await vscode.env.clipboard.writeText(text);
      const approxTokens = Math.ceil(text.length / 4.3);
      vscode.window.showInformationMessage(
        `Context copied. Approx tokens: ${approxTokens}`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.selectAllInFolder",
      async (node: FileNode) => {
        const folderPath = node.resourceUri.fsPath;
        const files = await getAllFilesAsync(folderPath);
        for (const file of files) {
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(
            vscode.Uri.file(file)
          );
          const relPath = workspaceFolder
            ? path.relative(workspaceFolder.uri.fsPath, file)
            : file;
          activeProfile.selectedFiles[relPath] = true;
        }
        config.profiles[config.activeProfile] = activeProfile;
        saveConfig();
        refreshViews();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.unselectAllInFolder",
      async (node: FileNode) => {
        const folderPath = node.resourceUri.fsPath;
        const files = await getAllFilesAsync(folderPath);
        for (const file of files) {
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(
            vscode.Uri.file(file)
          );
          const relPath = workspaceFolder
            ? path.relative(workspaceFolder.uri.fsPath, file)
            : file;
          delete activeProfile.selectedFiles[relPath];
        }
        config.profiles[config.activeProfile] = activeProfile;
        saveConfig();
        refreshViews();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("extension.newProfile", async () => {
      const profileName = await vscode.window.showInputBox({
        prompt: "Enter new profile name",
      });
      if (profileName && !config.profiles[profileName]) {
        config.profiles[profileName] = {
          selectedFiles: {},
          prePrompt: "",
          includeFileTree: false,
        };
        config.activeProfile = profileName;
        activeProfile = config.profiles[profileName];
        projectProvider.selectedFiles = activeProfile.selectedFiles;
        selectedProvider.selectedFiles = activeProfile.selectedFiles;
        saveConfig();
        refreshViews();
        vscode.window.showInformationMessage(
          "New profile created and activated: " + profileName
        );
      } else if (profileName) {
        vscode.window.showErrorMessage("Profile already exists.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("extension.renameProfile", async () => {
      const newName = await vscode.window.showInputBox({
        prompt: "Enter new name for current profile",
        value: config.activeProfile,
      });
      if (newName && newName !== config.activeProfile) {
        if (config.profiles[newName]) {
          vscode.window.showErrorMessage(
            "A profile with that name already exists."
          );
        } else {
          config.profiles[newName] = activeProfile;
          delete config.profiles[config.activeProfile];
          config.activeProfile = newName;
          activeProfile = config.profiles[newName];
          saveConfig();
          refreshViews();
          vscode.window.showInformationMessage(
            "Profile renamed to: " + newName
          );
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("extension.switchProfile", async () => {
      const profileNames = Object.keys(config.profiles);
      const selected = await vscode.window.showQuickPick(profileNames, {
        placeHolder: "Select profile",
      });
      if (selected) {
        config.activeProfile = selected;
        activeProfile = config.profiles[selected];
        prePrompt = activeProfile.prePrompt;
        projectProvider.selectedFiles = activeProfile.selectedFiles;
        selectedProvider.selectedFiles = activeProfile.selectedFiles;
        saveConfig();
        updateToggleStatusBar();
        refreshViews();
        vscode.window.showInformationMessage(
          "Switched to profile: " + selected
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("extension.openHowTo", () => {
      const panel = vscode.window.createWebviewPanel(
        "howTo",
        "Project Context Copier - How To Use",
        vscode.ViewColumn.One,
        { enableScripts: false }
      );
      panel.webview.html = getHowToHtml();
    })
  );

  const copyStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  copyStatusBar.command = "extension.copyContext";
  copyStatusBar.text = "$(clippy) Copy Context Caddy";
  copyStatusBar.tooltip =
    "Click to copy the full text and names of the files you selected in Context Caddy";
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
      <li><strong>Folder buttons:</strong> In the Project File Selector each folder now has two inline buttons (“All” and “None”) that select or unselect all files in that folder and its subfolders.</li>
      <li><strong>Pre-Prompt:</strong> For the files you selected, you can use the "Pre-Prompt" to always prepend the contents of the files you select.</li>
      <li><strong>Profiles:</strong> Create, rename, and switch profiles so you can save different file selections and pre-prompts.</li>
      <li><strong>Copy Context:</strong> The Copy Context buttons copy your pre-prompt along with all text of the selected files plus their relative paths.</li>
    </ul>
    <p>If you move, rename, or delete something, it won't appear in your copied context. Reselect those files in the hierarchy.</p>
    <p>Enjoy!</p>
  </body>
  </html>
  `;
}

export function deactivate() {}

// Async helper to build a minimal file tree.
async function buildMinimalFileTreeAsyncWrapper(
  dir: string,
  includePaths: Set<string>,
  indent: string
): Promise<string> {
  return await buildMinimalFileTreeAsync(dir, includePaths, indent);
}

class ProjectContextProvider implements vscode.TreeDataProvider<FileNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<FileNode | null> =
    new vscode.EventEmitter<FileNode | null>();
  public readonly onDidChangeTreeData: vscode.Event<FileNode | null> =
    this._onDidChangeTreeData.event;
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

  async getChildren(element?: FileNode): Promise<FileNode[]> {
    if (!vscode.workspace.workspaceFolders) {
      vscode.window.showInformationMessage("No workspace folder open");
      return [];
    }
    if (element) {
      return await this.readDirAsync(element.resourceUri.fsPath);
    } else {
      let roots: FileNode[] = [];
      for (const folder of vscode.workspace.workspaceFolders) {
        roots.push(
          new FileNode(folder.uri, folder.name, true, this.selectedFiles)
        );
      }
      return roots;
    }
  }

  private async readDirAsync(dir: string): Promise<FileNode[]> {
    let items: FileNode[] = [];
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch (error) {
      console.error("Error reading directory: " + dir, error);
      return items;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = await fs.promises.stat(fullPath);
        items.push(
          new FileNode(
            vscode.Uri.file(fullPath),
            entry,
            stat.isDirectory(),
            this.selectedFiles
          )
        );
      } catch (err) {
        console.error("Error reading stats for: " + fullPath, err);
      }
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
    super(
      label,
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    this.isDirectory = isDirectory;
    if (isDirectory) {
      this.contextValue = "folder";
    }
    this.updateLabel();
    if (!this.isDirectory) {
      this.command = {
        command: "extension.toggleSelection",
        title: "Toggle File Selection",
        arguments: [this],
      };
    }
  }
  updateLabel() {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      this.resourceUri
    );
    const fileKey = workspaceFolder
      ? path.relative(workspaceFolder.uri.fsPath, this.resourceUri.fsPath)
      : this.resourceUri.fsPath;
    this.label = path.basename(this.resourceUri.fsPath);
    this.description = this.selectedFiles[fileKey] ? "[x]" : "";
  }
}

class SelectedFilesProvider
  implements vscode.TreeDataProvider<SelectedFileNode>
{
  private _onDidChangeTreeData: vscode.EventEmitter<SelectedFileNode | null> =
    new vscode.EventEmitter<SelectedFileNode | null>();
  public readonly onDidChangeTreeData: vscode.Event<SelectedFileNode | null> =
    this._onDidChangeTreeData.event;
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

  async getChildren(): Promise<SelectedFileNode[]> {
    let nodes: SelectedFileNode[] = [];
    const filePaths = Object.keys(this.selectedFiles);
    const workspaceFolderPath =
      vscode.workspace.workspaceFolders &&
      vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : "";
    for (const filePath of filePaths) {
      let displayPath = filePath;
      if (path.isAbsolute(filePath) && workspaceFolderPath) {
        displayPath = path.relative(workspaceFolderPath, filePath);
      }
      nodes.push(new SelectedFileNode(filePath, displayPath));
    }
    return nodes;
  }
}

class SelectedFileNode extends vscode.TreeItem {
  constructor(public filePath: string, label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: "extension.removeFromContext",
      title: "Remove from Context",
      arguments: [this],
    };
    this.contextValue = "selectedFile";
  }
}
