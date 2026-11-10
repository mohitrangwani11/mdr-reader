import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDoc } from '../src/tree.ts';
import { diffDocs } from '../src/diff.ts';
import { renderDoc, renderOutline, renderImported } from '../src/render.ts';
import { countRules } from '../src/rules.ts';
import { findImports } from '../src/imports.ts';

const fx = (p: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url)), 'utf8');

describe('section tree', () => {
  const doc = buildDoc(fx('CLAUDE.md'));

  it('nests sections by heading level with stable slug-path ids', () => {
    expect(doc.root.children.map((s) => s.id)).toEqual(['project-guide-for-agents']);
    const top = doc.root.children[0];
    expect(top.children.map((s) => s.id)).toEqual([
      'project-guide-for-agents/code-style',
      'project-guide-for-agents/testing',
      'project-guide-for-agents/git-workflow',
      'project-guide-for-agents/code-style-2',
    ]);
    const testing = doc.byId.get('project-guide-for-agents/testing')!;
    expect(testing.children.map((s) => s.title)).toEqual(['Unit tests', 'End-to-end']);
    expect(testing.children[0].depth).toBe(3);
  });

  it('ids survive unrelated edits', () => {
    const edited = buildDoc(fx('CLAUDE.md').replace('Use vitest.', 'Use vitest with coverage.'));
    expect(edited.sections.map((s) => s.id)).toEqual(doc.sections.map((s) => s.id));
  });

  it('parses frontmatter', () => {
    const skill = buildDoc(fx('.claude/skills/release-notes/SKILL.md'));
    expect(skill.frontmatter?.data?.name).toBe('release-notes');
    expect(skill.frontmatter?.data?.model).toBe('sonnet');
  });
});

describe('rules', () => {
  it('matches caps keywords only', () => {
    expect(countRules('You MUST do it. NEVER skip. never mind. Must be ok. MUSTARD')).toBe(2);
    expect(countRules("DO NOT and DON'T and MUST NOT")).toBe(3);
  });

  it('counts rules per section, ignoring code and lowercase prose', () => {
    const doc = buildDoc(fx('CLAUDE.md'));
    const style = doc.byId.get('project-guide-for-agents/code-style')!;
    expect(style.own.rules).toBe(2); // MUST, NEVER ("Never mind" is not a rule)
    const testing = doc.byId.get('project-guide-for-agents/testing')!;
    expect(testing.own.rules).toBe(1); // IMPORTANT (code block MUST NOT ignored)
    expect(doc.root.sum.rules).toBe(4); // + DO NOT
  });

  it('marks rule-bearing list items', () => {
    const html = renderDoc(buildDoc(fx('CLAUDE.md')));
    expect(html).toMatch(/<li class="rule">You <mark class="kw">MUST<\/mark>/);
    expect(html).not.toMatch(/Never mind[^<]*<\/mark>/);
  });
});

describe('checklists', () => {
  it('rolls progress up the tree', () => {
    const doc = buildDoc(fx('plans/PLAN.md'));
    const prep = doc.byId.get('migration-plan/phase-1-prep')!;
    expect(prep.sum).toMatchObject({ done: 2, total: 3 });
    const build = doc.byId.get('migration-plan/phase-2-build')!;
    expect(build.own).toMatchObject({ done: 2, total: 6 });
    expect(build.sum).toMatchObject({ done: 2, total: 8 });
    expect(doc.root.sum).toMatchObject({ done: 4, total: 11 });
  });
});

describe('imports and links', () => {
  it('detects path-like @imports outside code, not emails or @mentions', () => {
    const doc = buildDoc(fx('CLAUDE.md'));
    expect(findImports(doc)).toEqual(['docs/testing.md', 'package.json']);
  });

  it('renders wiki links and import chips', () => {
    const html = renderDoc(buildDoc(fx('CLAUDE.md')));
    expect(html).toContain('data-import="docs/testing.md"');
    expect(html).toContain('data-wiki="release-notes"');
    expect(html).not.toContain('data-import="alice"');
  });

  it('renders non-markdown imports as code', () => {
    expect(renderImported('package.json', '{"a":1}')).toContain('<pre><code class="language-json">');
  });
});

describe('folding', () => {
  it('wraps long code blocks and tables in collapsed details', () => {
    const plan = renderDoc(buildDoc(fx('plans/PLAN.md')));
    expect(plan).toMatch(/<details class="fold fold-code" data-key="[^"]+"><summary><span class="fold-kind">sql<\/span><span class="fold-meta">17 lines/);
    const skill = renderDoc(buildDoc(fx('.claude/skills/release-notes/SKILL.md')));
    expect(skill).toContain('class="fold fold-table"');
    expect(skill).toMatch(/<details class="fm" data-key="fm"><summary[^>]*><span class="fm-tag">Frontmatter<\/span><span class="fm-name">release-notes<\/span>/);
  });

  it('adds toggles to list items with nested lists', () => {
    const html = renderDoc(buildDoc(fx('CLAUDE.md')));
    expect(html).toMatch(/<li class="rule has-sub"><button class="li-tog"/);
  });

  it('restores opened folds by key', () => {
    const doc = buildDoc(fx('plans/PLAN.md'));
    const key = renderDoc(doc).match(/fold-code" data-key="([^"]+)"/)![1];
    expect(renderDoc(doc, { openKeys: new Set([key]) })).toContain(`data-key="${key}" open`);
  });

  it('renders an outline mirroring the tree', () => {
    const html = renderOutline(buildDoc(fx('plans/PLAN.md')));
    expect(html).toContain('data-id="migration-plan/phase-2-build/rollout"');
    expect(html).toContain('2/3');
  });
});

describe('diff since last read', () => {
  const base = buildDoc(fx('CLAUDE.md'));

  it('reports nothing for identical docs', () => {
    expect(diffDocs(base, buildDoc(fx('CLAUDE.md'))).count).toBe(0);
  });

  it('classifies changed, added and removed sections and flags ancestors', () => {
    const text = fx('CLAUDE.md')
      .replace('Use vitest.', 'Use vitest with coverage.')
      .replace('## Git workflow', '## Deploys\n\nShip on Fridays.\n\n## Git workflow')
      .replace(/### End-to-end[\s\S]*?(?=## Git workflow|## Deploys)/, '');
    const d = diffDocs(base, buildDoc(text));
    expect(d.status.get('project-guide-for-agents/testing/unit-tests')).toBe('changed');
    expect(d.status.get('project-guide-for-agents/deploys')).toBe('added');
    expect(d.removed.get('project-guide-for-agents/testing')!.map((s) => s.title)).toEqual(['End-to-end']);
    expect(d.subChanged.has('project-guide-for-agents/testing')).toBe(true);
    expect(d.subChanged.has('project-guide-for-agents')).toBe(true);
    expect(d.subChanged.has('project-guide-for-agents/git-workflow')).toBe(false);
    expect(d.count).toBe(3);
  });

  it('produces block-level ops with ghosts for removed blocks', () => {
    const text = fx('CLAUDE.md').replace('Playwright, run with `npm run e2e`.', 'Cypress now.');
    const cur = buildDoc(text);
    const d = diffDocs(base, cur);
    const ops = d.blockOps.get('project-guide-for-agents/testing/end-to-end')!;
    expect(ops.map((o) => o.kind)).toEqual(['removed', 'added', 'same']);
    const html = renderDoc(cur, { diff: d });
    expect(html).toContain('class="blk ghost" data-diff="removed"');
    expect(html).toContain('data-diff="added"');
  });

  it('detects frontmatter changes', () => {
    const skill = fx('.claude/skills/release-notes/SKILL.md');
    const d = diffDocs(buildDoc(skill), buildDoc(skill.replace('model: sonnet', 'model: opus')));
    expect(d.frontmatterChanged).toBe(true);
    expect(d.count).toBe(1);
  });
});

describe('import guards', async () => {
  const { importBlocked, MAX_IMPORT_DEPTH } = await import('../src/imports.ts');
  it('blocks cycles and excessive depth', () => {
    expect(importBlocked(['CLAUDE.md', 'docs/testing.md'], 'CLAUDE.md')).toBe('cycle');
    expect(importBlocked(['a', 'b'], 'c')).toBeNull();
    expect(importBlocked(Array.from({ length: MAX_IMPORT_DEPTH + 1 }, (_, i) => `f${i}`), 'x')).toBe('depth');
  });
});

describe('section markdown and tokens', async () => {
  const { sectionMarkdown, formatTokens } = await import('../src/tree.ts');
  const { classifyText, nameFromText } = await import('../src/classify.ts');
  const text = fx('CLAUDE.md');
  const doc = buildDoc(text);

  it('copies a section with all its subsections, and nothing after it', () => {
    const md = sectionMarkdown(doc, 'project-guide-for-agents/testing');
    expect(md.startsWith('## Testing\n')).toBe(true);
    expect(md).toContain('### Unit tests');
    expect(md).toContain('### End-to-end');
    expect(md).not.toContain('## Git workflow');
  });

  it('copies the last section to the end of the file', () => {
    expect(sectionMarkdown(doc, 'project-guide-for-agents/code-style-2')).toBe('## Code style\n\nDuplicate heading on purpose (id must be unique).\n');
  });

  it('copies the whole doc from a lone top heading', () => {
    expect(sectionMarkdown(doc, 'project-guide-for-agents')).toBe(text.trimEnd() + '\n');
  });

  it('rolls token estimates up the tree', () => {
    const testing = doc.byId.get('project-guide-for-agents/testing')!;
    const kids = testing.children.reduce((n, c) => n + c.sum.tokens, 0);
    expect(testing.sum.tokens).toBe(testing.own.tokens + kids);
    expect(doc.root.sum.tokens).toBeGreaterThan(Math.floor(text.length / 4) * 0.8);
    expect(doc.root.sum.tokens).toBeLessThanOrEqual(Math.ceil(text.length / 4) + 40);
    expect([formatTokens(950), formatTokens(1234), formatTokens(2000), formatTokens(15400)]).toEqual(['950', '1.2k', '2k', '15k']);
  });

  it('classifies pasted text by content', () => {
    expect(classifyText('Untitled', fx('.claude/skills/release-notes/SKILL.md'))).toBe('Skills');
    expect(classifyText('Migration plan', fx('plans/PLAN.md'))).toBe('Plans & specs');
    expect(classifyText('Project guide', fx('CLAUDE.md'))).toBe('Instructions');
    expect(classifyText('Testing conventions', fx('docs/testing.md'))).toBe('Other');
    expect(classifyText('AGENTS.md', 'hello')).toBe('Instructions');
  });

  it('names pasted text from its first heading or frontmatter', () => {
    expect(nameFromText(fx('CLAUDE.md'))).toBe('Project guide for agents');
    expect(nameFromText('---\nname: my-skill\n---\nbody')).toBe('my-skill');
    expect(nameFromText('no headings', 'notes.md')).toBe('notes.md');
  });
});

describe('token weight', async () => {
  const { tokenShares, heavySections, hasLoneTitle } = await import('../src/tree.ts');
  const big = 'x'.repeat(2000);
  const md = `# Guide\n\n## Small\n\nshort\n\n## Big\n\n${big}\n\n### Inner\n\nmore\n\n## Tiny\n\nhi\n`;
  const doc = buildDoc(md);

  it('skips a lone title and gives each section its share of the file', () => {
    expect(hasLoneTitle(doc)).toBe(true);
    const shares = tokenShares(doc);
    expect(shares.has('guide')).toBe(false);
    const top = doc.root.children[0].children.map((s) => shares.get(s.id)!);
    expect(top.reduce((a, b) => a + b, 0)).toBeGreaterThan(0.95);
    expect(top.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1.0001);
  });

  it('flags the section that dominates the budget', () => {
    const heavy = heavySections(doc);
    expect([...heavy].some((id) => id.endsWith('big'))).toBe(true);
    expect([...heavy].some((id) => id.endsWith('small'))).toBe(false);
    expect(renderOutline(doc)).toMatch(/data-heavy="1"[^>]*>.*?Big/);
    expect(heavySections(buildDoc('## A\n\none\n\n## B\n\ntwo\n\n## C\n\nthree\n')).size).toBe(1); // ~equal: largest still ≥ 30 %
  });

  it('labels the copy button with the section token count', () => {
    expect(renderDoc(doc)).toMatch(/<span class="lbl">Copy<span class="lbl-tok"> · ~\d+ tokens<\/span>/);
  });

  it('keeps stats off a lone title (they live in the toolbar) and marks top-level sections', () => {
    const html = renderDoc(buildDoc('# Guide\n\n## A\n\n- [ ] x\n\nYou MUST.\n\n## B\n\ntext\n'));
    const title = html.match(/<section class="sec" data-id="guide"[^>]*>.*?<\/header>/s)![0];
    expect(title).toContain('data-title="1"');
    expect(title).not.toContain('b-prog');
    expect(title).not.toContain('b-rule');
    expect(html).toMatch(/data-id="guide\/a"[^>]*data-top="1"/);
    expect(html).toMatch(/data-id="guide\/a"[^>]*>.*?b-prog/s);
  });
});
