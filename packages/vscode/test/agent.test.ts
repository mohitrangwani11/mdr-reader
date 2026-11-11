import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveName, formatChanges, formatOutline, formatFileList, changeCount } from '../src/agent.ts';
import { classify } from '@mdr/core/paths';

const claude = readFileSync(new URL('../../core/test/fixtures/CLAUDE.md', import.meta.url), 'utf8');

describe('resolveName', () => {
  const files = [
    { path: 'CLAUDE.md', name: 'CLAUDE.md' },
    { path: 'packages/api/CLAUDE.md', name: 'CLAUDE.md' },
    { path: 'plans/PLAN.md', name: 'PLAN.md' },
    { path: 'docs/a/notes.md', name: 'notes.md' },
    { path: 'docs/b/notes.md', name: 'notes.md' },
  ];
  it('prefers an exact path, then the shallowest file of that name', () => {
    expect(resolveName(files, 'packages/api/CLAUDE.md')).toEqual(files[1]);
    expect(resolveName(files, 'claude.md')).toEqual(files[0]);
    expect(resolveName(files, './plans/PLAN.md')).toEqual(files[2]);
  });
  it('matches a name without extension or a path fragment', () => {
    expect(resolveName(files, 'plan')).toEqual(files[2]);
    expect(resolveName(files, 'api/CLAUDE.md')).toEqual(files[1]);
  });
  it('reports ambiguity and misses', () => {
    expect(resolveName(files, 'notes.md')).toEqual({ candidates: [files[3], files[4]] });
    expect(resolveName(files, 'nope.md')).toBeNull();
  });
});

describe('agent tool output', () => {
  it('outlines sections with tokens, progress and rule counts', () => {
    const out = formatOutline('CLAUDE.md', claude);
    expect(out).toMatch(/^CLAUDE\.md: ~\d/);
    expect(out).toMatch(/- Code style \(~\d+ tok, \d+ rules?\)/);
    expect(out).toMatch(/\n {2}- Testing/);
    expect(out).toMatch(/\n {4}- Unit tests/); // nested under Testing
  });
  it('lists rule lines by section, never from code blocks', () => {
    const out = formatOutline('CLAUDE.md', claude, true);
    expect(out).toContain('You MUST run');
    expect(out).toContain('DO NOT force-push');
    expect(out).toContain('Testing:');
    expect(out).not.toContain('MUST NOT appear');
  });
  it('summarises changes since the last read', () => {
    const edited = claude.replace('Use vitest.', 'Use vitest with coverage.').replace('## Git workflow', '## Releases\n\nTag from main.\n\n## Git workflow');
    const out = formatChanges('CLAUDE.md', claude, edited);
    expect(out).toMatch(/2 sections changed/);
    expect(out).toContain('Changed: Project guide for agents › Testing › Unit tests');
    expect(out).toContain('+ Use vitest with coverage.');
    expect(out).toContain('− Use vitest.');
    expect(out).toContain('Added section: Project guide for agents › Releases');
    expect(changeCount(claude, edited)).toBe(2);
    expect(formatChanges('CLAUDE.md', claude, claude)).toMatch(/no changes/);
    expect(formatChanges('CLAUDE.md', null, claude)).toMatch(/not been opened in mdr/);
  });
  it('lists files with their changed flag', () => {
    const out = formatFileList([{ groups: [{ name: 'Instructions', files: [{ path: 'CLAUDE.md', name: 'CLAUDE.md', group: 'Instructions', unread: true }] }] }]);
    expect(out).toBe('1 markdown file, 1 changed since the user last read it.\n## Instructions\n- CLAUDE.md  (changed since last read)');
  });
});

describe('Copilot files', () => {
  it('are grouped like other agent files', () => {
    expect(classify('.github/copilot-instructions.md')).toBe('Instructions');
    expect(classify('.github/instructions/react.instructions.md')).toBe('Instructions');
    expect(classify('.github/prompts/review.prompt.md')).toBe('Commands & agents');
    expect(classify('prompts/fix.prompt.md')).toBe('Commands & agents');
    expect(classify('.github/chatmodes/plan.chatmode.md')).toBe('Commands & agents');
    expect(classify('.github/agents/reviewer.agent.md')).toBe('Commands & agents');
  });
});
