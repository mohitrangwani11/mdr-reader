/**
 * The reader tab: one shared WebviewPanel (like Markdown Preview's single preview).
 * It serves the reader's Host calls from a Workspace and forwards change events.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Workspace } from '../../cli/src/workspace.ts';
import type { FromWebview, ToWebview } from './protocol.ts';

export const VIEW_TYPE = 'mdr.reader';

export interface PanelDeps {
  extensionUri: vscode.Uri;
  /** Open a workspace-relative path of some workspace in the reader. */
  openPath(ws: Workspace, id: string, section?: string | null): Promise<void>;
}

export class ReaderPanel {
  static current: ReaderPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private offEvents: (() => void) | undefined;
  private ready = false;
  private outbox: ToWebview[] = [];

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private ws: Workspace,
    private path: string,
    private readonly deps: PanelDeps,
  ) {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'dist')] };
    panel.iconPath = {
      light: vscode.Uri.joinPath(deps.extensionUri, 'media', 'tab-light.svg'),
      dark: vscode.Uri.joinPath(deps.extensionUri, 'media', 'tab-dark.svg'),
    };
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m)),
    );
    this.mount();
  }

  /** Show the reader on a file, creating or reusing the tab. section: heading to reveal, null = first change. */
  static show(deps: PanelDeps, ws: Workspace, id: string, section?: string | null, preserveFocus = false): ReaderPanel {
    const cur = ReaderPanel.current;
    if (cur) {
      cur.panel.reveal(cur.panel.viewColumn, preserveFocus);
      cur.switchTo(ws, id, section);
      return cur;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, title(id), { viewColumn: vscode.ViewColumn.Active, preserveFocus }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      enableFindWidget: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'dist')],
    });
    const p = new ReaderPanel(panel, ws, id, deps);
    ReaderPanel.current = p;
    if (section !== undefined) p.post({ type: 'open', path: id, section });
    return p;
  }

  /** Re-attach a tab VS Code restored after a window reload. */
  static revive(panel: vscode.WebviewPanel, deps: PanelDeps, ws: Workspace, id: string): ReaderPanel {
    ReaderPanel.current?.panel.dispose();
    const p = new ReaderPanel(panel, ws, id, deps);
    ReaderPanel.current = p;
    return p;
  }

  get workspace(): Workspace {
    return this.ws;
  }
  get currentPath(): string {
    return this.path;
  }

  private switchTo(ws: Workspace, id: string, section?: string | null) {
    if (ws !== this.ws) {
      // Another workspace folder: remount, so view state is read from and saved to the right one.
      this.ws = ws;
      this.path = id;
      this.mount();
      if (section !== undefined) this.post({ type: 'open', path: id, section });
      return;
    }
    this.path = id;
    this.panel.title = title(id);
    this.post({ type: 'open', path: id, section });
  }

  private mount() {
    this.ready = false;
    this.outbox = [];
    this.offEvents?.();
    this.offEvents = this.ws.onEvent((event) => this.post({ type: 'event', event }));
    this.panel.title = title(this.path);
    this.panel.webview.html = html(this.panel.webview, this.deps.extensionUri, this.path);
  }

  post(m: ToWebview) {
    if (!this.ready && m.type !== 'rpc') this.outbox.push(m);
    else void this.panel.webview.postMessage(m);
  }

  private async onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        for (const x of this.outbox.splice(0)) void this.panel.webview.postMessage(x);
        return;
      case 'opened':
        this.path = m.path;
        this.panel.title = title(m.path);
        return;
      case 'editSource': {
        const abs = await this.ws.readable(m.path);
        if (abs) await vscode.window.showTextDocument(vscode.Uri.file(abs), { viewColumn: vscode.ViewColumn.Beside, preview: true });
        return;
      }
      case 'link':
        return this.openLink(m.href, m.from);
      case 'rpc': {
        try {
          const result = await this.rpc(m.method, m.args);
          void this.panel.webview.postMessage({ type: 'rpc', id: m.id, result: result ?? null } satisfies ToWebview);
        } catch (e) {
          void this.panel.webview.postMessage({ type: 'rpc', id: m.id, error: (e as Error).message || 'Error' } satisfies ToWebview);
        }
      }
    }
  }

  private rpc(method: string, a: unknown[]): Promise<unknown> {
    const s = (i: number) => (typeof a[i] === 'string' ? (a[i] as string) : null);
    switch (method) {
      case 'readFile':
        return this.ws.readFile(s(0));
      case 'resolveImport':
        return this.ws.resolveImport(s(0), s(1));
      case 'getBaseline':
        return this.ws.getBaseline(s(0));
      case 'markRead':
        return this.ws.markRead(s(0), s(1) ?? '');
      case 'getState':
        return this.ws.getState(s(0) ?? '');
      case 'setState':
        return this.ws.setState(s(0) ?? '', a[1]);
      default:
        return Promise.reject(new Error(`Unknown method ${method}`));
    }
  }

  /** Links the reader doesn't handle itself: web links go to the browser, files open in VS Code. */
  private async openLink(href: string, from: string | null) {
    if (/^(https?|mailto):/i.test(href)) return void vscode.env.openExternal(vscode.Uri.parse(href));
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return; // other schemes: ignore (command:, file:, javascript:…)
    const fromAbs = from ? await this.ws.readable(from) : null;
    const base = fromAbs ? path.dirname(fromAbs) : this.ws.root;
    const [file, frag] = decodeURI(href).split('#');
    const abs = path.resolve(base, file);
    const rel = path.relative(this.ws.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return void vscode.window.showWarningMessage(`mdr: ${file} is outside this workspace.`);
    const line = frag?.match(/^L(\d+)/)?.[1];
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs)).then(undefined, () => null);
    if (!doc) return void vscode.window.showWarningMessage(`mdr: could not open ${file}.`);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    if (line) {
      const pos = new vscode.Position(Math.max(0, Number(line) - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  private dispose() {
    if (ReaderPanel.current === this) ReaderPanel.current = undefined;
    this.offEvents?.();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

function title(id: string): string {
  return id.split('/').pop() || id;
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri, initialPath: string): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', f));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    // 'unsafe-inline' only for style attributes (token meters set an inline width).
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  const config = JSON.stringify({ path: initialPath }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en" data-host="vscode" data-theme="dark">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('webview.css')}">
<script nonce="${nonce}">window.MDR_VSCODE=${config};</script>
</head>
<body>
<script nonce="${nonce}">{const c=document.body.classList;document.documentElement.dataset.theme=c.contains('vscode-light')||c.contains('vscode-high-contrast-light')?'light':'dark';}</script>
<div id="app"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
}
