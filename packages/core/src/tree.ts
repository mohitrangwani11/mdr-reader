import type { Root, RootContent, Heading, Nodes, Parent } from 'mdast';
import { toString } from 'mdast-util-to-string';
import { parse as parseYaml } from 'yaml';
import { parseMarkdown, countKw } from './parse.ts';

export interface Stats {
  rules: number;
  done: number;
  total: number;
  /** Rough token estimate (chars / 4). */
  tokens: number;
}

export interface Block {
  node: RootContent;
  /** Raw markdown source of the block. */
  src: string;
  hash: string;
  stats: Stats;
}

export interface Section {
  /** Stable id: slug path of headings, e.g. "testing/unit-tests". Root is "". */
  id: string;
  /** Heading level 1–6 (0 for the root/preamble). */
  level: number;
  /** Depth in the section tree (root 0, top-level sections 1). */
  depth: number;
  title: string;
  heading?: Heading;
  blocks: Block[];
  children: Section[];
  parent?: Section;
  /** Stats of this section's own blocks. */
  own: Stats;
  /** Stats of this section including all descendants. */
  sum: Stats;
  /** Hash of title + own blocks (not children). */
  hash: string;
  /** Lowercased searchable text of title + own blocks. */
  searchText: string;
  /** Source range of the heading plus all descendants (root: whole doc). */
  start: number;
  end: number;
}

export interface Frontmatter {
  raw: string;
  data: Record<string, unknown> | null;
  error?: string;
}

export interface Doc {
  text: string;
  root: Section;
  frontmatter?: Frontmatter;
  /** All sections except root, in document order. */
  sections: Section[];
  byId: Map<string, Section>;
}

export function buildDoc(text: string): Doc {
  const mdast: Root = parseMarkdown(text);
  const root = newSection('', 0, 0, '');
  const stack: Section[] = [root];
  const sections: Section[] = [];
  const byId = new Map<string, Section>([['', root]]);
  let frontmatter: Frontmatter | undefined;

  for (const node of mdast.children) {
    if (node.type === 'yaml') {
      frontmatter = parseFrontmatter(node.value);
      continue;
    }
    if (node.type === 'heading') {
      while (stack.length > 1 && stack[stack.length - 1].level >= node.depth) stack.pop();
      const parent = stack[stack.length - 1];
      const title = toString(node).trim() || '(untitled)';
      const id = uniqueId(parent.id ? `${parent.id}/${slug(title)}` : slug(title), byId);
      const sec = newSection(id, node.depth, parent.depth + 1, title);
      sec.heading = node;
      sec.parent = parent;
      parent.children.push(sec);
      stack.push(sec);
      sections.push(sec);
      byId.set(id, sec);
      continue;
    }
    if (node.type === 'definition' || node.type === 'footnoteDefinition') {
      // Definitions render nothing useful on their own; keep them out of the tree.
      continue;
    }
    stack[stack.length - 1].blocks.push(makeBlock(node, text));
  }

  finalize(root);
  root.start = 0;
  root.end = text.length;
  for (const sec of sections) sec.start = sec.heading?.position?.start.offset ?? 0;
  sections.forEach((sec, i) => {
    const next = sections.slice(i + 1).find((s) => s.depth <= sec.depth);
    sec.end = next ? next.start : text.length;
  });
  return { text, root, frontmatter, sections, byId };
}

function newSection(id: string, level: number, depth: number, title: string): Section {
  return {
    id,
    level,
    depth,
    title,
    blocks: [],
    children: [],
    own: { rules: 0, done: 0, total: 0, tokens: 0 },
    sum: { rules: 0, done: 0, total: 0, tokens: 0 },
    hash: '',
    searchText: '',
    start: 0,
    end: 0,
  };
}

function makeBlock(node: RootContent, text: string): Block {
  const p = node.position;
  const src = p?.start.offset != null && p.end.offset != null ? text.slice(p.start.offset, p.end.offset) : '';
  return { node, src, hash: hash(src.trim()), stats: { ...blockStats(node), tokens: estimateTokens(src) } };
}

/** Rough token estimate. Real tokenizers vary; ~4 chars per token is a common rule of thumb. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : Math.round(n / 1000) + 'k';
}

/** Raw markdown of a section: its heading plus all descendants. */
export function sectionMarkdown(doc: Doc, id: string): string {
  const sec = doc.byId.get(id);
  if (!sec) return '';
  return doc.text.slice(sec.start, sec.end).trimEnd() + '\n';
}

function blockStats(node: Nodes): Omit<Stats, 'tokens'> {
  const stats = { rules: countKw(node), done: 0, total: 0 };
  const walk = (n: Nodes) => {
    if (n.type === 'listItem' && typeof n.checked === 'boolean') {
      stats.total++;
      if (n.checked) stats.done++;
    }
    if ('children' in n) for (const c of (n as Parent).children) walk(c as Nodes);
  };
  walk(node);
  return stats;
}

function finalize(sec: Section): Stats {
  const own = { rules: 0, done: 0, total: 0, tokens: 0 };
  for (const b of sec.blocks) add(own, b.stats);
  if (sec.heading) {
    own.rules += countKw(sec.heading);
    const p = sec.heading.position;
    if (p?.start.offset != null && p.end.offset != null) own.tokens += Math.ceil((p.end.offset - p.start.offset) / 4);
  }
  const sum = { ...own };
  for (const c of sec.children) add(sum, finalize(c));
  sec.own = own;
  sec.sum = sum;
  sec.hash = hash(sec.title + '\u0000' + sec.blocks.map((b) => b.hash).join(','));
  sec.searchText = (sec.title + '\n' + sec.blocks.map((b) => b.src).join('\n')).toLowerCase();
  return sum;
}

function add(a: Stats, b: Stats) {
  a.rules += b.rules;
  a.done += b.done;
  a.total += b.total;
  a.tokens += b.tokens;
}

function parseFrontmatter(raw: string): Frontmatter {
  try {
    const data = parseYaml(raw);
    return { raw, data: data && typeof data === 'object' && !Array.isArray(data) ? data : null };
  } catch (e) {
    return { raw, data: null, error: (e as Error).message };
  }
}

export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

function uniqueId(base: string, used: Map<string, unknown>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/** FNV-1a 32-bit, hex. Fast and good enough for change detection. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function ancestors(sec: Section): Section[] {
  const out: Section[] = [];
  for (let p = sec.parent; p; p = p.parent) out.push(p);
  return out;
}

/** True when the document is one title heading wrapping everything ("# Guide" + sections). */
export function hasLoneTitle(doc: Doc): boolean {
  return doc.root.children.length === 1 && doc.root.children[0].children.length > 0;
}

/**
 * Share of the document's tokens per section (0–1), for the outline's weight bars.
 * A lone title heading is skipped (it would always be 100 %).
 */
export function tokenShares(doc: Doc): Map<string, number> {
  const total = doc.root.sum.tokens || 1;
  const out = new Map<string, number>();
  const lone = hasLoneTitle(doc) ? doc.root.children[0].id : null;
  for (const s of doc.sections) if (s.id !== lone) out.set(s.id, s.sum.tokens / total);
  return out;
}

/**
 * Sections that dominate the token budget: the largest among its siblings
 * and at least 30 % of the document. These are the first places to trim.
 */
export function heavySections(doc: Doc): Set<string> {
  const shares = tokenShares(doc);
  const out = new Set<string>();
  const visit = (sibs: Section[]) => {
    if (sibs.length >= 2) {
      const top = sibs.reduce((a, b) => (b.sum.tokens > a.sum.tokens ? b : a));
      if ((shares.get(top.id) ?? 0) >= 0.3) out.add(top.id);
    }
    for (const s of sibs) visit(s.children);
  };
  visit(doc.root.children);
  return out;
}
