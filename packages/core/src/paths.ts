/**
 * Path rules shared by every host that reads a real workspace (CLI, VS Code):
 * which files are markdown, which folders to skip, and how a path maps to a group.
 */
import type { FileGroupName } from './host.ts';

export const GROUP_ORDER: FileGroupName[] = ['Instructions', 'Skills', 'Commands & agents', 'Plans & specs', 'Memory', 'Other'];

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', 'vendor',
  '.venv', 'venv', '__pycache__', 'target', '.turbo', '.cache', '.idea', '.vscode',
]);
const ALLOWED_HIDDEN = new Set(['.claude', '.github', '.cursor', '.agents', '.codex', '.gemini']);
const MD = /\.(md|markdown|mdx|mdc)$/i;
const INSTRUCTION_FILES = new Set(['claude.md', 'claude.local.md', 'agents.md', 'agent.md', 'gemini.md', 'copilot-instructions.md', 'conventions.md']);

export function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name) || (name.startsWith('.') && !ALLOWED_HIDDEN.has(name));
}

export function isMarkdown(p: string): boolean {
  return MD.test(p);
}

/** Group for a workspace-relative posix path. */
export function classify(rel: string): FileGroupName {
  const lower = rel.toLowerCase();
  const segs = lower.split('/');
  const base = segs[segs.length - 1];
  const dirs = segs.slice(0, -1);

  // GitHub Copilot: .github/copilot-instructions.md, *.instructions.md, *.prompt.md, *.chatmode.md, *.agent.md
  if (INSTRUCTION_FILES.has(base) || base.endsWith('.instructions.md') || lower.startsWith('.cursor/rules/')) return 'Instructions';
  if (base === 'skill.md' || dirs.includes('skills')) return 'Skills';
  if (
    /(^|\/)\.claude\/(commands|agents)\//.test(lower) ||
    /(^|\/)\.(codex|gemini)\/(commands|prompts)\//.test(lower) ||
    /(^|\/)\.github\/(prompts|agents|chatmodes)\//.test(lower) ||
    /\.(prompt|chatmode|agent)\.md$/.test(base)
  )
    return 'Commands & agents';
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
