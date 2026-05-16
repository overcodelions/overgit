# Contributing to overgit

Thanks for your interest. overgit is small and opinionated; the bar for new behavior is "does it make coordinated multi-repo work cleaner?". Bug fixes, polish, and well-scoped features are all welcome.

## Development

Requires Node 20 or newer.

```bash
npm install
npm run dev          # vite dev server + electron, with HMR
# or
npm start            # build once, run electron
npm test             # vitest
```

If you're hacking on overgit *in* overgit, prefer `npm start` over `npm run dev`: Vite HMR otherwise reloads the renderer every time you save a file through overgit's editor.

## Project layout

- `src/main` — Electron main process. IPC handlers, git/CLI shell-outs, store.
- `src/preload` — `contextBridge` API. Single typed `invoke` channel.
- `src/renderer` — React UI.
- `src/shared` — types and helpers shared across processes.

## Submitting changes

1. Fork and branch from `main`.
2. Keep PRs focused — one logical change per PR.
3. Run `npm run build` and `npm test` before pushing.
4. Match existing style (TypeScript strict mode, no comments-for-comments-sake, prefer editing existing files).
5. New IPC channels go through `IPCInvokeMap` in `src/shared/types.ts` so the preload stays type-safe.

## Security-sensitive areas

If your change touches any of these, call it out in the PR description:

- Anything that spawns a child process (`spawn` calls in `src/main/git.ts` or `src/main/cli.ts`).
- Anything that resolves a filesystem path (`src/main/fs.ts`).
- The Electron `webPreferences`, navigation handlers, or CSP in `src/main/index.ts` / `src/renderer/index.html`.

For suspected vulnerabilities, please follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.

## Conduct

Please read the [Code of Conduct](./CODE_OF_CONDUCT.md) before participating.

## License

By submitting a contribution you agree it is licensed under the project's [Apache-2.0 license](./LICENSE).
