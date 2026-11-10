import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { FileGroupName } from '@mdr/core';

export interface Found {
  path: string; // posix, relative to root
  name: string;
  group: FileGroupName;
}

export const GROUP_ORDER: FileGroupName[] = ['Instructions', 'Skills', 'Commands & agents', 'Plans & specs', 'Memory', 'Other'];

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', 'vendor',
  '.venv', 'venv', '__pycache__', 'target', '.turbo', '.cache', '.idea', '.vscode',
]);
const ALLOWED_HIDDEN = new Set(['.claude', '.github', '.cursor', '.agents', '.codex', '.gemini']);
const MD = /\.(md|markdown|mdx|mdc)$/i;
const INSTRUCTION_FILES = new Set(['claude.md', 'claude.local.md', 'agents.md', 'agent.md', 'gemini.md', 'copilot-instructions.md', 'conventions.md']);
const MAX_FILES = 5000;

export function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name) || (name.startsWith('.') && !ALLOWED_HIDDEN.has(name));
}

export function isMarkdown(p: string): boolean {
  return MD.test(p);
}

export function classify(rel: string): FileGroupName {
  const lower = rel.toLowerCase();
  const segs = lower.split('/');
  const base = segs[segs.length - 1];
  const dirs = segs.slice(0, -1);

  if (INSTRUCTION_FILES.has(base) || lower.startsWith('.cursor/rules/')) return 'Instructions';
  if (base === 'skill.md' || dirs.includes('skills')) return 'Skills';
  if (/(^|\/)\.claude\/(commands|agents)\//.test(lower) || /(^|\/)\.(codex|gemini)\/(commands|prompts)\//.test(lower)) return 'Commands & agents';
  if (base === 'memory.md' || dirs.includes('memory') || dirs.includes('memories')) return 'Memory';
  if (
    dirs.some((d) => ['plans', 'plan', 'specs', 'spec', 'docs', 'rfcs', 'adr', 'adrs', 'design'].includes(d)) ||
    /(plan|spec|todo|roadmap|prd|design|tasks?)/.test(base)
  )
    return 'Plans & specs';
  return 'Other';
}

export function displayName(rel: string): string {
  const segs = rel.split('/');
  const base = segs[segs.length - 1];
  // SKILL.md files are all named the same; the folder is the real name.
  if (base.toLowerCase() === 'skill.md' && segs.length > 1) return segs[segs.length - 2];
  return base;
}

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
