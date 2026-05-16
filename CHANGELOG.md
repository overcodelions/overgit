# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- File editor now uses CodeMirror for syntax highlighting (replaces `highlight.js`).

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

[Unreleased]: https://github.com/overcodelions/overgit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/overcodelions/overgit/releases/tag/v0.1.0
