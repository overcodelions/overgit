# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-02

### Added

- Clone from a forge instead of a pasted URL. The clone sheet has source tabs —
  Paste URL plus GitHub, GitLab, and Bitbucket — each listing the repos your
  existing local credentials can already reach, with a filter box, an https /
  ssh toggle that persists, and a Refresh. Picking a repo fills in the URL and
  folder name. Auth reuses what is already on the machine: `gh` for GitHub,
  `glab` (or the git credential helper) for GitLab, and the credential helper
  for Bitbucket. Overgit never asks for or stores a token of its own, and no
  credential is exposed to the renderer.

### Fixed

- The Changes-tab "Committing as" banner now updates as soon as an identity
  changes. Saving a per-repo override left it showing the previous author until
  the repo was reselected.

### Security

- Branch, tag, and remote names that begin with `-` are refused everywhere they
  reach a positional `git` argument. `git update-ref` will create a ref named
  `--upload-pack=<path>`, so a hostile repo could seed a branch list with one
  and have a later `git fetch` / `git ls-remote` execute the referenced binary.

### Changed

- File editor now uses CodeMirror for syntax highlighting (replaces
  `highlight.js`). This landed in the 0.1.0 build but was missing from its
  notes.

## [0.1.0] - 2026-05-09

Initial public release. Building in the open from here.

### Added

- Workspace-overlay model: name a group of repos, coordinate branch / sync /
  pull / commit across all of them with per-member outcomes.
- Branch picker (⌘B) with searchable local + remote groups, ↑↓/Enter,
  inline create-branch with optional sync-and-pull, per-branch cherry-pick.
- Command palette (⌘K) for switching repos / workspaces / branches and
  running per-repo actions (stage all, fetch, pull, push, AI review, suggest
  commit message).
- Per-repo Changes / History / Files / Graph / Stash tabs with multi-select
  and bulk-action bar.
- Sandboxed file editor with `highlight.js` syntax highlighting, scoped to
  registered repos.
- AI review and commit-message suggest via detected `claude` / `codex` /
  `gemini` CLIs, piping the diff through stdin in non-interactive mode.
- `gh`-backed PR aggregation across workspace members.
- Per-lane colored branch graph with ref labels.
- Resizable sidebar, light / dark / system theme, keyboard shortcuts.

[Unreleased]: https://github.com/overcodelions/overgit/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/overcodelions/overgit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/overcodelions/overgit/releases/tag/v0.1.0
