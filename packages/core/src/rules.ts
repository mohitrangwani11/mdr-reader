/**
 * Rule keywords that agents treat as hard constraints. Matched case-sensitively
 * (caps only) so ordinary prose like "never mind" is not flagged.
 */
export const RULE_KEYWORDS = [
  'MUST NOT',
  'MUST',
  'NEVER',
  'ALWAYS',
  'IMPORTANT',
  'DO NOT',
  "DON'T",
  'REQUIRED',
  'SHOULD NOT',
  'SHALL NOT',
  'CRITICAL',
];

const alternation = RULE_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

/** Global regex. Use with matchAll / replace; never call .test() on it (lastIndex). */
export const RULE_RE = new RegExp(`(?<![A-Za-z])(?:${alternation})(?![A-Za-z])`, 'g');

export function countRules(text: string): number {
  return [...text.matchAll(RULE_RE)].length;
}
