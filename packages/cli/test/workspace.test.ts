import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cp, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace, NotFound, type WatchTarget, type Workspace } from '../src/workspace.ts';
import { Store } from '../src/store.ts';
import type { HostEvent } from '@mdr/core';

const fixtures = fileURLToPath(new URL('../../core/test/fixtures', import.meta.url));
let dir: string;
let ws: Workspace;
let target: WatchTarget;
const added: string[] = [];

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'mdr-ws-')));
  await cp(fixtures, path.join(dir, 'ws'), { recursive: true });
  await writeFile(path.join(dir, 'outside.md'), '# Outside');
  ws = await createWorkspace({
    target: path.join(dir, 'ws'),
    store: new Store(path.join(dir, 'home')),
    watch: (t) => {
      target = t;
      return { add: (abs) => void added.push(abs), close: () => {} };
    },
  });
});
afterAll(async () => {
  await ws.close();
  await rm(dir, { recursive: true, force: true });
});

describe('workspace', () => {
  it('turns watcher events into host events, for markdown only, skipping ignored folders', () => {
    const got: HostEvent[] = [];
    const off = ws.onEvent((e) => got.push(e));
    target.onFs('change', path.join(ws.root, 'CLAUDE.md'));
    target.onFs('add', path.join(ws.root, 'plans/NEW.md'));
    target.onFs('change', path.join(ws.root, 'package.json'));
    off();
    expect(got).toEqual([{ type: 'change', path: 'CLAUDE.md' }, { type: 'change', path: 'plans/NEW.md' }, { type: 'files' }]);
    expect(target.ignored(path.join(ws.root, 'node_modules/x/README.md'))).toBe(true);
    expect(target.ignored(path.join(ws.root, '.claude/skills/x/SKILL.md'))).toBe(false);
  });

  it('flags a file unread once it differs from the last-read snapshot', async () => {
    const reads: string[] = [];
    ws.onDidMarkRead((id) => reads.push(id));
    await ws.markRead('CLAUDE.md', 'old text');
    const unread = async () => (await ws.listFiles()).flatMap((g) => g.files).find((f) => f.path === 'CLAUDE.md')?.unread;
    expect(await unread()).toBe(true);
    await ws.markRead('CLAUDE.md', await ws.readFile('CLAUDE.md'));
    expect(await unread()).toBe(false);
    expect(reads).toEqual(['CLAUDE.md', 'CLAUDE.md']);
  });

  it('only reads markdown inside the root, plus imports the file really contains', async () => {
    await expect(ws.readFile('../outside.md')).rejects.toBeInstanceOf(NotFound);
    await expect(ws.readFile('package.json')).rejects.toBeInstanceOf(NotFound);
    const imp = await ws.resolveImport('CLAUDE.md', 'package.json');
    expect(imp?.path).toBe('package.json');
    expect(await ws.readFile('package.json')).toContain('{');
    expect(await ws.resolveImport('CLAUDE.md', '../outside.md')).toBeNull();
  });
});
