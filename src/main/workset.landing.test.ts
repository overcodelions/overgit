import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Repo, Workset } from '../shared/types';
import * as gitApi from './git';
import { mergePreflight, showTreeFile } from './git';
import { evictPreflightTree, worksetLanding } from './workset';

let repoPath: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' });
const repo = (): Repo => ({ id: 'repo', name: 'fixture', path: repoPath, defaultBranch: 'main' });
const workset = (branch: string): Workset => ({ id: 'ws', name: 'Landing', repoIds: ['repo'], preferredBranch: branch });

beforeEach(() => {
  repoPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overgit-landing-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repoPath, 'shared.txt'), 'base\n');
  git('add', '.'); git('commit', '-qm', 'base');
});
afterEach(() => {
  // A failing assertion must not leave a spy behind for the next test.
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe('worksetLanding', () => {
  it('returns an empty unsupported report for a workset that no longer exists', async () => {
    const report = await worksetLanding('missing', [], [repo()]);
    expect(report).toMatchObject({
      worksetId: 'missing',
      gitVersion: null,
      supported: false,
      outcomes: [],
      collisions: [],
    });
  });

  it('reports on-default without attempting a preflight', async () => {
    const [outcome] = (await worksetLanding('ws', [workset('main')], [repo()])).outcomes;
    expect(outcome).toMatchObject({ result: 'on-default', branch: 'main', baseRef: 'main' });
  });

  it('reports no-default-ref when the configured default exists nowhere', async () => {
    const missingDefault = { ...repo(), defaultBranch: 'nope' };
    const [outcome] = (await worksetLanding('ws', [workset('main')], [missingDefault])).outcomes;
    expect(outcome.result).toBe('no-default-ref');
  });

  it('reports a clean feature branch and records its simulated tree', async () => {
    git('checkout', '-qb', 'feature/clean');
    fs.writeFileSync(path.join(repoPath, 'added.txt'), 'feature\n');
    git('add', '.'); git('commit', '-qm', 'feature');
    const [outcome] = (await worksetLanding('ws', [workset('feature/clean')], [repo()])).outcomes;
    expect(outcome.result).toBe('clean');
    expect(outcome.treeOid).toMatch(/^[0-9a-f]{40,64}$/);
    expect(outcome.conflictFiles).toEqual([]);
  });

  it('reports conflicting paths and previews merge-tree conflict markers without checkout', async () => {
    git('checkout', '-qb', 'feature/conflict');
    fs.writeFileSync(path.join(repoPath, 'shared.txt'), 'feature side\n');
    git('commit', '-am', 'feature edit');
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repoPath, 'shared.txt'), 'main side\n');
    git('commit', '-am', 'main edit');
    git('checkout', '-q', 'feature/conflict');
    const [outcome] = (await worksetLanding('ws', [workset('feature/conflict')], [repo()])).outcomes;
    expect(outcome.result).toBe('conflicts');
    expect(outcome.conflictFiles).toContain('shared.txt');
    const preview = await showTreeFile(repoPath, outcome.treeOid!, 'shared.txt');
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.content).toMatch(/<<<<<<<[\s\S]*feature side[\s\S]*=======[\s\S]*main side[\s\S]*>>>>>>>/);
  });

  it('distinguishes an identical branch from a branch already contained by main', async () => {
    git('checkout', '-qb', 'feature/identical');
    const [identical] = (await worksetLanding('ws', [workset('feature/identical')], [repo()])).outcomes;
    expect(identical.result).toBe('nothing-to-land');
    expect(identical.aheadOfBase).toBe(0);
    expect(identical.behindBase).toBe(0);

    git('checkout', '-q', 'main'); git('checkout', '-qb', 'feature/landed');
    fs.writeFileSync(path.join(repoPath, 'landed.txt'), 'landed\n');
    git('add', '.'); git('commit', '-qm', 'landed');
    git('checkout', '-q', 'main'); git('merge', '--ff-only', 'feature/landed');
    fs.writeFileSync(path.join(repoPath, 'after.txt'), 'after\n'); git('add', '.'); git('commit', '-qm', 'after');
    git('checkout', '-q', 'feature/landed');
    const [outcome] = (await worksetLanding('ws', [workset('feature/landed')], [repo()])).outcomes;
    expect(outcome.result).toBe('merged');
    expect(outcome.aheadOfBase).toBe(0);
    expect(outcome.behindBase).toBeGreaterThan(0);
  });

  it('reports a collision only for another active workset sharing the repo', async () => {
    git('checkout', '-qb', 'feature/a'); fs.writeFileSync(path.join(repoPath, 'shared.txt'), 'a\n'); git('commit', '-am', 'a');
    git('checkout', '-q', 'main'); git('checkout', '-qb', 'feature/b'); fs.writeFileSync(path.join(repoPath, 'shared.txt'), 'b\n'); git('commit', '-am', 'b');
    const other: Workset = { id: 'other', name: 'Other', repoIds: ['repo'], preferredBranch: 'feature/b' };
    const archived: Workset = { id: 'archived', name: 'Archived', repoIds: ['repo'], preferredBranch: 'feature/b', archived: true };
    const report = await worksetLanding('ws', [workset('feature/a'), other, archived], [repo()]);
    expect(report.collisions).toHaveLength(1);
    expect(report.collisions[0]).toMatchObject({
      result: 'conflicts',
      aBranch: 'feature/a',
      bBranch: 'feature/b',
      bWorksets: [{ id: 'other', name: 'Other' }],
      conflictFiles: ['shared.txt'],
    });
  });

  it('merges worksets bound to the same branch into one collision', async () => {
    git('checkout', '-qb', 'feature/a'); fs.writeFileSync(path.join(repoPath, 'shared.txt'), 'a\n'); git('commit', '-am', 'a');
    git('checkout', '-q', 'main'); git('checkout', '-qb', 'feature/b'); fs.writeFileSync(path.join(repoPath, 'shared.txt'), 'b\n'); git('commit', '-am', 'b');
    const one: Workset = { id: 'one', name: 'TD-1', repoIds: ['repo'], preferredBranch: 'feature/b' };
    const two: Workset = { id: 'two', name: 'TD-1 again', repoIds: ['repo'], preferredBranch: 'feature/b' };
    const spy = vi.spyOn(gitApi, 'mergePreflight');
    const report = await worksetLanding('ws', [workset('feature/a'), one, two], [repo()]);
    expect(report.collisions).toHaveLength(1);
    expect(report.collisions[0].bWorksets).toEqual([
      { id: 'one', name: 'TD-1' },
      { id: 'two', name: 'TD-1 again' },
    ]);
    // One simulated merge for the pair (plus one for the checked-out
    // branch's own landing row), not one per workset.
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('reports a clean collision when parallel worksets change different files', async () => {
    git('checkout', '-qb', 'feature/a');
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'a\n');
    git('add', '.'); git('commit', '-qm', 'a');
    git('checkout', '-q', 'main'); git('checkout', '-qb', 'feature/b');
    fs.writeFileSync(path.join(repoPath, 'b.txt'), 'b\n');
    git('add', '.'); git('commit', '-qm', 'b');
    const other: Workset = { id: 'other', name: 'Other', repoIds: ['repo'], preferredBranch: 'feature/b' };
    const report = await worksetLanding('ws', [workset('feature/a'), other], [repo()]);
    expect(report.collisions).toHaveLength(1);
    expect(report.collisions[0]).toMatchObject({ result: 'clean', conflictFiles: [] });
  });

  it('skips a collision when the other workset branch is not available locally', async () => {
    git('checkout', '-qb', 'feature/a');
    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'a\n');
    git('add', '.'); git('commit', '-qm', 'a');
    const missing: Workset = { id: 'other', name: 'Other', repoIds: ['repo'], preferredBranch: 'feature/missing' };
    const report = await worksetLanding('ws', [workset('feature/a'), missing], [repo()]);
    expect(report.collisions).toEqual([]);
  });

  it('recomputes the preflight when the base SHA changes', async () => {
    git('checkout', '-qb', 'feature/memo');
    fs.writeFileSync(path.join(repoPath, 'shared.txt'), 'feature side\n');
    git('commit', '-am', 'feature edit');
    const first = await worksetLanding('ws', [workset('feature/memo')], [repo()]);
    expect(first.outcomes[0].result).toBe('clean');
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repoPath, 'shared.txt'), 'main side\n');
    git('commit', '-am', 'main edit');
    git('checkout', '-q', 'feature/memo');
    const second = await worksetLanding('ws', [workset('feature/memo')], [repo()]);
    expect(second.outcomes[0]).toMatchObject({ result: 'conflicts', conflictFiles: ['shared.txt'] });
  });

  it('does not memoize a transient error, so the next check recomputes', async () => {
    git('checkout', '-qb', 'feature/transient');
    fs.writeFileSync(path.join(repoPath, 'added.txt'), 'feature\n');
    git('add', '.'); git('commit', '-qm', 'feature');
    const failing = vi.spyOn(gitApi, 'mergePreflight').mockResolvedValueOnce({
      status: 'error', treeOid: null, conflictFiles: [], message: 'git merge-tree timed out after 30s',
    });
    const first = await worksetLanding('ws', [workset('feature/transient')], [repo()]);
    expect(first.outcomes[0]).toMatchObject({ result: 'error', message: 'git merge-tree timed out after 30s' });
    const second = await worksetLanding('ws', [workset('feature/transient')], [repo()]);
    expect(second.outcomes[0].result).toBe('clean');
    expect(failing).toHaveBeenCalledTimes(2);
    failing.mockRestore();
  });

  it('serves a memoized answer until force or eviction bypasses it', async () => {
    git('checkout', '-qb', 'feature/memo-hit');
    fs.writeFileSync(path.join(repoPath, 'added.txt'), 'feature\n');
    git('add', '.'); git('commit', '-qm', 'feature');
    const warm = await worksetLanding('ws', [workset('feature/memo-hit')], [repo()]);
    expect(warm.outcomes[0].result).toBe('clean');
    const spy = vi.spyOn(gitApi, 'mergePreflight');
    await worksetLanding('ws', [workset('feature/memo-hit')], [repo()]);
    expect(spy).not.toHaveBeenCalled();
    await worksetLanding('ws', [workset('feature/memo-hit')], [repo()], true);
    expect(spy).toHaveBeenCalledTimes(1);
    evictPreflightTree(repoPath, warm.outcomes[0].treeOid!);
    await worksetLanding('ws', [workset('feature/memo-hit')], [repo()]);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('reports an unborn repo as having no commits rather than as detached', async () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overgit-unborn-')));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: empty });
      const unborn: Repo = { id: 'unborn', name: 'unborn', path: empty, defaultBranch: 'main' };
      const ws: Workset = { id: 'ws', name: 'Landing', repoIds: ['unborn'] };
      const [outcome] = (await worksetLanding('ws', [ws], [unborn])).outcomes;
      expect(outcome.result).toBe('error');
      expect(outcome.message).not.toMatch(/Detached/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('returns an error outcome for a broken member without aborting the valid member', async () => {
    const broken: Repo = { id: 'broken', name: 'broken', path: path.join(repoPath, 'missing'), defaultBranch: 'main' };
    const twoRepoWorkset: Workset = { id: 'ws', name: 'Landing', repoIds: ['repo', 'broken'] };
    const report = await worksetLanding('ws', [twoRepoWorkset], [repo(), broken]);
    expect(report.outcomes).toHaveLength(2);
    expect(report.outcomes.find((o) => o.repoId === 'broken')?.result).toBe('error');
  });

  it('isolates an unrelated-history merge-tree failure as an error outcome', async () => {
    git('checkout', '-q', '--orphan', 'feature/unrelated');
    git('rm', '-rf', '.');
    fs.writeFileSync(path.join(repoPath, 'other.txt'), 'other root\n');
    git('add', '.'); git('commit', '-qm', 'other root');
    const [outcome] = (await worksetLanding('ws', [workset('feature/unrelated')], [repo()])).outcomes;
    expect(outcome.result).toBe('error');
  });

  it('returns unsupported outcomes and skips collisions below Git 2.38', async () => {
    const version = vi.spyOn(gitApi, 'gitVersion').mockResolvedValue({ major: 2, minor: 37, patch: 9, text: '2.37.9' });
    const report = await worksetLanding('ws', [workset('main')], [repo()]);
    expect(report).toMatchObject({ supported: false, collisions: [] });
    expect(report.outcomes[0].result).toBe('unsupported');
    version.mockRestore();
  });

  it('refuses option-shaped refs before git can execute an injected option', async () => {
    const hostile = '--upload-pack=/tmp/overgit-landing-sentinel';
    git('update-ref', `refs/heads/${hostile}`, 'HEAD');
    const result = await mergePreflight(repoPath, hostile, 'main');
    expect(result.status).toBe('error');
    expect(fs.existsSync('/tmp/overgit-landing-sentinel')).toBe(false);
  });

  it('rejects invalid, missing, and binary simulated-tree previews', async () => {
    expect(await showTreeFile(repoPath, 'not-a-tree', 'shared.txt')).toMatchObject({ ok: false });
    const head = git('rev-parse', 'HEAD').trim();
    expect(await showTreeFile(repoPath, head, 'missing.txt')).toMatchObject({ ok: false });
    fs.writeFileSync(path.join(repoPath, 'binary.bin'), Buffer.from([0, 1, 2]));
    git('add', '.'); git('commit', '-qm', 'binary');
    const binary = await showTreeFile(repoPath, git('rev-parse', 'HEAD').trim(), 'binary.bin');
    expect(binary).toMatchObject({ ok: false, binary: true });
  });
});
