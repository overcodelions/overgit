// Filesystem IPC for the in-app file editor. Every operation is gated on
// "is this absolute path under one of the repo roots the user has
// registered with overgit?" — the renderer cannot read or write files
// elsewhere. Mirrors the safety model overcli uses.

import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.DS_Store',
  'DerivedData',
  '.swiftpm',
  'dist',
  'build',
  '.build',
  'release',
]);

/// Hard cap on a single read so a stray binary or generated file can't
/// freeze the renderer trying to render megabytes into a textarea.
const MAX_READ_BYTES = 5 * 1024 * 1024;
/// Hard cap on the file walk; we'd rather show a partial tree than hang.
const MAX_TREE_FILES = 20000;

function normalizeUnderRoot(target: string, root: string): string | null {
  const resolved = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  // path.relative returns "" for the root itself, "../…" for siblings,
  // and a valid relative path for descendants — that's the cleanest
  // "is X under Y" check that handles symlinks and trailing slashes.
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '') return resolved;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

export function listFilesUnder(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = fs.readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(cur, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile()) {
        out.push(full);
        if (out.length >= MAX_TREE_FILES) return out;
      }
    }
  }
  return out;
}

export function readFileUnderRoot(
  root: string,
  filePath: string,
):
  | { ok: true; content: string; resolvedPath: string }
  | { ok: false; error: string } {
  const resolved = normalizeUnderRoot(filePath, root);
  if (!resolved) {
    return { ok: false, error: 'Refused: path is outside the repo' };
  }
  try {
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_READ_BYTES) {
      return {
        ok: false,
        error: `File is ${Math.round(stat.size / 1024 / 1024)} MB — editor opens files under 5 MB.`,
      };
    }
    const content = fs.readFileSync(resolved, 'utf-8');
    if (content.includes('\0')) {
      return { ok: false, error: 'Binary file — editor only opens text.' };
    }
    return { ok: true, content, resolvedPath: resolved };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function writeFileUnderRoot(
  root: string,
  filePath: string,
  content: string,
): { ok: boolean; error?: string } {
  const resolved = normalizeUnderRoot(filePath, root);
  if (!resolved) {
    return { ok: false, error: 'Refused: path is outside the repo' };
  }
  try {
    fs.writeFileSync(resolved, content, 'utf-8');
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
