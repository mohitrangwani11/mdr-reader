import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import type { Root, Parent, Nodes, Text, PhrasingContent } from 'mdast';
import { RULE_KEYWORDS } from './rules.ts';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']);

/** Parse markdown and annotate it with agent-aware inline nodes (rules, @imports, [[links]]). */
export function parseMarkdown(text: string): Root {
  const root = processor.runSync(processor.parse(text)) as Root;
  enrich(root);
  return root;
}

/* ------------------------------------------------------------------------ */
/* Inline enrichment                                                         */
/* ------------------------------------------------------------------------ */

const kwAlt = RULE_KEYWORDS.join('|');
// 1: wiki target, 2: wiki label, 3: import ref, 4: rule keyword
const TOKEN_RE = new RegExp(
  String.raw`\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]` +
    String.raw`|(?<=^|[\s(])@((?:~|\.{1,2})?\/?[\w.\-]+(?:\/[\w.\-]+)*)` +
    `|(?<![A-Za-z])(${kwAlt})(?![A-Za-z])`,
  'g',
);

/** An @ref counts as an import only if it looks like a path (has a slash or a file extension). */
export function normalizeImportRef(raw: string): string | null {
  const ref = raw.replace(/[.,;:]+$/, '');
  if (!ref || ref === '.' || ref === '..') return null;
  if (ref.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(ref)) return ref;
  return null;
}

function splitText(node: Text): PhrasingContent[] | null {
  const value = node.value;
  const out: PhrasingContent[] = [];
  let last = 0;
  let changed = false;
  for (const m of value.matchAll(TOKEN_RE)) {
    const start = m.index!;
    let created: PhrasingContent | null = null;
    let consumed = m[0];
    if (m[1] !== undefined) {
      const target = m[1].trim();
      created = mk('mdrWiki', 'a', { className: ['wiki'], href: '#', dataWiki: target }, m[2]?.trim() || target);
    } else if (m[3] !== undefined) {
      const ref = normalizeImportRef(m[3]);
      if (ref) {
        consumed = '@' + ref;
        created = mk('mdrImport', 'a', { className: ['import'], href: '#', dataImport: ref, title: 'Show imported file' }, '@' + ref);
      }
    } else if (m[4] !== undefined) {
      created = mk('mdrKw', 'mark', { className: ['kw'] }, m[4]);
    }
    if (!created) continue;
    changed = true;
    if (start > last) out.push({ type: 'text', value: value.slice(last, start) });
    out.push(created);
    last = start + consumed.length;
  }
  if (!changed) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function mk(type: string, hName: string, hProperties: Record<string, unknown>, label: string): PhrasingContent {
  return {
    type,
    data: { hName, hProperties },
    children: [{ type: 'text', value: label }],
  } as unknown as PhrasingContent;
}

// Links are skipped so we never nest an <a> inside an <a>.
const SKIP = new Set(['code', 'inlineCode', 'html', 'yaml', 'definition', 'link', 'linkReference']);

function enrich(node: Nodes): void {
  if (SKIP.has(node.type) || !('children' in node)) return;
  const parent = node as Parent;
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i] as Nodes;
    if (child.type === 'text') {
      const parts = splitText(child);
      if (parts) {
        parent.children.splice(i, 1, ...(parts as never[]));
        i += parts.length - 1;
      }
    } else {
      enrich(child);
    }
  }
  // Mark the containing block so "rules only" mode and styling can find it.
  if ((node.type === 'paragraph' || node.type === 'listItem' || node.type === 'tableRow') && hasDirectRule(node)) {
    addClass(node, 'rule');
  }
}

function hasDirectRule(node: Parent): boolean {
  const kids = node.type === 'listItem'
    ? node.children.filter((c) => c.type === 'paragraph').flatMap((p) => (p as Parent).children)
    : node.type === 'tableRow'
      ? node.children.flatMap((c) => (c as Parent).children)
      : node.children;
  return kids.some((c) => containsKw(c as Nodes));
}

function containsKw(n: Nodes): boolean {
  if ((n.type as string) === 'mdrKw') return true;
  if (n.type === 'list') return false; // nested lists mark their own items
  return 'children' in n && (n as Parent).children.some((c) => containsKw(c as Nodes));
}

function addClass(node: Nodes, cls: string): void {
  const data = (node.data ??= {}) as { hProperties?: Record<string, unknown> };
  const props = (data.hProperties ??= {});
  const cur = (props.className as string[] | undefined) ?? [];
  props.className = [...cur, cls];
}

/** Count rule keywords inside an (enriched) mdast subtree. */
export function countKw(node: Nodes): number {
  if ((node.type as string) === 'mdrKw') return 1;
  if (!('children' in node)) return 0;
  let n = 0;
  for (const c of (node as Parent).children) n += countKw(c as Nodes);
  return n;
}
