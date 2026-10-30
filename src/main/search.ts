// Cross-repo search. Fans `git grep` (tracked file contents) or
// `git log --grep` (commit messages) out over a workspace's or a
// workset's members. Read-only, and streamed: each repo's output is
// cut off at a hit cap so a one-letter query over a monorepo can't
// buffer hundreds of megabytes the way a plain `run()` would.

import { spawn } from 'node:child_process';
import { resolveCommit } from './git';
import {
  Repo,
  RepoSearchMode,
  RepoSearchResult,
  SearchCodeHit,
  SearchCommitHit,
  UUID,
} from '../shared/types';

/// Hits kept per repo. Enough to scan by eye; past this the renderer
/// says "more not shown" and the user narrows the query.
export const MAX_HITS_PER_REPO = 100;
/// Matched lines longer than this are clipped — minified bundles
/// otherwise turn one hit into a screen of text.
const MAX_LINE_CHARS = 300;
const SEARCH_TIMEOUT_MS = 15_000;
const SEARCH_FANOUT = 4;

/// Hex strings this long or longer are tried as commit SHAs. Four is
/// git's own minimum abbreviation.
const SHA_QUERY = /^[0-9a-f]{4,40}$/i;

/// Parse one `git grep -z -n` record: `path\0line\0text`.
export function parseGrepLine(raw: string): SearchCodeHit | null {
  const a = raw.indexOf('\0');
  if (a === -1) return null;
  const b = raw.indexOf('\0', a + 1);
  if (b === -1) return null;
  const line = Number.parseInt(raw.slice(a + 1, b), 10);
  if (!Number.isFinite(line)) return null;
  const text = raw.slice(b + 1);
  return {
    path: raw.slice(0, a),
    line,
    text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text,
  };
}

/// Parse one `git log` record in the `%H %h %s %an %aI` (0x1f-separated) format.
export function parseCommitLine(raw: string): SearchCommitHit | null {
  const [sha, shortSha, subject, author, date] = raw.split('\x1f');
  if (!sha || !shortSha) return null;
  return { sha, shortSha, subject: subject ?? '', author: author ?? '', date: date ?? '' };
}

/// Run git and hand each stdout line to `onLine` until it returns
/// false, then stop the child. Resolves with whether we stopped early
/// and any stderr. `git grep` exits 1 for "no matches", which isn't an
/// error, so the caller only sees stderr when git actually complained.
function streamLines(
  cwd: string,
  args: string[],
  onLine: (line: string) => boolean,
): Promise<{ stopped: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    let buf = '';
    let stderr = '';
    let stopped = false;
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stopped, error });
    };
    const stop = () => {
      stopped = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(() => {
      stop();
      finish(`Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s`);
    }, SEARCH_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => {
      if (stopped) return;
      buf += b.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line && !onLine(line)) {
          stop();
          return;
        }
        nl = buf.indexOf('\n');
      }
    });
    child.stderr.on('data', (b: Buffer) => {
      if (stderr.length < 4096) stderr += b.toString('utf8');
    });
    child.on('error', (err) => finish(String(err)));
    child.on('close', (code) => {
      if (!stopped && buf) onLine(buf);
      // Exit 1 with nothing on stderr is grep's "no matches".
      finish(code && code > 1 && !stopped ? stderr.trim() || `git exited ${code}` : undefined);
    });
  });
}

export interface SearchOptions {
  /// Commits mode: drop merge commits from the message search. A SHA
  /// match is still shown, since the user asked for that exact commit.
  noMerges?: boolean;
}

async function searchRepo(
  repo: Repo,
  query: string,
  mode: RepoSearchMode,
  caseSensitive: boolean,
  opts: SearchOptions,
): Promise<RepoSearchResult> {
  const result: RepoSearchResult = { repoId: repo.id, code: [], commits: [], truncated: false };
  let res: { stopped: boolean; error?: string };
  if (mode === 'code') {
    const args = ['grep', '-n', '-z', '-I', '--no-color', '--full-name', '-F'];
    if (!caseSensitive) args.push('-i');
    args.push('-e', query);
    res = await streamLines(repo.path, args, (line) => {
      const hit = parseGrepLine(line);
      if (hit) result.code.push(hit);
      return result.code.length < MAX_HITS_PER_REPO;
    });
  } else {
    // A hex query might be a SHA: resolve it and put that commit first,
    // ahead of any messages that merely mention it.
    if (SHA_QUERY.test(query)) {
      const sha = await resolveCommit(repo.path, query);
      if (sha) {
        await streamLines(
          repo.path,
          ['log', '-1', '--no-walk', '--no-color', '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI', sha],
          (line) => {
            const hit = parseCommitLine(line);
            if (hit) result.commits.push(hit);
            return false;
          },
        );
      }
    }
    const bySha = new Set(result.commits.map((c) => c.sha));
    const args = [
      'log',
      '--all',
      `-${MAX_HITS_PER_REPO + 1}`,
      '--no-color',
      '-F',
      `--grep=${query}`,
      '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI',
    ];
    if (!caseSensitive) args.push('-i');
    if (opts.noMerges) args.push('--no-merges');
    res = await streamLines(repo.path, args, (line) => {
      const hit = parseCommitLine(line);
      if (hit && !bySha.has(hit.sha)) result.commits.push(hit);
      return result.commits.length <= MAX_HITS_PER_REPO;
    });
    // Asked for one past the cap so "exactly 100" and "more than 100"
    // read differently.
    if (result.commits.length > MAX_HITS_PER_REPO) {
      result.commits.length = MAX_HITS_PER_REPO;
      result.truncated = true;
    }
  }
  if (mode === 'code' && res.stopped && !res.error) result.truncated = true;
  if (res.error) result.error = res.error;
  return result;
}

/// Search every repo in `repoIds`, in their given order. Bounded
/// fan-out: grep is CPU- and disk-heavy, so a 20-repo workspace
/// running all at once would stall the status polls behind it.
export async function searchRepos(
  repoIds: UUID[],
  repos: Repo[],
  query: string,
  mode: RepoSearchMode,
  caseSensitive: boolean,
  opts: SearchOptions = {},
): Promise<RepoSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const byId = new Map(repos.map((r) => [r.id, r] as const));
  const members = repoIds.map((id) => byId.get(id)).filter((r): r is Repo => Boolean(r));
  const out: RepoSearchResult[] = new Array(members.length);
  let next = 0;
  const worker = async () => {
    while (next < members.length) {
      const i = next++;
      out[i] = await searchRepo(members[i], q, mode, caseSensitive, opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEARCH_FANOUT, members.length) }, worker));
  return out;
}
