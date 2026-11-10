import { classifyText, nameFromText, hash, type FileGroupName } from '@mdr/core';

/** The subset of Storage we use, so tests can pass a fake. */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DocMeta {
  id: string;
  name: string;
  group: FileGroupName;
  /** Original filename for dropped/opened files; used to match new versions. */
  fileName?: string;
  hash: string;
  updatedAt: number;
  /** The doc is linked to a file on disk (handle kept in IndexedDB) and can be reloaded. */
  linked?: boolean;
}

const P = 'mdr:';

/** localStorage when it works (it can throw in private mode or when blocked), else memory. */
export function safeKV(): KV {
  try {
    const ls = window.localStorage;
    ls.setItem(P + 'probe', '1');
    ls.removeItem(P + 'probe');
    return ls;
  } catch {
    const m = new Map<string, string>();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
    };
  }
}

export class StorageFullError extends Error {
  constructor() {
    super('Browser storage is full. Remove some docs and try again.');
  }
}

/** Pasted/dropped docs, their last-read baselines and view state, all in the browser. */
export class DocStore {
  constructor(private kv: KV) {}

  list(): DocMeta[] {
    try {
      const raw = JSON.parse(this.kv.getItem(P + 'docs') ?? '[]');
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  get(id: string): string | null {
    return this.kv.getItem(P + 'doc:' + id);
  }

  meta(id: string): DocMeta | undefined {
    return this.list().find((d) => d.id === id);
  }

  findByHash(text: string): DocMeta | undefined {
    const h = hash(text);
    return this.list().find((d) => d.hash === h);
  }

  findByFileName(fileName: string): DocMeta | undefined {
    return this.list().find((d) => d.fileName === fileName);
  }

  create(text: string, fileName?: string): DocMeta {
    const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const meta = this.describe(id, text, fileName);
    this.write(P + 'doc:' + id, text);
    this.saveList([meta, ...this.list()]);
    return meta;
  }

  /** Replace a doc's text. The last-read baseline is kept, so the reader shows the diff. */
  update(id: string, text: string): DocMeta {
    const old = this.meta(id);
    if (!old) throw new Error(`No doc ${id}`);
    const meta = { ...this.describe(id, text, old.fileName), linked: old.linked };
    this.write(P + 'doc:' + id, text);
    this.saveList([meta, ...this.list().filter((d) => d.id !== id)]);
    return meta;
  }

  /** Mark a doc as linked to a file on disk (or not). */
  setLinked(id: string, linked: boolean): void {
    this.saveList(this.list().map((d) => (d.id === id ? { ...d, linked: linked || undefined } : d)));
  }

  /** Remember which doc was open last, so a relaunch reopens it. */
  get last(): string | null {
    return this.kv.getItem(P + 'last');
  }

  set last(id: string | null) {
    try {
      if (id) this.kv.setItem(P + 'last', id);
      else this.kv.removeItem(P + 'last');
    } catch {
      /* convenience only */
    }
  }

  remove(id: string): void {
    this.kv.removeItem(P + 'doc:' + id);
    this.kv.removeItem(P + 'base:' + id);
    this.kv.removeItem(P + 'state:view:' + id);
    if (this.last === id) this.last = null;
    this.saveList(this.list().filter((d) => d.id !== id));
  }

  getBaseline(id: string): string | null {
    return this.kv.getItem(P + 'base:' + id);
  }

  setBaseline(id: string, text: string): void {
    this.write(P + 'base:' + id, text);
  }

  getState(key: string): unknown {
    try {
      const v = this.kv.getItem(P + 'state:' + key);
      return v == null ? undefined : JSON.parse(v);
    } catch {
      return undefined;
    }
  }

  setState(key: string, value: unknown): void {
    try {
      this.write(P + 'state:' + key, JSON.stringify(value));
    } catch {
      /* view state is a convenience; never fail on it */
    }
  }

  private describe(id: string, text: string, fileName?: string): DocMeta {
    const name = nameFromText(text, fileName ?? 'Untitled');
    return { id, name, fileName, group: classifyText(fileName ?? name, text), hash: hash(text), updatedAt: Date.now() };
  }

  private saveList(list: DocMeta[]) {
    this.write(P + 'docs', JSON.stringify(list));
  }

  private write(key: string, value: string) {
    try {
      this.kv.setItem(key, value);
    } catch (e) {
      if (e instanceof DOMException || (e as Error)?.name === 'QuotaExceededError') throw new StorageFullError();
      throw e;
    }
  }
}
