# Project guide for agents

This repo is a TypeScript monorepo. See @docs/testing.md for test conventions
and @package.json for scripts. Ping me@example.com or @alice if stuck.

## Code style

- Use 2-space indentation.
- You MUST run `npm run lint` before committing.
- NEVER use `any` unless there is a comment explaining why.
  - Prefer `unknown` and narrow it.
  - Generic helpers live in `src/util`.
- Never mind the old `legacy/` folder, it is going away.

## Testing

IMPORTANT: always run the full suite, not a single file.

### Unit tests

Use vitest. Tests live next to the code as `*.test.ts`.

### End-to-end

Playwright, run with `npm run e2e`.

```ts
// MUST NOT appear as a rule: this is code
const x = 1;
```

## Git workflow

- Branch from `main`.
- DO NOT force-push shared branches.
- See [[release-notes]] for the release checklist.

## Code style

Duplicate heading on purpose (id must be unique).
