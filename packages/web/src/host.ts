import type { Host, HostEvent, FileGroup, FileGroupName } from '@mdr/core';
import type { DocStore } from './store.ts';
import { deleteLink } from './handles.ts';

const GROUP_ORDER: FileGroupName[] = ['Instructions', 'Skills', 'Commands & agents', 'Plans & specs', 'Memory', 'Other'];

/** Host for the paste edition: documents live in the browser (see DocStore). */
export class WebHost implements Host {
  readonly mode = 'folder' as const;
  readonly showAll = true;
  readonly opaquePaths = true;
  private listeners = new Set<(e: HostEvent) => void>();

  constructor(readonly store: DocStore) {
    // Keep several open tabs in sync.
    window.addEventListener('storage', (e) => {
      if (!e.key?.startsWith('mdr:')) return;
      if (e.key === 'mdr:docs') this.emit({ type: 'files' });
      else if (e.key.startsWith('mdr:doc:')) this.emit({ type: 'change', path: e.key.slice(8) });
    });
  }

  emit(e: HostEvent) {
    for (const l of this.listeners) l(e);
  }

  onEvent(cb: (e: HostEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async listFiles(): Promise<FileGroup[]> {
    const docs = this.store.list();
    return GROUP_ORDER.map((name) => ({
      name,
      files: docs
        .filter((d) => d.group === name)
        .map((d) => {
          const base = this.store.getBaseline(d.id);
          const unread = base != null && base !== this.store.get(d.id);
          return { path: d.id, name: d.name, group: d.group, unread, linked: d.linked ? (d.fileName ?? d.name) : undefined };
        }),
    })).filter((g) => g.files.length);
  }

  async readFile(path: string) {
    const t = this.store.get(path);
    if (t == null) throw new Error('Not found');
    return t;
  }

  /** Best effort: an @import matches a saved doc with the same file or doc name. */
  async resolveImport(_from: string, ref: string) {
    const base = ref.split('/').pop()!.toLowerCase();
    const stem = base.replace(/\.[^.]+$/, '');
    const hit = this.store
      .list()
      .find((d) => d.fileName?.toLowerCase() === base || d.name.toLowerCase() === stem || d.name.toLowerCase() === base);
    const text = hit && this.store.get(hit.id);
    return hit && text != null ? { path: hit.id, text } : null;
  }

  async getBaseline(path: string) {
    return this.store.getBaseline(path);
  }

  async markRead(path: string, text: string) {
    this.store.setBaseline(path, text);
  }

  async removeFile(path: string) {
    this.store.remove(path);
    await deleteLink(path);
  }

  state = {
    // 'last' (the doc open at close) lives in its own key so it is cheap to read before first paint.
    get: async <T>(key: string) => (key === 'last' ? this.store.last : this.store.getState(key)) as T | undefined,
    set: async (key: string, value: unknown) => {
      if (key === 'last') this.store.last = value as string;
      else this.store.setState(key, value);
    },
  };
}
