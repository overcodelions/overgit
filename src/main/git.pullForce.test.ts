import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hiddenIndexFlags, pull, pullForce, restoreIndexFlags } from './git';

// Each test gets a bare upstream, a "local" clone left one commit
// behind, and a helper clone that pushes the upstream change. The
// local clone then has edits to `app/package.json` that the incoming
// commit would overwrite.
let tmp: string;
let upstream: string;
let local: string;
let helper: string;

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const git = (...args: string[]) => gitIn(local, ...args);
const read = (rel: string) => fs.readFileSync(path.join(local, rel), 'utf8');
const write = (dir: string, rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};
const tag = (rel: string) => git('ls-files', '-v', '--', rel).slice(0, 1);
const clone = (dir: string) => {
  gitIn(tmp, 'clone', '-q', upstream, dir);
  gitIn(dir, 'config', 'user.email', 'test@example.com');
  gitIn(dir, 'config', 'user.name', 'Test');
};

/// Push an upstream commit made by `change` in the helper clone.
const pushUpstream = (change: (dir: string) => void) => {
  gitIn(helper, 'pull', '-q');
  change(helper);
  gitIn(helper, 'add', '-A');
  gitIn(helper, 'commit', '-qm', 'upstream change');
  gitIn(helper, 'push', '-q', 'origin', 'HEAD');
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overgit-pullforce-')));
  upstream = path.join(tmp, 'up.git');
  local = path.join(tmp, 'local');
  helper = path.join(tmp, 'helper');
  gitIn(tmp, 'init', '-q', '--bare', '-b', 'main', upstream);
  clone(helper);
  write(helper, 'app/package.json', 'base\n');
  write(helper, 'README', 'readme\n');
  gitIn(helper, 'add', '-A');
  gitIn(helper, 'commit', '-qm', 'base');
  gitIn(helper, 'push', '-q', 'origin', 'HEAD');
  clone(local);
  pushUpstream((d) => write(d, 'app/package.json', 'upstream\n'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('pullForce with plain local edits', () => {
  it('stash & retry saves the edits, pulls, and flags nothing', async () => {
    write(local, 'app/package.json', 'local\n');
    const blocked = await pull(local);
    expect(blocked.conflicts).toEqual(['app/package.json']);

    const res = await pullForce(local, ['app/package.json'], 'stash');
    expect(res).toEqual({ ok: true, stashed: true });
    expect(read('app/package.json')).toBe('upstream\n');
    expect(git('stash', 'list')).toContain('auto: pull');
    expect(git('stash', 'show', '-p')).toContain('+local');
    expect(tag('app/package.json')).toBe('H');
  });

  it('discard & retry drops the edits and pulls', async () => {
    write(local, 'app/package.json', 'local\n');
    const res = await pullForce(local, ['app/package.json'], 'discard');
    expect(res).toEqual({ ok: true, stashed: false });
    expect(read('app/package.json')).toBe('upstream\n');
    expect(git('stash', 'list')).toBe('');
  });

  it('refuses paths that escape the repo', async () => {
    const res = await pullForce(local, ['../outside'], 'stash');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/escapes the repo/);
  });
});

describe('pullForce with hidden local edits', () => {
  // Each flag hides the edits from status/stash/checkout, yet pull
  // still refuses to overwrite them. `ls-files -v` tag after restore.
  const cases = [
    { name: 'skip-worktree', flags: ['--skip-worktree'], tag: 'S' },
    { name: 'assume-unchanged', flags: ['--assume-unchanged'], tag: 'h' },
    { name: 'both flags', flags: ['--skip-worktree', '--assume-unchanged'], tag: 's' },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      beforeEach(async () => {
        for (const f of c.flags) git('update-index', f, '--', 'app/package.json');
        write(local, 'app/package.json', 'local\n');
        expect(tag('app/package.json')).toBe(c.tag);
        expect(git('status', '--porcelain')).toBe('');
        expect((await pull(local)).conflicts).toEqual(['app/package.json']);
      });

      it('stash & retry saves the edits, pulls, and re-hides the file', async () => {
        const res = await pullForce(local, ['app/package.json'], 'stash');
        expect(res).toEqual({ ok: true, stashed: true });
        expect(read('app/package.json')).toBe('upstream\n');
        expect(git('stash', 'show', '-p')).toContain('+local');
        expect(tag('app/package.json')).toBe(c.tag);
      });

      it('discard & retry drops the edits, pulls, and re-hides the file', async () => {
        const res = await pullForce(local, ['app/package.json'], 'discard');
        expect(res).toEqual({ ok: true, stashed: false });
        expect(read('app/package.json')).toBe('upstream\n');
        expect(git('stash', 'list')).toBe('');
        expect(tag('app/package.json')).toBe(c.tag);
      });
    });
  }

  it('only touches flags on the blocked paths', async () => {
    git('update-index', '--skip-worktree', '--', 'app/package.json');
    git('update-index', '--assume-unchanged', '--', 'README');
    write(local, 'app/package.json', 'local\n');
    const res = await pullForce(local, ['app/package.json'], 'stash');
    expect(res.ok).toBe(true);
    expect(tag('app/package.json')).toBe('S');
    expect(tag('README')).toBe('h');
  });

  it('restores the flag when the pull itself fails', async () => {
    git('update-index', '--skip-worktree', '--', 'app/package.json');
    write(local, 'app/package.json', 'local\n');
    git('remote', 'set-url', 'origin', path.join(tmp, 'missing.git'));
    const res = await pullForce(local, ['app/package.json'], 'stash');
    expect(res.ok).toBe(false);
    expect(res.stashed).toBe(true);
    expect(res.warning).toBeUndefined();
    expect(tag('app/package.json')).toBe('S');
  });

  it('stays quiet when the pull removes the flagged file', async () => {
    pushUpstream((d) => fs.rmSync(path.join(d, 'app/package.json')));
    git('update-index', '--skip-worktree', '--', 'app/package.json');
    write(local, 'app/package.json', 'local\n');
    const res = await pullForce(local, ['app/package.json'], 'discard');
    expect(res).toEqual({ ok: true, stashed: false });
    expect(git('ls-files', '--', 'app/package.json')).toBe('');
  });

  it('reports an error and no warning when the index is locked up front', async () => {
    git('update-index', '--skip-worktree', '--', 'app/package.json');
    write(local, 'app/package.json', 'local\n');
    fs.writeFileSync(path.join(local, '.git/index.lock'), '');
    const res = await pullForce(local, ['app/package.json'], 'stash');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/index\.lock/);
    expect(res.warning).toBeUndefined();
    fs.rmSync(path.join(local, '.git/index.lock'));
    expect(tag('app/package.json')).toBe('S');
    expect(read('app/package.json')).toBe('local\n');
  });
});

describe('hiddenIndexFlags', () => {
  it('returns only flagged paths, matching names literally', async () => {
    write(local, 'lib/[id].json', 'x\n');
    write(local, 'lib/a.json', 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'more');
    git('update-index', '--skip-worktree', '--', 'lib/[id].json');
    git('update-index', '--assume-unchanged', '--', 'README');
    const flags = await hiddenIndexFlags(local, ['lib/[id].json', 'lib/a.json', 'README', 'nope']);
    expect(flags).toEqual([
      { path: 'README', skipWorktree: false, assumeUnchanged: true },
      { path: 'lib/[id].json', skipWorktree: true, assumeUnchanged: false },
    ]);
  });
});

describe('restoreIndexFlags', () => {
  const flagged = [{ path: 'app/package.json', skipWorktree: true, assumeUnchanged: false }];

  it('re-applies a missing flag', async () => {
    expect(await restoreIndexFlags(local, flagged)).toBeNull();
    expect(tag('app/package.json')).toBe('S');
  });

  it('does nothing when the flag is already set, even with the index locked', async () => {
    git('update-index', '--skip-worktree', '--', 'app/package.json');
    fs.writeFileSync(path.join(local, '.git/index.lock'), '');
    expect(await restoreIndexFlags(local, flagged)).toBeNull();
  });

  it('warns with a copy-pasteable fix when git refuses', async () => {
    fs.writeFileSync(path.join(local, '.git/index.lock'), '');
    const warning = await restoreIndexFlags(local, [
      ...flagged,
      { path: 'my file.json', skipWorktree: false, assumeUnchanged: true },
    ]);
    // `my file.json` isn't in the index, so it's skipped.
    expect(warning).toContain("Couldn't re-hide app/package.json");
    expect(warning).toContain('git update-index --skip-worktree -- app/package.json');
    expect(warning).not.toContain('my file.json');
    expect(warning).toMatch(/index\.lock/);
    expect(tag('app/package.json')).toBe('H');
  });

  it('quotes paths that need it in the suggested command', async () => {
    write(local, 'my file.json', 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'spaced');
    fs.writeFileSync(path.join(local, '.git/index.lock'), '');
    const warning = await restoreIndexFlags(local, [
      { path: 'my file.json', skipWorktree: false, assumeUnchanged: true },
    ]);
    expect(warning).toContain("git update-index --assume-unchanged -- 'my file.json'");
  });
});
