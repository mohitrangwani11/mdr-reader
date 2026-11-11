/**
 * The reader inside a VS Code webview. Every Host call is a postMessage round-trip to the
 * extension, which owns the disk (see ../panel.ts). The native "Agent files" view is the file
 * navigator, so the reader runs in 'file' mode (no file sidebar) and switches files on request.
 */
import { mountReader, type Host, type HostEvent, type Reader } from '@mdr/core';
import type { ToWebview, FromWebview } from '../protocol.ts';

interface VsCodeApi {
  postMessage(msg: FromWebview): void;
  getState(): { path?: string } | undefined;
  setState(s: { path?: string }): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const cfg = (window as unknown as { MDR_VSCODE: { path: string } }).MDR_VSCODE;
let current = cfg.path;

/* ---- rpc ---------------------------------------------------------------------------- */
let seq = 0;
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    vscode.postMessage({ type: 'rpc', id, method, args });
  });
}

const listeners = new Set<(e: HostEvent) => void>();
let reader: Reader | null = null;
const queued: ToWebview[] = [];

window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  if (m.type === 'rpc') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error != null) p.reject(new Error(m.error));
    else p.resolve(m.result);
  } else if (m.type === 'event') {
    for (const l of listeners) l(m.event);
  } else if (!reader) queued.push(m);
  else void handle(m);
});

async function handle(m: ToWebview) {
  if (!reader) return;
  if (m.type === 'open') {
    current = m.path;
    if (reader.currentPath() !== m.path) await reader.open(m.path);
    if (m.section !== undefined) reader.reveal(m.section ?? undefined);
  } else if (m.type === 'refresh') await reader.refresh();
}

/* ---- host ------------------------------------------------------------------------------ */
const host: Host = {
  mode: 'file',
  // Only consulted at boot in 'file' mode: the file this tab was opened for.
  listFiles: async () => [{ name: 'Other', files: [{ path: current, name: current.split('/').pop()!, group: 'Other' }] }],
  readFile: (p) => call('readFile', p),
  resolveImport: (from, ref) => call('resolveImport', from, ref),
  getBaseline: (p) => call('getBaseline', p),
  markRead: (p, text) => call('markRead', p, text),
  state: {
    get: (k) => call('getState', k),
    set: (k, v) => call('setState', k, v),
  },
  onEvent(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

/* ---- theme: follow VS Code ------------------------------------------------------------------ */
const isLight = () => document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
const theme = {
  get: (): 'light' | 'dark' => (isLight() ? 'light' : 'dark'),
  onChange(cb: () => void) {
    new MutationObserver(cb).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  },
};

void (async () => {
  reader = await mountReader(document.getElementById('app')!, host, {
    theme,
    actions: [
      {
        label: 'Edit source',
        title: 'Open the markdown source in an editor beside the reader',
        icon: 'file',
        key: 'e',
        placement: 'menu', // VS Code's own editor title bar carries the visible button
        needsFile: true,
        run: (r) => vscode.postMessage({ type: 'editSource', path: r.currentPath()! }),
      },
    ],
    onLink(href, from) {
      vscode.postMessage({ type: 'link', href, from });
      return true;
    },
    onOpen(p) {
      current = p;
      vscode.setState({ path: p });
      vscode.postMessage({ type: 'opened', path: p });
    },
  });
  vscode.postMessage({ type: 'ready' });
  for (const m of queued.splice(0)) await handle(m);
})();
