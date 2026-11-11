import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { classify, displayName, isIgnoredDir, isMarkdown, GROUP_ORDER } from '@mdr/core/paths';
import type { FileGroupName } from '@mdr/core';

export { classify, displayName, isIgnoredDir, isMarkdown, GROUP_ORDER };

export interface Found {
  path: string; // posix, relative to root
  name: string;
  group: FileGroupName;
}

const MAX_FILES = 5000;

export async function discover(root: string): Promise<Found[]> {
  const out: Found[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 12 || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!isIgnoredDir(e.name)) await walk(abs, depth + 1);
      } else if ((e.isFile() || e.isSymbolicLink()) && isMarkdown(e.name)) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        out.push({ path: rel, name: displayName(rel), group: classify(rel) });
      }
    }
  };
  await walk(root, 0);
  return out.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      a.path.split('/').length - b.path.split('/').length ||
      a.path.localeCompare(b.path),
  );
}
