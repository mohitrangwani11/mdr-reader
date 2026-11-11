/**
 * mdr for VS Code.
 *  - Activity bar "mdr" → native "Agent files" view (badge = files changed since last read).
 *  - The reader opens as one shared editor tab (panel.ts).
 *  - Status bar item when something changed; editor title / explorer "Open in mdr"; ⌘⌥M.
 *  - Language-model tools so Copilot agent mode can list, open and summarise agent files.
 * The disk side is the CLI's Workspace (same discovery, imports, snapshots in ~/.mdr).
 */
import * as vscode from 'vscode';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { createWorkspace, type Workspace, type WatchFactory } from '../../cli/src/workspace.ts';
import { Store } from '../../cli/src/store.ts';
import type { FileEntry, FileGroup } from '@mdr/core/model';
import { ReaderPanel, VIEW_TYPE, type PanelDeps } from './panel.ts';
import { resolveName, formatFileList, formatChanges, formatOutline, changeCount } from './agent.ts';

const store = new Store();

/* ---- watching through VS Code's file watcher ------------------------------------------- */
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    try {
      return path.join(realpathSync.native(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}

const vscodeWatch: WatchFactory = (t) => {
  const watchers: vscode.FileSystemWatcher[] = [];
  const hook = (pattern: vscode.RelativePattern) => {
    const w = vscode.workspace.createFileSystemWatcher(pattern);
    const on = (kind: 'add' | 'change' | 'unlink') => (uri: vscode.Uri) => {
      const abs = real(uri.fsPath);
      if (!t.ignored(abs)) t.onFs(kind, abs);
    };
    w.onDidCreate(on('add'));
    w.onDidChange(on('change'));
    w.onDidDelete(on('unlink'));
    watchers.push(w);
  };
  if (t.singleFile) hook(new vscode.RelativePattern(vscode.Uri.file(path.dirname(t.singleFile)), path.basename(t.singleFile)));
  else hook(new vscode.RelativePattern(vscode.Uri.file(t.root), '**/*.{md,markdown,mdx,mdc}'));
  return {
    add: (abs) => hook(new vscode.RelativePattern(vscode.Uri.file(path.dirname(abs)), path.basename(abs))),
    close: () => watchers.forEach((w) => w.dispose()),
  };
};

/* ---- workspaces ----------------------------------------------------------------------------- */
interface Folder {
  name: string;
  ws: Workspace;
  groups: FileGroup[];
}

class Workspaces implements vscode.Disposable {
  private byRoot = new Map<string, Promise<Workspace>>();
  folders: Folder[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  /** File lists or unread state changed. */
  readonly onDidChange = this.emitter.event;
  private timer: NodeJS.Timeout | undefined;

  private get(target: string): Promise<Workspace> {
    const key = real(target);
    let p = this.byRoot.get(key);
    if (!p) {
      p = createWorkspace({ target: key, store, watch: vscodeWatch }).then((ws) => {
        ws.onEvent(() => this.soon());
        ws.onDidMarkRead(() => this.soon(50));
        return ws;
      });
      p.catch(() => this.byRoot.delete(key));
      this.byRoot.set(key, p);
    }
    return p;
  }

  /** Re-scan every workspace folder. */
  async refresh(): Promise<void> {
    const roots = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    this.folders = (
      await Promise.all(
        roots.map(async (f) => {
          try {
            const ws = await this.get(f.uri.fsPath);
            return { name: f.name, ws, groups: await ws.listFiles() };
          } catch {
            return null;
          }
        }),
      )
    ).filter((x): x is Folder => !!x);
    this.emitter.fire();
  }

  soon(ms = 300) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), ms);
  }

  /** The workspace and id for a file on disk (a loose file gets its own single-file workspace). */
  async forUri(uri: vscode.Uri): Promise<{ ws: Workspace; id: string }> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const ws = await this.get(folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : uri.fsPath);
    return { ws, id: ws.toId(real(uri.fsPath)) };
  }

  all(): { folder: Folder; file: FileEntry }[] {
    return this.folders.flatMap((folder) => folder.groups.flatMap((g) => g.files.map((file) => ({ folder, file }))));
  }

  unread() {
    return this.all().filter((x) => x.file.unread);
  }

  dispose() {
    clearTimeout(this.timer);
    for (const p of this.byRoot.values()) void p.then((ws) => ws.close(), () => {});
    this.emitter.dispose();
  }
}

/* ---- the Agent files view ------------------------------------------------------------------- */
type Node = { kind: 'folder'; folder: Folder } | { kind: 'group'; folder: Folder; group: FileGroup } | { kind: 'file'; folder: Folder; file: FileEntry };

class FilesView implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly spaces: Workspaces) {
    spaces.onDidChange(() => this.emitter.fire(undefined));
  }

  getChildren(n?: Node): Node[] {
    const f = this.spaces.folders;
    if (!n) {
      if (f.length === 1) return f[0].groups.map((group) => ({ kind: 'group', folder: f[0], group }));
      return f.filter((x) => x.groups.length).map((folder) => ({ kind: 'folder', folder }));
    }
    if (n.kind === 'folder') return n.folder.groups.map((group) => ({ kind: 'group', folder: n.folder, group }));
    if (n.kind === 'group') return n.group.files.map((file) => ({ kind: 'file', folder: n.folder, file }));
    return [];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'folder') {
      const it = new vscode.TreeItem(n.folder.name, vscode.TreeItemCollapsibleState.Expanded);
      it.iconPath = vscode.ThemeIcon.Folder;
      it.id = `f:${n.folder.ws.root}`;
      return it;
    }
    if (n.kind === 'group') {
      const showAll = vscode.workspace.getConfiguration('mdr').get<boolean>('showAllMarkdown');
      const collapsed = n.group.name === 'Other' && !showAll;
      const it = new vscode.TreeItem(n.group.name, collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      const unread = n.group.files.filter((x) => x.unread).length;
      it.description = unread ? `${n.group.files.length} · ${unread} changed` : String(n.group.files.length);
      it.id = `g:${n.folder.ws.root}:${n.group.name}`;
      it.contextValue = 'mdr.group';
      return it;
    }
    const { file, folder } = n;
    const abs = path.join(folder.ws.root, file.path);
    const it = new vscode.TreeItem(file.name, vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(file.path);
    const where = dir === '.' ? '' : file.name === path.posix.basename(file.path) ? dir : file.path;
    it.id = `p:${abs}`;
    it.resourceUri = vscode.Uri.file(abs);
    it.description = file.unread ? (where ? `changed · ${where}` : 'changed') : where;
    it.tooltip = new vscode.MarkdownString(`**${file.path}**${file.unread ? '\n\nChanged since you last read it. Open to see what changed.' : ''}`);
    if (file.unread) it.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
    it.command = { command: 'mdr.openFile', title: 'Open in mdr', arguments: [vscode.Uri.file(abs)] };
    it.contextValue = file.unread ? 'mdr.file.unread' : 'mdr.file';
    return it;
  }
}

/* ---- activation --------------------------------------------------------------------------------- */
export function activate(ctx: vscode.ExtensionContext) {
  const spaces = new Workspaces();
  const view = vscode.window.createTreeView('mdr.files', { treeDataProvider: new FilesView(spaces), showCollapseAll: true });
  const status = vscode.window.createStatusBarItem('mdr.changes', vscode.StatusBarAlignment.Left, 50);
  status.name = 'mdr: changed agent files';
  ctx.subscriptions.push(spaces, view, status);

  const deps: PanelDeps = {
    extensionUri: ctx.extensionUri,
    openPath: async (ws, id, section) => void ReaderPanel.show(deps, ws, id, section),
  };

  /** Open a file in the reader. If it changed since last read, land on the first change. */
  async function openUri(uri: vscode.Uri, section?: string | null) {
    const { ws, id } = await spaces.forUri(uri);
    if (!(await ws.readable(id))) return void vscode.window.showWarningMessage(`mdr: ${path.basename(uri.fsPath)} is not a markdown file.`);
    const changed = spaces.unread().some((x) => x.folder.ws === ws && x.file.path === id);
    ReaderPanel.show(deps, ws, id, section !== undefined ? section : changed ? null : undefined);
  }

  /** ⌘⌥M: the active markdown file, else the last file read, else the main instructions, else the first file. */
  async function openDefault() {
    const ed = vscode.window.activeTextEditor?.document;
    if (ed && ed.uri.scheme === 'file' && ed.languageId === 'markdown') return openUri(ed.uri);
    if (ReaderPanel.current) return void ReaderPanel.current.panel.reveal();
    if (!spaces.folders.length) await spaces.refresh();
    for (const f of spaces.folders) {
      const last = (await f.ws.getState('last')) as string | undefined;
      if (last && (await f.ws.readable(last))) return void ReaderPanel.show(deps, f.ws, last);
    }
    const all = spaces.all();
    const pick = all.find((x) => x.file.group === 'Instructions') ?? all[0];
    if (pick) return void ReaderPanel.show(deps, pick.folder.ws, pick.file.path);
    const choice = await vscode.window.showInformationMessage('mdr: no markdown files in this workspace.', 'Open a file…');
    if (choice) await vscode.commands.executeCommand('mdr.openFromDisk');
  }

  function updateBadge() {
    const unread = spaces.unread();
    const n = unread.length;
    view.badge = n ? { value: n, tooltip: `${n} agent file${n === 1 ? '' : 's'} changed since you last read ${n === 1 ? 'it' : 'them'}` } : undefined;
    void vscode.commands.executeCommand('setContext', 'mdr.hasUnread', n > 0);
    const mode = vscode.workspace.getConfiguration('mdr').get<string>('statusBar');
    if (!n || mode === 'never') return status.hide();
    status.text = n === 1 ? `$(book) ${unread[0].file.name} changed` : `$(book) ${n} agent files changed`;
    status.tooltip = new vscode.MarkdownString(
      `**mdr:** changed since you last read:\n\n${unread.slice(0, 8).map((x) => `- ${x.file.path}`).join('\n')}${n > 8 ? `\n- … ${n - 8} more` : ''}\n\nClick to see what changed.`,
    );
    status.command = 'mdr.openChanged';
    status.show();
  }
  spaces.onDidChange(updateBadge);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('mdr.open', openDefault),
    vscode.commands.registerCommand('mdr.openFile', async (arg?: vscode.Uri) => {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      if (uri) await openUri(uri);
      else await openDefault();
    }),
    vscode.commands.registerCommand('mdr.openFromDisk', async () => {
      const [uri] =
        (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Markdown: ['md', 'markdown', 'mdx', 'mdc'] }, openLabel: 'Open in mdr' })) ?? [];
      if (uri) await openUri(uri);
    }),
    vscode.commands.registerCommand('mdr.openChanged', async () => {
      const [first] = spaces.unread();
      if (first) ReaderPanel.show(deps, first.folder.ws, first.file.path, null);
    }),
    vscode.commands.registerCommand('mdr.editSource', async () => {
      const p = ReaderPanel.current;
      const abs = p && (await p.workspace.readable(p.currentPath));
      if (abs) await vscode.window.showTextDocument(vscode.Uri.file(abs), { viewColumn: vscode.ViewColumn.Beside });
    }),
    vscode.commands.registerCommand('mdr.refresh', () => spaces.refresh()),
    vscode.commands.registerCommand('mdr.markAllRead', async () => {
      for (const { folder, file } of spaces.unread()) await folder.ws.markRead(file.path, await folder.ws.readFile(file.path));
      ReaderPanel.current?.post({ type: 'refresh' });
      await spaces.refresh();
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state: { path?: string; root?: string } | undefined) {
        const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file');
        if (!folder) return panel.dispose();
        const { ws } = await spaces.forUri(folder.uri);
        const id = state?.path && (await ws.readable(state.path)) ? state.path : ((await ws.getState('last')) as string | undefined);
        if (!id || !(await ws.readable(id))) return panel.dispose();
        ReaderPanel.revive(panel, deps, ws, id);
      },
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => spaces.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mdr')) void spaces.refresh();
    }),
  );

  registerTools(ctx, spaces, deps);
  void spaces.refresh();
}

/* ---- Copilot agent mode: language model tools -------------------------------------------------- */
function registerTools(ctx: vscode.ExtensionContext, spaces: Workspaces, deps: PanelDeps) {
  if (!vscode.lm?.registerTool) return; // older VS Code: no tools, everything else works
  const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

  /** A file the agent named, or a message telling it what to do instead (returned as the tool result, not thrown). */
  async function locate(query: string | undefined): Promise<{ ws: Workspace; id: string } | string> {
    if (!spaces.folders.length) await spaces.refresh();
    const all = spaces.all();
    const hit = resolveName(
      all.map((x) => ({ ...x, path: x.file.path, name: x.file.name })),
      query ?? '',
    );
    if (!hit) return `No markdown file matching "${query}" in this workspace. Call mdr_listAgentFiles to see what exists.`;
    if ('candidates' in hit) return `"${query}" matches several files; call again with one of these paths: ${hit.candidates.map((c) => c.path).join(', ')}`;
    return { ws: hit.folder.ws, id: hit.file.path };
  }

  ctx.subscriptions.push(
    vscode.lm.registerTool<Record<string, never>>('mdr_listAgentFiles', {
      prepareInvocation: () => ({ invocationMessage: 'Listing agent files' }),
      async invoke() {
        await spaces.refresh();
        return text(formatFileList(spaces.folders.map((f) => ({ folder: f.name, groups: f.groups }))));
      },
    }),
    vscode.lm.registerTool<{ path: string; section?: string }>('mdr_openInReader', {
      prepareInvocation: (o) => ({ invocationMessage: `Opening ${o.input.path} in mdr` }),
      async invoke(o) {
        const at = await locate(o.input.path);
        if (typeof at === 'string') return text(at);
        const { ws, id } = at;
        const n = changeCount(await ws.getBaseline(id), await ws.readFile(id));
        ReaderPanel.show(deps, ws, id, o.input.section ?? (n ? null : undefined), true);
        return text(`Opened ${id} in the mdr reader tab${o.input.section ? ` at "${o.input.section}"` : ''}${n ? ` (${n} section${n === 1 ? '' : 's'} changed since the user last read it; changes are highlighted)` : ''}.`);
      },
    }),
    vscode.lm.registerTool<{ path: string }>('mdr_changesSinceRead', {
      prepareInvocation: (o) => ({ invocationMessage: `Comparing ${o.input.path} with your last read` }),
      async invoke(o) {
        const at = await locate(o.input.path);
        if (typeof at === 'string') return text(at);
        return text(formatChanges(at.id, await at.ws.getBaseline(at.id), await at.ws.readFile(at.id)));
      },
    }),
    vscode.lm.registerTool<{ path: string; rulesOnly?: boolean }>('mdr_outline', {
      prepareInvocation: (o) => ({ invocationMessage: o.input.rulesOnly ? `Reading the rules in ${o.input.path}` : `Reading the outline of ${o.input.path}` }),
      async invoke(o) {
        const at = await locate(o.input.path);
        if (typeof at === 'string') return text(at);
        return text(formatOutline(at.id, await at.ws.readFile(at.id), !!o.input.rulesOnly));
      },
    }),
  );
}

export function deactivate() {
  return store.flush();
}
