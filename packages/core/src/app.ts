import type { Host, FileGroup, FileEntry } from './host.ts';
import { buildDoc, sectionMarkdown, formatTokens, hasLoneTitle, type Doc, type Section } from './tree.ts';
import { diffDocs, type DocDiff } from './diff.ts';
import { renderDoc, renderOutline, renderImported, esc } from './render.ts';
import { importBlocked, MAX_IMPORT_DEPTH } from './imports.ts';
import { icons, type IconName } from './icons.ts';

type Mode = 'show' | 'path' | 'hide';

interface ViewState {
  collapsed: string[];
  focus: string[];
  openKeys: string[];
  openImports: string[];
}

const SHELL = `
<div class="mdr-shell">
  <aside class="mdr-side" aria-label="Sidebar">
    <section class="side-files" hidden>
      <div class="side-title">Files</div>
      <nav class="files"></nav>
    </section>
    <section class="side-outline">
      <div class="side-title">Outline<span class="side-sub" title="Bars show each section's share of the file's tokens">Tokens</span></div>
      <nav class="outline" aria-label="Outline"></nav>
    </section>
  </aside>
  <div class="mdr-scrim"></div>
  <main class="mdr-main">
    <div class="mdr-bar">
      <div class="bar-l">
        <button class="ibtn btn-side" type="button" title="Toggle sidebar (o)" aria-label="Toggle sidebar">${icons.menu}</button>
        <div class="crumb"><span class="file-name"></span><span class="crumb-acts"></span></div>
        <span class="doc-tok" title="Estimated tokens (≈ 4 characters per token)"></span>
        <span class="changes" hidden>
          <button class="chip-chg btn-next" type="button" title="Jump to next change (n)"></button><button class="ibtn btn-read" type="button" title="Mark as read (m)" aria-label="Mark as read">${icons.check}</button>
        </span>
      </div>
      <div class="bar-c">
        <label class="search" title="Filter sections (/)">${icons.search}<input type="search" placeholder="Filter sections" aria-label="Filter sections" spellcheck="false"><kbd>/</kbd></label>
        <div class="levels" role="group" aria-label="Fold to level">
          <button type="button" data-level="1" title="Fold to level 1 (1)">1</button><button type="button" data-level="2" title="Fold to level 2 (2)">2</button><button type="button" data-level="3" title="Fold to level 3 (3)">3</button><button type="button" data-level="0" title="Unfold everything (0)">All</button>
        </div>
        <button class="tbtn btn-rules" type="button" aria-pressed="false" title="Show only rules: MUST, NEVER, ALWAYS… (r)">Rules</button>
      </div>
      <div class="bar-r">
        <span class="actions"></span>
        <div class="menu-wrap">
          <button class="ibtn btn-more" type="button" title="More" aria-label="More" aria-haspopup="menu" aria-expanded="false">${icons.more}</button>
          <div class="menu" role="menu" hidden></div>
        </div>
      </div>
    </div>
    <div class="focusbar" hidden>
      <span class="focus-label">Focused on</span><span class="focus-chips"></span>
      <button class="tbtn btn-unfocus" type="button">Show all <kbd>Esc</kbd></button>
    </div>
    <div class="content"><article class="doc"></article></div>
  </main>
  <div class="help" hidden role="dialog" aria-label="Keyboard shortcuts">
    <div class="help-card">
      <h2>Keyboard shortcuts</h2>
      <dl>
        <dt><kbd>1</kbd>–<kbd>6</kbd></dt><dd>Fold to that level</dd>
        <dt><kbd>0</kbd></dt><dd>Unfold everything</dd>
        <dt><kbd>f</kbd></dt><dd>Focus current section (again to add/remove)</dd>
        <dt><kbd>c</kbd></dt><dd>Copy current section as markdown</dd>
        <dt><kbd>Esc</kbd></dt><dd>Clear search, then focus</dd>
        <dt><kbd>/</kbd></dt><dd>Filter sections</dd>
        <dt><kbd>r</kbd></dt><dd>Rules only</dd>
        <dt><kbd>n</kbd> / <kbd>N</kbd></dt><dd>Next / previous change</dd>
        <dt><kbd>m</kbd></dt><dd>Mark as read</dd>
        <dt><kbd>o</kbd></dt><dd>Toggle sidebar</dd>
        <dt><kbd>t</kbd></dt><dd>Theme: auto / light / dark</dd>
        <!--ACTION_KEYS-->
        <dt>Click heading</dt><dd>Fold / unfold</dd>
        <dt><kbd>Alt</kbd>+click</dt><dd>Fold / unfold with all subsections</dd>
      </dl>
      <button class="tbtn btn-help-close" type="button">Close</button>
    </div>
  </div>
  <div class="toast" role="status" aria-live="polite"></div>
</div>`;

export interface Reader {
  open(path: string): Promise<void>;
  /** Re-read the file list and the open file. */
  refresh(): Promise<void>;
  currentPath(): string | null;
  toast(message: string): void;
  /** Re-check which host actions apply to the open file. */
  updateActions(): void;
  /**
   * Scroll to a section, by id or (case-insensitive) title. With no target, go to the first change.
   * Returns false when nothing matched.
   */
  reveal(target?: string): boolean;
  destroy(): void;
}

export interface ReaderAction {
  label: string;
  title?: string;
  /** Single-key shortcut. */
  key?: string;
  /** Only show while a file is open. */
  needsFile?: boolean;
  /** Show only for some files (called with the open path). */
  showFor?(path: string): boolean;
  /** Render as the primary (filled) button. */
  primary?: boolean;
  icon?: IconName;
  /**
   * Where it lives: 'bar' (toolbar button; moves into the menu when space is tight),
   * 'menu' (the ⋯ menu), or 'crumb' (an icon next to the file name, and in the menu).
   */
  placement?: 'bar' | 'menu' | 'crumb';
  run(reader: Reader): void | Promise<void>;
}

export type Theme = 'auto' | 'light' | 'dark';
const THEMES: Theme[] = ['auto', 'light', 'dark'];
const THEME_ICON: Record<Theme, string> = { auto: icons.auto, light: icons.sun, dark: icons.moon };

/** Apply a theme to the page (auto follows the OS setting). */
export function applyTheme(t: Theme) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export interface ReaderOptions {
  /** Host-specific toolbar buttons. */
  actions?: ReaderAction[];
  /** Shown in place of the document when the workspace has no files. */
  emptyState?: HTMLElement;
  /**
   * The host owns the theme (e.g. VS Code): the reader follows it and hides its own theme controls.
   */
  theme?: { get(): 'light' | 'dark'; onChange(cb: () => void): void };
  /**
   * A link in the document that the reader doesn't handle itself (anything but #anchors,
   * relative .md links, imports and wiki links). Return true to take it over.
   */
  onLink?(href: string, from: string | null): boolean;
  /** Called after a file is opened or switched to. */
  onOpen?(path: string): void;
}

export async function mountReader(el: HTMLElement, host: Host, options: ReaderOptions = {}): Promise<Reader> {
  el.classList.add('mdr');
  el.innerHTML = SHELL;
  const $ = <T extends Element = HTMLElement>(s: string) => el.querySelector(s) as T;
  const shell = $('.mdr-shell');
  const filesEl = $('.files');
  const outlineEl = $('.outline');
  const docEl = $('.doc');
  const contentEl = $('.content');
  const searchEl = $<HTMLInputElement>('.search input');
  const rulesBtn = $('.btn-rules');
  const changesEl = $('.changes');
  const nextBtn = $('.btn-next');
  const focusBar = $('.focusbar');
  const focusChips = $('.focus-chips');
  const helpEl = $('.help');
  const toastEl = $('.toast');

  // ---- state ---------------------------------------------------------------
  let groups: FileGroup[] = [];
  let path: string | null = null;
  let text = '';
  let doc: Doc | null = null;
  let diff: DocDiff | null = null;
  let collapsed = new Set<string>();
  let focus = new Set<string>();
  let openKeys = new Set<string>();
  let openImports = new Set<string>();
  let query = '';
  let rulesOnly = false;
  /** Level last applied with 1–6/All; null once folds are changed by hand. */
  let level: number | null = null;
  let theme: Theme = 'auto';
  let cursorId: string | null = null;
  let changeIdx = -1;
  let secEls = new Map<string, HTMLElement>();
  let olEls = new Map<string, HTMLElement>();
  const closedGroups = new Set<string>(host.showAll ? [] : ['Other']);

  if (host.mode === 'folder') $('.side-files').hidden = false;
  const narrow = window.matchMedia('(max-width: 760px)');
  if (narrow.matches) shell.classList.add('side-closed');
  // Shrinking to widget size closes the sidebar; growing back opens it.
  narrow.addEventListener('change', (e) => shell.classList.toggle('side-closed', e.matches));

  // ---- files ---------------------------------------------------------------
  async function refreshFiles() {
    if (host.mode !== 'folder') return;
    groups = await host.listFiles();
    renderFiles();
  }

  function renderFiles() {
    if (!groups.length) {
      filesEl.innerHTML = `<p class="muted side-empty">${host.opaquePaths ? 'No docs yet.' : 'No markdown files found.'}</p>`;
      return;
    }
    filesEl.innerHTML = groups
      .map((g) => {
        const closed = closedGroups.has(g.name);
        const unread = g.files.filter((f) => f.unread).length;
        return (
          `<div class="fg${closed ? ' closed' : ''}" data-group="${esc(g.name)}">` +
          `<button class="fg-h" type="button"><span class="fg-chev"></span>${esc(g.name)}<span class="fg-n">${g.files.length}</span>` +
          (unread ? `<span class="fg-unread" title="${unread} changed since you last read"></span>` : '') +
          `</button><ul>` +
          g.files
            .map(
              (f) =>
                `<li><a href="#" class="f-link${f.path === path ? ' active' : ''}${f.unread ? ' unread' : ''}" data-path="${esc(f.path)}" title="${esc(f.path)}">` +
                `<span class="f-name">${esc(f.name)}${f.linked ? `<span class="f-linked" title="Linked to ${esc(f.linked)}: reload picks up edits">${icons.link}</span>` : ''}</span>${dirOf(f) ? `<span class="f-dir">${esc(dirOf(f))}</span>` : ''}</a>` +
                (host.removeFile ? `<button type="button" class="f-del" data-path="${esc(f.path)}" title="Remove from this browser" aria-label="Remove ${esc(f.name)}">×</button>` : '') +
                `</li>`,
            )
            .join('') +
          `</ul></div>`
        );
      })
      .join('');
  }

  function dirOf(f: FileEntry): string {
    const i = f.path.lastIndexOf('/');
    const dir = i > 0 ? f.path.slice(0, i) : '';
    return dir && !f.name.includes('/') ? dir : '';
  }

  function updateCrumb() {
    if (!path || !doc) return;
    const label = host.opaquePaths ? (allFiles().find((f) => f.path === path)?.name ?? nameOf(doc)) : path;
    $('.file-name').textContent = label;
    const linked = allFiles().find((f) => f.path === path)?.linked;
    $('.file-name').title = linked ? `Linked to ${linked}` : label;
    document.title = `${host.opaquePaths ? label : path.split('/').pop()} · mdr`;
  }

  function nameOf(d: Doc): string {
    return d.root.children[0]?.title ?? 'Untitled';
  }

  function allFiles(): FileEntry[] {
    return groups.flatMap((g) => g.files);
  }

  // ---- loading ---------------------------------------------------------------
  async function open(p: string, opts: { live?: boolean } = {}) {
    let newText: string;
    try {
      newText = await host.readFile(p);
    } catch (e) {
      if (opts.live) return; // file briefly missing during an atomic save
      toast(`Could not open ${p}`);
      return;
    }
    const switching = p !== path;
    if (!switching && newText === text) return; // spurious event, nothing to do
    if (switching) {
      await saveStateNow();
      const st = (await host.state.get<ViewState>(`view:${p}`)) ?? { collapsed: [], focus: [], openKeys: [], openImports: [] };
      collapsed = new Set(st.collapsed);
      focus = new Set(st.focus);
      openKeys = new Set(st.openKeys);
      openImports = new Set(st.openImports ?? []);
      query = '';
      searchEl.value = '';
      changeIdx = -1;
      cursorId = null;
      level = null;
    }
    let baseline = await host.getBaseline(p);
    if (baseline == null) {
      await host.markRead(p, newText);
      baseline = newText;
    }
    path = p;
    text = newText;
    shell.classList.remove('empty');
    doc = buildDoc(text);
    diff = baseline === text ? null : diffDocs(buildDoc(baseline), doc);
    if (diff && diff.count === 0) diff = null;
    // Drop state for sections that no longer exist.
    for (const s of [collapsed, focus]) for (const id of s) if (!doc.byId.has(id)) s.delete(id);

    render({ keepScroll: !switching });
    if (switching) contentEl.scrollTop = 0;
    updateCrumb();
    updateActions();
    if (switching) void host.state.set('last', p);
    if (host.mode === 'folder') history.replaceState(null, '', `#f=${encodeURIComponent(p)}`);
    renderFiles();
    if (switching) options.onOpen?.(p);
  }

  // ---- rendering -------------------------------------------------------------
  function render({ keepScroll }: { keepScroll: boolean }) {
    if (!doc) return;
    const anchor = keepScroll ? scrollAnchor() : null;
    docEl.innerHTML = doc.text.trim() ? renderDoc(doc, { diff, openKeys }) : `<p class="muted">This file is empty.</p>`;
    outlineEl.innerHTML = renderOutline(doc, diff) || `<p class="muted">No headings.</p>`;
    secEls = new Map([...docEl.querySelectorAll<HTMLElement>('.sec[data-id]')].map((e) => [e.dataset.id!, e]));
    olEls = new Map([...outlineEl.querySelectorAll<HTMLElement>('li[data-id]')].map((e) => [e.dataset.id!, e]));
    applyFold();
    applyVisibility();
    updateBar();
    reopenImports();
    if (anchor) restoreAnchor(anchor);
    spy();
  }

  function applyFold() {
    for (const [id, e] of secEls) e.classList.toggle('collapsed', collapsed.has(id));
    for (const [id, e] of olEls) e.classList.toggle('collapsed', collapsed.has(id));
    for (const b of el.querySelectorAll<HTMLElement>('.levels button')) b.setAttribute('aria-pressed', String(Number(b.dataset.level) === level));
    updateTokens();
  }

  /** "~1.2k / 2.0k tokens": what you can see right now vs. the whole file. */
  function updateTokens() {
    const tokEl = $('.doc-tok');
    if (!doc || !doc.root.sum.tokens) {
      tokEl.textContent = '';
      return;
    }
    const total = doc.root.sum.tokens;
    const expandAll = rulesOnly || query.trim() !== '';
    let visible = 0;
    for (const s of [doc.root, ...doc.sections]) {
      const e = secEls.get(s.id);
      if (!e || e.classList.contains('hid') || e.classList.contains('path')) continue;
      let shown = true;
      for (let p: Section | undefined = s; p && shown; p = p.parent) {
        if (secEls.get(p.id)?.classList.contains('hid')) shown = false;
        else if (!expandAll && collapsed.has(p.id)) shown = false;
      }
      if (!shown) continue;
      visible += rulesOnly ? s.blocks.filter((b) => b.stats.rules > 0).reduce((n, b) => n + b.stats.tokens, 0) : s.own.tokens;
    }
    visible = Math.min(visible, total);
    const all = visible >= total * 0.98;
    const { done, total: tasks, rules } = doc.root.sum;
    tokEl.innerHTML =
      `<i></i>${all ? '' : `~${formatTokens(visible)}<span class="tok-sep"> / </span>`}<span class="tok-total">${all ? '~' : ''}${formatTokens(total)}</span> tokens` +
      (tasks ? `<span class="tok-x" title="${done} of ${tasks} tasks done"> · ${done}/${tasks} done</span>` : '') +
      (rules ? `<span class="tok-x" title="${rules} rule keywords (MUST, NEVER, …)"> · ${rules} rule${rules > 1 ? 's' : ''}</span>` : '');
    tokEl.title = all
      ? `About ${total.toLocaleString('en-US')} tokens (≈ 4 characters per token)`
      : `About ${visible.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} tokens visible with the current folds and filters`;
    tokEl.classList.toggle('partial', !all);
  }

  function applyVisibility() {
    if (!doc) return;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = new Set<string>();
    if (terms.length) for (const s of [doc.root, ...doc.sections]) if (terms.every((t) => s.searchText.includes(t))) matches.add(s.id);

    const modeFor = (s: Section, set: Set<string>): Mode => {
      for (let p: Section | undefined = s; p; p = p.parent) if (set.has(p.id)) return 'show';
      return hasDescendantIn(s, set) ? 'path' : 'hide';
    };
    const worst = (a: Mode, b: Mode): Mode => (a === 'hide' || b === 'hide' ? 'hide' : a === 'path' || b === 'path' ? 'path' : 'show');

    for (const s of [doc.root, ...doc.sections]) {
      let m: Mode = 'show';
      if (focus.size) m = worst(m, s.id === '' ? 'path' : modeFor(s, focus));
      if (terms.length) m = worst(m, modeFor(s, matches));
      if (rulesOnly && s.sum.rules === 0 && s.id !== '') m = 'hide';
      if (s.id === '' && m === 'hide') m = 'path';
      const e = secEls.get(s.id);
      if (e) {
        e.classList.toggle('hid', m === 'hide');
        e.classList.toggle('path', m === 'path');
      }
      const o = olEls.get(s.id);
      if (o) o.classList.toggle('hid', m === 'hide');
    }

    const fm = docEl.querySelector<HTMLElement>('.fm');
    if (fm) fm.hidden = focus.size > 0 || rulesOnly || (terms.length > 0 && !terms.every((t) => (doc!.frontmatter?.raw ?? '').toLowerCase().includes(t)));

    docEl.classList.toggle('rules-only', rulesOnly);
    docEl.classList.toggle('searching', terms.length > 0);
    rulesBtn.setAttribute('aria-pressed', String(rulesOnly));

    focusBar.hidden = focus.size === 0;
    focusChips.innerHTML = [...focus]
      .map((id) => `<button type="button" class="chip" data-id="${esc(id)}" title="Remove from focus">${esc(doc!.byId.get(id)?.title ?? id)} ×</button>`)
      .join('');

    const visible = terms.length ? [...matches].filter((id) => !secEls.get(id)?.classList.contains('hid')).length : 0;
    docEl.querySelector('.no-results')?.remove();
    if (terms.length && !visible) docEl.insertAdjacentHTML('afterbegin', `<p class="no-results muted">No sections match “${esc(query)}”.</p>`);
    highlightSearch(terms);
    updateTokens();
  }

  function hasDescendantIn(s: Section, set: Set<string>): boolean {
    return s.children.some((c) => set.has(c.id) || hasDescendantIn(c, set));
  }

  function highlightSearch(terms: string[]) {
    const reg = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> })?.highlights;
    const HL = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!reg || !HL) return;
    reg.delete('mdr-search');
    if (!terms.length) return;
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && ranges.length < 2000; n = walker.nextNode()) {
      const t = n.textContent!.toLowerCase();
      for (const term of terms) {
        for (let i = t.indexOf(term); i !== -1 && ranges.length < 2000; i = t.indexOf(term, i + term.length)) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + term.length);
          ranges.push(r);
        }
      }
    }
    reg.set('mdr-search', new HL(...ranges));
  }

  function updateBar() {
    const n = diff?.count ?? 0;
    changesEl.hidden = n === 0;
    nextBtn.innerHTML = `<i></i>${n} change${n === 1 ? '' : 's'}`;
  }

  // ---- scroll anchoring & spy --------------------------------------------------
  function scrollAnchor(): { id: string; offset: number } | null {
    const top = contentEl.getBoundingClientRect().top;
    for (const [id, e] of secEls) {
      if (!id || e.offsetParent === null) continue;
      const r = e.getBoundingClientRect();
      if (r.bottom > top) return { id, offset: r.top - top };
    }
    return null;
  }

  function restoreAnchor(a: { id: string; offset: number }) {
    const e = secEls.get(a.id);
    if (!e) return;
    contentEl.scrollTop += e.getBoundingClientRect().top - contentEl.getBoundingClientRect().top - a.offset;
  }

  let spyQueued = false;
  function spy() {
    if (spyQueued) return;
    spyQueued = true;
    requestAnimationFrame(() => {
      spyQueued = false;
      const top = contentEl.getBoundingClientRect().top + 48;
      let active: string | null = null;
      for (const [id, e] of secEls) {
        if (!id || e.offsetParent === null) continue;
        if (e.getBoundingClientRect().top <= top) active = id;
        else break;
      }
      cursorId = active;
      for (const [id, o] of olEls) o.classList.toggle('active', id === active);
    });
  }

  // ---- actions -----------------------------------------------------------------
  function toggleFold(id: string, deep = false) {
    if (!doc) return;
    const sec = doc.byId.get(id);
    if (!sec) return;
    const close = !collapsed.has(id);
    const targets = deep ? [sec, ...descendants(sec)] : [sec];
    for (const s of targets) {
      if (close && (s.blocks.length || s.children.length)) collapsed.add(s.id);
      else collapsed.delete(s.id);
    }
    level = null;
    applyFold();
    saveState();
  }

  function descendants(s: Section): Section[] {
    return s.children.flatMap((c) => [c, ...descendants(c)]);
  }

  function foldToLevel(lvl: number) {
    if (!doc) return;
    // A lone title heading (e.g. "# Project guide") doesn't count as a level,
    // so "1" shows the document's real top-level sections.
    const d = lvl + (hasLoneTitle(doc) ? 1 : 0);
    collapsed = new Set(lvl === 0 ? [] : doc.sections.filter((s) => s.depth >= d && (s.blocks.length || s.children.length)).map((s) => s.id));
    level = lvl;
    applyFold();
    saveState();
    toast(lvl === 0 ? 'Unfolded everything' : `Folded to level ${lvl}`);
  }

  function toggleFocus(id: string | null) {
    if (!id || !doc?.byId.has(id)) {
      toast('Scroll to a section, then press f');
      return;
    }
    if (focus.has(id)) focus.delete(id);
    else {
      focus.add(id);
      // Focusing a section should show it: unfold it and its ancestors.
      for (let s = doc.byId.get(id); s; s = s.parent) collapsed.delete(s.id);
    }
    applyFold();
    applyVisibility();
    contentEl.scrollTop = 0;
    saveState();
  }

  async function copySection(id: string | null) {
    if (!doc || !id || !doc.byId.has(id)) {
      toast('Scroll to a section, then press c');
      return;
    }
    const sec = doc.byId.get(id)!;
    const md = sectionMarkdown(doc, id);
    try {
      await navigator.clipboard.writeText(md);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = md;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(`Copied “${sec.title}” (~${formatTokens(sec.sum.tokens)} tokens)`);
  }

  function reveal(id: string, flash = true) {
    if (!doc) return;
    const sec = doc.byId.get(id);
    if (!sec) return;
    let changed = false;
    for (let p = sec.parent; p; p = p.parent) changed = collapsed.delete(p.id) || changed;
    if (changed) {
      applyFold();
      saveState();
    }
    const e = secEls.get(id);
    if (!e || e.offsetParent === null) {
      toast('That section is hidden by the current filter');
      return;
    }
    e.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (flash) {
      e.classList.remove('flash');
      void e.offsetWidth;
      e.classList.add('flash');
    }
  }

  function nextChange(dir: 1 | -1) {
    const targets = [...docEl.querySelectorAll<HTMLElement>('.sec[data-st] > .sec-h, .blk[data-diff], .ghost-sec, .fm[data-diff]')];
    if (!targets.length) return;
    changeIdx = (changeIdx + dir + targets.length) % targets.length;
    const t = targets[changeIdx];
    for (let s = t.closest<HTMLElement>('.sec'); s; s = s.parentElement?.closest<HTMLElement>('.sec') ?? null) {
      const id = s.dataset.id!;
      if (collapsed.has(id) && !(t.parentElement === s)) collapsed.delete(id);
    }
    applyFold();
    if (t.offsetParent === null) {
      toast('Change is hidden by the current filter');
      return;
    }
    t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    t.classList.remove('flash');
    void t.offsetWidth;
    t.classList.add('flash');
    nextBtn.innerHTML = `<i></i>${changeIdx + 1} / ${targets.length}`;
  }

  async function markRead() {
    if (!path || !diff) return;
    await host.markRead(path, text);
    diff = null;
    changeIdx = -1;
    render({ keepScroll: true });
    const f = allFiles().find((x) => x.path === path);
    if (f) f.unread = false;
    renderFiles();
    toast('Marked as read');
  }

  // ---- imports -------------------------------------------------------------------
  async function toggleImport(a: HTMLAnchorElement) {
    const existing = a.nextPanel as HTMLElement | undefined;
    const ref = a.dataset.import!;
    const parentPanel = a.closest<HTMLElement>('.imp-panel');
    if (existing?.isConnected) {
      existing.remove();
      a.classList.remove('open');
      a.nextPanel = undefined;
      if (!parentPanel) {
        openImports.delete(ref);
        saveState();
      }
      return;
    }
    const from = parentPanel?.dataset.path ?? path!;
    const chain: string[] = parentPanel ? JSON.parse(parentPanel.dataset.chain!) : [path!];
    const panel = document.createElement('div');
    panel.className = 'imp-panel';
    panel.innerHTML = `<div class="imp-h"><span class="imp-ref">@${esc(ref)}</span><span class="imp-path muted">loading…</span><button type="button" class="ibtn imp-close" aria-label="Close import">×</button></div><div class="imp-b"></div>`;
    const host_ = a.closest('li') ?? a.closest('p, td, th, .blk') ?? a;
    if (host_.tagName === 'LI') {
      // Put the panel after the item's own text, before any nested list.
      const sub = [...host_.children].find((c) => c.tagName === 'UL' || c.tagName === 'OL');
      host_.insertBefore(panel, sub ?? null);
    } else host_.after(panel);
    a.nextPanel = panel;
    a.classList.add('open');
    if (!parentPanel) {
      openImports.add(ref);
      saveState();
    }
    panel.querySelector('.imp-close')!.addEventListener('click', () => toggleImport(a));

    let res = null;
    try {
      res = await host.resolveImport(from, ref);
    } catch {
      /* fall through */
    }
    const pathEl = panel.querySelector<HTMLElement>('.imp-path')!;
    const body = panel.querySelector<HTMLElement>('.imp-b')!;
    if (!res) {
      pathEl.textContent = 'not found';
      body.innerHTML = `<p class="muted">Could not resolve <code>${esc(ref)}</code> relative to <code>${esc(from)}</code>.</p>`;
      return;
    }
    pathEl.textContent = res.path;
    panel.dataset.path = res.path;
    const blocked = importBlocked(chain, res.path);
    if (blocked) {
      body.innerHTML =
        blocked === 'cycle'
          ? `<p class="muted">Import cycle: this file is already open above.</p>`
          : `<p class="muted">Stopped: imports nest deeper than ${MAX_IMPORT_DEPTH} levels.</p>`;
      return;
    }
    panel.dataset.chain = JSON.stringify([...chain, res.path]);
    body.innerHTML = renderImported(res.path, res.text);
  }

  function reopenImports() {
    for (const ref of openImports) {
      const a = [...docEl.querySelectorAll<HTMLAnchorElement>('a.import')].find((x) => x.dataset.import === ref && !x.closest('.imp-panel'));
      if (a && a.offsetParent !== null) void toggleImport(a);
      else if (!a) openImports.delete(ref);
    }
  }

  // ---- persistence -----------------------------------------------------------------
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveStateNow, 300);
  }
  async function saveStateNow() {
    clearTimeout(saveTimer);
    if (!path) return;
    const st: ViewState = { collapsed: [...collapsed], focus: [...focus], openKeys: [...openKeys], openImports: [...openImports] };
    await host.state.set(`view:${path}`, st);
  }

  // ---- toast -------------------------------------------------------------------------
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(msg: string) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
  }

  // ---- events --------------------------------------------------------------------------
  el.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const a = t.closest<HTMLAnchorElement>('a');

    if (t.closest('.btn-side') || t.closest('.mdr-scrim')) return void shell.classList.toggle('side-closed');
    if (t.closest('.btn-more')) return openMenu(menuEl.hidden === true);
    if (t.closest('.m-help')) {
      openMenu(false);
      return showHelp();
    }
    const themeOpt = t.closest<HTMLElement>('[data-theme-opt]');
    if (themeOpt) return void setTheme(themeOpt.dataset.themeOpt as Theme);
    if (t.closest('.btn-help-close') || t === helpEl) return hideHelp();
    if (t.closest('.btn-rules')) return void toggleRules();
    if (t.closest('.btn-next')) return nextChange(1);
    if (t.closest('.btn-read')) return void markRead();
    if (t.closest('.btn-unfocus')) return void clearFocus();
    const lvl = t.closest<HTMLElement>('.levels button');
    if (lvl) return foldToLevel(Number(lvl.dataset.level));
    const chip = t.closest<HTMLElement>('.focus-chips .chip');
    if (chip) return toggleFocus(chip.dataset.id!);

    // files sidebar
    const fg = t.closest<HTMLElement>('.fg-h');
    if (fg) {
      const g = fg.parentElement!.dataset.group!;
      if (closedGroups.has(g)) closedGroups.delete(g);
      else closedGroups.add(g);
      fg.parentElement!.classList.toggle('closed');
      return;
    }
    const del = t.closest<HTMLElement>('.f-del');
    if (del && host.removeFile) {
      const p = del.dataset.path!;
      return void host.removeFile(p).then(async () => {
        if (p === path) path = null;
        await syncFiles();
        toast('Removed');
      });
    }
    const act = t.closest<HTMLElement>('[data-act]');
    if (act) {
      openMenu(false);
      return void actions[Number(act.dataset.act)].run(api);
    }
    const fl = t.closest<HTMLAnchorElement>('a.f-link');
    if (fl) {
      ev.preventDefault();
      if (narrow.matches) shell.classList.add('side-closed');
      return void open(fl.dataset.path!);
    }

    // outline
    const olc = t.closest<HTMLElement>('.ol-chev');
    if (olc) return toggleFold(olc.closest<HTMLElement>('li')!.dataset.id!, ev.altKey);
    const oll = t.closest<HTMLElement>('.ol-link');
    if (oll) {
      ev.preventDefault();
      if (narrow.matches) shell.classList.add('side-closed');
      return reveal(oll.closest<HTMLElement>('li')!.dataset.id!);
    }

    // content
    if (a?.classList.contains('import')) {
      ev.preventDefault();
      return void toggleImport(a);
    }
    if (a?.classList.contains('wiki')) {
      ev.preventDefault();
      return void openWiki(a.dataset.wiki!);
    }
    if (a && !a.target && a.closest('.doc')) {
      const href = a.getAttribute('href') ?? '';
      if (href.startsWith('#')) {
        ev.preventDefault();
        const sec = doc?.sections.find((s) => s.id.endsWith(href.slice(1).toLowerCase()));
        if (sec) reveal(sec.id);
        return;
      }
      if (/\.(md|markdown|mdx)(#.*)?$/i.test(href) && !/^[a-z]+:/i.test(href)) {
        ev.preventDefault();
        return void openRelative(href.replace(/#.*$/, ''));
      }
      if (options.onLink?.(href, path)) return void ev.preventDefault();
    }
    const copyBtn = t.closest<HTMLElement>('.sec-copy');
    if (copyBtn) return void copySection(copyBtn.closest<HTMLElement>('.sec')!.dataset.id!);
    const focusBtn = t.closest<HTMLElement>('.sec-focus');
    if (focusBtn) return toggleFocus(focusBtn.closest<HTMLElement>('.sec')!.dataset.id!);
    const liTog = t.closest<HTMLElement>('.li-tog');
    if (liTog) return void liTog.parentElement!.classList.toggle('li-collapsed');
    const head = t.closest<HTMLElement>('.sec-h');
    if (head && !a && !window.getSelection()?.toString()) {
      const id = head.parentElement!.dataset.id!;
      cursorId = id;
      return toggleFold(id, ev.altKey);
    }
  });

  // Track which <details> folds are open so they survive live reloads.
  docEl.addEventListener(
    'toggle',
    (ev) => {
      const d = ev.target as HTMLDetailsElement;
      const key = d.dataset?.key;
      if (!key) return;
      if (d.open) openKeys.add(key);
      else openKeys.delete(key);
      saveState();
    },
    true,
  );

  contentEl.addEventListener('scroll', spy, { passive: true });

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = searchEl.value.trim();
      applyVisibility();
      if (query) contentEl.scrollTop = 0;
    }, 80);
  });
  searchEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const first = docEl.querySelector<HTMLElement>('.sec:not(.hid):not(.path)[data-id]:not([data-id=""])');
      if (first) first.scrollIntoView({ block: 'start' });
      searchEl.blur();
    }
  });

  let helpReturn: HTMLElement | null = null;
  function showHelp() {
    helpReturn = document.activeElement as HTMLElement | null;
    helpEl.hidden = false;
    helpEl.querySelector<HTMLElement>('.btn-help-close')?.focus();
  }
  function hideHelp() {
    helpEl.hidden = true;
    if (helpReturn?.isConnected && helpReturn.offsetParent !== null) helpReturn.focus();
    helpReturn = null;
  }

  function clearFocus() {
    focus.clear();
    applyVisibility();
    saveState();
  }

  function toggleRules() {
    rulesOnly = !rulesOnly;
    applyVisibility();
    toast(rulesOnly ? 'Showing only rules' : 'Showing everything');
  }

  async function openWiki(name: string) {
    const n = name.toLowerCase().replace(/\.md$/, '');
    const f = allFiles().find((x) => {
      const base = x.path.split('/').pop()!.toLowerCase().replace(/\.md$/, '');
      const dir = x.path.split('/').slice(-2, -1)[0]?.toLowerCase();
      return base === n || x.name.toLowerCase() === n || (base === 'skill' && dir === n);
    });
    if (f) await open(f.path);
    else toast(`No file named “${name}” in this workspace`);
  }

  async function openRelative(href: string) {
    if (!path) return;
    const parts = path.split('/').slice(0, -1);
    for (const seg of href.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    }
    const target = parts.join('/');
    if (host.mode === 'file' || allFiles().some((f) => f.path === target)) await open(target);
    else toast(`Not in this workspace: ${target}`);
  }

  const onKey = (ev: KeyboardEvent) => {
    const inInput = (ev.target as HTMLElement).closest?.('input, textarea, [contenteditable]');
    if (ev.key === 'Escape') {
      if (!menuEl.hidden) openMenu(false);
      else if (!helpEl.hidden) hideHelp();
      else if (query || searchEl.value) {
        searchEl.value = '';
        query = '';
        applyVisibility();
      } else if (focus.size) clearFocus();
      else if (rulesOnly) toggleRules();
      if (inInput) searchEl.blur();
      return;
    }
    if (inInput || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key;
    if (k === '/') {
      ev.preventDefault();
      searchEl.focus();
      searchEl.select();
    } else if (/^[0-6]$/.test(k)) foldToLevel(Number(k));
    else if (k === 'f') toggleFocus(cursorId);
    else if (k === 'c') void copySection(cursorId);
    else if (k === 'r') toggleRules();
    else if (k === 'n') nextChange(1);
    else if (k === 'N') nextChange(-1);
    else if (k === 'm') void markRead();
    else if (k === 'o') shell.classList.toggle('side-closed');
    else if (k === 't' && !options.theme) void cycleTheme();
    else if (k === '?') helpEl.hidden ? showHelp() : hideHelp();
    else {
      const a = actions.find((x) => x.key === k && actionVisible(x));
      if (!a) return;
      void a.run(api);
    }
    ev.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  // ---- live updates ---------------------------------------------------------------------
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let filesTimer: ReturnType<typeof setTimeout> | undefined;
  const off = host.onEvent((e) => {
    if (e.type === 'change' && e.path === path) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void open(e.path, { live: true }), 150);
    } else if (e.type === 'change') {
      // An open import panel may show this file.
      for (const p of docEl.querySelectorAll<HTMLElement>('.imp-panel')) {
        if (p.dataset.path === e.path) {
          const a = [...docEl.querySelectorAll<HTMLAnchorElement>('a.import')].find((x) => x.nextPanel === p);
          if (a) void toggleImport(a).then(() => toggleImport(a));
        }
      }
    }
    if (e.type === 'files' && path) {
      // Also covers reconnects and atomic saves (unlink + add): re-read the open file.
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void open(path!, { live: true }), 150);
    }
    clearTimeout(filesTimer);
    filesTimer = setTimeout(() => void syncFiles(), 300);
  });

  /** Refresh the file list; if the open file is gone (or none is open), open the first file or show the empty state. */
  async function syncFiles() {
    await refreshFiles();
    if (host.mode !== 'folder') return;
    const files = allFiles();
    if (path && files.some((f) => f.path === path)) return updateCrumb();
    const first = files.find((f) => f.group === 'Instructions')?.path ?? files[0]?.path;
    if (first) await open(first);
    else showEmpty();
  }

  function showEmpty() {
    shell.classList.add('empty');
    path = null;
    doc = null;
    diff = null;
    secEls = new Map();
    olEls = new Map();
    outlineEl.innerHTML = '';
    $('.file-name').textContent = '';
    $('.doc-tok').textContent = '';
    $('.file-name').title = '';
    changesEl.hidden = true;
    focusBar.hidden = true;
    docEl.innerHTML = '';
    if (options.emptyState) docEl.append(options.emptyState);
    else docEl.innerHTML = `<p class="muted">No agent markdown files found here. Try <code>--all</code> or open a file directly.</p>`;
    updateActions();
    if (host.mode === 'folder') history.replaceState(null, '', location.pathname + location.search);
  }

  // ---- host actions ------------------------------------------------------------------------
  const actions = options.actions ?? [];
  const actionsEl = $('.actions');
  const crumbActs = $('.crumb-acts');
  const tip = (a: ReaderAction) => `${esc(a.title ?? a.label)}${a.key ? ` (${esc(a.key)})` : ''}`;
  actionsEl.innerHTML = actions
    .map((a, i) =>
      !a.placement || a.placement === 'bar'
        ? `<button type="button" class="tbtn${a.primary ? ' primary' : ''}${a.icon ? ' has-ic' : ''}" data-act="${i}" title="${tip(a)}">${a.icon ? icons[a.icon] : ''}<span class="lbl">${esc(a.label)}</span></button>`
        : '',
    )
    .join('');
  crumbActs.innerHTML = actions
    .map((a, i) => (a.placement === 'crumb' ? `<button type="button" class="ibtn" data-act="${i}" title="${tip(a)}" aria-label="${esc(a.label)}">${a.icon ? icons[a.icon] : esc(a.label)}</button>` : ''))
    .join('');
  helpEl.querySelector('dl')!.innerHTML = helpEl
    .querySelector('dl')!
    .innerHTML.replace(
      '<!--ACTION_KEYS-->',
      actions
        .filter((a) => a.key)
        .map((a) => `<dt><kbd>${esc(a.key!)}</kbd></dt><dd>${esc(a.label)}</dd>`)
        .join(''),
    );
  if (options.theme) {
    helpEl.querySelector('dl')!.innerHTML = helpEl.querySelector('dl')!.innerHTML.replace(/<dt><kbd>t<\/kbd><\/dt><dd>[^<]*<\/dd>/, '');
    options.theme.onChange(() => showTheme());
  }
  function actionVisible(a: ReaderAction): boolean {
    if ((a.needsFile || a.showFor) && !path) return false;
    return !a.showFor || a.showFor(path!);
  }
  function updateActions() {
    actions.forEach((a, i) => {
      for (const b of el.querySelectorAll<HTMLElement>(`[data-act="${i}"]`)) b.hidden = !actionVisible(a);
    });
  }

  // ---- theme ----------------------------------------------------------------------------------
  function showTheme() {
    applyTheme(options.theme ? options.theme.get() : theme);
    for (const b of menuEl.querySelectorAll<HTMLElement>('[data-theme-opt]')) b.setAttribute('aria-pressed', String(b.dataset.themeOpt === theme));
  }
  async function setTheme(t: Theme, announce = true) {
    theme = t;
    showTheme();
    if (announce) toast(theme === 'auto' ? 'Theme follows your system' : `${theme[0].toUpperCase()}${theme.slice(1)} theme`);
    await host.state.set('theme', theme);
  }
  const cycleTheme = () => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]);

  // ---- overflow menu ------------------------------------------------------------------------------
  const menuEl = $('.menu');
  const moreBtn = $('.btn-more');
  function renderMenu() {
    const item = (a: ReaderAction, i: number) =>
      `<button type="button" role="menuitem" class="m-item" data-act="${i}">` +
      `${a.icon ? icons[a.icon] : '<span class="ic"></span>'}<span>${esc(a.label)}</span>${a.key ? `<kbd>${esc(a.key)}</kbd>` : ''}</button>`;
    const acts = actions.map((a, i) => [a, i] as const);
    const bar = acts.filter(([a]) => !a.placement || a.placement === 'bar').map(([a, i]) => item(a, i)).join('');
    const rest = acts.filter(([a]) => a.placement === 'menu' || a.placement === 'crumb').map(([a, i]) => item(a, i)).join('');
    menuEl.innerHTML =
      (bar ? `<div class="m-group m-compact">${bar}</div>` : '') +
      (rest ? `<div class="m-group">${rest}</div>` : '') +
      `<div class="m-group">` +
      (options.theme
        ? ''
        : `<div class="m-theme" role="group" aria-label="Theme"><span>Theme</span>` +
          THEMES.map((t) => `<button type="button" role="menuitemradio" data-theme-opt="${t}" title="${t === 'auto' ? 'Follow system' : t[0].toUpperCase() + t.slice(1)}" aria-label="${t}">${THEME_ICON[t]}</button>`).join('') +
          `</div>`) +
      `<button type="button" role="menuitem" class="m-item m-help">${icons.keyboard}<span>Keyboard shortcuts</span><kbd>?</kbd></button></div>`;
    showTheme();
  }
  function menuItems() {
    return [...menuEl.querySelectorAll<HTMLElement>('[role^="menuitem"]')].filter((b) => b.offsetParent !== null && !b.hidden);
  }
  function openMenu(open: boolean, focusFirst = false) {
    // Never leave focus on an item that is about to disappear.
    if (!open && menuEl.contains(document.activeElement)) moreBtn.focus();
    menuEl.hidden = !open;
    moreBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      updateActions();
      if (focusFirst) menuItems()[0]?.focus();
    }
  }
  menuEl.addEventListener('keydown', (ev) => {
    const items = menuItems();
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      items[(i + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (ev.key === 'Escape') {
      ev.stopPropagation();
      openMenu(false);
      moreBtn.focus();
    } else if (ev.key === 'Tab') openMenu(false);
  });
  moreBtn.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      openMenu(true, true);
    }
  });
  document.addEventListener('pointerdown', (ev) => {
    if (!menuEl.hidden && !(ev.target as HTMLElement).closest?.('.menu-wrap')) openMenu(false);
  });
  renderMenu();

  const api: Reader = {
    open: (p) => open(p),
    refresh: async () => {
      await syncFiles();
      if (path) await open(path, { live: true });
    },
    currentPath: () => path,
    toast,
    updateActions: () => updateActions(),
    reveal(target) {
      if (!doc) return false;
      if (target == null || target === '') {
        if (!diff) return false;
        changeIdx = -1;
        nextChange(1);
        return true;
      }
      const q = target.trim().replace(/^#+\s*/, '').toLowerCase();
      const sec =
        doc.byId.get(target) ??
        doc.sections.find((s) => s.title.toLowerCase() === q) ??
        doc.sections.find((s) => s.title.toLowerCase().includes(q));
      if (!sec) return false;
      reveal(sec.id);
      return true;
    },
    destroy() {
      off();
      document.removeEventListener('keydown', onKey);
      el.innerHTML = '';
    },
  };

  window.addEventListener('beforeunload', () => void saveStateNow());

  // ---- boot -----------------------------------------------------------------------------
  const savedTheme = await host.state.get<Theme>('theme');
  theme = savedTheme && THEMES.includes(savedTheme) ? savedTheme : 'auto';
  showTheme();
  await refreshFiles();
  const fromHash = decodeURIComponent(location.hash.match(/f=([^&]+)/)?.[1] ?? '');
  const last = await host.state.get<string>('last');
  const files = allFiles();
  const has = (p: string | null | undefined) => (p && files.some((f) => f.path === p) ? p : null);
  // Reopen what you were reading: the link's file, else the last file you opened, else the main instructions.
  const initial = has(fromHash) || has(last) || files.find((f) => f.group === 'Instructions')?.path || files[0]?.path;
  if (host.mode === 'file') {
    const single = (await host.listFiles())[0]?.files[0]?.path;
    if (single) await open(single);
  } else if (initial) await open(initial);
  else showEmpty();

  return api;
}

declare global {
  interface HTMLAnchorElement {
    nextPanel?: HTMLElement;
  }
}
