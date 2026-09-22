import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fetch, parsePorcelainV2, rawDiff, run } from './git';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
};

const spawnMock = vi.mocked(spawn);

let tmp: string;
let repoPath: string;

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.killed = false;
  child.kill = vi.fn((signal?: string) => {
    if (signal === 'SIGKILL') child.killed = true;
    return true;
  });
  return child;
}

function closeChild(child: FakeChild, code: number, stdout = '', stderr = '') {
  if (stdout) child.stdout.emit('data', Buffer.from(stdout));
  if (stderr) child.stderr.emit('data', Buffer.from(stderr));
  child.emit('close', code);
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overgit-git-')));
  repoPath = path.join(tmp, 'repo');
  fs.mkdirSync(repoPath);
  fs.mkdirSync(path.join(repoPath, '.git'));
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.OVERGIT_TEST_RUN_KEEP;
  delete process.env.OVERGIT_TEST_RUN_OVERRIDE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('run', () => {
  it('captures stdout on a successful git command', async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child as never);

    const promise = run(repoPath, ['status']);
    await flushMicrotasks();
    closeChild(child, 0, 'ok\n');

    const result = await promise;
    expect(result).toEqual({
      ok: true,
      stdout: 'ok\n',
      stderr: '',
      code: 0,
    });
  });

  it('returns the exit code and stderr on failure', async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child as never);

    const promise = run(repoPath, ['status']);
    await flushMicrotasks();
    closeChild(child, 2, 'partial\n', 'fatal: nope\n');

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('partial\n');
    expect(result.stderr).toBe('fatal: nope\n');
  });

  it('merges envOverride into process.env for spawn', async () => {
    process.env.OVERGIT_TEST_RUN_KEEP = 'base';
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child as never);

    const promise = run(repoPath, ['status'], {
      OVERGIT_TEST_RUN_KEEP: 'override',
      OVERGIT_TEST_RUN_OVERRIDE: 'added',
    });
    await flushMicrotasks();

    const options = spawnMock.mock.calls[0]?.[2] as { cwd?: string; env?: Record<string, string> };
    expect(options.cwd).toBe(repoPath);
    expect(options.env?.OVERGIT_TEST_RUN_KEEP).toBe('override');
    expect(options.env?.OVERGIT_TEST_RUN_OVERRIDE).toBe('added');

    closeChild(child, 0);
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it('sends SIGTERM immediately and SIGKILL after the timeout fallback', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child as never);

    const promise = run(repoPath, ['fetch'], undefined, 5);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5);
    await expect(promise).resolves.toMatchObject({
      ok: false,
      code: null,
      stderr: 'git fetch timed out after 0s',
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(2000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('deletes a stale lock file and retries the command', async () => {
    const lockPath = path.join(repoPath, '.git', 'index.lock');
    fs.writeFileSync(lockPath, 'locked');
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(lockPath, old, old);

    const first = makeChild();
    const second = makeChild();
    spawnMock
      .mockImplementationOnce(() => first as never)
      .mockImplementationOnce(() => second as never);

    const promise = run(repoPath, ['status']);
    await flushMicrotasks();
    closeChild(first, 128, '', `Unable to create '${lockPath}': File exists\n`);
    await flushMicrotasks();

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    closeChild(second, 0, 'clean\n');
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('clean\n');
  });

  it('waits before retrying a fresh lock file', async () => {
    vi.useFakeTimers();
    const lockPath = path.join(repoPath, '.git', 'index.lock');
    fs.writeFileSync(lockPath, 'locked');

    const first = makeChild();
    const second = makeChild();
    spawnMock
      .mockImplementationOnce(() => first as never)
      .mockImplementationOnce(() => second as never);

    const promise = run(repoPath, ['status']);
    await flushMicrotasks();
    closeChild(first, 128, '', `Unable to create '${lockPath}': File exists\n`);
    await flushMicrotasks();

    expect(spawnMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(149);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(2);

    closeChild(second, 0, 'retry\n');
    await expect(promise).resolves.toMatchObject({ ok: true, stdout: 'retry\n' });
  });

  it('serializes concurrent writes for the same cwd', async () => {
    const first = makeChild();
    const second = makeChild();
    spawnMock
      .mockImplementationOnce(() => first as never)
      .mockImplementationOnce(() => second as never);

    const p1 = run(repoPath, ['commit', '-m', 'one']);
    const p2 = run(repoPath, ['commit', '-m', 'two']);

    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    closeChild(first, 0, 'first\n');
    await expect(p1).resolves.toMatchObject({ ok: true, stdout: 'first\n' });

    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(2);

    closeChild(second, 0, 'second\n');
    await expect(p2).resolves.toMatchObject({ ok: true, stdout: 'second\n' });
  });

  it('runs read-only commands for the same cwd concurrently', async () => {
    const first = makeChild();
    const second = makeChild();
    spawnMock
      .mockImplementationOnce(() => first as never)
      .mockImplementationOnce(() => second as never);

    const p1 = run(repoPath, ['status', '--porcelain=v1']);
    const p2 = run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);

    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(2);

    closeChild(first, 0, 'status\n');
    closeChild(second, 0, 'main\n');
    await expect(p1).resolves.toMatchObject({ stdout: 'status\n' });
    await expect(p2).resolves.toMatchObject({ stdout: 'main\n' });
  });

  it('classifies a mutating subcommand of a read-ish verb as a write', async () => {
    const first = makeChild();
    const second = makeChild();
    spawnMock
      .mockImplementationOnce(() => first as never)
      .mockImplementationOnce(() => second as never);

    const p1 = run(repoPath, ['worktree', 'prune', '--verbose']);
    const p2 = run(repoPath, ['worktree', 'list', '--porcelain']);

    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    closeChild(first, 0, 'pruned\n');
    await expect(p1).resolves.toMatchObject({ ok: true });

    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    closeChild(second, 0, 'listed\n');
    await expect(p2).resolves.toMatchObject({ stdout: 'listed\n' });
  });

  it('holds a write until in-flight reads finish', async () => {
    const read = makeChild();
    const write = makeChild();
    spawnMock
      .mockImplementationOnce(() => read as never)
      .mockImplementationOnce(() => write as never);

    const readPromise = run(repoPath, ['log', '-1']);
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const writePromise = run(repoPath, ['checkout', 'main']);
    await flushMicrotasks();
    // The write must wait — the reader still holds the repo.
    expect(spawnMock).toHaveBeenCalledTimes(1);

    closeChild(read, 0, 'commit\n');
    await expect(readPromise).resolves.toMatchObject({ ok: true });
    await flushMicrotasks();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    closeChild(write, 0, 'switched\n');
    await expect(writePromise).resolves.toMatchObject({ ok: true });
  });

  it('queues a later read behind a write that is still waiting', async () => {
    const read1 = makeChild();
    const write = makeChild();
    const read2 = makeChild();
    spawnMock
      .mockImplementationOnce(() => read1 as never)
      .mockImplementationOnce(() => write as never)
      .mockImplementationOnce(() => read2 as never);

    const p1 = run(repoPath, ['log', '-1']);
    await flushMicrotasks();
    const pWrite = run(repoPath, ['merge', 'other']);
    const p2 = run(repoPath, ['status', '--porcelain=v2']);
    await flushMicrotasks();
    // Only the first read has started: the write is waiting on it,
    // and the second read is waiting on the write.
    expect(spawnMock).toHaveBeenCalledTimes(1);

    closeChild(read1, 0, 'log\n');
    await expect(p1).resolves.toMatchObject({ ok: true });
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(2);

    closeChild(write, 0, 'merged\n');
    await expect(pWrite).resolves.toMatchObject({ ok: true });
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(3);

    closeChild(read2, 0, 'clean\n');
    await expect(p2).resolves.toMatchObject({ stdout: 'clean\n' });
  });

  it('disables optional index locking for read-only commands only', async () => {
    const reader = makeChild();
    spawnMock.mockImplementationOnce(() => reader as never);
    const readPromise = run(repoPath, ['status', '--porcelain=v1']);
    await flushMicrotasks();
    const readEnv = (spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> }).env;
    expect(readEnv?.GIT_OPTIONAL_LOCKS).toBe('0');
    closeChild(reader, 0);
    await readPromise;

    const writer = makeChild();
    spawnMock.mockImplementationOnce(() => writer as never);
    const writePromise = run(repoPath, ['add', '-A']);
    await flushMicrotasks();
    const writeEnv = (spawnMock.mock.calls[1]?.[2] as { env?: Record<string, string> }).env;
    expect(writeEnv?.GIT_OPTIONAL_LOCKS).toBeUndefined();
    closeChild(writer, 0);
    await writePromise;
  });
});

describe('fetch', () => {
  it('applies the network env overlay when fetching', async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child as never);

    const promise = fetch(repoPath);
    await flushMicrotasks();

    const options = spawnMock.mock.calls[0]?.[2] as { cwd?: string; env?: Record<string, string> };
    expect(options.cwd).toBe(repoPath);
    expect(options.env?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(options.env?.GIT_ASKPASS).toBe('true');
    expect(options.env?.SSH_ASKPASS).toBe('true');
    expect(options.env?.GIT_SSH_COMMAND).toContain('BatchMode=yes');

    closeChild(child, 0);
    await expect(promise).resolves.toEqual({ ok: true });
  });
});

describe('rawDiff', () => {
  const ADD_DIFF = [
    'diff --git a/dev/null b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+brand new',
    '',
  ].join('\n');

  // The queued children let a single rawDiff call drive several
  // sequential `run` invocations, which serialize per-cwd.
  function queueChildren() {
    spawnMock.mockImplementation(() => makeChild() as never);
  }

  async function nthChild(n: number): Promise<FakeChild> {
    for (let i = 0; i < 100 && spawnMock.mock.results.length < n; i++) {
      await flushMicrotasks();
    }
    return spawnMock.mock.results[n - 1].value as FakeChild;
  }

  function argsOf(n: number): string[] {
    return spawnMock.mock.calls[n - 1][1] as string[];
  }

  it('synthesizes an add diff for untracked paths', async () => {
    queueChildren();

    const promise = rawDiff(repoPath, 'working', ['new.txt']);

    // `git diff HEAD -- new.txt` sees nothing: the file is untracked.
    closeChild(await nthChild(1), 0, '');
    closeChild(await nthChild(2), 0, 'new.txt\0');
    // `--no-index` exits 1 when a difference exists, which is the norm here.
    closeChild(await nthChild(3), 1, ADD_DIFF);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.text).toBe(ADD_DIFF);

    expect(argsOf(2)).toEqual([
      'ls-files', '--others', '--exclude-standard', '-z', '--', 'new.txt',
    ]);
    expect(argsOf(3)).toEqual([
      'diff', '--no-index', '--no-color', '--', '/dev/null', 'new.txt',
    ]);
  });

  it('appends the add diff after tracked changes', async () => {
    queueChildren();
    const tracked = 'diff --git a/tracked.txt b/tracked.txt\n@@ -1 +1 @@\n-old\n+new\n';

    const promise = rawDiff(repoPath, 'working', ['tracked.txt', 'new.txt']);
    closeChild(await nthChild(1), 0, tracked);
    closeChild(await nthChild(2), 0, 'new.txt\0');
    closeChild(await nthChild(3), 1, ADD_DIFF);

    const result = await promise;
    expect(result.text).toBe(tracked + ADD_DIFF);
  });

  it('returns the tracked diff untouched when nothing is untracked', async () => {
    queueChildren();
    const tracked = 'diff --git a/tracked.txt b/tracked.txt\n@@ -1 +1 @@\n-old\n+new\n';

    const promise = rawDiff(repoPath, 'working', ['tracked.txt']);
    closeChild(await nthChild(1), 0, tracked);
    closeChild(await nthChild(2), 0, '');

    const result = await promise;
    expect(result.text).toBe(tracked);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('propagates a failure from the tracked diff', async () => {
    queueChildren();

    const promise = rawDiff(repoPath, 'working', ['new.txt']);
    closeChild(await nthChild(1), 128, '', 'fatal: bad revision\n');

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('fatal: bad revision');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('parsePorcelainV2', () => {
  it('reads branch, upstream and ahead/behind from the header lines', () => {
    const out = [
      '# branch.oid 1111111111111111111111111111111111111111',
      '# branch.head feature/login',
      '# branch.upstream origin/feature/login',
      '# branch.ab +3 -1',
      '',
    ].join('\n');

    expect(parsePorcelainV2(out)).toEqual({
      branch: 'feature/login',
      hasUpstream: true,
      ahead: 3,
      behind: 1,
      dirtyCount: 0,
      conflicts: [],
    });
  });

  it('reports a detached HEAD as no branch', () => {
    const out = ['# branch.oid 2222222222222222222222222222222222222222', '# branch.head (detached)'].join('\n');
    expect(parsePorcelainV2(out).branch).toBeNull();
  });

  it('leaves ahead/behind null when the upstream ref is gone', () => {
    // git prints the configured upstream but no `branch.ab` line when
    // the remote-tracking ref has been pruned.
    const out = ['# branch.head feature', '# branch.upstream origin/feature'].join('\n');
    const parsed = parsePorcelainV2(out);
    expect(parsed.hasUpstream).toBe(true);
    expect(parsed.ahead).toBeNull();
    expect(parsed.behind).toBeNull();
  });

  it('counts changed, renamed, unmerged and untracked entries as dirty', () => {
    const out = [
      '# branch.head main',
      '1 .M N... 100644 100644 100644 aaa bbb src/app.ts',
      '2 R. N... 100644 100644 100644 ccc ddd R100 new.ts\told.ts',
      'u UU N... 100644 100644 100644 100644 eee fff ggg conflicted.ts',
      '? untracked.ts',
      '! ignored.ts',
    ].join('\n');

    const parsed = parsePorcelainV2(out);
    expect(parsed.dirtyCount).toBe(4);
    expect(parsed.conflicts).toEqual(['conflicted.ts']);
  });

  it('keeps spaces in a conflicted path intact', () => {
    const out = [
      '# branch.head main',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc my notes.md',
    ].join('\n');
    // v1 porcelain quoted these; the raw path is what every caller
    // actually wants to hand back to git.
    expect(parsePorcelainV2(out).conflicts).toEqual(['my notes.md']);
  });
});
