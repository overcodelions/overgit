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
  GraphCommit,
  RepoChanges,
  RepoStatus,
  Stash,
  UUID,
} from '../shared/types';

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(
  cwd: string,
  args: string[],
  envOverride?: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const env = envOverride
      ? { ...process.env, ...envOverride }
      : process.env;
    const child = spawn('git', args, { cwd, env });
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

export async function status(
  repoId: UUID,
  repoPath: string,
  defaultBranch?: string,
): Promise<RepoStatus> {
  if (!looksLikeRepo(repoPath)) {
    return {
      repoId,
      branch: null,
      dirtyCount: 0,
      ahead: null,
      behind: null,
      aheadDefault: null,
      behindDefault: null,
      defaultRef: null,
      inProgress: null,
      conflicts: [],
      error: 'Not a git repo',
    };
  }

  const branchRes = await run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const rawBranch = branchRes.stdout.trim();
  const branch = rawBranch && rawBranch !== 'HEAD' ? rawBranch : null;

  const porcelainRes = await run(repoPath, ['status', '--porcelain=v1']);
  const dirtyCount = porcelainRes.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0).length;

  // Conflicting paths: porcelain v1 emits `XY <path>` where conflict
  // states are any of UU AA DD AU UA DU UD. Pull paths out of those
  // rows so the conflict pane has something to render.
  const conflicts: string[] = [];
  for (const line of porcelainRes.stdout.split('\n')) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const path = line.slice(3);
    if (
      xy === 'UU' ||
      xy === 'AA' ||
      xy === 'DD' ||
      xy === 'AU' ||
      xy === 'UA' ||
      xy === 'DU' ||
      xy === 'UD'
    ) {
      conflicts.push(path);
    }
  }

  let ahead: number | null = null;
  let behind: number | null = null;
  if (branch) {
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

  // Distance from the repo's "trunk" (default branch). Compared
  // against `origin/<default>` when that ref exists — that's the
  // up-to-date version after a fetch, which is what tells the user
  // "you're 12 behind main, time to rebase." Falls back to the local
  // default when origin/* isn't around (e.g. local-only repo). Null
  // when no default is configured, or when HEAD IS the default
  // (comparison would be 0/0 forever).
  let aheadDefault: number | null = null;
  let behindDefault: number | null = null;
  let defaultRef: string | null = null;
  if (defaultBranch && branch && branch !== defaultBranch) {
    const remoteRef = `refs/remotes/origin/${defaultBranch}`;
    const localRef = `refs/heads/${defaultBranch}`;
    const remoteExists = await run(repoPath, ['show-ref', '--verify', '--quiet', remoteRef]);
    const localExists = await run(repoPath, ['show-ref', '--verify', '--quiet', localRef]);
    const ref = remoteExists.ok
      ? `origin/${defaultBranch}`
      : localExists.ok
        ? defaultBranch
        : null;
    if (ref) {
      const cmp = await run(repoPath, [
        'rev-list',
        '--left-right',
        '--count',
        `${ref}...HEAD`,
      ]);
      if (cmp.ok) {
        const [b, a] = cmp.stdout
          .trim()
          .split(/\s+/)
          .map((n) => Number.parseInt(n, 10));
        if (Number.isFinite(b) && Number.isFinite(a)) {
          behindDefault = b;
          aheadDefault = a;
          defaultRef = ref;
        }
      }
    }
  }

  return {
    repoId,
    branch,
    dirtyCount,
    ahead,
    behind,
    aheadDefault,
    behindDefault,
    defaultRef,
    inProgress: detectInProgress(repoPath),
    conflicts,
  };
}

/// Probe `.git/` for the marker files git creates while a merge,
/// rebase, or cherry-pick is paused. Cheap — just a few stat calls.
function detectInProgress(repoPath: string): 'merge' | 'rebase' | 'cherry-pick' | null {
  const gitDir = path.join(repoPath, '.git');
  // .git can be a file in worktrees (`gitdir: <path>`); chase it.
  let resolvedGitDir = gitDir;
  try {
    const stat = fs.statSync(gitDir);
    if (stat.isFile()) {
      const ref = fs.readFileSync(gitDir, 'utf-8').trim();
      const m = ref.match(/^gitdir:\s*(.+)$/);
      if (m) resolvedGitDir = path.resolve(repoPath, m[1].trim());
    }
  } catch {
    return null;
  }
  const exists = (rel: string) => {
    try {
      fs.accessSync(path.join(resolvedGitDir, rel));
      return true;
    } catch {
      return false;
    }
  };
  if (exists('rebase-merge') || exists('rebase-apply')) return 'rebase';
  if (exists('MERGE_HEAD')) return 'merge';
  if (exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
  return null;
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

/// Fetch the raw unified-diff text for either the working tree
/// (`scope: 'working'`, equivalent to `git diff HEAD`) or the staged
/// changes (`scope: 'staged'`, equivalent to `git diff --cached`).
/// Used by the LLM review flow, which needs the diff as a single string
/// to pipe into a reviewer CLI's stdin.
export async function rawDiff(
  repoPath: string,
  scope: 'staged' | 'working',
): Promise<{ ok: boolean; text: string; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, text: '', error: 'Not a git repo' };
  const args = scope === 'staged'
    ? ['diff', '--cached', '--no-color']
    : ['diff', '--no-color', 'HEAD'];
  const res = await run(repoPath, args);
  if (!res.ok) {
    return { ok: false, text: '', error: res.stderr.trim() || `git exited ${res.code}` };
  }
  return { ok: true, text: res.stdout };
}

/// Parse the "Your local changes to the following files would be
/// overwritten by merge" block out of git stderr. Returns the paths
/// it lists. Empty when the error isn't this shape.
export function parseLocalChangesBlocked(stderr: string): string[] {
  if (!/would be overwritten by (merge|checkout)/i.test(stderr)) return [];
  const paths: string[] = [];
  const lines = stderr.split('\n');
  let inBlock = false;
  for (const line of lines) {
    if (/Your local changes to the following files would be overwritten/i.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^Please commit your changes/i.test(line) || /^Aborting/i.test(line) || line.trim() === '') {
      // End of the block — git terminates with "Please commit ..." or
      // a blank line before the abort message.
      if (/^Please commit/i.test(line) || /^Aborting/i.test(line)) break;
      continue;
    }
    // The path lines are indented by a tab in git's output. Trim it.
    const p = line.replace(/^\s+/, '').trim();
    if (p) paths.push(p);
  }
  return paths;
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
// `%b` is the body (everything after the subject line) and carries
// embedded newlines. We put it last so the field count after splitting
// on \x1f stays predictable even when the body contains the field
// separator (it shouldn't, but `%b` is the only multi-line field).
const LOG_FORMAT = '%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%b%x1e';

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
    // %b can be empty; preserve its leading newline-delimiters by
    // trimming only the record's outer whitespace, not internal
    // whitespace inside fields.
    const trimmed = record.replace(/^\s+|\s+$/g, '');
    if (!trimmed) continue;
    const [sha, shortSha, parents, subject, author, authorEmail, date, body] =
      trimmed.split('\x1f');
    if (!sha) continue;
    out.push({
      sha,
      shortSha: shortSha ?? sha.slice(0, 7),
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      subject: subject ?? '',
      author: author ?? '',
      authorEmail: authorEmail ?? '',
      date: date ?? '',
      body: (body ?? '').trim(),
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

/// Path-scoped stash. `git stash push --include-untracked -- <paths>`
/// stashes only the listed paths (tracked or untracked) and leaves the
/// rest of the working tree alone — that's what the bulk-action bar's
/// "Stash" affordance needs. We pass paths after `--` so they can't be
/// misread as flags, and reject empties so an accidental zero-arg call
/// doesn't end up stashing the whole tree.
export async function stashFiles(
  repoPath: string,
  paths: string[],
  message?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (paths.length === 0) {
    return { ok: false, error: 'No files selected' };
  }
  const args = ['stash', 'push', '--include-untracked'];
  if (message?.trim()) args.push('-m', message.trim());
  args.push('--', ...paths);
  const res = await run(repoPath, args);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git exited ${res.code}` };
}

/// Enumerate the user's stash entries. We pull the structured fields
/// (sha, branch, subject, date) via `--pretty=format` rather than
/// parsing the human-readable `git stash list` output, which mixes the
/// branch name into the subject and gets ambiguous when the subject
/// contains punctuation.
export async function listStashes(repoPath: string): Promise<Stash[]> {
  if (!looksLikeRepo(repoPath)) return [];
  const fmt = '%gd%x1f%h%x1f%gs%x1f%aI%x1e';
  const res = await run(repoPath, ['stash', 'list', `--pretty=format:${fmt}`]);
  if (!res.ok) return [];
  const out: Stash[] = [];
  for (const record of res.stdout.split('\x1e')) {
    const t = record.trim();
    if (!t) continue;
    const [ref, shortSha, gs, date] = t.split('\x1f');
    if (!ref) continue;
    // `%gd` looks like "stash@{2}"; pull the index out for IPC calls.
    const m = ref.match(/^stash@\{(\d+)\}$/);
    const index = m ? Number.parseInt(m[1], 10) : 0;
    // `%gs` (reflog subject) is shaped like
    //   "WIP on main: c0ffee Some commit message"
    // or "On main: <user message>" when the user passed -m. Split on
    // the first ":" so the renderer can show the branch tag separately
    // from the subject.
    const colon = (gs ?? '').indexOf(':');
    const branchPrefix = colon === -1 ? '' : (gs ?? '').slice(0, colon).trim();
    const subject = colon === -1 ? (gs ?? '') : (gs ?? '').slice(colon + 1).trim();
    // The branch part itself is "WIP on <name>" or "On <name>" — peel
    // the leading verb so we can render just the branch name.
    const branchMatch = branchPrefix.match(/^(?:WIP\s+on|On)\s+(.+)$/);
    const branch = branchMatch ? branchMatch[1] : branchPrefix;
    out.push({
      index,
      ref,
      shortSha: shortSha ?? '',
      branch,
      subject,
      date: date ?? '',
    });
  }
  return out;
}

/// Apply (or pop) a stash by numeric index. We resolve by `stash@{N}`
/// so the call targets the exact entry the user clicked even if the
/// list reshuffles between fetch and click. `pop` removes the entry on
/// success; without it the entry stays in the list.
export async function applyStash(
  repoPath: string,
  index: number,
  pop: boolean,
): Promise<{ ok: boolean; error?: string; conflicts?: string[] }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!Number.isInteger(index) || index < 0) {
    return { ok: false, error: `Invalid stash index ${index}` };
  }
  const ref = `stash@{${index}}`;
  const res = await run(repoPath, ['stash', pop ? 'pop' : 'apply', ref]);
  if (res.ok) return { ok: true };
  const stderr = res.stderr.trim() || `git stash exited ${res.code}`;
  // Detect the "untracked file already exists" failure shape so the
  // renderer can offer a force-overwrite affordance instead of just
  // surfacing a wall of git output.
  const conflicts = parseAlreadyExistsConflicts(stderr);
  return { ok: false, error: stderr, conflicts: conflicts.length ? conflicts : undefined };
}

function parseAlreadyExistsConflicts(stderr: string): string[] {
  // `git stash apply` emits one line per conflicting untracked file:
  //   "<path> already exists, no checkout"
  // followed by "error: could not restore untracked files from stash".
  // We pluck the filenames so the renderer can list and target them.
  const out: string[] = [];
  for (const line of stderr.split('\n')) {
    const m = line.match(/^(.+) already exists, no checkout$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/// Force-apply: delete the working-tree files that block the apply,
/// then re-run. We restrict the deletion to files reported by git as
/// "already exists, no checkout" so we don't nuke unrelated content.
/// Path safety: every candidate is path.resolve()'d against repoPath
/// and rejected if it escapes — defense against a stash containing a
/// crafted "../../../etc/passwd" name.
export async function applyStashForce(
  repoPath: string,
  index: number,
  pop: boolean,
): Promise<{ ok: boolean; error?: string; removed?: string[] }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!Number.isInteger(index) || index < 0) {
    return { ok: false, error: `Invalid stash index ${index}` };
  }

  // First, run the normal apply to capture the exact conflict list.
  // We could use `git ls-tree stash@{N}^3` to enumerate the stash's
  // untracked entries, but ^3 only exists when --include-untracked was
  // used at push time, AND we'd remove files that aren't actually in
  // conflict. Trusting git's own error output keeps the deletion
  // minimal.
  const probe = await applyStash(repoPath, index, false);
  if (probe.ok) {
    // Apply already succeeded on its own — convert to pop if the
    // caller asked for pop.
    if (pop) {
      const drop = await run(repoPath, ['stash', 'drop', `stash@{${index}}`]);
      if (!drop.ok) {
        return {
          ok: false,
          error: drop.stderr.trim() || `git stash drop exited ${drop.code}`,
        };
      }
    }
    return { ok: true };
  }
  if (!probe.conflicts?.length) {
    // Failure but not the "already exists" class — pass it back.
    return { ok: false, error: probe.error };
  }

  const removed: string[] = [];
  for (const rel of probe.conflicts) {
    const full = path.resolve(repoPath, rel);
    const root = path.resolve(repoPath);
    if (full !== root && !full.startsWith(root + path.sep)) {
      return {
        ok: false,
        error: `Refusing to remove "${rel}" — path escapes the repo.`,
        removed,
      };
    }
    try {
      fs.rmSync(full, { force: true, recursive: false });
      removed.push(rel);
    } catch (err: unknown) {
      return {
        ok: false,
        error:
          err instanceof Error
            ? `Could not remove ${rel}: ${err.message}`
            : `Could not remove ${rel}`,
        removed,
      };
    }
  }

  const ref = `stash@{${index}}`;
  const retry = await run(repoPath, ['stash', pop ? 'pop' : 'apply', ref]);
  if (retry.ok) return { ok: true, removed };
  return {
    ok: false,
    error: retry.stderr.trim() || `git stash exited ${retry.code}`,
    removed,
  };
}

export async function dropStash(
  repoPath: string,
  index: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!Number.isInteger(index) || index < 0) {
    return { ok: false, error: `Invalid stash index ${index}` };
  }
  const res = await run(repoPath, ['stash', 'drop', `stash@{${index}}`]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git stash drop exited ${res.code}` };
}

export async function stashDiff(repoPath: string, index: number): Promise<FileDiff[]> {
  if (!looksLikeRepo(repoPath)) return [];
  if (!Number.isInteger(index) || index < 0) return [];
  // `git stash show -p stash@{N}` emits the same shape as `git show`
  // (header + per-file blocks), with no commit-message preamble for
  // stashes — but pass `--format=` defensively so future git versions
  // don't surprise us. Reusing the same per-file parser as `diff()`.
  const res = await run(repoPath, [
    'stash',
    'show',
    '-p',
    '--no-color',
    '--format=',
    `stash@{${index}}`,
  ]);
  if (!res.ok) return [];
  return splitDiff(res.stdout).map(parseFileBlock);
}

/// Apply a unified-diff patch to the repo. The three modes:
///   stage    → `git apply --cached -` (worktree unchanged, index updated)
///   unstage  → `git apply --cached --reverse -` (reverses staged hunk)
///   discard  → `git apply --reverse -` (reverses worktree changes)
///
/// We pass the patch via stdin rather than a temp file so we never
/// touch disk for content we'll throw away. `--unidiff-zero` is NOT
/// passed because our patches always carry standard 3-line context;
/// adding it would make `git apply` reject any patch with non-zero
/// context. The `--whitespace=nowarn` flag silences benign warnings
/// about trailing whitespace which would otherwise count as a non-zero
/// exit on some git versions.
export async function applyPatch(
  repoPath: string,
  patch: string,
  mode: 'stage' | 'unstage' | 'discard',
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!patch.trim()) return { ok: false, error: 'Empty patch' };
  const args = ['apply', '--whitespace=nowarn'];
  if (mode === 'stage') args.push('--cached');
  if (mode === 'unstage') args.push('--cached', '--reverse');
  if (mode === 'discard') args.push('--reverse');
  args.push('-');
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: repoPath, env: process.env });
    let stderr = '';
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else
        resolve({
          ok: false,
          error: stderr.trim() || `git apply exited ${code}`,
        });
    });
    child.on('error', (err) => {
      resolve({ ok: false, error: String(err) });
    });
    try {
      child.stdin.write(patch.endsWith('\n') ? patch : patch + '\n');
      child.stdin.end();
    } catch {
      /* close handler will fire */
    }
  });
}

/// Merge a branch into the current one. The three modes match the
/// canonical git invocations:
///   merge   → `git merge --no-ff <branch>` (always create a merge commit)
///   ff-only → `git merge --ff-only <branch>` (refuse if non-trivial)
///   squash  → `git merge --squash <branch>` (leaves changes staged
///             but no commit; the user finishes via the commit form)
export async function mergeBranch(
  repoPath: string,
  branch: string,
  mode: 'merge' | 'ff-only' | 'squash',
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!branch || /[\s;|`$]/.test(branch)) {
    return { ok: false, error: `Refusing to merge "${branch}"` };
  }
  const flag =
    mode === 'merge' ? '--no-ff' : mode === 'ff-only' ? '--ff-only' : '--squash';
  const res = await run(repoPath, ['merge', flag, branch]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git merge exited ${res.code}` };
}

export async function abortMerge(
  repoPath: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const res = await run(repoPath, ['merge', '--abort']);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git merge --abort exited ${res.code}` };
}

export async function rebaseOnto(
  repoPath: string,
  onto: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!onto || /[\s;|`$]/.test(onto)) {
    return { ok: false, error: `Refusing to rebase onto "${onto}"` };
  }
  const res = await run(repoPath, ['rebase', onto]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git rebase exited ${res.code}` };
}

export async function abortRebase(
  repoPath: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const res = await run(repoPath, ['rebase', '--abort']);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git rebase --abort exited ${res.code}` };
}

export async function continueRebase(
  repoPath: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  // GIT_EDITOR=true: `git rebase --continue` opens an editor when the
  // user's resolution introduces a new commit message. We don't have
  // an inline editor here, so we no-op the editor and let git use the
  // existing message. The renderer surfaces a clearer flow if that
  // assumption breaks.
  const res = await run(repoPath, ['rebase', '--continue'], {
    GIT_EDITOR: 'true',
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git rebase --continue exited ${res.code}` };
}

export async function abortCherryPick(
  repoPath: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const res = await run(repoPath, ['cherry-pick', '--abort']);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git cherry-pick --abort exited ${res.code}` };
}

export async function continueCherryPick(
  repoPath: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const res = await run(repoPath, ['cherry-pick', '--continue'], {
    GIT_EDITOR: 'true',
  });
  if (res.ok) return { ok: true };
  return {
    ok: false,
    error: res.stderr.trim() || `git cherry-pick --continue exited ${res.code}`,
  };
}

export async function markResolved(
  repoPath: string,
  paths: string[],
): Promise<{ ok: boolean; remaining: string[]; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, remaining: [], error: 'Not a git repo' };
  if (paths.length === 0) {
    // Nothing to add; just refresh the conflict list.
    return resolveStatus(repoPath);
  }
  const res = await run(repoPath, ['add', '--', ...paths]);
  if (!res.ok) {
    return {
      ok: false,
      remaining: [],
      error: res.stderr.trim() || `git add exited ${res.code}`,
    };
  }
  return resolveStatus(repoPath);
}

async function resolveStatus(
  repoPath: string,
): Promise<{ ok: boolean; remaining: string[]; error?: string }> {
  const porcelain = await run(repoPath, ['status', '--porcelain=v1']);
  if (!porcelain.ok) {
    return {
      ok: true,
      remaining: [],
      error: porcelain.stderr.trim() || undefined,
    };
  }
  const remaining: string[] = [];
  for (const line of porcelain.stdout.split('\n')) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const p = line.slice(3);
    if (
      xy === 'UU' ||
      xy === 'AA' ||
      xy === 'DD' ||
      xy === 'AU' ||
      xy === 'UA' ||
      xy === 'DU' ||
      xy === 'UD'
    )
      remaining.push(p);
  }
  return { ok: true, remaining };
}

/// `git commit --amend`. With a message, replace the previous commit's
/// subject + body. With `message: null`, fold the currently staged
/// changes onto the previous commit, keeping the message. We never
/// touch unstaged changes — the user stages first, then amends.
export async function amendCommit(
  repoPath: string,
  message: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const args = ['commit', '--amend'];
  if (message === null) args.push('--no-edit');
  else if (!message.trim()) return { ok: false, error: 'Commit message required' };
  else args.push('-m', message.trim());
  const res = await run(repoPath, args);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git commit --amend exited ${res.code}` };
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

export async function pull(
  repoPath: string,
): Promise<{ ok: boolean; error?: string; conflicts?: string[] }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const res = await run(repoPath, ['pull', '--no-rebase']);
  if (res.ok) return { ok: true };
  // Detect "would be overwritten" so the renderer can offer recovery
  // (stash & retry / discard & retry) instead of just dumping git's
  // wall of text into an alert.
  const blocked = parseLocalChangesBlocked(res.stderr);
  return {
    ok: false,
    error: res.stderr.trim() || `git pull exited ${res.code}`,
    conflicts: blocked.length ? blocked : undefined,
  };
}

/// Recovery flow when pull is blocked by local changes. Two strategies:
///   stash    → `git stash push --include-untracked -m "auto: pull" -- <paths>`
///              then pull. The stash stays around so the user can pop
///              it later if they want their changes back.
///   discard  → `git checkout HEAD -- <paths>` then pull. Destructive
///              (the local changes are gone), so the renderer must
///              confirm before calling.
export async function pullForce(
  repoPath: string,
  conflicts: string[],
  strategy: 'stash' | 'discard',
): Promise<{ ok: boolean; error?: string; stashed?: boolean }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (conflicts.length === 0) return { ok: false, error: 'No conflicting paths' };
  // Validate paths against the repo root the same way applyStashForce
  // does — defends against ".." escapes in any caller.
  for (const rel of conflicts) {
    const full = path.resolve(repoPath, rel);
    const root = path.resolve(repoPath);
    if (full !== root && !full.startsWith(root + path.sep)) {
      return { ok: false, error: `Refusing to act on "${rel}" — escapes the repo.` };
    }
  }

  if (strategy === 'stash') {
    const stash = await run(repoPath, [
      'stash',
      'push',
      '--include-untracked',
      '-m',
      'auto: pull',
      '--',
      ...conflicts,
    ]);
    if (!stash.ok) {
      return {
        ok: false,
        error: stash.stderr.trim() || `git stash exited ${stash.code}`,
      };
    }
  } else {
    const reset = await run(repoPath, ['checkout', 'HEAD', '--', ...conflicts]);
    if (!reset.ok) {
      return {
        ok: false,
        error: reset.stderr.trim() || `git checkout exited ${reset.code}`,
      };
    }
  }

  const pullRes = await run(repoPath, ['pull', '--no-rebase']);
  if (pullRes.ok) {
    return { ok: true, stashed: strategy === 'stash' };
  }
  return {
    ok: false,
    error: pullRes.stderr.trim() || `git pull exited ${pullRes.code}`,
    stashed: strategy === 'stash',
  };
}

/// Detach HEAD onto an arbitrary commit SHA. Useful from the History
/// view's right-click context menu. We accept SHAs with the usual
/// sha-shape regex so the caller can't smuggle flags.
export async function checkoutCommit(
  repoPath: string,
  sha: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) {
    return { ok: false, error: `Refusing to checkout non-sha "${sha}"` };
  }
  const res = await run(repoPath, ['checkout', sha]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git checkout exited ${res.code}` };
}

export async function createBranch(
  repoPath: string,
  name: string,
  checkoutAfter: boolean,
  from?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!name.trim()) return { ok: false, error: 'Branch name required' };
  // Optional starting ref. We allow only sha-like values here; a
  // branch name would also be a valid git ref, but this codepath is
  // currently only called from the history "Branch from here" flow,
  // which always passes a sha. Keeping it strict avoids accidental
  // arg-injection through a commit subject that looks like a flag.
  if (from !== undefined && !/^[0-9a-fA-F]{4,64}$/.test(from)) {
    return { ok: false, error: `Invalid base ref "${from}"` };
  }
  const args = checkoutAfter
    ? ['checkout', '-b', name.trim(), ...(from ? [from] : [])]
    : ['branch', name.trim(), ...(from ? [from] : [])];
  const res = await run(repoPath, args);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git exited ${res.code}` };
}

/// Detect the repo's default branch — the line `origin/main` is on, the
/// branch overgit treats as the "trunk" for compare/PR-base actions.
/// Falls back through three sources: the symbolic HEAD ref of origin
/// (the canonical answer), then a heuristic over `main`/`master`/`develop`.
/// Returns null only when the repo has none of those — at which point
/// the user can pick one in settings.
export async function detectDefaultBranch(repoPath: string): Promise<string | null> {
  if (!looksLikeRepo(repoPath)) return null;
  // 1. `origin/HEAD` — set during `clone`, refreshed by
  //    `git remote set-head origin -a`. When it exists, it's the
  //    repository owner's declared default.
  const symbolic = await run(repoPath, [
    'symbolic-ref',
    '--quiet',
    'refs/remotes/origin/HEAD',
  ]);
  if (symbolic.ok) {
    const ref = symbolic.stdout.trim();
    const m = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  }
  // 2. Heuristic: pick the first of main/master/develop that exists.
  for (const candidate of ['main', 'master', 'develop']) {
    const exists = await run(repoPath, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${candidate}`,
    ]);
    if (exists.ok) return candidate;
  }
  return null;
}

export interface BranchSummary {
  name: string;
  /// Short display name. For local branches this equals `name`; for
  /// remote-tracking branches it's the part after the remote ("foo"
  /// for "origin/foo").
  shortName: string;
  kind: 'local' | 'remote';
  isCurrent: boolean;
  /// Tip commit. Used by the picker to show the user what state each
  /// branch is in without having to switch first.
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
  /// Configured upstream tracking ref ("origin/main" for local "main"),
  /// or null if untracked. Lets the picker tag a branch as "tracks X".
  upstream: string | null;
}

const BRANCH_FORMAT = [
  '%(refname:short)',
  '%(objectname)',
  '%(objectname:short)',
  '%(subject)',
  '%(authorname)',
  '%(committerdate:iso-strict)',
  '%(upstream:short)',
].join('%1f');

/// Enumerate every branch — local + remote. We hit `for-each-ref` twice
/// rather than once (heads + remotes in a single call) so we can tag the
/// `kind` from the namespace it came from, instead of doing N `show-ref`
/// round-trips per branch to disambiguate.
export async function branchSummaries(repoPath: string): Promise<BranchSummary[]> {
  if (!looksLikeRepo(repoPath)) return [];

  const [headRes, locals, remotes] = await Promise.all([
    run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    run(repoPath, [
      'for-each-ref',
      '--sort=-committerdate',
      `--format=${BRANCH_FORMAT}`,
      'refs/heads',
    ]),
    run(repoPath, [
      'for-each-ref',
      '--sort=-committerdate',
      `--format=${BRANCH_FORMAT}`,
      'refs/remotes',
    ]),
  ]);

  const currentBranch = headRes.ok ? headRes.stdout.trim() : '';
  const out: BranchSummary[] = [];

  const consume = (raw: string, kind: 'local' | 'remote') => {
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const [name, sha, shortSha, subject, author, date, upstream] = line.split('\x1f');
      if (!name) continue;
      // `<remote>/HEAD` is a symbolic alias to whatever the remote's
      // default branch is — the same commit shows up under its real name
      // already, so dropping the alias keeps the picker tidy.
      if (name.endsWith('/HEAD')) continue;
      const shortName =
        kind === 'remote' ? name.split('/').slice(1).join('/') : name;
      out.push({
        name,
        shortName,
        kind,
        isCurrent: kind === 'local' && name === currentBranch,
        sha: sha ?? '',
        shortSha: shortSha ?? '',
        subject: subject ?? '',
        author: author ?? '',
        date: date ?? '',
        upstream: upstream && upstream.length > 0 ? upstream : null,
      });
    }
  };

  if (locals.ok) consume(locals.stdout, 'local');
  if (remotes.ok) consume(remotes.stdout, 'remote');
  return out;
}

export async function listBranchCommits(
  repoPath: string,
  ref: string,
  limit = 50,
): Promise<Commit[]> {
  if (!looksLikeRepo(repoPath)) return [];
  if (!ref || /[\s;|`$]/.test(ref)) return [];
  const res = await run(repoPath, [
    'log',
    `-${Math.max(1, Math.min(limit, 500))}`,
    `--pretty=format:${LOG_FORMAT}`,
    ref,
    '--',
  ]);
  if (!res.ok) return [];
  const out: Commit[] = [];
  for (const record of res.stdout.split('\x1e')) {
    const t = record.replace(/^\s+|\s+$/g, '');
    if (!t) continue;
    const [sha, shortSha, parents, subject, author, authorEmail, date, body] =
      t.split('\x1f');
    if (!sha) continue;
    out.push({
      sha,
      shortSha: shortSha ?? sha.slice(0, 7),
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      subject: subject ?? '',
      author: author ?? '',
      authorEmail: authorEmail ?? '',
      date: date ?? '',
      body: (body ?? '').trim(),
    });
  }
  return out;
}

/// Apply commits onto the current branch via `git cherry-pick`. We pass
/// shas individually rather than a range so a partial failure leaves
/// the user a clean intermediate state to recover from (cherry-pick
/// auto-stops on conflict; we surface the error and the user can resolve).
export async function cherryPick(
  repoPath: string,
  shas: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (shas.length === 0) return { ok: true };
  // Reject shas that don't look like git object names. A surprising
  // amount of damage is possible if someone managed to slip `; rm -rf`
  // into a sha — `spawn(..., {shell: false})` already protects us, but
  // belt-and-braces.
  for (const s of shas) {
    if (!/^[0-9a-fA-F]{4,64}$/.test(s)) {
      return { ok: false, error: `Refusing to cherry-pick non-sha "${s}"` };
    }
  }
  const res = await run(repoPath, ['cherry-pick', ...shas]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git cherry-pick exited ${res.code}` };
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

// GraphCommit lives in shared/types.ts so renderer + main share the
// same shape. Re-imported below where it's needed.

const GRAPH_FORMAT = '%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%b%x1e';

/// Build a small commit graph for the branch visualization. Pulls
/// `git log --all --topo-order` and lays the commits onto vertical lanes
/// so the UI can draw a left-rail graph with branch labels.
export async function commitGraph(
  repoPath: string,
  limit = 200,
  defaultBranch?: string,
): Promise<GraphCommit[]> {
  if (!looksLikeRepo(repoPath)) return [];
  const res = await run(repoPath, [
    'log',
    '--all',
    '--topo-order',
    `-${Math.max(1, Math.min(limit, 2000))}`,
    `--pretty=format:${GRAPH_FORMAT}`,
  ]);
  if (!res.ok) return [];

  const parsed: Omit<GraphCommit, 'lane' | 'parentLanes'>[] = [];
  for (const record of res.stdout.split('\x1e')) {
    const t = record.replace(/^\s+|\s+$/g, '');
    if (!t) continue;
    const [sha, shortSha, parents, subject, author, authorEmail, date, refs, body] =
      t.split('\x1f');
    if (!sha) continue;
    parsed.push({
      sha,
      shortSha: shortSha ?? sha.slice(0, 7),
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      subject: subject ?? '',
      author: author ?? '',
      authorEmail: authorEmail ?? '',
      date: date ?? '',
      body: (body ?? '').trim(),
      refs: refs
        ? refs
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean)
        : [],
    });
  }

  // Build the trunk-set: SHAs along the default branch's first-parent
  // chain. We pin them to lane 0 so the trunk runs as a continuous
  // line down the leftmost lane regardless of which feature branch
  // happened to commit most recently. Falls through silently when no
  // default is configured or the trunk ref doesn't resolve — without
  // a trunk-set the allocator behaves exactly as before.
  const trunkSet = new Set<string>();
  if (defaultBranch) {
    const remoteCheck = await run(repoPath, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${defaultBranch}`,
    ]);
    const localCheck = await run(repoPath, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${defaultBranch}`,
    ]);
    const trunkRef = remoteCheck.ok
      ? `origin/${defaultBranch}`
      : localCheck.ok
        ? defaultBranch
        : null;
    if (trunkRef) {
      const chain = await run(repoPath, [
        'rev-list',
        '--first-parent',
        trunkRef,
      ]);
      if (chain.ok) {
        for (const line of chain.stdout.split('\n')) {
          const sha = line.trim();
          if (sha) trunkSet.add(sha);
        }
      }
    }
  }
  const haveTrunk = trunkSet.size > 0;

  // Lane allocator. Standard greedy walk child-first, with one twist:
  // when a `defaultBranch` is configured and its first-parent chain
  // resolves, we pin those commits to lane 0 and skip lane 0 for
  // every other commit's allocation. Net effect: trunk is always a
  // straight purple line down the left edge, feature branches fan to
  // the right. Matches what SourceTree/GitKraken do.
  //
  // When `haveTrunk` is false we fall back to the original behavior —
  // first-allocated commit wins lane 0 — so repos without a
  // configured default still get a sensible graph.
  const out: GraphCommit[] = [];
  const active: (string | null)[] = [];

  // Search-from offset: for non-trunk commits we always start the
  // "leftmost free" search at lane 1 when haveTrunk is true. Helper
  // captures the bias.
  const findLane = (predicate: (s: string | null, idx: number) => boolean, skipZero: boolean) =>
    active.findIndex((s, idx) => (skipZero ? idx > 0 : true) && predicate(s, idx));
  const ensureLane = (lane: number) => {
    while (active.length <= lane) active.push(null);
  };

  for (let i = 0; i < parsed.length; i += 1) {
    const c = parsed[i];
    const isTrunk = haveTrunk && trunkSet.has(c.sha);

    let lane: number;
    if (isTrunk) {
      lane = 0;
      ensureLane(0);
    } else {
      // Look for a lane that an earlier child reserved for us. Skip
      // lane 0 — even if some earlier non-trunk allocation strayed
      // there in the no-trunk fallback path, when haveTrunk we treat
      // 0 as off-limits to non-trunk.
      lane = findLane((s) => s === c.sha, haveTrunk);
      if (lane === -1) {
        lane = findLane((s) => s === null, haveTrunk);
        if (lane === -1) {
          lane = haveTrunk ? Math.max(active.length, 1) : active.length;
          ensureLane(lane);
        }
      }
    }
    active[lane] = null;

    const parentLanes: number[] = [];
    for (let pi = 0; pi < c.parents.length; pi += 1) {
      const parent = c.parents[pi];
      const parentIsTrunk = haveTrunk && trunkSet.has(parent);

      let pLane: number;
      if (parentIsTrunk) {
        pLane = 0;
        ensureLane(0);
      } else {
        pLane = findLane((s) => s === parent, haveTrunk);
        if (pLane === -1) {
          if (pi === 0 && lane !== 0) {
            // First parent inherits this commit's lane — keeps a
            // non-trunk feature branch running straight on its lane.
            // Skip when lane === 0 (commit was trunk but parent isn't —
            // shouldn't happen because trunk-set is closed under
            // first-parent, but defensive).
            pLane = lane;
          } else {
            pLane = findLane((s) => s === null, haveTrunk);
            if (pLane === -1) {
              pLane = haveTrunk ? Math.max(active.length, 1) : active.length;
              ensureLane(pLane);
            }
          }
        }
      }
      active[pLane] = parent;
      parentLanes.push(pLane);
    }

    out.push({ ...c, lane, parentLanes });
  }
  return out;
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
