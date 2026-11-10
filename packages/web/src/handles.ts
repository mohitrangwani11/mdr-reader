/**
 * Linked files: when a doc comes from a file on disk, keep the file's handle
 * (File System Access API, Chromium browsers) so the doc can be reloaded later.
 * Handles are structured-cloneable, so they go straight into IndexedDB.
 * Everything here fails soft: no API, no IndexedDB → no linking, docs still work.
 */

export interface FileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  queryPermission?(opts: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(opts: { mode: 'read' }): Promise<PermissionState>;
}

interface Linked {
  handle: FileHandle;
  /** lastModified of the file when its text was last pulled in. */
  lastModified: number;
}

type PickerWindow = Window & {
  showOpenFilePicker?: (opts: unknown) => Promise<FileHandle[]>;
};

export const canLink = typeof window !== 'undefined' && typeof (window as PickerWindow).showOpenFilePicker === 'function';

/** Show the system file picker. Resolves [] if the user cancels. */
export async function pickFileHandles(): Promise<FileHandle[]> {
  try {
    return await (window as PickerWindow).showOpenFilePicker!({
      multiple: true,
      excludeAcceptAllOption: false,
      types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdx', '.mdc'], 'text/plain': ['.txt'] } }],
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return [];
    throw e;
  }
}

/** Collect file handles from a drop. Must be called synchronously inside the drop handler. */
export function handlesFromDrop(dt: DataTransfer): Promise<(FileHandle | null)[]> {
  const items = [...dt.items].filter((i) => i.kind === 'file');
  type WithHandle = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileHandle | null> };
  return Promise.all(
    items.map((i) => {
      const get = (i as WithHandle).getAsFileSystemHandle;
      return get ? get.call(i).then((h) => (h?.kind === 'file' ? h : null)).catch(() => null) : Promise.resolve(null);
    }),
  );
}

/** Read permission without prompting ('granted' | 'prompt' | 'denied'). */
export async function permission(h: FileHandle, ask: boolean): Promise<PermissionState> {
  try {
    const now = (await h.queryPermission?.({ mode: 'read' })) ?? 'granted';
    if (now === 'granted' || !ask) return now;
    return (await h.requestPermission?.({ mode: 'read' })) ?? 'denied';
  } catch {
    return 'denied';
  }
}

/* ---- IndexedDB ----------------------------------------------------------------------- */

let dbP: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  dbP ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open('mdr', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbP;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const req = fn(d.transaction('handles', mode).objectStore('handles'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function saveLink(id: string, handle: FileHandle, lastModified: number): Promise<boolean> {
  return (await tx('readwrite', (s) => s.put({ handle, lastModified } satisfies Linked, id))) !== undefined;
}

export async function getLink(id: string): Promise<Linked | undefined> {
  return tx<Linked>('readonly', (s) => s.get(id));
}

export async function deleteLink(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

export async function allLinks(): Promise<[string, Linked][]> {
  const keys = ((await tx('readonly', (s) => s.getAllKeys())) ?? []) as string[];
  const vals = ((await tx('readonly', (s) => s.getAll())) ?? []) as Linked[];
  return keys.map((k, i) => [k, vals[i]]);
}
