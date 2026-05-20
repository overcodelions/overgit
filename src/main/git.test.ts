import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fetch, run } from './git';

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

  it('serializes concurrent calls for the same cwd', async () => {
    const first = makeChild();
    const second = makeChild();
    spawnMock
      .mockImplementationOnce(() => first as never)
      .mockImplementationOnce(() => second as never);

    const p1 = run(repoPath, ['status']);
    const p2 = run(repoPath, ['status']);

    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    closeChild(first, 0, 'first\n');
    await expect(p1).resolves.toMatchObject({ ok: true, stdout: 'first\n' });

    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(2);

    closeChild(second, 0, 'second\n');
    await expect(p2).resolves.toMatchObject({ ok: true, stdout: 'second\n' });
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
