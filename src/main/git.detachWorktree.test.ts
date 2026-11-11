import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkoutBranch as checkout, detachWorktree } from './git';

let root: string;
let repoPath: string;
let wtPath: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overgit-detach-')));
  repoPath = path.join(root, 'repo');
  wtPath = path.join(root, 'wt');
  fs.mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.email', 't@example.com');
  git(repoPath, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repoPath, 'a.txt'), 'a\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-qm', 'init');
  git(repoPath, 'switch', '-qc', 'feature');
  // Linked worktree holds main, so the main checkout can't switch to it.
  git(repoPath, 'worktree', 'add', '-q', wtPath, 'main');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('detachWorktree', () => {
  it('frees the branch without touching uncommitted work in the worktree', async () => {
    fs.writeFileSync(path.join(wtPath, 'a.txt'), 'dirty\n');
    const blocked = await checkout('r', repoPath, 'main', false);
    expect(blocked.result).toBe('worktree-conflict');

    const res = await detachWorktree(repoPath, wtPath);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(wtPath, 'a.txt'), 'utf8')).toBe('dirty\n');
    expect(git(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD');

    const switched = await checkout('r', repoPath, 'main', false);
    expect(switched.result).toBe('switched');
  });

  it('prunes when the worktree directory is already gone', async () => {
    fs.rmSync(wtPath, { recursive: true, force: true });
    const res = await detachWorktree(repoPath, wtPath);
    expect(res.ok).toBe(true);
    expect((await checkout('r', repoPath, 'main', false)).result).toBe('switched');
  });

  it('refuses the main checkout and unknown paths', async () => {
    expect((await detachWorktree(repoPath, repoPath)).ok).toBe(false);
    expect((await detachWorktree(repoPath, path.join(root, 'nope'))).ok).toBe(false);
  });
});
