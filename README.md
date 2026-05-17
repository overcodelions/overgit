# overgit

A multi-repo git client built around two ideas: **workspaces** (durable groupings of repos) and **worksets** (units of work — tickets — that span some of those repos). Coordinate many repos at once without ever owning their state.

Sibling project of [overcli](https://github.com/overcodelions/overcli).

## Why overgit

GitHub Desktop, Tower, and Fork are all single-repo-at-a-time. If your work spans services + shared libs + infra, you end up scripting your own "checkout `feature/x` everywhere" flow. overgit fills that gap, runs every action as a plain `git` command in the repo's existing directory, and never writes inside `.git`.

### Workspaces vs. worksets

The two concepts are **orthogonal** — the same repo lives in both at once:

- **Workspace** — a durable, identity-bearing grouping of repos. "These are Platform." "These are Payments." Workspaces are the sidebar's collapsible sections, and they're the target for bulk actions like *fetch all*, *reset all to default*, and "what's the status across this whole group?"
- **Workset** — a transient unit of in-flight work that spans some repos, pinned to a feature branch. Think of a workset as a *ticket you can resume across repos*: "ship the auth migration across `api-gateway`, `billing-svc`, and `ledger-core` this week." Worksets are created when you start work, archived when the work ships, and reset cleanly when you're done with them.

A repo can belong to many workspaces (small shared libs are the common case) and to many worksets at once (the migration ticket and the rate-limit ticket both touch `api-gateway`).

### Three principles

1. **Coordinate.** Branch across the repos a workset spans in one go. See status, PRs, and dirty state across every workspace member at once.
2. **Overlay, not metadata.** overgit never writes inside `.git`. No manifest, no synthetic root, no hidden file on disk. Stop using it any time and your repos behave the same in any other tool.
3. **AI in the loop.** Pipe a diff to `claude` / `codex` / `gemini` for review. Have an LLM CLI draft your commit message from the staged diff. Uses your existing CLI auth — nothing leaves your machine via overgit.

## What's in the box

### Workspaces (durable groupings)

- **Sidebar grouping.** Each workspace is a collapsible section. Repos can appear in many workspaces.
- **Workspace-wide actions.** Fetch all, status all, *reset all repos to default* (fetch → switch → hard-reset to `origin/<default>` across every member).
- **Workspace-wide PR list.** `gh pr list --json` per member, merged into one view.
- **Smart reset safety.** Any repo with commits not on `origin/<default>` stops and asks before the hard-reset would erase them — per-repo `[force reset (lose N)]` / `[skip]` outcomes, never a silent disaster.

### Worksets (tickets across repos)

- **A workset is a ticket.** Name it ("rate-limiter rollout"), pick the repos it touches, optionally bind it to a feature branch (`feat/rate-limit`). Resume it any time — the sidebar surfaces active worksets above the workspace list.
- **Workset-wide branching.** Sync each member repo to its default → pull → branch, all in one workflow. Per-repo outcomes if any of them fail.
- **Archive when shipped.** Workset done — committed and pushed across all repos? Archive it. It vanishes from the active list into the collapsed "Archived" section. Repos on disk are unchanged. Reactivate any time.
- **Workset reset.** One action fans out fetch → switch back to `origin/<default>` → hard-reset → delete the workset's bound branch across every member. Same safety checks as workspace reset.

### Per-repo and AI

- **Branch picker.** Searchable popover (⌘B). Local + remote branches grouped, ↑↓/Enter, inline create-branch with optional sync-and-pull, per-branch cherry-pick (commit-list multi-select).
- **Command palette.** ⌘K opens a context-aware palette: switch / create branches, jump to repos / workspaces / worksets, search files, run repo actions (stage all, fetch, pull, push, AI review, "stage all & suggest commit message").
- **Per-repo management.** Changes / History / Files / Graph / Stash tabs. Multi-select with checkboxes, bulk-action bar (Stage / Stash / Discard). File editor sandboxed to registered repos with hljs syntax highlighting.
- **AI review & suggest.** Detects `claude` / `codex` / `gemini`. Pipes diffs into the chosen CLI in non-interactive mode (90s cap). Suggest drafts a conventional-commit message from the staged diff and drops it into the commit input.
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
| ⌘N | New branch (across a workset's repos) |
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

> Spawned CLIs inherit your shell environment — that's how their auth works. Anything in your env (e.g. `*_API_KEY`, `GITHUB_TOKEN`) is visible to whichever CLI you invoke. overgit itself never reads or transmits those values.

## Security

See [SECURITY.md](./SECURITY.md) for how to report a vulnerability and what overgit does/doesn't send over the network.

## A father–son project

overgit is a collaboration between **[Lionel Farr](https://github.com/lionelfarr)** and his son **[Owen Farr](https://github.com/owenlfarr)**, sibling to [overcli](https://github.com/overcodelions/overcli). Same setup: an excuse to build something real together — Owen learning how a desktop app holds together end to end (IPC, state, subprocess plumbing, packaging), Lionel getting to teach by doing instead of explaining in the abstract.

## Contributing

Issues, bug reports, and PRs welcome — please open an issue first for anything non-trivial so we can talk about the shape of it.

- [Open an issue](https://github.com/overcodelions/overgit/issues/new) for bugs, features, or questions
- Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for dev setup and PR expectations
- See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) before participating
- Found a security bug? Don't file a public issue — see [`SECURITY.md`](./SECURITY.md)

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

Copyright © 2026 Lionel Farr and Owen Farr.
