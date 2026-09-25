# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The app mark still broke up at the smallest sizes: the branch graph's
  ring nodes closed up and its strokes thinned to about two device pixels.
  16–32px icons now use a heavier cut with solid nodes
  (`build/icon-small.svg`), and the in-app mark switches to heavier strokes
  below 64px. The dock icon gains the family's shade, rim and drop shadow,
  and the in-app mark is now the app icon's white tile instead of a purple
  one, so the window and the Dock match.

## [0.4.2] - 2026-09-23

### Added

- Overgit now updates itself. New versions download in the background from
  GitHub Releases and install when you quit; once one is ready, a prompt
  offers to restart now. Settings → General has an Update channel switch:
  Stable follows tagged releases, Nightly follows the daily builds. This is
  the first version that can update itself, so 0.4.1 and earlier still need
  this one installed by hand.

### Changed

- The Windows installer is now named `Overgit-Setup-<version>.exe`.
- Nightly builds are versioned one patch ahead of the latest release (for
  example `0.4.3-nightly.<date>.<sha>`) and each is published under its own
  tag, so their download links change with every build.

## [0.4.1] - 2026-09-23

### Fixed

- The macOS app icon showed as coloured noise in Finder's list view and the
  Applications folder. electron-builder's conversion of `icon.png` garbled
  the 16×16 and 32×32 images; the app now ships an `.icns` built with
  Apple's `iconutil`, correct at every size.

## [0.4.0] - 2026-09-23

### Added

- A first-run welcome screen. With nothing added yet, overgit explains repos,
  workspaces and worksets, offers Add repos and Clone, and checks this machine
  for git and the optional CLIs (gh, claude, codex, gemini), with a
  copyable install command for anything missing. Add repos and Clone wait for
  git, and the screen notices git being installed without a restart.
- A Getting started checklist in the sidebar: add repos, make a workspace,
  start a workset. It is derived from what you have, retires itself once
  every step is done, and can be hidden.
- Help sheets: How Overgit Works, Setup — Git and CLIs (live re-check), and
  Keyboard Shortcuts (⌘/ or `?`). Each is reachable from a new native Help
  menu and from the command palette, and each links to the others.
- A native app menu, replacing Electron's default one: File → Add
  Repositories… (⌘O) and Clone Repository… (⇧⌘O), View → Command Palette and
  Toggle Sidebar, plus Documentation and Report an Issue under Help.
- Command palette entries for Add repos, Clone a repo, New workspace and the
  help sheets.
- Settings → AI & Forges shows the git version and whether it is new
  enough for Landing Check.

### Changed

- One shortcut list drives the Shortcuts sheet, Settings → Shortcuts and the
  About sheet. Settings had been listing four repo tabs and missing ⌘P, ⌘F
  and ⌘⏎.
- The About sheet shows the real app version instead of a fixed "v0.1.0".
- The empty main pane now says what each sidebar section is and offers a way
  in, instead of a paragraph with no actions.
- The menu no longer has View → Reload. Electron's default menu bound it to
  ⌘R, the key overgit uses to refresh a pane.
- Repo status is faster. Read-only git commands in a repo now run
  concurrently instead of queueing behind one lock, and status takes three git
  processes instead of seven. A full sidebar sweep over 12 repos went from
  about 450ms to about 170ms.
- Slow actions show a spinner on the button that started them, and work sent
  to the background ("Run in background" on reset, fetch and sync) shows as a
  live progress pill in the title bar until it finishes.
- Sync N behind is local-only: it fast-forwards to the already-fetched
  remote-tracking branch, eight repos at a time, instead of fetching each repo
  first.
- Release pages have a download table and permanent, version-free download
  links under `/releases/latest/download/`.
- CI type-checks the whole tree, tests included (`npm run typecheck`).

### Fixed

- Synced repos no longer show as behind again: a status read that started
  before a fast-forward can't overwrite the fresher result.
- Conflicted paths containing spaces are no longer shown quoted, and a repo
  with no commits reports its branch instead of reading as detached.
- Reviewing a selection made only of new, untracked files showed "no changes";
  those files now appear in the diff.

### Security

- Electron 41.10.7 (CVE-2026-70608, the one advisory that reached the shipped
  app), electron-builder 26.15.3 and related packaging libraries, plus vite
  and vitest. The unpatchable `extract-zip` dependency is gone.
- Dev dependency advisories cleared (postcss, axios, form-data, shell-quote
  and others); none of them ship in the app.
- The repo pins the public npm registry, so a machine configured for a private
  mirror can't rewrite the lockfile's URLs.

### Documentation

- TRADEMARKS.md: the Apache-2.0 license covers the code, not the overgit name
  or logo. CONTRIBUTING.md gains contribution terms (DCO sign-off,
  Apache-2.0 inbound).

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

[Unreleased]: https://github.com/overcodelions/overgit/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/overcodelions/overgit/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/overcodelions/overgit/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/overcodelions/overgit/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/overcodelions/overgit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/overcodelions/overgit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/overcodelions/overgit/releases/tag/v0.1.0
