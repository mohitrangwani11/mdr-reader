/**
 * The Host is the only seam between the reader core and a target
 * (CLI + browser, VS Code webview, website). The core never touches the disk.
 */

export type FileGroupName =
  | 'Instructions'
  | 'Skills'
  | 'Commands & agents'
  | 'Plans & specs'
  | 'Memory'
  | 'Other';

export interface FileEntry {
  /** Stable identifier the host understands (relative path for files in the workspace). */
  path: string;
  /** Short display name. */
  name: string;
  group: FileGroupName;
  /** True when the file differs from the last-read snapshot. */
  unread?: boolean;
  /** Set when the doc is linked to a file on disk it can be reloaded from (shown as a tooltip). */
  linked?: string;
}

export interface FileGroup {
  name: FileGroupName;
  files: FileEntry[];
}

export interface ResolvedImport {
  path: string;
  text: string;
}

export type HostEvent =
  | { type: 'change'; path: string }
  | { type: 'files' };

export interface Host {
  /** Whether the workspace is a folder (shows the file sidebar) or a single file. */
  mode: 'file' | 'folder';
  /** Paths are opaque ids (e.g. pasted docs): show the file's name instead of its path. */
  opaquePaths?: boolean;
  /** Expand the "Other markdown" group by default. */
  showAll?: boolean;
  listFiles(): Promise<FileGroup[]>;
  readFile(path: string): Promise<string>;
  onEvent(cb: (e: HostEvent) => void): () => void;
  resolveImport(from: string, ref: string): Promise<ResolvedImport | null>;
  getBaseline(path: string): Promise<string | null>;
  markRead(path: string, text: string): Promise<void>;
  /** Optional: lets the user remove a file from the workspace (e.g. a pasted doc). */
  removeFile?(path: string): Promise<void>;
  state: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
}
