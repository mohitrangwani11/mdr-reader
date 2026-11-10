import type { Nodes, Parent } from 'mdast';
import type { Doc } from './tree.ts';

/** Claude Code follows @imports up to 5 hops; mirror that. */
export const MAX_IMPORT_DEPTH = 5;

/** Unique @import refs in document order. */
export function findImports(doc: Doc): string[] {
  const out: string[] = [];
  const walk = (n: Nodes) => {
    if ((n.type as string) === 'mdrImport') {
      const ref = (n.data as { hProperties?: { dataImport?: string } } | undefined)?.hProperties?.dataImport;
      if (ref && !out.includes(ref)) out.push(ref);
      return;
    }
    if ('children' in n) for (const c of (n as Parent).children) walk(c as Nodes);
  };
  for (const sec of [doc.root, ...doc.sections]) {
    if (sec.heading) walk(sec.heading);
    for (const b of sec.blocks) walk(b.node);
  }
  return out;
}

/**
 * Decide whether an import can be expanded.
 * @param chain resolved paths from the top-level file down to the file containing the import
 * @param path resolved path of the import target
 */
export function importBlocked(chain: string[], path: string): 'cycle' | 'depth' | null {
  if (chain.includes(path)) return 'cycle';
  if (chain.length > MAX_IMPORT_DEPTH) return 'depth';
  return null;
}
