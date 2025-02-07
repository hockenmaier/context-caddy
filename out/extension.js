"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
let config;
let configFilePath;
function getConfigFilePath() {
    if (!vscode.workspace.workspaceFolders ||
        vscode.workspace.workspaceFolders.length === 0) {
        return undefined;
    }
    return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "contextcaddy-config.json");
}
function loadConfig() {
    const filePath = getConfigFilePath();
    let defaultConfig = {
        profiles: {
            default: { selectedFiles: {}, prePrompt: "", includeFileTree: false },
        },
        activeProfile: "default",
    };
    if (!filePath) {
        vscode.window.showErrorMessage("No workspace folder open. Config cannot be loaded.");
        return defaultConfig;
    }
    if (fs.existsSync(filePath)) {
        try {
            const raw = fs.readFileSync(filePath, "utf8");
            const parsed = JSON.parse(raw);
            if (!parsed.profiles["default"]) {
                parsed.profiles["default"] = {
                    selectedFiles: {},
                    prePrompt: "",
                    includeFileTree: false,
                };
            }
            // Ensure every profile has includeFileTree defined.
            for (const key in parsed.profiles) {
                if (parsed.profiles[key].includeFileTree === undefined) {
                    parsed.profiles[key].includeFileTree = false;
                }
            }
            if (!parsed.activeProfile || !parsed.profiles[parsed.activeProfile]) {
                parsed.activeProfile = "default";
            }
            return parsed;
        }
        catch (e) {
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
function getAllFiles(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach((file) => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
            results = results.concat(getAllFiles(fullPath));
        }
        else {
            results.push(fullPath);
        }
    });
    return results;
}
function updateAllSelectedContext(activeFiles) {
    return __awaiter(this, void 0, void 0, function* () {
        let allFiles = [];
        if (vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                allFiles = allFiles.concat(getAllFiles(folder.uri.fsPath));
            }
        }
        const selectedCount = Object.keys(activeFiles).length;
        const allSelected = allFiles.length > 0 && selectedCount === allFiles.length;
        yield vscode.commands.executeCommand("setContext", "allSelected", allSelected);
    });
}
function activate(context) {
    configFilePath = getConfigFilePath();
    config = loadConfig();
    let activeProfile = config.profiles[config.activeProfile];
    let prePrompt = activeProfile.prePrompt;
    const projectProvider = new ProjectContextProvider(activeProfile.selectedFiles);
    vscode.window.createTreeView("projectContext", {
        treeDataProvider: projectProvider,
    });
    const selectedProvider = new SelectedFilesProvider(activeProfile.selectedFiles);
    const selectedTreeView = vscode.window.createTreeView("selectedFilesView", {
        treeDataProvider: selectedProvider,
    });
    function refreshViews() {
        return __awaiter(this, void 0, void 0, function* () {
            projectProvider.refresh();
            selectedProvider.refresh();
            yield updateAllSelectedContext(activeProfile.selectedFiles);
            // Update token count in Files Selected view header (using message)
            let text = prePrompt + "\n\n";
            const selectedPaths = Object.keys(activeProfile.selectedFiles);
            for (let filePath of selectedPaths) {
                try {
                    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                        let content = fs.readFileSync(filePath, "utf8");
                        let workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
                        let relPath = workspaceFolder
                            ? path.relative(workspaceFolder.uri.fsPath, filePath)
                            : filePath;
                        text += `----- ${relPath} -----\n${content}\n\n`;
                    }
                }
                catch (error) {
                    console.error("Error reading file: " + filePath, error);
                }
            }
            const approxTokens = Math.ceil(text.length / 4.3);
            selectedTreeView.message = `Approx tokens: ${approxTokens}`;
        });
    }
    // Watch for file changes to refresh the project tree.
    const fsWatcher = vscode.workspace.createFileSystemWatcher("**/*");
    fsWatcher.onDidCreate(() => projectProvider.refresh());
    fsWatcher.onDidDelete(() => projectProvider.refresh());
    fsWatcher.onDidChange(() => projectProvider.refresh());
    context.subscriptions.push(fsWatcher);
    // Watch config file for external changes.
    if (configFilePath) {
        const configWatcher = vscode.workspace.createFileSystemWatcher(configFilePath);
        configWatcher.onDidChange(() => {
            config = loadConfig();
            activeProfile = config.profiles[config.activeProfile];
            prePrompt = activeProfile.prePrompt;
            projectProvider.selectedFiles = activeProfile.selectedFiles;
            selectedProvider.selectedFiles = activeProfile.selectedFiles;
            refreshViews();
        });
        context.subscriptions.push(configWatcher);
    }
    context.subscriptions.push(vscode.commands.registerCommand("extension.toggleSelection", (node) => {
        const filePath = node.resourceUri.fsPath;
        if (activeProfile.selectedFiles[filePath]) {
            delete activeProfile.selectedFiles[filePath];
        }
        else {
            activeProfile.selectedFiles[filePath] = true;
        }
        config.profiles[config.activeProfile] = activeProfile;
        saveConfig();
        refreshViews();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("extension.removeFromContext", (node) => {
        const filePath = node.filePath;
        if (activeProfile.selectedFiles[filePath]) {
            delete activeProfile.selectedFiles[filePath];
            config.profiles[config.activeProfile] = activeProfile;
            saveConfig();
            refreshViews();
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("extension.setPrePrompt", () => __awaiter(this, void 0, void 0, function* () {
        const input = yield vscode.window.showInputBox({
            prompt: "Enter Pre-Prompt",
            value: prePrompt,
        });
        if (input !== undefined) {
            prePrompt = input;
            activeProfile.prePrompt = prePrompt;
            config.profiles[config.activeProfile] = activeProfile;
            saveConfig();
            vscode.window.showInformationMessage("Pre-Prompt saved for profile: " + config.activeProfile);
        }
    })));
    // New command: toggle the Include File Tree setting.
    context.subscriptions.push(vscode.commands.registerCommand("extension.toggleIncludeFileTree", () => {
        activeProfile.includeFileTree = !activeProfile.includeFileTree;
        config.profiles[config.activeProfile] = activeProfile;
        saveConfig();
        vscode.window.showInformationMessage("Include File Tree " +
            (activeProfile.includeFileTree ? "Enabled" : "Disabled"));
    }));
    context.subscriptions.push(vscode.commands.registerCommand("extension.copyContext", () => __awaiter(this, void 0, void 0, function* () {
        let text = prePrompt + "\n\n";
        if (activeProfile.includeFileTree && vscode.workspace.workspaceFolders) {
            let fileTreeText = "";
            for (const folder of vscode.workspace.workspaceFolders) {
                const workspacePath = folder.uri.fsPath;
                const includePaths = new Set();
                // For each selected file under this workspace, add all its ancestors.
                for (const filePath of Object.keys(activeProfile.selectedFiles)) {
                    if (filePath.startsWith(workspacePath)) {
                        let current = path.dirname(filePath);
                        while (current.startsWith(workspacePath)) {
                            includePaths.add(current);
                            const parent = path.dirname(current);
                            if (parent === current)
                                break;
                            current = parent;
                        }
                    }
                }
                fileTreeText += `Project: ${folder.name}\n`;
                fileTreeText += buildMinimalFileTree(workspacePath, includePaths, "  ", true);
            }
            text +=
                "Here is the structure of the project as it relates to the file contents below:\n";
            text += fileTreeText + "\n";
        }
        const selectedPaths = Object.keys(activeProfile.selectedFiles);
        for (let filePath of selectedPaths) {
            try {
                if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                    let content = fs.readFileSync(filePath, "utf8");
                    let workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
                    let relPath = workspaceFolder
                        ? path.relative(workspaceFolder.uri.fsPath, filePath)
                        : filePath;
                    text += `----- ${relPath} -----\n${content}\n\n`;
                }
            }
            catch (error) {
                console.error("Error reading file: " + filePath, error);
            }
        }
        yield vscode.env.clipboard.writeText(text);
        const approxTokens = Math.ceil(text.length / 4.3);
        vscode.window.showInformationMessage(`Context copied. Approx tokens: ${approxTokens}`);
    })));
    context.subscriptions.push(vscode.commands.registerCommand("extension.selectAllInFolder", (node) => __awaiter(this, void 0, void 0, function* () {
        const folderPath = node.resourceUri.fsPath;
        const files = getAllFiles(folderPath);
        files.forEach((file) => (activeProfile.selectedFiles[file] = true));
        config.profiles[config.activeProfile] = activeProfile;
        saveConfig();
        refreshViews();
    })));
    context.subscriptions.push(vscode.commands.registerCommand("extension.unselectAllInFolder", (node) => __awaiter(this, void 0, void 0, function* () {
        const folderPath = node.resourceUri.fsPath;
        const files = getAllFiles(folderPath);
        files.forEach((file) => {
            delete activeProfile.selectedFiles[file];
        });
        config.profiles[config.activeProfile] = activeProfile;
        saveConfig();
        refreshViews();
    })));
    context.subscriptions.push(vscode.commands.registerCommand("extension.newProfile", () => __awaiter(this, void 0, void 0, function* () {
        const profileName = yield vscode.window.showInputBox({
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
            // Update providers to use the new profile's data:
            projectProvider.selectedFiles = activeProfile.selectedFiles;
            selectedProvider.selectedFiles = activeProfile.selectedFiles;
            saveConfig();
            refreshViews();
            vscode.window.showInformationMessage("New profile created and activated: " + profileName);
        }
        else if (profileName) {
            vscode.window.showErrorMessage("Profile already exists.");
        }
    })));
    context.subscriptions.push(vscode.commands.registerCommand("extension.renameProfile", () => __awaiter(this, void 0, void 0, function* () {
        const newName = yield vscode.window.showInputBox({
            prompt: "Enter new name for current profile",
            value: config.activeProfile,
        });
        if (newName && newName !== config.activeProfile) {
            if (config.profiles[newName]) {
                vscode.window.showErrorMessage("A profile with that name already exists.");
            }
            else {
                config.profiles[newName] = activeProfile;
                delete config.profiles[config.activeProfile];
                config.activeProfile = newName;
                activeProfile = config.profiles[newName];
                saveConfig();
                refreshViews();
                vscode.window.showInformationMessage("Profile renamed to: " + newName);
            }
        }
    })));
    context.subscriptions.push(vscode.commands.registerCommand("extension.switchProfile", () => __awaiter(this, void 0, void 0, function* () {
        const profileNames = Object.keys(config.profiles);
        const selected = yield vscode.window.showQuickPick(profileNames, {
            placeHolder: "Select profile",
        });
        if (selected) {
            config.activeProfile = selected;
            activeProfile = config.profiles[selected];
            prePrompt = activeProfile.prePrompt;
            // Update providers to point to the new profile’s selectedFiles:
            projectProvider.selectedFiles = activeProfile.selectedFiles;
            selectedProvider.selectedFiles = activeProfile.selectedFiles;
            saveConfig();
            refreshViews();
            vscode.window.showInformationMessage("Switched to profile: " + selected);
        }
    })));
    context.subscriptions.push(vscode.commands.registerCommand("extension.openHowTo", () => {
        const panel = vscode.window.createWebviewPanel("howTo", "Project Context Copier - How To Use", vscode.ViewColumn.One, { enableScripts: false });
        panel.webview.html = getHowToHtml();
    }));
    const copyStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    copyStatusBar.command = "extension.copyContext";
    copyStatusBar.text = "$(clippy) Context Caddy Copy";
    copyStatusBar.tooltip =
        "Click to copy the full text and names of the files you selected in Context Caddy";
    copyStatusBar.show();
    context.subscriptions.push(copyStatusBar);
    refreshViews();
}
exports.activate = activate;
function getHowToHtml() {
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
function deactivate() { }
exports.deactivate = deactivate;
// Helper: Build a minimal file tree string.
// It prints folder and file names with indentation. Only expands folders if
// they are at the root or are ancestors of a selected file.
function buildMinimalFileTree(dir, includePaths, indent, isRoot) {
    let result = "";
    const excluded = new Set(["node_modules", ".git", "dist", "build"]);
    let items;
    try {
        items = fs.readdirSync(dir);
    }
    catch (e) {
        return result;
    }
    items.sort((a, b) => a.localeCompare(b));
    for (const item of items) {
        const fullPath = path.join(dir, item);
        let stat;
        try {
            stat = fs.statSync(fullPath);
        }
        catch (e) {
            continue;
        }
        if (stat.isDirectory()) {
            result += indent + item + "/\n";
            if (isRoot || includePaths.has(fullPath)) {
                if (excluded.has(item) && !includePaths.has(fullPath)) {
                    continue;
                }
                result += buildMinimalFileTree(fullPath, includePaths, indent + "  ", false);
            }
        }
        else {
            result += indent + item + "\n";
        }
    }
    return result;
}
class ProjectContextProvider {
    constructor(selectedFiles) {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.selectedFiles = selectedFiles;
    }
    refresh() {
        this._onDidChangeTreeData.fire(null);
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showInformationMessage("No workspace folder open");
            return Promise.resolve([]);
        }
        if (element) {
            return Promise.resolve(this.readDir(element.resourceUri.fsPath));
        }
        else {
            let roots = [];
            for (const folder of vscode.workspace.workspaceFolders) {
                roots.push(new FileNode(folder.uri, folder.name, true, this.selectedFiles));
            }
            return Promise.resolve(roots);
        }
    }
    readDir(dir) {
        let items = [];
        try {
            const entries = fs.readdirSync(dir);
            for (let entry of entries) {
                const fullPath = path.join(dir, entry);
                try {
                    const stat = fs.statSync(fullPath);
                    const isDirectory = stat.isDirectory();
                    items.push(new FileNode(vscode.Uri.file(fullPath), entry, isDirectory, this.selectedFiles));
                }
                catch (err) {
                    console.error("Error reading stats for: " + fullPath, err);
                }
            }
        }
        catch (error) {
            console.error("Error reading directory: " + dir, error);
        }
        items.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory)
                return -1;
            if (!a.isDirectory && b.isDirectory)
                return 1;
            return a.label.localeCompare(b.label);
        });
        return items;
    }
}
class FileNode extends vscode.TreeItem {
    constructor(resourceUri, label, isDirectory, selectedFiles) {
        super(label, isDirectory
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        this.resourceUri = resourceUri;
        this.selectedFiles = selectedFiles;
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
        this.label = path.basename(this.resourceUri.fsPath);
        this.description = this.selectedFiles[this.resourceUri.fsPath] ? "[x]" : "";
    }
}
class SelectedFilesProvider {
    constructor(selectedFiles) {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.selectedFiles = selectedFiles;
    }
    refresh() {
        this._onDidChangeTreeData.fire(null);
    }
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        let nodes = [];
        const filePaths = Object.keys(this.selectedFiles);
        for (let filePath of filePaths) {
            let workspaceFolder = vscode.workspace.workspaceFolders
                ? vscode.workspace.workspaceFolders[0].uri.fsPath
                : "";
            let relPath = workspaceFolder
                ? path.relative(workspaceFolder, filePath)
                : filePath;
            nodes.push(new SelectedFileNode(filePath, relPath));
        }
        return Promise.resolve(nodes);
    }
}
class SelectedFileNode extends vscode.TreeItem {
    constructor(filePath, label) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.filePath = filePath;
        this.command = {
            command: "extension.removeFromContext",
            title: "Remove from Context",
            arguments: [this],
        };
        this.contextValue = "selectedFile";
    }
}
//# sourceMappingURL=extension.js.map