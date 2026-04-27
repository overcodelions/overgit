# overgit

A workspace-overlay git client. Coordinate many repos at once without owning their state.

Sibling project of [overcli](https://github.com/lionelfarr/overcli).

## Why overgit

GitHub Desktop, Tower, and Fork are all single-repo-at-a-time. If your work spans services + shared libs + infra, you end up scripting your own "checkout `feature/x` everywhere" flow. overgit fills that gap — a desktop client built around **workspaces**, not single repos, that runs every action as a plain `git` command in the repo's existing directory.

Three principles:

1. **Coordinate.** Workspaces are named groups of repos. Bring all of them to the same branch in one go. See status, PRs, and dirty state across every member at once.
2. **Overlay, not metadata.** overgit never writes inside `.git`. Stop using it any time and your repos behave the same in any other tool.
3. **AI in the loop.** Pipe a diff to `claude` / `codex` / `gemini` for review. Have an LLM CLI draft your commit message from the staged diff. Uses your existing CLI auth — nothing leaves your machine via overgit.

## What's in the box

- **Workspace-wide branching.** Sync each repo to its default branch → pull → branch, all in one workflow. Per-repo outcomes if any of them fail.
- **Branch picker.** Searchable popover (⌘B). Local + remote branches grouped, ↑↓/Enter, inline create-branch with optional sync-and-pull, per-branch cherry-pick (commit-list multi-select).
- **Command palette.** ⌘K opens a context-aware palette: switch / create branches, jump to repos / workspaces, search files, run repo actions (stage all, fetch, pull, push, AI review, "stage all & suggest commit message").
- **Per-repo management.** Changes / History / Files / Graph / Stash tabs. Multi-select with checkboxes, bulk-action bar (Stage / Stash / Discard). File editor sandboxed to registered repos with hljs syntax highlighting.
- **AI review & suggest.** Detects `claude` / `codex` / `gemini`. Pipes diffs into the chosen CLI in non-interactive mode (90s cap). Suggest button drafts a conventional-commit message from the staged diff and drops it into the commit input.
- **gh PR aggregation.** Workspace-wide PR list via `gh pr list --json` per member, merged into one view.
- **Branch graph.** Per-lane colored visualization with ref labels.
- **Resizable sidebar**, dark / light / system theme, keyboard shortcuts everywhere.

## Status

v0.1.0 — building in the open. Expect things to move.

## Stack

Electron + React + Tailwind + Vite + Zustand + TypeScript. Mirrors overcli's `src/{main,preload,renderer,shared}` layout.

## Run it

```bash
npm install
npm run dev          # dev server on :5273 + Electron
# or
npm run build && npm start    # built renderer
```

If you want to use overgit on its own source tree, run `npm start` rather than `npm run dev` — Vite HMR otherwise reloads the renderer every time you save a watched file through overgit's editor.

## Keyboard shortcuts

| Key | What |
| --- | --- |
| ⌘K | Command palette |
| ⌘, | Settings |
| ⌘\ | Toggle sidebar |
| ⌘R | Refresh current pane |
| ⌘B | Branch picker (in a repo) |
| ⌘N | New branch (in a workspace) |
| ⌘1 – 4 | Repo tabs: Changes / History / Files / Graph |
| ⌘S | Save open file |
| ↑↓⏎ | Navigate picker / palette |

## CLIs overgit shells out to

- **`git`** — every operation. The whole point.
- **`gh`** — GitHub PR list, comments, reviews.
- **`glab`**, **`jj`** — detected; integrations planned.
- **`claude`** — `claude -p -` for review / suggest commit message.
- **`codex`** — `codex exec --skip-git-repo-check -`. Transcript post-processed to keep only the final assistant body.
- **`gemini`** — `gemini -p -`.

Missing CLIs hide the relevant UI; nothing else changes.

## License

Apache-2.0. Built by Lionel Farr.
