/** Sample doc for "Try an example": exercises rules, checklists, code folding and nesting. */
export const EXAMPLE = `# Payments service: agent guide

This file tells coding agents how to work in this repo. Read **Rules** first.

## Rules

- You MUST run \`npm test\` before every commit.
- NEVER commit secrets. Use \`.env.local\`, which is git-ignored.
- ALWAYS add a migration when you change the schema.
  - Migrations live in \`db/migrations\`.
  - Name them \`YYYYMMDD_description.sql\`.
- Prefer small PRs (under 400 lines).

IMPORTANT: DO NOT call the real payment provider in tests. Use the sandbox mock.

## Architecture

| Layer | Folder | Notes |
|---|---|---|
| API | \`src/api\` | REST handlers |
| Domain | \`src/domain\` | Pure logic, no I/O |
| Adapters | \`src/adapters\` | Stripe, Postgres |

### Error handling

Return typed errors from the domain; map them to HTTP codes in \`src/api/errors.ts\`.

## Current plan: refunds

- [x] Design the refund state machine
- [x] Add \`refunds\` table
- [ ] Implement partial refunds
  - [x] Domain logic
  - [ ] API endpoint
  - [ ] Webhook handling
- [ ] Load test with 10k refunds/hour

## Useful commands

\`\`\`sh
npm run dev          # start API on :3000
npm test             # unit tests
npm run test:e2e     # end-to-end, needs Docker
npm run db:migrate   # apply migrations
npm run db:seed      # seed sample merchants
npm run lint         # eslint + prettier
npm run typecheck    # tsc --noEmit
npm run build        # production build
npm run start        # run the build
npm run stripe:mock  # local payment sandbox
npm run logs         # tail service logs
npm run clean        # remove build output
npm run gen:types    # regenerate API types
npm run docs         # build API docs
npm run bench        # micro-benchmarks
npm run release      # tag and publish
\`\`\`

## Try it

Fold sections by clicking headings, press **1** for an outline, **r** for rules only, **/** to filter.
Then use **New version** to paste an edited copy of this text and see what changed.
`;
