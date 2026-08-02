// Regression tests for option-injection through ref-shaped arguments.
// `git update-ref` will create a branch literally named
// `--upload-pack=<path>`, so a cloned repo can put that string into our
// branch lists. Anything that forwards it to a positional git slot turns
// it into an option — and `--upload-pack` / `--exec` on a network
// command executes a local binary.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addRemote,
  checkoutBranch,
  createBranch,
  createTag,
  deleteBranch,
  deleteTag,
  isSafeRefArg,
  mergeBranch,
  pushTag,
  renameBranch,
  setRemoteUrl,
} from './git';

const HOSTILE = '--upload-pack=/tmp/overgit-should-never-run';

describe('isSafeRefArg', () => {
  it('accepts ordinary names', () => {
    for (const ok of ['main', 'feature/IB-56', 'v1.2.3', 'origin', 'release_2026']) {
      expect(isSafeRefArg(ok)).toBe(true);
    }
  });

  it('rejects option-shaped and empty names', () => {
    for (const bad of [HOSTILE, '-evil', '--force', '  --exec=sh  ', '', '   ']) {
      expect(isSafeRefArg(bad)).toBe(false);
    }
  });
});

describe('ref-taking git helpers refuse option-shaped names', () => {
  let repo: string;

  beforeAll(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overgit-refarg-')));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('commit', '-q', '--allow-empty', '-m', 'root');
    // The thing a hostile remote can ship: a ref whose name is an option.
    // `git branch` refuses it; the plumbing does not.
    git('update-ref', `refs/heads/${HOSTILE}`, 'HEAD');
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('the hostile ref really is present (test fixture sanity)', () => {
    const refs = execFileSync('git', ['for-each-ref', '--format=%(refname:short)'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(refs).toContain(HOSTILE);
  });

  it('checkoutBranch refuses it', async () => {
    const out = await checkoutBranch('repo-id', repo, HOSTILE, true);
    expect(out.result).toBe('error');
  });

  it('createBranch / deleteBranch / renameBranch refuse it', async () => {
    expect((await createBranch(repo, HOSTILE, false)).ok).toBe(false);
    expect((await deleteBranch(repo, HOSTILE, true)).ok).toBe(false);
    expect((await renameBranch(repo, HOSTILE, null, false)).ok).toBe(false);
    expect((await renameBranch(repo, 'fine', HOSTILE, false)).ok).toBe(false);
  });

  it('mergeBranch refuses it', async () => {
    expect((await mergeBranch(repo, HOSTILE, 'merge')).ok).toBe(false);
  });

  it('tag helpers refuse it in the name, start point, and remote slots', async () => {
    expect((await createTag(repo, { name: HOSTILE, ref: null, message: null })).ok).toBe(false);
    expect((await createTag(repo, { name: 'v1', ref: HOSTILE, message: null })).ok).toBe(false);
    expect((await deleteTag(repo, HOSTILE)).ok).toBe(false);
    expect((await pushTag(repo, 'v1', HOSTILE)).ok).toBe(false);
    expect((await pushTag(repo, HOSTILE, 'origin')).ok).toBe(false);
  });

  it('remote helpers refuse it in the name and URL slots', async () => {
    expect((await addRemote(repo, HOSTILE, 'https://example.com/x.git')).ok).toBe(false);
    expect((await addRemote(repo, 'origin', HOSTILE)).ok).toBe(false);
    expect((await setRemoteUrl(repo, HOSTILE, 'https://example.com/x.git', 'fetch')).ok).toBe(false);
  });

  it('still allows a legitimate branch through the same path', async () => {
    expect((await createBranch(repo, 'feature/ok', false)).ok).toBe(true);
    const out = await checkoutBranch('repo-id', repo, 'feature/ok', false);
    expect(out.result).toBe('switched');
  });
});
