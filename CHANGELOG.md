# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-09-13

### Added

- Landing Check. For every workset, overgit answers "will this land on its
  default branch?" per member repo using `git merge-tree --write-tree` (Git
  2.38+), which never touches the working tree, index, or any ref. Each repo
  gets an outcome (clean, conflicts with the files listed, already merged,
  nothing to land, on the default branch, no default ref, unsupported, or
  error). Conflicted files preview read-only from the merge-tree result, and
  Rebase and Merge onto the default branch reuse the existing flows.
- Collisions between worksets. For every repo shared by two or more active
  worksets, the two bound branches are simulated against each other, grouped
  by repo with conflicts first.
- Landing results surface as a sidebar dot on workset rows, a Landing section
  in the workset view, a badge on the Push step, a Re-check button, and a
  command palette entry. They refresh after the background fetch and are
  memoized per repo and commit pair.

### Changed

- macOS builds are signed with the Developer ID and notarized, so the app
  opens without a Gatekeeper warning. Nightly builds are signed but not
  notarized. The macOS release runner is pinned to `macos-15`.

### Fixed

- File-system check/use races flagged by CodeQL: files under a repo root are
  read through a single descriptor, in-progress operations are detected by
  reading `.git` directly, and the AWS account ID scanner reads links first.

### Security

- CI blocks AWS account IDs and private git identities in commits, commit
  messages, and pull requests, with matching local hooks.
- A customer organization name used as a search example in the clone sheet
  was replaced.

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

[Unreleased]: https://github.com/overcodelions/overgit/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/overcodelions/overgit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/overcodelions/overgit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/overcodelions/overgit/releases/tag/v0.1.0
