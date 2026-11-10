import { toHast } from 'mdast-util-to-hast';
import { toHtml } from 'hast-util-to-html';
import type { Nodes as HastNodes, Element, ElementContent, Root as HastRoot } from 'hast';
import type { Nodes as MdNodes, RootContent } from 'mdast';
import type { Doc, Section, Block, Frontmatter } from './tree.ts';
import type { DocDiff, BlockOp } from './diff.ts';
import { buildDoc, formatTokens, tokenShares, heavySections, hasLoneTitle } from './tree.ts';
import { icons } from './icons.ts';
import { parseMarkdown } from './parse.ts';

export const CODE_FOLD_LINES = 15;
export const TABLE_FOLD_ROWS = 10;

export interface RenderOptions {
  diff?: DocDiff | null;
  /** Keys of <details> folds the user has opened (code, tables, frontmatter, ghosts). */
  openKeys?: Set<string>;
  /** Internal: id of a lone title section (its stats live in the toolbar instead). */
  lone?: string | null;
  /** Internal: ids of the document's top-level sections (get a separator). */
  top?: Set<string>;
}

/** The sections a reader thinks of as "top level": children of a lone title, else depth 1. */
export function topSections(doc: Doc): Section[] {
  return hasLoneTitle(doc) ? doc.root.children[0].children : doc.root.children;
}

/* ------------------------------------------------------------------------ */
/* Document                                                                  */
/* ------------------------------------------------------------------------ */

export function renderDoc(doc: Doc, opts: RenderOptions = {}): string {
  const o: RenderOptions = { ...opts, lone: hasLoneTitle(doc) ? doc.root.children[0].id : null, top: new Set(topSections(doc).map((s) => s.id)) };
  const fm = doc.frontmatter ? renderFrontmatter(doc.frontmatter, o) : '';
  return fm + renderSection(doc.root, o);
}

function renderSection(sec: Section, opts: RenderOptions): string {
  const diff = opts.diff;
  const st = diff?.status.get(sec.id);
  const attrs = [
    `class="sec"`,
    `data-id="${esc(sec.id)}"`,
    `data-depth="${sec.depth}"`,
    `data-rt="${sec.sum.rules}"`,
    st ? `data-st="${st}"` : '',
    diff?.subChanged.has(sec.id) ? `data-sub="1"` : '',
    sec.blocks.length || sec.children.length ? '' : `data-empty="1"`,
    opts.top?.has(sec.id) ? 'data-top="1"' : '',
    opts.lone === sec.id ? 'data-title="1"' : '',
  ]
    .filter(Boolean)
    .join(' ');

  let head = '';
  if (sec.heading) {
    const h = toHast(sec.heading) as Element;
    const inner = toHtml({ type: 'root', children: h.children } as HastRoot);
    head =
      `<header class="sec-h">` +
      `<button class="chev" type="button" aria-label="Fold section" tabindex="-1"></button>` +
      `<h${sec.level} class="sec-t">${inner}</h${sec.level}>` +
      // A lone title's stats are the whole document's: they live in the toolbar.
      `<span class="badges">${opts.lone === sec.id ? changeDot(sec, diff) : badges(sec, diff)}</span>` +
      `<span class="sec-tools">` +
      `<button class="sec-copy" type="button" title="Copy this section and its subsections as markdown (c)" aria-label="Copy section">` +
      `${icons.copy}<span class="lbl">Copy${sec.sum.tokens ? `<span class="lbl-tok"> · ~${formatTokens(sec.sum.tokens)} tokens</span>` : ''}</span></button>` +
      `<button class="sec-focus" type="button" title="Focus on this section (f)" aria-label="Focus">${icons.focus}</button>` +
      `</span>` +
      `</header>`;
  }

  const ops: BlockOp[] = diff?.blockOps.get(sec.id) ?? sec.blocks.map((b) => ({ kind: 'same' as const, block: b }));
  let body = '';
  let idx = 0;
  for (const op of ops) {
    if (op.kind === 'removed') {
      body += `<div class="blk ghost" data-diff="removed" title="Removed since you last read">${blockHtml(op.block, '', opts)}</div>`;
      continue;
    }
    const key = `${sec.id}#${idx++}`;
    const rule = op.block.stats.rules > 0 ? ' data-rule="1"' : '';
    const d = op.kind === 'added' ? ' data-diff="added"' : '';
    body += `<div class="blk"${rule}${d}>${blockHtml(op.block, key, opts)}</div>`;
  }
  for (const gone of diff?.removed.get(sec.id) ?? []) body += renderGhostSection(gone);
  for (const child of sec.children) body += renderSection(child, opts);

  return `<section ${attrs}>${head}<div class="sec-b">${body}</div></section>`;
}

function renderGhostSection(sec: Section): string {
  const inner = sec.blocks.map((b) => blockHtml(b, '', {})).join('') + sec.children.map(renderGhostSection).join('');
  return (
    `<details class="ghost-sec" data-diff="removed"><summary>` +
    `<span class="ghost-label">Removed</span> ${esc('#'.repeat(sec.level))} ${esc(sec.title)}</summary>` +
    `<div class="ghost-body">${inner}</div></details>`
  );
}

export function badges(sec: Section, diff?: DocDiff | null): string {
  let out = '';
  const { done, total, rules } = sec.sum;
  if (total > 0) {
    const pct = Math.round((done / total) * 100);
    const cls = done === total ? ' complete' : '';
    out += `<span class="b-prog${cls}" title="${done} of ${total} tasks done"><span class="bar"><i style="width:${pct}%"></i></span>${done}/${total}</span>`;
  }
  const tokens = sec.sum.tokens;
  if (tokens > 0) out += `<span class="b-tok" title="About ${tokens.toLocaleString('en-US')} tokens incl. subsections (estimate)">~${formatTokens(tokens)}</span>`;
  if (rules > 0) out += `<span class="b-rule" title="${rules} rule keyword${rules > 1 ? 's' : ''} (MUST, NEVER, …)">${rules}</span>`;
  return out + changeDot(sec, diff);
}

function changeDot(sec: Section, diff?: DocDiff | null): string {
  if (!diff?.subChanged.has(sec.id)) return '';
  const st = diff.status.get(sec.id);
  const label = st === 'added' ? 'New since you last read' : st === 'changed' ? 'Changed since you last read' : 'Something inside changed';
  return `<span class="b-chg" data-kind="${st ?? 'sub'}" title="${label}"></span>`;
}

/* ------------------------------------------------------------------------ */
/* Blocks                                                                    */
/* ------------------------------------------------------------------------ */

function blockHtml(block: Block, key: string, opts: RenderOptions): string {
  const node = block.node;
  const html = nodeHtml(node);
  if (node.type === 'code') {
    const lines = node.value.split('\n').length;
    if (lines > CODE_FOLD_LINES) {
      const first = node.value.split('\n').find((l) => l.trim()) ?? '';
      return details(
        'fold fold-code',
        key,
        opts,
        `<span class="fold-kind">${esc(node.lang || 'code')}</span><span class="fold-meta">${lines} lines</span><code class="fold-peek">${esc(first.slice(0, 120))}</code>`,
        html,
      );
    }
  }
  if (node.type === 'table') {
    const rows = node.children.length - 1;
    if (rows > TABLE_FOLD_ROWS) {
      const cols = (node.children[0]?.children ?? []).map((c) => mdText(c as MdNodes)).join(' · ');
      return details(
        'fold fold-table',
        key,
        opts,
        `<span class="fold-kind">table</span><span class="fold-meta">${rows} rows</span><span class="fold-peek">${esc(cols.slice(0, 140))}</span>`,
        `<div class="table-wrap">${html}</div>`,
      );
    }
    return `<div class="table-wrap">${html}</div>`;
  }
  return html;
}

function details(cls: string, key: string, opts: RenderOptions, summary: string, body: string): string {
  const open = key && opts.openKeys?.has(key) ? ' open' : '';
  const k = key ? ` data-key="${esc(key)}"` : '';
  return `<details class="${cls}"${k}${open}><summary>${summary}</summary>${body}</details>`;
}

function nodeHtml(node: RootContent | MdNodes): string {
  const h = toHast(node as MdNodes) as HastNodes | undefined;
  if (!h) return '';
  decorate(h);
  return toHtml(h);
}

/** Add fold toggles to list items that contain nested lists. */
function decorate(n: HastNodes): void {
  if (!('children' in n)) return;
  for (const c of n.children as ElementContent[]) {
    if (c.type !== 'element') continue;
    if (c.tagName === 'li' && c.children.some((k) => k.type === 'element' && (k.tagName === 'ul' || k.tagName === 'ol'))) {
      const cls = (c.properties.className as string[] | undefined) ?? [];
      c.properties.className = [...cls, 'has-sub'];
      c.children.unshift({
        type: 'element',
        tagName: 'button',
        properties: { className: ['li-tog'], type: 'button', ariaLabel: 'Fold list', tabIndex: -1 },
        children: [],
      });
    }
    if (c.tagName === 'a') {
      const href = String(c.properties.href ?? '');
      if (/^https?:/i.test(href)) {
        c.properties.target = '_blank';
        c.properties.rel = ['noopener', 'noreferrer'];
      }
    }
    decorate(c);
  }
}

function mdText(n: MdNodes): string {
  if ('value' in n && typeof n.value === 'string') return n.value;
  if ('children' in n) return (n.children as MdNodes[]).map(mdText).join('');
  return '';
}

/* ------------------------------------------------------------------------ */
/* Frontmatter                                                               */
/* ------------------------------------------------------------------------ */

function renderFrontmatter(fm: Frontmatter, opts: RenderOptions): string {
  const data = fm.data ?? {};
  const name = typeof data.name === 'string' ? data.name : typeof data.title === 'string' ? data.title : '';
  const desc = typeof data.description === 'string' ? data.description : '';
  const ver = typeof data.version === 'string' || typeof data.version === 'number' ? String(data.version) : '';
  const rest = Object.keys(data).filter((k) => !['name', 'title', 'description', 'version'].includes(k));
  const changed = opts.diff?.frontmatterChanged ? ' data-diff="changed"' : '';
  const rows = Object.entries(data)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`)
    .join('');
  const summary =
    `<span class="fm-tag">Frontmatter</span>` +
    (name ? `<span class="fm-name">${esc(name)}</span>` : '') +
    (ver ? `<span class="fm-ver">v${esc(ver.replace(/^v/i, ''))}</span>` : '') +
    (desc ? `<span class="fm-desc" title="${esc(desc)}">${esc(desc)}</span>` : '') +
    (rest.length ? `<span class="fm-more">+${rest.length} field${rest.length > 1 ? 's' : ''}</span>` : '') +
    `<span class="fm-chev" aria-hidden="true"></span>` +
    (fm.error ? `<span class="fm-err">invalid YAML</span>` : '');
  const body = (rows ? `<table class="fm-table">${rows}</table>` : '') + `<pre class="fm-raw"><code>${esc(fm.raw)}</code></pre>`;
  const open = opts.openKeys?.has('fm') ? ' open' : '';
  return `<details class="fm" data-key="fm"${open}${changed}><summary title="Frontmatter: click to see all fields">${summary}</summary>${body}</details>`;
}

/* ------------------------------------------------------------------------ */
/* Outline                                                                   */
/* ------------------------------------------------------------------------ */

export function renderOutline(doc: Doc, diff?: DocDiff | null): string {
  const shares = tokenShares(doc);
  const heavy = heavySections(doc);
  const lone = hasLoneTitle(doc) ? doc.root.children[0].id : null;
  const top = new Set(topSections(doc).map((s) => s.id));
  const meta = (s: Section): string => {
    if (s.id === lone) return changeDot(s, diff); // the toolbar shows the whole file's numbers
    let out = '';
    // Progress and rules only on top-level rows: deeper rows stay quiet.
    if (top.has(s.id)) {
      const { done, total, rules } = s.sum;
      if (total > 0) out += `<span class="b-prog${done === total ? ' complete' : ''}" title="${done} of ${total} tasks done">${done}/${total}</span>`;
      if (rules > 0) out += `<span class="b-rule" title="${rules} rule keyword${rules > 1 ? 's' : ''}">${rules}</span>`;
    }
    out += changeDot(s, diff);
    if (s.sum.tokens > 0) {
      const pct = Math.round((shares.get(s.id) ?? 0) * 100);
      out += `<span class="b-tok" title="About ${s.sum.tokens.toLocaleString('en-US')} tokens · ${pct}% of the file">~${formatTokens(s.sum.tokens)}</span>`;
    }
    return out;
  };
  const items = (secs: Section[]): string =>
    secs.length
      ? `<ul>${secs
          .map((s) => {
            const share = shares.get(s.id);
            const weight =
              share != null && s.sum.tokens > 0
                ? `<span class="ol-w" aria-hidden="true"><i style="width:${Math.max(2, Math.round(share * 100))}%"></i></span>`
                : '';
            return (
              `<li data-id="${esc(s.id)}"${diff?.subChanged.has(s.id) ? ' data-sub="1"' : ''}${heavy.has(s.id) ? ' data-heavy="1"' : ''}>` +
              `<div class="ol-row">` +
              (s.children.length ? `<button class="ol-chev" type="button" tabindex="-1" aria-label="Fold"></button>` : `<span class="ol-pad"></span>`) +
              `<a href="#" class="ol-link" title="${esc(s.title)}">${esc(s.title)}</a>` +
              `<span class="badges">${meta(s)}</span>` +
              weight +
              `</div>${items(s.children)}</li>`
            );
          })
          .join('')}</ul>`
      : '';
  return items(doc.root.children);
}

/* ------------------------------------------------------------------------ */
/* Imported files                                                            */
/* ------------------------------------------------------------------------ */

const MD_EXT = /\.(md|markdown|mdx|mdc)$/i;

/** Render an imported file: markdown is rendered (without frontmatter); anything else as code. */
export function renderImported(path: string, text: string): string {
  if (!MD_EXT.test(path)) {
    const lang = path.split('.').pop() ?? '';
    return `<pre><code class="language-${esc(lang)}">${esc(text)}</code></pre>`;
  }
  const doc = buildDoc(text);
  const fm = doc.frontmatter ? renderFrontmatter(doc.frontmatter, {}) : '';
  const all = [doc.root, ...doc.sections];
  return (
    fm +
    all
      .map((s) => (s.heading ? nodeHtml(s.heading) : '') + s.blocks.map((b) => blockHtml(b, '', {})).join(''))
      .join('')
  );
}

/** Render plain markdown text (no tree, no folding). */
export function renderMarkdown(text: string): string {
  const root = parseMarkdown(text);
  root.children = root.children.filter((c) => c.type !== 'yaml');
  return nodeHtml(root);
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
