import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cp, mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { classify } from '../src/discover.ts';

const fixtures = fileURLToPath(new URL('../../core/test/fixtures', import.meta.url));
const publicDir = fileURLToPath(new URL('../dist/public', import.meta.url));

let dir: string;
let srv: RunningServer;
const base = () => `http://127.0.0.1:${srv.port}`;
const api = (p: string, init: RequestInit = {}) =>
  fetch(base() + p, { ...init, headers: { 'x-mdr-token': srv.token, ...(init.headers ?? {}) } });

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mdr-test-'));
  await cp(fixtures, path.join(dir, 'ws'), { recursive: true });
  await writeFile(path.join(dir, 'secret.txt'), 'top secret');
  srv = await startServer({ target: path.join(dir, 'ws'), port: 0, showAll: false, publicDir, store: new Store(path.join(dir, 'home')) });
});

afterAll(async () => {
  await srv.close();
  await rm(dir, { recursive: true, force: true });
});

describe('classify', () => {
  it('groups agent files', () => {
    expect(classify('CLAUDE.md')).toBe('Instructions');
    expect(classify('packages/api/AGENTS.md')).toBe('Instructions');
    expect(classify('.claude/skills/x/SKILL.md')).toBe('Skills');
    expect(classify('.claude/commands/deploy.md')).toBe('Commands & agents');
    expect(classify('plans/PLAN.md')).toBe('Plans & specs');
    expect(classify('README.md')).toBe('Other');
  });
});

describe('server', () => {
  it('requires the token for the page and the API', async () => {
    expect((await fetch(base() + '/')).status).toBe(403);
    expect((await fetch(base() + '/api/files')).status).toBe(403);
    const page = await fetch(srv.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('window.MDR_CONFIG=');
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    // fetch() ignores custom Host headers, so use a raw request.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: srv.port, path: `/?t=${srv.token}`, headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('discovers files in groups', async () => {
    const groups = (await (await api('/api/files')).json()) as { name: string; files: { path: string; name: string }[] }[];
    const by = Object.fromEntries(groups.map((g) => [g.name, g.files.map((f) => f.name)]));
    expect(by['Instructions']).toEqual(['CLAUDE.md']);
    expect(by['Skills']).toEqual(['release-notes']);
    expect(by['Plans & specs']).toEqual(expect.arrayContaining(['testing.md', 'PLAN.md']));
  });

  it('serves markdown in the root but blocks traversal and non-markdown', async () => {
    expect((await api('/api/file?p=CLAUDE.md')).status).toBe(200);
    expect((await api('/api/file?p=../secret.txt')).status).toBe(404);
    expect((await api('/api/file?p=package.json')).status).toBe(404);
    expect((await api(`/api/file?p=${encodeURIComponent(path.join(dir, 'secret.txt'))}`)).status).toBe(404);
  });

  it('resolves only imports that the source file contains', async () => {
    const ok = await (await api('/api/import?from=CLAUDE.md&ref=package.json')).json();
    expect(ok).toMatchObject({ path: 'package.json' });
    expect(ok.text).toContain('"lint"');
    const nested = await (await api('/api/import?from=docs/testing.md&ref=../CLAUDE.md')).json();
    expect(nested).toMatchObject({ path: 'CLAUDE.md' });
    expect(await (await api('/api/import?from=CLAUDE.md&ref=../secret.txt')).json()).toBeNull();
  });

  it('stores last-read snapshots and reports unread files', async () => {
    expect(await (await api('/api/baseline?p=plans/PLAN.md')).json()).toEqual({ text: null });
    await api('/api/read?p=plans/PLAN.md', { method: 'POST', body: 'old text' });
    expect(await (await api('/api/baseline?p=plans/PLAN.md')).json()).toEqual({ text: 'old text' });
    const groups = (await (await api('/api/files')).json()) as { files: { path: string; unread?: boolean }[] }[];
    expect(groups.flatMap((g) => g.files).find((f) => f.path === 'plans/PLAN.md')?.unread).toBe(true);
  });

  it('persists view state', async () => {
    await api('/api/state?k=view%3ACLAUDE.md', { method: 'POST', body: JSON.stringify({ collapsed: ['a'] }) });
    expect(await (await api('/api/state?k=view%3ACLAUDE.md')).json()).toEqual({ value: { collapsed: ['a'] } });
  });

  it('pushes change events over SSE', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base()}/api/events?t=${srv.token}`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const got = (async () => {
      let buf = '';
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return buf;
        buf += dec.decode(value);
        if (buf.includes('"type":"change"')) return buf;
      }
    })();
    await new Promise((r) => setTimeout(r, 300)); // let the watcher settle
    await appendFile(path.join(dir, 'ws', 'CLAUDE.md'), '\n## New section\n');
    const out = await Promise.race([got, new Promise<string>((r) => setTimeout(() => r('timeout'), 4000))]);
    ctrl.abort();
    expect(out).toContain('{"type":"change","path":"CLAUDE.md"}');
  });
});
