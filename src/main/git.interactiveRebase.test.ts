import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRebaseTodo,
  interactiveRebase,
  interactiveRebasePlan,
  showCommitForLlm,
} from './git';
import { isNoopRebase, validateRebaseSteps } from '../shared/rebase';
import type { RebaseStep } from '../shared/types';

let root: string;
let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const commit = (file: string, content: string, msg: string) => {
  fs.writeFileSync(path.join(repo, file), content);
  git('add', '.');
  git('commit', '-qm', msg);
};
const subjects = () => git('log', '--format=%s', 'base..HEAD').trim().split('\n').reverse();

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overgit-rebase-i-')));
  repo = path.join(root, 'repo with space');
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  // A user's global editor must never be opened.
  git('config', 'core.editor', 'false');
  commit('base.txt', 'base\n', 'base');
  git('tag', 'base');
  commit('a.txt', 'a\n', 'add a');
  commit('b.txt', 'b\n', 'add b');
  commit('c.txt', 'c\n', 'add c');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function stepsFor(): Promise<RebaseStep[]> {
  const plan = await interactiveRebasePlan(repo, 'base');
  if (!plan.ok) throw new Error(plan.error);
  return plan.commits.map((c) => ({ sha: c.sha, action: 'pick' as const }));
}

describe('interactiveRebasePlan', () => {
  it('lists commits after base, oldest first, with full messages', async () => {
    const plan = await interactiveRebasePlan(repo, 'base');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.branch).toBe('main');
    expect(plan.commits.map((c) => c.subject)).toEqual(['add a', 'add b', 'add c']);
    expect(plan.commits.every((c) => !c.pushed)).toBe(true);
  });

  it('refuses a base that is not in the branch history', async () => {
    git('switch', '-qc', 'other', 'base');
    commit('o.txt', 'o\n', 'other');
    const sha = git('rev-parse', 'HEAD').trim();
    git('switch', '-q', 'main');
    const plan = await interactiveRebasePlan(repo, sha);
    expect(plan.ok).toBe(false);
  });

  it('refuses ranges with merge commits', async () => {
    git('switch', '-qc', 'side', 'base');
    commit('s.txt', 's\n', 'side');
    git('switch', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    const plan = await interactiveRebasePlan(repo, 'base');
    expect(plan.ok).toBe(false);
  });

  it('marks commits already on the upstream as pushed', async () => {
    const remote = path.join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git('remote', 'add', 'origin', remote);
    git('push', '-q', '-u', 'origin', 'HEAD~1:refs/heads/main');
    git('branch', '-q', '--set-upstream-to=origin/main');
    const plan = await interactiveRebasePlan(repo, 'base');
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.commits.map((c) => c.pushed)).toEqual([true, true, false]);
  });
});

describe('interactiveRebase', () => {
  it('reorders, squashes, fixes up and drops', async () => {
    commit('d.txt', 'd\n', 'add d');
    const [a, b, c, d] = await stepsFor();
    const res = await interactiveRebase(repo, 'base', [
      { ...c, action: 'pick' },
      { ...a, action: 'squash' },
      { ...b, action: 'drop' },
      { ...d, action: 'fixup' },
    ]);
    expect(res).toEqual({ ok: true, stopped: false });
    expect(subjects()).toEqual(['add c']);
    const msg = git('log', '-1', '--format=%B');
    expect(msg).toContain('add c');
    expect(msg).toContain('add a');
    expect(msg).not.toContain('add d');
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'd.txt'))).toBe(true);
  });

  it('rewords without opening an editor, keeping quotes and newlines', async () => {
    const [a, b, c] = await stepsFor();
    const message = `feat: it's "quoted" $HOME \`x\`\n\nbody line`;
    const res = await interactiveRebase(repo, 'base', [a, { ...b, action: 'reword', message }, c]);
    expect(res).toEqual({ ok: true, stopped: false });
    expect(subjects()).toEqual(['add a', `feat: it's "quoted" $HOME \`x\``, 'add c']);
    expect(git('log', '-1', '--format=%B', 'HEAD~1').trim()).toBe(message);
  });

  it('pauses on a conflict and leaves the rebase in progress', async () => {
    commit('a.txt', 'a2\n', 'edit a');
    const [addA, b, c, editA] = await stepsFor();
    // Moving "edit a" before "add a" can't apply cleanly.
    const res = await interactiveRebase(repo, 'base', [editA, addA, b, c]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stopped).toBe(true);
    expect(fs.existsSync(path.join(repo, '.git', 'rebase-merge'))).toBe(true);
    git('rebase', '--abort');
  });

  it('refuses to run with uncommitted changes', async () => {
    const steps = await stepsFor();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty\n');
    const res = await interactiveRebase(repo, 'base', [steps[1], steps[0], steps[2]]);
    expect(res.ok).toBe(false);
  });

  it('rejects step lists that do not match the branch', async () => {
    const [a, b] = await stepsFor();
    const res = await interactiveRebase(repo, 'base', [a, b]);
    expect(res.ok).toBe(false);
  });
});

describe('validateRebaseSteps / isNoopRebase / buildRebaseTodo', () => {
  const planned = ['1', '2', '3'];
  const s = (sha: string, action: RebaseStep['action'], message?: string): RebaseStep => ({
    sha,
    action,
    message,
  });

  it('rejects squashing the first kept commit, even after drops', () => {
    expect(validateRebaseSteps(planned, [s('1', 'drop'), s('2', 'fixup'), s('3', 'pick')])).toMatch(
      /first kept commit/,
    );
  });

  it('rejects dropping everything and empty rewords', () => {
    expect(validateRebaseSteps(planned, planned.map((x) => s(x, 'drop')))).toBeTruthy();
    expect(validateRebaseSteps(planned, [s('1', 'reword', '  '), s('2', 'pick'), s('3', 'pick')])).toBeTruthy();
  });

  it('rejects duplicates and accepts valid plans', () => {
    expect(validateRebaseSteps(planned, [s('1', 'pick'), s('1', 'pick'), s('3', 'pick')])).toBeTruthy();
    expect(validateRebaseSteps(planned, [s('2', 'pick'), s('1', 'squash'), s('3', 'drop')])).toBeNull();
  });

  it('detects a no-op plan', () => {
    expect(isNoopRebase(planned, planned.map((x) => s(x, 'pick')))).toBe(true);
    expect(isNoopRebase(planned, [s('2', 'pick'), s('1', 'pick'), s('3', 'pick')])).toBe(false);
  });

  it('turns reword into pick + exec amend from a quoted file', () => {
    const todo = buildRebaseTodo([s('1', 'pick'), s('2', 'reword', 'x')], (i) => `/tmp/it's/m-${i}`);
    expect(todo.split('\n')).toEqual([
      'pick 1',
      'pick 2',
      `exec git commit --amend --allow-empty --no-verify --cleanup=strip -F '/tmp/it'\\''s/m-1'`,
      '',
    ]);
  });
});

describe('showCommitForLlm', () => {
  it('returns the patch for a commit and rejects non-SHAs', async () => {
    const sha = git('rev-parse', 'HEAD').trim();
    const res = await showCommitForLlm(repo, sha);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('add c');
    expect(res.text).toContain('+c');
    expect((await showCommitForLlm(repo, '--output=/tmp/x')).ok).toBe(false);
  });
});
