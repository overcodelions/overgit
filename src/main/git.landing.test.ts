import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGitVersion, resolveDefaultRef, status, supportsMergeTree } from './git';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overgit-default-ref-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('commit', '--allow-empty', '-qm', 'root');
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('Landing Check git capability detection', () => {
  it('parses vendor git version strings', () => {
    expect(parseGitVersion('git version 2.40.0')).toMatchObject({ major: 2, minor: 40, patch: 0 });
    expect(parseGitVersion('git version 2.39.3 (Apple Git-145)')).toMatchObject({ major: 2, minor: 39, patch: 3 });
    expect(parseGitVersion('git version 2.45.0.windows.1')).toMatchObject({ major: 2, minor: 45, patch: 0 });
    expect(parseGitVersion('')).toBeNull();
    expect(parseGitVersion('not a version')).toBeNull();
  });

  it('requires Git 2.38 for merge-tree write-tree', () => {
    expect(supportsMergeTree({ major: 2, minor: 37, patch: 9, text: '2.37.9' })).toBe(false);
    expect(supportsMergeTree({ major: 2, minor: 34, patch: 1, text: '2.34.1' })).toBe(false);
    expect(supportsMergeTree({ major: 2, minor: 38, patch: 0, text: '2.38.0' })).toBe(true);
    expect(supportsMergeTree({ major: 2, minor: 40, patch: 0, text: '2.40.0' })).toBe(true);
    expect(supportsMergeTree({ major: 3, minor: 0, patch: 0, text: '3.0.0' })).toBe(true);
    expect(supportsMergeTree(null)).toBe(false);
  });
});

describe('default-ref resolution shared by status and Landing Check', () => {
  it('prefers origin/default when remote and local default refs both exist', async () => {
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(await resolveDefaultRef(repo, 'main')).toBe('origin/main');
  });

  it('falls back to the local default ref and returns null when neither exists', async () => {
    git('update-ref', '-d', 'refs/remotes/origin/main');
    expect(await resolveDefaultRef(repo, 'main')).toBe('main');
    expect(await resolveDefaultRef(repo, 'nope')).toBeNull();
  });

  it('keeps status default comparison off the default branch only', async () => {
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-qb', 'feature/status');
    git('commit', '--allow-empty', '-qm', 'feature');
    const feature = await status('repo', repo, 'main');
    expect(feature).toMatchObject({ defaultRef: 'origin/main', aheadDefault: 1, behindDefault: 0 });
    git('checkout', '-q', 'main');
    const main = await status('repo', repo, 'main');
    expect(main.defaultRef).toBeNull();
  });
});
