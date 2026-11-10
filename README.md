# mdr — a reader for agent markdown

A read-only reader for the markdown files agents live on: `CLAUDE.md`, `AGENTS.md`, `SKILL.md`, slash commands, plans and specs. It turns a file into a **foldable tree** so you can read only the parts you care about, and shows **what changed since you last read it**, which helps when an agent rewrites the file while you're away.

## Quick start (no install)

**Use it online:** https://mohitrangwani11.github.io/mdr-reader/ (rebuilt from `main` on every push). Everything stays in your browser; nothing is uploaded.

Or open **`dist/mdr.html`** in any browser: double-click it, send it to someone, or put it on any static host. It's a single self-contained file with no server, and nothing is uploaded.

- **Paste** markdown anywhere on the page (⌘V / Ctrl+V), **drop** `.md` files, or click **+ New**: one dialog takes pasted text, dropped files or **Choose files…**
- **New version** (`v`, in the ⋯ menu): paste or drop an updated copy of a doc to see exactly what changed. Dropping a file with the same name does the same.
- **Share:** copies a link that contains the doc itself, compressed into the URL fragment. No server ever sees it.
- **Linked files** (Chrome, Edge): a file you choose or drop stays linked to the file on disk (🔗 in the sidebar). Press **↻** next to its name (`u`) to pull in your edits with the changes highlighted. Linked files are also checked whenever you come back to the tab. In Safari and Firefox, Reload asks you to pick the file again.
- Docs are saved in this browser (localStorage), and relaunching reopens the doc you were reading. Remove one with the × in the sidebar.

To build it: `npm install && npm run web` (builds and opens `dist/mdr.html`; `dist/` is not committed).

## Live mode (CLI)

For files that agents keep rewriting: it watches the disk and updates as they change.

```sh
npm run build
npm run mdr -- path/to/CLAUDE.md     # one file
npm run mdr -- path/to/project       # a folder: auto-discovers agent files
```

To get a global `mdr` command: `npm link -w packages/cli`, then `mdr .`

Options: `--port <n>` (default 4711), `--all` (expand "Other markdown"), `--no-open`.

## What it does

- **Fold anything:** headings, nested lists, long code blocks, big tables, and YAML frontmatter (shown as a card).
- **Fold to level** with `1` `2` `3` (a lone title heading is skipped). `0` unfolds everything.
- **Focus** (`f` or ◎): show only the sections you pick. `Esc` shows everything again.
- **Filter** (`/`): narrow the tree to the sections that match.
- **Rules** (`r`): highlights `MUST` / `NEVER` / `ALWAYS` / `IMPORTANT` / `DO NOT`… (caps only, never inside code), with a rules-only view.
- **Checklist progress** per section, rolled up the tree.
- **Copy section** (⧉ or `c`): copies a section and its subsections as markdown, ready to paste back to an agent.
- **Token estimates** per section (outline) and for the whole file (top bar). This is a rough estimate (~4 characters per token).
- **@imports** (`@docs/testing.md`) expand inline. Cycles are detected and nesting stops at 5 levels.
- **Live reload with diff since last read:** added, changed and removed blocks are highlighted. Folded sections still show a change dot. Press `n` for the next change and `m` to mark the file as read.
- **Folder mode** groups files into Instructions, Skills, Commands & agents, Plans & specs, Memory and Other, with an unread dot on each changed file.
- **Token weight:** each outline row has a bar for its share of the file. The section that dominates the budget is amber. The top bar shows tokens *visible now* / whole file, so you know what you'd be sending.
- Fold, focus and open-import state are remembered per file. **Theme:** in the ⋯ menu, or `t` to cycle Auto (follows the OS), Light and Dark. Works at widget size (~400px wide).

State lives in `~/.mdr` (last-read snapshots plus view state). Set `MDR_HOME` to move it.

## Use cases

| Who | Job | How |
|---|---|---|
| Developer using agents | Review the plan an agent proposes before approving it | Fold, focus (`f`), checklist progress |
| | The agent revised the plan: what changed? | **New version** → diff, `n` to step through changes |
| Tech lead | Audit a CLAUDE.md: what is the agent *forced* to do? | Rules only (`r`), rule counts per section |
| | Vet a third-party SKILL.md before installing it | Frontmatter card (name, description, allowed-tools) |
| PM / non-engineer | Skim a long agent-written report or spec | `1` = table of contents, filter (`/`) |
| | Send a spec to someone | **Share** link |
| Prompt / platform engineer | Keep instruction files lean | Token estimate per section |
| Anyone | "Fix only *this* section" | Copy section → paste to the agent |

## Architecture

```
packages/core   the reader: parse → section tree → render → interactions. No disk access.
packages/cli    Live mode host: discovery, file watching (chokidar), HTTP + SSE on 127.0.0.1, ~/.mdr store
packages/web    Paste edition host: docs in localStorage, paste / drop / open, share links → dist/mdr.html
```

The `Host` interface (`packages/core/src/host.ts`) is the only seam between the reader and the outside world. The VS Code extension will be one more host with the same core.

Security: the server binds to 127.0.0.1 only and rejects foreign `Host` headers. The API needs a per-run token. It serves only markdown inside the opened folder, plus files that an open file explicitly `@imports`.

## Develop

```sh
npm test            # vitest: core model + server integration
npm run typecheck
npm run build
```

## Roadmap

- **Phase 2:** memory files (backlinks, link graph), then a VS Code extension (webview host).
- **Backlog:** item-level diffs inside lists (today a changed list shows as removed + added), flagging risky `allowed-tools` in skills, comparing two docs side by side, exporting the focused view, publishing the CLI to npm (`npx mdr`).
