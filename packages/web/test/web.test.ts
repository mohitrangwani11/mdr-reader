import { describe, it, expect } from 'vitest';
import { DocStore, type KV } from '../src/store.ts';
import { encodeShare, decodeShare, shareFromHash } from '../src/share.ts';

function fakeKV(): KV & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

describe('DocStore', () => {
  it('creates docs with a name and group from their content', () => {
    const s = new DocStore(fakeKV());
    const a = s.create('# Release plan\n\n- [ ] ship it\n');
    expect(a).toMatchObject({ name: 'Release plan', group: 'Plans & specs' });
    expect(s.get(a.id)).toContain('ship it');
    expect(s.list().map((d) => d.id)).toEqual([a.id]);
  });

  it('keeps the last-read baseline when a new version arrives', () => {
    const s = new DocStore(fakeKV());
    const a = s.create('# Guide\n\nv1\n', 'CLAUDE.md');
    s.setBaseline(a.id, '# Guide\n\nv1\n');
    const b = s.update(a.id, '# Guide\n\nv2\n');
    expect(b.id).toBe(a.id);
    expect(b.group).toBe('Instructions'); // from the file name
    expect(s.get(a.id)).toContain('v2');
    expect(s.getBaseline(a.id)).toContain('v1');
    expect(s.findByFileName('CLAUDE.md')?.id).toBe(a.id);
    expect(s.findByHash('# Guide\n\nv2\n')?.id).toBe(a.id);
  });

  it('removes a doc with its baseline and view state', () => {
    const kv = fakeKV();
    const s = new DocStore(kv);
    const a = s.create('# X');
    s.setBaseline(a.id, '# X');
    s.setState(`view:${a.id}`, { collapsed: [] });
    s.remove(a.id);
    expect(s.list()).toEqual([]);
    expect([...kv.m.keys()]).toEqual(['mdr:docs']);
  });

  it('survives corrupted storage', () => {
    const kv = fakeKV();
    kv.setItem('mdr:docs', '{not json');
    expect(new DocStore(kv).list()).toEqual([]);
  });
});

describe('DocStore: last doc & links', () => {
  it('remembers the last doc and forgets it when removed', () => {
    const s = new DocStore(fakeKV());
    const a = s.create('# A\n');
    expect(s.last).toBe(null);
    s.last = a.id;
    expect(new DocStore((s as unknown as { kv: KV }).kv).last).toBe(a.id);
    s.remove(a.id);
    expect(s.last).toBe(null);
  });

  it('keeps the linked flag across new versions', () => {
    const s = new DocStore(fakeKV());
    const a = s.create('# A\n', 'a.md');
    s.setLinked(a.id, true);
    s.update(a.id, '# A\n\nmore\n');
    expect(s.meta(a.id)?.linked).toBe(true);
    s.setLinked(a.id, false);
    expect(s.meta(a.id)?.linked).toBeUndefined();
  });
});

describe('share links', () => {
  it('round-trips text, including unicode, through a compact URL-safe payload', async () => {
    const text = '# Plan ✅\n\n' + '- [ ] step with émojis 🚀\n'.repeat(200);
    const data = await encodeShare(text);
    expect(data).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(data.length).toBeLessThan(text.length / 5);
    expect(await decodeShare(data)).toBe(text);
  });

  it('reads the payload from a location hash', () => {
    expect(shareFromHash('#s=abc')).toBe('abc');
    expect(shareFromHash('#f=x')).toBeNull();
  });
});
