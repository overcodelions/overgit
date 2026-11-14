import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { branchSummaries, checkoutBranch, parseUpstreamTrack } from './git';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overgit-branch-summaries-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('commit', '--allow-empty', '-qm', 'root');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('update-ref', 'refs/remotes/origin/feat/x', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('branchSummaries', () => {
  it('drops the origin/HEAD alias, whose short name is bare "origin"', async () => {
    const remotes = (await branchSummaries(repo)).filter((b) => b.kind === 'remote');
    expect(remotes.map((b) => b.name).sort()).toEqual(['origin/feat/x', 'origin/main']);
    expect(remotes.every((b) => b.shortName !== '')).toBe(true);
  });

  it('reports how far a local branch is ahead of its upstream', async () => {
    // git only tracks refs of a configured remote; pointing it at the
    // repo itself keeps the test offline.
    git('remote', 'add', 'origin', repo);
    git('branch', '--set-upstream-to=origin/main', 'main');
    git('commit', '--allow-empty', '-qm', 'local only');
    const main = (await branchSummaries(repo)).find((b) => b.kind === 'local' && b.name === 'main');
    expect(main?.track).toEqual({ ahead: 1, behind: 0, gone: false });
  });
});

describe('checkoutBranch from a non-origin remote', () => {
  it('creates a local branch tracking that remote', async () => {
    git('remote', 'add', 'upstream', repo);
    git('update-ref', 'refs/remotes/upstream/feat/y', 'HEAD');
    const out = await checkoutBranch('repo-id', repo, 'feat/y', false, 'upstream');
    expect(out.result).toBe('switched');
    expect(git('rev-parse', '--abbrev-ref', 'feat/y@{upstream}').trim()).toBe('upstream/feat/y');
  });
});

describe('parseUpstreamTrack', () => {
  it('reads every shape git prints', () => {
    expect(parseUpstreamTrack('[ahead 2, behind 5]')).toEqual({ ahead: 2, behind: 5, gone: false });
    expect(parseUpstreamTrack('[behind 1]')).toEqual({ ahead: 0, behind: 1, gone: false });
    expect(parseUpstreamTrack('[gone]')).toEqual({ ahead: 0, behind: 0, gone: true });
    expect(parseUpstreamTrack('')).toEqual({ ahead: 0, behind: 0, gone: false });
  });
});
