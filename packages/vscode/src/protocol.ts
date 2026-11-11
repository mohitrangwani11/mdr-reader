/** Messages between the extension (panel.ts) and the reader webview (webview/main.ts). */
import type { HostEvent } from '@mdr/core/model';

export type ToWebview =
  | { type: 'rpc'; id: number; result?: unknown; error?: string }
  | { type: 'event'; event: HostEvent }
  /** Switch to a file; section: a heading to reveal, null = the first change, undefined = stay at top. */
  | { type: 'open'; path: string; section?: string | null }
  | { type: 'refresh' };

export type FromWebview =
  | { type: 'rpc'; id: number; method: string; args: unknown[] }
  | { type: 'ready' }
  | { type: 'opened'; path: string }
  | { type: 'editSource'; path: string }
  | { type: 'link'; href: string; from: string | null };
