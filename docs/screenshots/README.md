# Screenshots

The top-level `README.md` shows these images. They're generated, not hand-captured, so they can be refreshed whenever the UI changes.

| File | Shows |
|---|---|
| `hero.png` | Hero: sidebar with workspaces and worksets, and the *Rate-limiter rollout* workset with PRs, CI status and the landing check (dark) |
| `workspace.png` | The *Platform* workspace page: branch, dirty, ahead and behind per repo (dark) |
| `landing.png` | Landing check with a conflict and a collision with another workset, plus the status table and activity feed (dark) |
| `search.png` | Code search across a workset, grouped by repo (dark) |
| `palette.png` | Command palette (⌘K) inside a repo that belongs to a workset (dark) |
| `changes-light.png` | A repo's Changes tab with a diff, commit identity and the AI actions (light) |

## Regenerating

```bash
npm run build
npm i --no-save playwright-core
pip3 install pillow   # once, for framing
node scripts/readme-screenshots/capture.mjs
```

[`scripts/readme-screenshots/`](../../scripts/readme-screenshots/) does the whole job:

- **`seed.mjs`** builds a throwaway HOME in your temp dir: nine fictional `acme-*` git repos with real history from fictional authors, feature branches, unpushed commits, uncommitted edits, a teammate's commit on `main` that conflicts with a workset branch, and two worksets whose branches collide in one repo. Each repo was pushed to a local bare origin, then origin is repointed at a fictional `github.com/acme-co` URL, and the sandbox gitconfig refuses ssh and https, so fetches fail fast instead of reaching the network. A stub `gh` answers `gh pr list` from canned JSON (PRs, checks and reviews), and stub `claude` / `codex` answer only `--version`. It also writes the app store (repos, workspaces, worksets, settings).
- **`capture.mjs`** runs the built app with that HOME, its own `--user-data-dir`, and a PATH cut down to the sandbox's `bin/` plus system dirs, so none of your own repos, settings, tokens or CLIs can appear in an image or be called. It clicks through each scene at 1600×1000 and 2× scale, rewrites the sandbox path to `~` in the DOM, then deletes the profile.
- **`frame.py`** adds macOS window chrome (traffic lights, rounded corners, soft shadow) on a transparent background, so the images work in GitHub's light and dark themes.

## Adding a shot

Add a scene to `capture.mjs`, add any data it needs to `seed.mjs` (PR data goes in the `PRS` fixture), then add a row above and an image to the README. Keep names `kebab-case.png`, and keep everything fictional: acme names only, no real people, companies or paths.
