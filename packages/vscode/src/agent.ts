/**
 * What the Copilot agent-mode tools say. Pure functions over the core model (no vscode import),
 * so they are unit-tested directly. Output is short plain text: it lands in the agent's context.
 */
import { buildDoc, diffDocs, formatTokens, RULE_RE, type Doc, type Section, type FileGroup } from '@mdr/core/model';

const MAX_OUT = 6000;
const EXCERPT = 160;

export interface Located {
  /** Workspace-relative id. */
  path: string;
  /** Folder name, when there are several workspace folders. */
  folder?: string;
}

/**
 * Resolve what the agent typed ("CLAUDE.md", "docs/plan.md", "plan") to one file.
 * Exact path wins, then a path ending in it, then a display name, then a substring.
 * Ties go to the earlier group (Instructions first) and the shallower path.
 */
export function resolveName<T extends { path: string; name: string }>(files: T[], query: string): T | { candidates: T[] } | null {
  const q = query.trim().replace(/^\.?\//, '').replace(/\\/g, '/').toLowerCase();
  if (!q) return null;
  const depth = (f: T) => f.path.split('/').length;
  // The root CLAUDE.md beats packages/x/CLAUDE.md; two at the same depth is ambiguous.
  const pick = (xs: T[]): T | { candidates: T[] } | null => {
    if (!xs.length) return null;
    const sorted = [...xs].sort((a, b) => depth(a) - depth(b));
    return sorted.length === 1 || depth(sorted[0]) < depth(sorted[1]) ? sorted[0] : { candidates: sorted.slice(0, 12) };
  };
  const exact = files.find((f) => f.path.toLowerCase() === q);
  if (exact) return exact;
  const tail = pick(files.filter((f) => f.path.toLowerCase().endsWith('/' + q)));
  if (tail) return tail;
  const named = pick(files.filter((f) => f.name.toLowerCase() === q || f.name.toLowerCase().replace(/\.(md|markdown|mdx|mdc)$/, '') === q));
  if (named) return named;
  const sub = files.filter((f) => f.path.toLowerCase().includes(q));
  if (sub.length === 1) return sub[0];
  if (sub.length > 1) return { candidates: sub.slice(0, 12) };
  return null;
}

export function formatFileList(groups: { folder?: string; groups: FileGroup[] }[]): string {
  const out: string[] = [];
  let total = 0;
  let unread = 0;
  for (const g of groups) {
    if (groups.length > 1) out.push(`# ${g.folder}`);
    for (const grp of g.groups) {
      out.push(`## ${grp.name}`);
      for (const f of grp.files) {
        total++;
        if (f.unread) unread++;
        out.push(`- ${f.path}${f.unread ? '  (changed since last read)' : ''}`);
      }
    }
  }
  if (!total) return 'No markdown files found in this workspace.';
  out.unshift(`${total} markdown file${total === 1 ? '' : 's'}${unread ? `, ${unread} changed since the user last read ${unread === 1 ? 'it' : 'them'}` : ''}.`);
  return cap(out.join('\n'));
}

const titlePath = (s: Section) => {
  const parts: string[] = [];
  for (let p: Section | undefined = s; p && p.id !== ''; p = p.parent) parts.unshift(p.title);
  return parts.join(' › ');
};

const oneLine = (src: string) => {
  const t = src.replace(/\s+/g, ' ').trim();
  return t.length > EXCERPT ? t.slice(0, EXCERPT - 1) + '…' : t;
};

/** Section-level summary of what changed between the last-read snapshot and now. */
export function formatChanges(path: string, baseline: string | null, current: string): string {
  if (baseline == null) return `${path} has not been opened in mdr yet, so there is no last-read snapshot to compare against.`;
  if (baseline === current) return `${path}: no changes since the user last read it.`;
  const base = buildDoc(baseline);
  const cur = buildDoc(current);
  const d = diffDocs(base, cur);
  const out: string[] = [];
  if (d.frontmatterChanged) out.push('- Frontmatter changed');
  for (const sec of [cur.root, ...cur.sections]) {
    const st = d.status.get(sec.id);
    if (!st) continue;
    const name = sec.id === '' ? '(text before the first heading)' : titlePath(sec);
    if (st === 'added') {
      out.push(`- Added section: ${name} (~${formatTokens(sec.sum.tokens)} tokens)`);
      continue;
    }
    out.push(`- Changed: ${name}`);
    for (const op of d.blockOps.get(sec.id) ?? []) {
      if (op.kind === 'added') out.push(`    + ${oneLine(op.block.src)}`);
      else if (op.kind === 'removed') out.push(`    − ${oneLine(op.block.src)}`);
    }
  }
  for (const [parentId, secs] of d.removed) {
    const parent = parentId ? cur.byId.get(parentId) : null;
    for (const s of secs) out.push(`- Removed section: ${s.title}${parent ? ` (was under ${titlePath(parent)})` : ''}`);
  }
  if (!out.length) return `${path}: only whitespace or formatting changed since the user last read it.`;
  const n = d.count;
  return cap(`${path}: ${n} section${n === 1 ? '' : 's'} changed since the user last read it.\n${out.join('\n')}`);
}

/** Outline with tokens, checklist progress and rule counts; or just the rule lines. */
export function formatOutline(path: string, text: string, rulesOnly = false): string {
  const doc = buildDoc(text);
  if (rulesOnly) return cap(rulesOf(path, doc));
  const out: string[] = [`${path}: ~${formatTokens(doc.root.sum.tokens)} tokens, ${doc.sections.length} sections${doc.root.sum.total ? `, checklist ${doc.root.sum.done}/${doc.root.sum.total} done` : ''}${doc.root.sum.rules ? `, ${doc.root.sum.rules} rule keywords` : ''}.`];
  const fm = doc.frontmatter?.data;
  if (fm) {
    const keys = ['name', 'description', 'version', 'allowed-tools', 'applyTo', 'mode', 'model', 'tools'].filter((k) => fm[k] != null);
    for (const k of keys) out.push(`${k}: ${oneLine(Array.isArray(fm[k]) ? (fm[k] as unknown[]).join(', ') : String(fm[k]))}`);
  }
  const minDepth = Math.min(...doc.sections.map((s) => s.depth));
  for (const s of doc.sections) {
    const meta = [`~${formatTokens(s.sum.tokens)} tok`];
    if (s.sum.total) meta.push(`${s.sum.done}/${s.sum.total} done`);
    if (s.sum.rules) meta.push(`${s.sum.rules} rule${s.sum.rules === 1 ? '' : 's'}`);
    out.push(`${'  '.repeat(s.depth - minDepth)}- ${s.title} (${meta.join(', ')})`);
  }
  if (!doc.sections.length) out.push('(no headings)');
  return cap(out.join('\n'));
}

function rulesOf(path: string, doc: Doc): string {
  const out: string[] = [];
  let n = 0;
  for (const sec of [doc.root, ...doc.sections]) {
    const lines: string[] = [];
    for (const b of sec.blocks) {
      if (b.node.type === 'code' || b.node.type === 'html' || b.node.type === 'yaml') continue;
      for (const line of b.src.split('\n')) {
        RULE_RE.lastIndex = 0;
        if (RULE_RE.test(line.replace(/`[^`]*`/g, ''))) lines.push(`  - ${oneLine(line.replace(/^\s*(?:[-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, ''))}`);
      }
    }
    if (lines.length) {
      out.push(`${sec.id === '' ? '(before the first heading)' : titlePath(sec)}:`, ...lines);
      n += lines.length;
    }
  }
  return n ? `${path}: ${n} line${n === 1 ? '' : 's'} with rule keywords (MUST, NEVER, ALWAYS, IMPORTANT, DO NOT…).\n${out.join('\n')}` : `${path}: no rule keywords (MUST, NEVER, ALWAYS…) found.`;
}

function cap(s: string): string {
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + '\n… (truncated)' : s;
}

/** Number of changed sections, for "Opened X (2 sections changed)". */
export function changeCount(baseline: string | null, current: string): number {
  if (baseline == null || baseline === current) return 0;
  return diffDocs(buildDoc(baseline), buildDoc(current)).count;
}
