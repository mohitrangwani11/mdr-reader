/** DOM-free entry point: the document model, for hosts that run outside a browser (VS Code extension host). */
export { buildDoc, estimateTokens, formatTokens, sectionMarkdown, hasLoneTitle, tokenShares, heavySections, type Doc, type Section, type Block, type Stats } from './tree.ts';
export { diffDocs, type DocDiff, type BlockOp, type SectionStatus } from './diff.ts';
export { RULE_RE, RULE_KEYWORDS, countRules } from './rules.ts';
export * from './paths.ts';
export type { FileGroup, FileGroupName, FileEntry, HostEvent, ResolvedImport } from './host.ts';
