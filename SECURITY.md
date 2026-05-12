# Security policy

## Reporting a vulnerability

If you find a security issue in overgit, please report it privately:

- **GitHub:** open a [private security advisory](https://github.com/overcodelions/overgit/security/advisories/new) on this repository.
- **Email:** security@codelionsllc.com.

Please include enough detail to reproduce — overgit is a desktop client that shells out to `git`, `gh`, and (optionally) `claude` / `codex` / `gemini`, so reports about command-injection, path-escape, or credential exfiltration are especially welcome.

I aim to acknowledge new reports within a few business days. Coordinated disclosure is appreciated; please give me a reasonable window to ship a fix before publishing details.

## Scope

In scope:

- The Electron main / preload / renderer code in `src/`.
- The IPC contract between renderer and main.
- File-editor path handling and any shell-out invocations.

Out of scope:

- Bugs in `git`, `gh`, `claude`, `codex`, `gemini`, or other third-party CLIs overgit shells out to — please report those upstream.
- Issues that require an attacker to already have local code execution as the user running overgit.

## What overgit sends where

- Every git operation runs as a plain `git` subprocess in the repo's directory. No data leaves your machine through overgit itself.
- AI review / commit-message suggestion pipes the diff to whichever CLI you select on stdin. That CLI inherits your shell environment (so any `*_API_KEY` / `*_TOKEN` env vars in your shell are visible to it). Nothing else leaves overgit.
- `gh` is invoked with your existing `gh` auth.
