/**
 * A workspace on disk: discovery, reading, @imports, last-read snapshots, view state and change events.
 * Shared by the CLI's HTTP server and the VS Code extension; they differ only in transport and watcher.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discover, classify, displayName, isIgnoredDir, isMarkdown, GROUP_ORDER } from './discover.ts';
import { Store } from './store.ts';
import type { FileGroup, HostEvent, ResolvedImport } from '@mdr/core';

export interface WatchTarget {
  root: string;
  /** Set when the workspace is a single file. */
  singleFile: string | null;
  /** Called with an absolute path. */
  onFs(kind: 'add' | 'change' | 'unlink', abs: string): void;
  /** True for paths inside an ignored folder (node_modules, dist, …). */
  ignored(abs: string): boolean;
}

export interface Watcher {
  /** Also watch a file outside the root (an @import target). */
  add(abs: string): void;
  close(): Promise<void> | void;
}

export type WatchFactory = (t: WatchTarget) => Watcher;

export interface WorkspaceOptions {
  /** Absolute path to a file or folder. */
  target: string;
  store?: Store;
  watch?: WatchFactory;
}

export class NotFound extends Error {}

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export type Workspace = Awaited<ReturnType<typeof createWorkspace>>;

export async function createWorkspace(opts: WorkspaceOptions) {
  const targetReal = await realpath(opts.target);
  const isDir = (await stat(targetReal)).isDirectory();
  const root = isDir ? targetReal : path.dirname(targetReal);
  const singleFile = isDir ? null : targetReal;
  const store = opts.store ?? new Store();
  const importAllowed = new Set<string>();
  const listeners = new Set<(e: HostEvent) => void>();
  const readListeners = new Set<(id: string) => void>();

  /* ---- path identity ------------------------------------------------------ */
  const inRoot = (abs: string) => {
    const rel = path.relative(root, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const toId = (abs: string) => (inRoot(abs) ? path.relative(root, abs).split(path.sep).join('/') : abs);
  const fromId = (id: string) => path.resolve(root, id);

  /** Resolve a client-supplied id to a real path the client may read, or null. */
  async function readable(id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    let abs: string;
    try {
      abs = await realpath(fromId(id));
    } catch {
      return null;
    }
    if (importAllowed.has(abs)) return abs;
    if (singleFile) return abs === singleFile ? abs : null;
    return inRoot(abs) && isMarkdown(abs) ? abs : null;
  }
  const mustRead = async (id: string | null | undefined) => {
    const abs = await readable(id);
    if (!abs) throw new NotFound(`Not found: ${id}`);
    return abs;
  };

  /* ---- watching ----------------------------------------------------------- */
  const emit = (e: HostEvent) => {
    for (const l of listeners) l(e);
  };
  const watcher = opts.watch?.({
    root,
    singleFile,
    ignored: (p) => !singleFile && inRoot(p) && path.relative(root, p).split(path.sep).some((seg) => seg && isIgnoredDir(seg)),
    onFs(kind, p) {
      if (!isMarkdown(p) && !importAllowed.has(p)) return;
      if (singleFile && p !== singleFile && !importAllowed.has(p)) return;
      if (kind !== 'unlink') emit({ type: 'change', path: toId(p) });
      if (kind !== 'change') emit({ type: 'files' });
    },
  });

  /* ---- api ------------------------------------------------------------------ */
  async function listFiles(): Promise<FileGroup[]> {
    const found = singleFile
      ? [{ path: toId(singleFile), name: displayName(toId(singleFile)), group: classify(toId(singleFile)) }]
      : await discover(root);
    const withUnread = await Promise.all(
      found.map(async (f, i) => {
        if (i > 500) return f;
        const abs = fromId(f.path);
        const snap = await store.getSnapshot(abs);
        if (snap == null) return f;
        const cur = await readFile(abs, 'utf8').catch(() => null);
        return { ...f, unread: cur != null && cur !== snap };
      }),
    );
    return GROUP_ORDER.map((name) => ({ name, files: withUnread.filter((f) => f.group === name) })).filter((g) => g.files.length);
  }

  async function resolveImport(fromIdStr: string | null, ref: string | null): Promise<ResolvedImport | null> {
    const fromAbs = await readable(fromIdStr);
    if (!fromAbs || !ref) return null;
    // Only follow imports that the source file actually contains.
    const fromText = await readFile(fromAbs, 'utf8');
    if (!fromText.includes('@' + ref)) return null;
    const expanded = ref.startsWith('~/') ? path.join(os.homedir(), ref.slice(2)) : ref;
    let target: string;
    try {
      target = await realpath(path.resolve(path.dirname(fromAbs), expanded));
      const st = await stat(target);
      if (!st.isFile() || st.size > MAX_IMPORT_BYTES) return null;
    } catch {
      return null;
    }
    const text = await readFile(target, 'utf8');
    if (text.includes('\u0000')) return null; // binary
    if (!importAllowed.has(target)) {
      importAllowed.add(target);
      if (singleFile || !inRoot(target)) watcher?.add(target);
    }
    return { path: toId(target), text };
  }

  const stateKey = (k: string) => `${root}|${k}`;

  return {
    root,
    singleFile,
    mode: (singleFile ? 'file' : 'folder') as 'file' | 'folder',
    toId,
    fromId,
    readable,
    listFiles,
    resolveImport,
    /** Throws NotFound for paths outside what the client may read. */
    async readFile(id: string | null): Promise<string> {
      return readFile(await mustRead(id), 'utf8');
    },
    async getBaseline(id: string | null): Promise<string | null> {
      return store.getSnapshot(await mustRead(id));
    },
    async markRead(id: string | null, text: string): Promise<void> {
      const abs = await mustRead(id);
      await store.setSnapshot(abs, text);
      for (const l of readListeners) l(toId(abs));
    },
    async getState(k: string): Promise<unknown> {
      return store.getState(stateKey(k));
    },
    async setState(k: string, v: unknown): Promise<void> {
      await store.setState(stateKey(k), v);
    },
    onEvent(cb: (e: HostEvent) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    /** Fires after a file's last-read snapshot moves (unread state may have changed). */
    onDidMarkRead(cb: (id: string) => void): () => void {
      readListeners.add(cb);
      return () => readListeners.delete(cb);
    },
    async close() {
      listeners.clear();
      readListeners.clear();
      await watcher?.close();
      await store.flush();
    },
  };
}
