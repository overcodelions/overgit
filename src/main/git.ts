// Thin wrapper around the `git` CLI. Overgit deliberately doesn't use a
// libgit2 binding — shelling out keeps overgit a pure overlay: every
// operation we perform is something the user could run themselves in a
// terminal, and any tool watching the repo (gh, jj, an IDE) sees the
// same end state.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ChangedFile,
  CheckoutOutcome,
  Commit,
  FileDiff,
  RepoChanges,
  RepoStatus,
  UUID,
} from '../shared/types';

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, stdout, stderr, code });
    });
    child.on('error', (err) => {
      resolve({ ok: false, stdout, stderr: stderr || String(err), code: null });
    });
  });
}

/// Sanity check before we record a path as a repo: it must exist and
/// have a .git entry (directory for normal repos, file for worktrees).
export function looksLikeRepo(repoPath: string): boolean {
  try {
    const dotGit = path.join(repoPath, '.git');
    return fs.existsSync(dotGit);
  } catch {
    return false;
  }
}

export async function status(repoId: UUID, repoPath: string): Promise<RepoStatus> {
  if (!looksLikeRepo(repoPath)) {
    return { repoId, branch: null, dirtyCount: 0, ahead: null, behind: null, error: 'Not a git repo' };
  }

  const branchRes = await run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const rawBranch = branchRes.stdout.trim();
  // `rev-parse --abbrev-ref HEAD` prints "HEAD" when the working tree is
  // detached. Treat that as no branch so the UI doesn't render a
  // misleading "on branch HEAD".
  const branch = rawBranch && rawBranch !== 'HEAD' ? rawBranch : null;

  const porcelainRes = await run(repoPath, ['status', '--porcelain=v1']);
  const dirtyCount = porcelainRes.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0).length;

  let ahead: number | null = null;
  let behind: number | null = null;
  if (branch) {
    // `rev-list --left-right --count @{u}...HEAD` prints "<behind>\t<ahead>"
    // when an upstream is configured, and exits non-zero otherwise. The
    // non-zero case is normal (no upstream tracking) — just leave the
    // counts null rather than surfacing it as an error.
    const upstreamRes = await run(repoPath, [
      'rev-list',
      '--left-right',
      '--count',
      '@{u}...HEAD',
    ]);
    if (upstreamRes.ok) {
      const [b, a] = upstreamRes.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
      if (Number.isFinite(b) && Number.isFinite(a)) {
        behind = b;
        ahead = a;
      }
    }
  }

  return { repoId, branch, dirtyCount, ahead, behind };
}

export async function listBranches(
  repoPath: string,
): Promise<{ local: string[]; remote: string[] }> {
  const local: string[] = [];
  const remote: string[] = [];
  if (!looksLikeRepo(repoPath)) return { local, remote };

  const localRes = await run(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (localRes.ok) {
    for (const line of localRes.stdout.split('\n')) {
      const name = line.trim();
      if (name) local.push(name);
    }
  }

  const remoteRes = await run(repoPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/remotes',
  ]);
  if (remoteRes.ok) {
    for (const line of remoteRes.stdout.split('\n')) {
      const name = line.trim();
      // Skip "origin/HEAD -> origin/main" alias entries; for-each-ref
      // doesn't expand the arrow, but the alias itself shows up as
      // "origin/HEAD" which is never useful for switching to.
      if (name && !name.endsWith('/HEAD')) remote.push(name);
    }
  }

  return { local, remote };
}

/// Try to switch a single repo to `branch`. The four shapes we report
/// each map to a real, distinct user remediation in the UI:
/// - `switched`: nothing more to do
/// - `already-on-branch`: same — but worth telling the user we no-op'd
/// - `missing-branch`: offer to create it (or skip)
/// - `dirty`: offer to stash, commit, or skip
/// - `error`: surface git's stderr
export async function checkoutBranch(
  repoId: UUID,
  repoPath: string,
  branch: string,
  createIfMissing: boolean,
): Promise<CheckoutOutcome> {
  if (!looksLikeRepo(repoPath)) {
    return { repoId, result: 'error', branch, message: 'Not a git repo' };
  }

  const head = await run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.ok && head.stdout.trim() === branch) {
    return { repoId, result: 'already-on-branch', branch };
  }

  // `show-ref --verify --quiet refs/heads/<branch>` is the cheapest
  // existence test for a local branch. Falls back to a remote-tracking
  // ref so the user can switch to a branch they've fetched but not yet
  // checked out locally.
  const localExists = await run(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  const remoteExists = await run(repoPath, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}`,
  ]);

  if (!localExists.ok && !remoteExists.ok) {
    if (!createIfMissing) {
      return { repoId, result: 'missing-branch', branch };
    }
    const create = await run(repoPath, ['checkout', '-b', branch]);
    if (create.ok) return { repoId, result: 'switched', branch };
    return classifyFailure(repoId, branch, create);
  }

  // `git switch` refuses to clobber local changes; that's exactly what we
  // want. We use `switch` over `checkout` so the dirty-tree case is
  // unambiguous: switch never silently merges, while plain `checkout`
  // sometimes does.
  const switchRes = localExists.ok
    ? await run(repoPath, ['switch', branch])
    : await run(repoPath, ['switch', '--track', branch, '-c', branch]);
  if (switchRes.ok) return { repoId, result: 'switched', branch };
  return classifyFailure(repoId, branch, switchRes);
}

function classifyFailure(repoId: UUID, branch: string, r: RunResult): CheckoutOutcome {
  const text = `${r.stdout}\n${r.stderr}`.toLowerCase();
  // Git's "would be overwritten by checkout" / "local changes" messages
  // are stable enough to pattern-match — the alternative is parsing
  // porcelain status, which is the same information at higher cost.
  if (
    text.includes('would be overwritten') ||
    text.includes('local changes') ||
    text.includes('uncommitted changes')
  ) {
    return { repoId, result: 'dirty', branch, message: r.stderr.trim() };
  }
  return { repoId, result: 'error', branch, message: r.stderr.trim() || `git exited ${r.code}` };
}

export async function fetch(repoPath: string): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const res = await run(repoPath, ['fetch', '--all', '--prune']);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git exited ${res.code}` };
}

/// We use ASCII unit-separator (\x1f) as the field delimiter and
/// record-separator (\x1e) as the line delimiter so commit subjects with
/// commas or pipes don't corrupt the parse. Both are forbidden in author
/// names/emails per RFC 5322 norms and don't appear in real subjects.
const LOG_FORMAT = '%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%aI%x1e';

export async function log(repoPath: string, limit = 50): Promise<Commit[]> {
  if (!looksLikeRepo(repoPath)) return [];
  const res = await run(repoPath, [
    'log',
    `-${Math.max(1, Math.min(limit, 1000))}`,
    `--pretty=format:${LOG_FORMAT}`,
  ]);
  if (!res.ok) return [];
  const out: Commit[] = [];
  for (const record of res.stdout.split('\x1e')) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [sha, shortSha, parents, subject, author, authorEmail, date] = trimmed.split('\x1f');
    if (!sha) continue;
    out.push({
      sha,
      shortSha: shortSha ?? sha.slice(0, 7),
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      subject: subject ?? '',
      author: author ?? '',
      authorEmail: authorEmail ?? '',
      date: date ?? '',
    });
  }
  return out;
}

/// Split a unified diff into per-file blocks. Git always emits each file
/// block starting with `diff --git a/x b/y`, so we cut on those lines and
/// keep the leading `diff --git` line attached to its own block.
function splitDiff(raw: string): string[] {
  if (!raw) return [];
  const blocks: string[] = [];
  let current = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) blocks.push(current);
      current = line + '\n';
    } else {
      current += line + '\n';
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/// Pull the file path + status from one per-file diff block. We prefer
/// the `+++ b/<path>` line (post-rename, post-add) and fall back to the
/// `diff --git` header so deletes and pure renames still get a path.
function parseFileBlock(block: string): FileDiff {
  const lines = block.split('\n');
  const header = lines[0] ?? '';
  let path = '';
  let status: FileDiff['status'] = 'M';

  // `+++ /dev/null` means delete; `--- /dev/null` means add.
  let plusPath: string | null = null;
  let minusPath: string | null = null;
  for (const l of lines.slice(0, 12)) {
    if (l.startsWith('+++ ')) plusPath = l.slice(4).trim();
    else if (l.startsWith('--- ')) minusPath = l.slice(4).trim();
  }

  if (plusPath && plusPath !== '/dev/null') {
    path = plusPath.replace(/^b\//, '');
  } else if (minusPath && minusPath !== '/dev/null') {
    path = minusPath.replace(/^a\//, '');
  } else {
    // Fall through to diff --git a/<x> b/<y>
    const m = header.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (m) path = m[2];
  }

  if (lines.some((l) => l.startsWith('new file'))) status = 'A';
  else if (lines.some((l) => l.startsWith('deleted file'))) status = 'D';
  else if (lines.some((l) => l.startsWith('rename from'))) status = 'R';
  else if (lines.some((l) => l.startsWith('copy from'))) status = 'C';
  else status = 'M';

  return { path: path || '?', status, body: block };
}

export async function diff(
  repoPath: string,
  sha?: string,
): Promise<FileDiff[]> {
  if (!looksLikeRepo(repoPath)) return [];
  // For a specific commit, `git show` gives the full diff with the
  // commit message prepended — strip that. Without a sha, `diff HEAD`
  // covers staged + unstaged so the user sees one consolidated working
  // change rather than two separate panes.
  const args = sha
    ? ['show', '--no-color', '--format=', sha]
    : ['diff', '--no-color', 'HEAD'];
  const res = await run(repoPath, args);
  if (!res.ok) return [];
  return splitDiff(res.stdout).map(parseFileBlock);
}

export async function stash(
  repoPath: string,
  message?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  // `--include-untracked` so untracked files (a common source of "dirty"
  // blocks during a workspace checkout) are stashed instead of being
  // left behind to fail the next switch.
  const args = ['stash', 'push', '--include-untracked'];
  if (message?.trim()) args.push('-m', message.trim());
  const res = await run(repoPath, args);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git exited ${res.code}` };
}

export async function commitAll(
  repoPath: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!message.trim()) return { ok: false, error: 'Commit message required' };
  // Stage everything (including deletes and untracked) then commit. We
  // use two steps rather than `commit -a` because -a doesn't pick up
  // untracked files, which is the common case for a "save my dirty
  // tree before switching" affordance.
  const addRes = await run(repoPath, ['add', '-A']);
  if (!addRes.ok) {
    return { ok: false, error: addRes.stderr.trim() || `git add exited ${addRes.code}` };
  }
  const commitRes = await run(repoPath, ['commit', '-m', message.trim()]);
  if (commitRes.ok) return { ok: true };
  return { ok: false, error: commitRes.stderr.trim() || `git commit exited ${commitRes.code}` };
}

/// Parse `git status --porcelain=v1 -z`. The `-z` form uses NUL as the
/// record separator AND emits rename pairs as two NUL-separated entries
/// in a row, which is the only way to handle paths with newlines or
/// quotes correctly. Each record starts with a 2-char code (X then Y),
/// a space, then the path; renames consume an extra record for the orig.
export async function changes(repoPath: string): Promise<RepoChanges> {
  if (!looksLikeRepo(repoPath)) return { staged: [], unstaged: [] };
  const res = await run(repoPath, ['status', '--porcelain=v1', '-z']);
  if (!res.ok) return { staged: [], unstaged: [] };

  const records = res.stdout.split('\0').filter((r) => r.length > 0);
  const staged: ChangedFile[] = [];
  const unstaged: ChangedFile[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    if (rec.length < 3) continue;
    const indexStatus = rec[0];
    const worktreeStatus = rec[1];
    const path = rec.slice(3);
    let origPath: string | undefined;
    // `R` (rename) and `C` (copy) on the index side carry the original
    // path in the very next NUL-delimited record. Consume it.
    if (indexStatus === 'R' || indexStatus === 'C') {
      origPath = records[i + 1];
      i += 1;
    }
    const file: ChangedFile = { path, indexStatus, worktreeStatus, origPath };
    // Untracked entries print as "??" — those are unstaged-only.
    if (indexStatus === '?' && worktreeStatus === '?') {
      unstaged.push(file);
      continue;
    }
    if (indexStatus !== ' ' && indexStatus !== '?') staged.push(file);
    if (worktreeStatus !== ' ' && worktreeStatus !== '?') unstaged.push(file);
  }
  return { staged, unstaged };
}

export async function stageFiles(
  repoPath: string,
  paths: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (paths.length === 0) return { ok: true };
  // `--` so paths starting with `-` aren't parsed as flags.
  const res = await run(repoPath, ['add', '--', ...paths]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git add exited ${res.code}` };
}

export async function unstageFiles(
  repoPath: string,
  paths: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (paths.length === 0) return { ok: true };
  // `git restore --staged` is the modern unstage; falls back to `reset`
  // semantics on older gits. We don't try to fall back automatically —
  // git 2.23+ has been out long enough that it's reasonable to require.
  const res = await run(repoPath, ['restore', '--staged', '--', ...paths]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git restore exited ${res.code}` };
}

/// Discard worktree changes. For tracked-but-modified files this is
/// `git restore --worktree --staged` (resets both sides to HEAD). For
/// untracked files, restore won't touch them — we delete from disk.
export async function discardFiles(
  repoPath: string,
  paths: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (paths.length === 0) return { ok: true };

  // Split tracked vs untracked so we don't ask `git restore` to touch
  // files it has no record of (it errors loudly).
  const ch = await changes(repoPath);
  const untracked = new Set(
    ch.unstaged
      .filter((f) => f.indexStatus === '?' && f.worktreeStatus === '?')
      .map((f) => f.path),
  );
  const tracked: string[] = [];
  const toDelete: string[] = [];
  for (const p of paths) {
    if (untracked.has(p)) toDelete.push(p);
    else tracked.push(p);
  }

  if (tracked.length > 0) {
    const res = await run(repoPath, ['restore', '--worktree', '--staged', '--', ...tracked]);
    if (!res.ok) {
      return { ok: false, error: res.stderr.trim() || `git restore exited ${res.code}` };
    }
  }
  for (const rel of toDelete) {
    try {
      fs.rmSync(path.join(repoPath, rel), { force: true, recursive: true });
    } catch (err: unknown) {
      return { ok: false, error: `Could not delete ${rel}: ${String(err)}` };
    }
  }
  return { ok: true };
}

/// Commit ONLY what's currently staged. Distinct from `commitAll`, which
/// stages everything first. The renderer's Changes pane drives staging
/// explicitly, so this is the precise commit users expect.
export async function commitStaged(
  repoPath: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!message.trim()) return { ok: false, error: 'Commit message required' };
  const res = await run(repoPath, ['commit', '-m', message.trim()]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git commit exited ${res.code}` };
}

async function hasUpstream(repoPath: string): Promise<boolean> {
  // `rev-parse --abbrev-ref @{upstream}` exits 0 with the upstream name
  // when one is configured, and exits non-zero otherwise. The cheapest
  // existence test for upstream tracking.
  const res = await run(repoPath, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  return res.ok && res.stdout.trim().length > 0;
}

export async function push(repoPath: string): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (await hasUpstream(repoPath)) {
    const res = await run(repoPath, ['push']);
    if (res.ok) return { ok: true };
    return { ok: false, error: res.stderr.trim() || `git push exited ${res.code}` };
  }
  // No upstream: set it on the first push so subsequent pushes/pulls
  // work without ceremony. We push to `origin` because that's the
  // overwhelming default; users with a different remote setup can run
  // `git push -u <remote> HEAD` themselves once.
  const res = await run(repoPath, ['push', '-u', 'origin', 'HEAD']);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git push exited ${res.code}` };
}

export async function pull(repoPath: string): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  // Default to merge-pull (`--no-rebase`) so we don't surprise users
  // whose repos are configured for rebase or fast-forward-only — both
  // common, and silently doing the other strategy can rewrite history.
  // Users who want rebase can run it from their shell.
  const res = await run(repoPath, ['pull', '--no-rebase']);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git pull exited ${res.code}` };
}

export async function createBranch(
  repoPath: string,
  name: string,
  checkoutAfter: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!name.trim()) return { ok: false, error: 'Branch name required' };
  const args = checkoutAfter ? ['checkout', '-b', name.trim()] : ['branch', name.trim()];
  const res = await run(repoPath, args);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git exited ${res.code}` };
}

export async function deleteBranch(
  repoPath: string,
  name: string,
  force: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!name.trim()) return { ok: false, error: 'Branch name required' };
  const flag = force ? '-D' : '-d';
  const res = await run(repoPath, ['branch', flag, name.trim()]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git branch exited ${res.code}` };
}

/// Single-file diff for the Changes pane. `staged` shows index vs HEAD;
/// otherwise we show worktree vs index, with one carve-out: untracked
/// files have no index entry, so we synthesize an "add" diff against
/// /dev/null using `git diff --no-index`.
export async function diffFile(
  repoPath: string,
  filePath: string,
  side: 'staged' | 'unstaged',
): Promise<FileDiff[]> {
  if (!looksLikeRepo(repoPath)) return [];
  if (side === 'staged') {
    const res = await run(repoPath, ['diff', '--cached', '--no-color', '--', filePath]);
    if (!res.ok) return [];
    return splitDiff(res.stdout).map(parseFileBlock);
  }

  // Unstaged: try `git diff -- <path>` first. For untracked files this
  // returns nothing (untracked has no index entry to diff against), so
  // we fall back to `diff --no-index /dev/null <path>` to synthesize an
  // add-diff. `--no-index` exits 1 when there's a difference (which is
  // the normal case here), so we tolerate exit-1 explicitly.
  const tracked = await run(repoPath, ['diff', '--no-color', '--', filePath]);
  if (tracked.ok && tracked.stdout.trim().length > 0) {
    return splitDiff(tracked.stdout).map(parseFileBlock);
  }
  const untracked = await run(repoPath, [
    'diff',
    '--no-index',
    '--no-color',
    '--',
    '/dev/null',
    filePath,
  ]);
  // exit 0 (no diff) and exit 1 (diff present) are both fine for our purposes.
  if (untracked.code !== 0 && untracked.code !== 1) return [];
  return splitDiff(untracked.stdout).map(parseFileBlock);
}
