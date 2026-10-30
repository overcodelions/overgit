import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_HITS_PER_REPO, parseCommitLine, parseGrepLine, searchRepos } from './search';
import type { Repo } from '../shared/types';

describe('parseGrepLine', () => {
  it('splits a -z -n record', () => {
    expect(parseGrepLine('src/a:b.ts\u000012\u0000  const x = 1;')).toEqual({
      path: 'src/a:b.ts',
      line: 12,
      text: '  const x = 1;',
    });
  });

  it('rejects malformed records', () => {
    expect(parseGrepLine('no separators')).toBeNull();
    expect(parseGrepLine('a\u0000nope\u0000text')).toBeNull();
  });

  it('clips very long lines', () => {
    const hit = parseGrepLine(`min.js\u00001\u0000${'x'.repeat(5000)}`);
    expect(hit!.text.length).toBeLessThan(400);
    expect(hit!.text.endsWith('…')).toBe(true);
  });
});

describe('parseCommitLine', () => {
  it('reads the 0x1f-separated fields', () => {
    expect(parseCommitLine('abc123\x1fabc\x1ffix: thing\x1fAcme Dev\x1f2026-01-02T03:04:05Z')).toEqual({
      sha: 'abc123',
      shortSha: 'abc',
      subject: 'fix: thing',
      author: 'Acme Dev',
      date: '2026-01-02T03:04:05Z',
    });
  });
});

describe('searchRepos', () => {
  let tmp: string;
  let repos: Repo[];

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Acme Dev',
        GIT_AUTHOR_EMAIL: 'dev@acme.test',
        GIT_COMMITTER_NAME: 'Acme Dev',
        GIT_COMMITTER_EMAIL: 'dev@acme.test',
      },
    });

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overgit-search-'));
    const mk = (name: string, files: Record<string, string>, message: string): Repo => {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir);
      git(dir, 'init', '-q');
      for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', message);
      return { id: name, name, path: dir } as Repo;
    };
    repos = [
      mk('api', { 'rate.ts': 'export const RateLimit = 10;\n' }, 'feat: add RateLimit'),
      mk('web', { 'app.ts': 'import { ratelimit } from "x";\n' }, 'chore: init'),
      mk('many', { 'big.txt': 'needle\n'.repeat(MAX_HITS_PER_REPO + 20) }, 'chore: big'),
    ];
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('finds code case-insensitively across repos, in member order', async () => {
    const res = await searchRepos(['api', 'web'], repos, 'ratelimit', 'code', false);
    expect(res.map((r) => r.repoId)).toEqual(['api', 'web']);
    expect(res[0].code[0]).toMatchObject({ path: 'rate.ts', line: 1 });
    expect(res[1].code).toHaveLength(1);
    expect(res.every((r) => !r.error)).toBe(true);
  });

  it('respects match case', async () => {
    const res = await searchRepos(['api', 'web'], repos, 'RateLimit', 'code', true);
    expect(res[0].code).toHaveLength(1);
    expect(res[1].code).toHaveLength(0);
    expect(res[1].error).toBeUndefined();
  });

  it('treats the query as literal text', async () => {
    const res = await searchRepos(['api'], repos, 'RateLimit = 1.', 'code', true);
    expect(res[0].code).toHaveLength(0);
  });

  it('caps hits per repo and flags truncation', async () => {
    const [r] = await searchRepos(['many'], repos, 'needle', 'code', false);
    expect(r.code).toHaveLength(MAX_HITS_PER_REPO);
    expect(r.truncated).toBe(true);
  });

  it('searches commit messages', async () => {
    const res = await searchRepos(['api', 'web'], repos, 'ratelimit', 'commits', false);
    expect(res[0].commits.map((c) => c.subject)).toEqual(['feat: add RateLimit']);
    expect(res[1].commits).toHaveLength(0);
  });

  it('finds a commit by full or abbreviated SHA', async () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repos[1].path }).toString().trim();
    for (const q of [sha, sha.slice(0, 7), sha.slice(0, 7).toUpperCase()]) {
      const res = await searchRepos(['api', 'web'], repos, q, 'commits', false);
      expect(res[1].commits.map((c) => c.sha)).toEqual([sha]);
      expect(res[0].commits).toHaveLength(0);
      expect(res[1].error).toBeUndefined();
    }
  });

  it('lists a SHA match once even when a message also mentions it', async () => {
    const dir = repos[0].path;
    const target = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    git(dir, 'commit', '-q', '--allow-empty', '-m', `revert ${target.slice(0, 10)}`);
    const [r] = await searchRepos(['api'], repos, target.slice(0, 10), 'commits', false);
    expect(r.commits[0].sha).toBe(target);
    expect(r.commits.map((c) => c.subject)).toEqual(['feat: add RateLimit', `revert ${target.slice(0, 10)}`]);
  });

  it('can leave merge commits out of a message search', async () => {
    const dir = repos[1].path;
    git(dir, 'checkout', '-q', '-b', 'side');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'side work');
    git(dir, 'checkout', '-q', '-');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'Merged in side work', 'side');
    const all = await searchRepos(['web'], repos, 'side work', 'commits', false);
    expect(all[0].commits.map((c) => c.subject)).toEqual(['Merged in side work', 'side work']);
    const noMerges = await searchRepos(['web'], repos, 'side work', 'commits', false, { noMerges: true });
    expect(noMerges[0].commits.map((c) => c.subject)).toEqual(['side work']);
  });

  it('returns nothing for a blank query', async () => {
    expect(await searchRepos(['api'], repos, '   ', 'code', false)).toEqual([]);
  });
});
