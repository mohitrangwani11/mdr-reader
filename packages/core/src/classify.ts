import type { FileGroupName } from './host.ts';
import { countRules } from './rules.ts';

/**
 * Guess a group for a document that has no meaningful path (pasted text),
 * from its name and content.
 */
export function classifyText(name: string, text: string): FileGroupName {
  const lower = name.toLowerCase();
  if (/^(claude|agents?|gemini)(\.local)?(\.md)?$/.test(lower) || /copilot-instructions/.test(lower)) return 'Instructions';
  if (lower === 'skill.md') return 'Skills';
  if (lower === 'memory.md') return 'Memory';

  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm && /^name:/m.test(fm[1]) && /^description:/m.test(fm[1])) return 'Skills';

  // Strip fenced code so examples don't count.
  const prose = text.replace(/```[\s\S]*?```/g, '');
  if (/^\s*[-*+] \[[ xX]\]/m.test(prose)) return 'Plans & specs';
  if (countRules(prose) >= 3) return 'Instructions';
  if (/(plan|spec|roadmap|prd|todo)/.test(lower)) return 'Plans & specs';
  return 'Other';
}

/** A display name for pasted text: frontmatter name (skills are known by it), then first heading, then fallback. */
export function nameFromText(text: string, fallback = 'Untitled'): string {
  const fmName = text.match(/^---\r?\n[\s\S]*?^name:\s*["']?([^\n"']+)/m)?.[1]?.trim();
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/```[\s\S]*?```/g, '');
  const heading = body.match(/^#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  return (fmName || heading || fallback).slice(0, 80);
}
