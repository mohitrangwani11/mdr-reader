import { diffArrays } from 'diff';
import type { Block, Doc, Section } from './tree.ts';

export type SectionStatus = 'added' | 'changed';

export interface BlockOp {
  kind: 'same' | 'added' | 'removed';
  block: Block;
}

export interface DocDiff {
  /** Status of sections whose own content changed (absent = unchanged). */
  status: Map<string, SectionStatus>;
  /** Sections with a change anywhere below them (badge shown even when folded). */
  subChanged: Set<string>;
  /** Removed sections, keyed by the id of the nearest surviving parent ("" = root). */
  removed: Map<string, Section[]>;
  /** Block-level ops for changed sections (and the root preamble if it changed). */
  blockOps: Map<string, BlockOp[]>;
  frontmatterChanged: boolean;
  /** Number of changed/added/removed sections. */
  count: number;
}

export function diffDocs(base: Doc, cur: Doc): DocDiff {
  const status = new Map<string, SectionStatus>();
  const blockOps = new Map<string, BlockOp[]>();
  const removed = new Map<string, Section[]>();
  const subChanged = new Set<string>();
  const frontmatterChanged = (base.frontmatter?.raw ?? '') !== (cur.frontmatter?.raw ?? '');

  const touch = (sec: Section | undefined) => {
    for (let p = sec; p; p = p.parent) subChanged.add(p.id);
  };

  for (const sec of [cur.root, ...cur.sections]) {
    const old = base.byId.get(sec.id);
    if (!old) {
      if (sec.id === '') continue;
      status.set(sec.id, 'added');
      touch(sec);
      continue;
    }
    if (old.hash !== sec.hash) {
      const ops = blockDiff(old.blocks, sec.blocks);
      // A heading rename with identical blocks still counts as changed.
      if (sec.id !== '' || ops.some((o) => o.kind !== 'same')) {
        status.set(sec.id, 'changed');
        blockOps.set(sec.id, ops);
        touch(sec);
      }
    }
  }

  for (const old of base.sections) {
    if (cur.byId.has(old.id)) continue;
    // Report only the top-most removed section of a removed subtree.
    if (old.parent && old.parent.id !== '' && !cur.byId.has(old.parent.id)) continue;
    const parentId = old.parent?.id ?? '';
    const list = removed.get(parentId) ?? [];
    list.push(old);
    removed.set(parentId, list);
    touch(cur.byId.get(parentId));
  }

  if (frontmatterChanged) subChanged.add('');

  let count = status.size;
  for (const list of removed.values()) count += list.length;
  if (frontmatterChanged) count++;

  return { status, subChanged, removed, blockOps, frontmatterChanged, count };
}

function blockDiff(oldBlocks: Block[], newBlocks: Block[]): BlockOp[] {
  const changes = diffArrays(
    oldBlocks.map((b) => b.hash),
    newBlocks.map((b) => b.hash),
  );
  const ops: BlockOp[] = [];
  let oi = 0;
  let ni = 0;
  for (const ch of changes) {
    const n = ch.count ?? ch.value.length;
    for (let i = 0; i < n; i++) {
      if (ch.removed) ops.push({ kind: 'removed', block: oldBlocks[oi++] });
      else if (ch.added) ops.push({ kind: 'added', block: newBlocks[ni++] });
      else {
        ops.push({ kind: 'same', block: newBlocks[ni++] });
        oi++;
      }
    }
  }
  return ops;
}
