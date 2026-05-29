// Thin wrapper around the `git` CLI. Overgit deliberately doesn't use a
// libgit2 binding — shelling out keeps overgit a pure overlay: every
// operation we perform is something the user could run themselves in a
// terminal, and any tool watching the repo (gh, jj, an IDE) sees the
// same end state.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  BlameLine,
  ChangedFile,
  CheckoutOutcome,
  BranchPruneCandidate,
  Commit,
  FileDiff,
  FileLogCommit,
  GraphCommit,
  Identity,
  LfsStatus,
  RepoChanges,
  RepoStatus,
  Remote,
  Stash,
  Submodule,
  Tag,
  UUID,
  Worktree,
} from '../shared/types';

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

// Cap on accumulated stdout/stderr per child. V8's max string length is
// ~512 MB; once we cross it `s += chunk.toString()` throws RangeError
// and kills the main process. 128 MB is far below the limit and far
// above any plausible legitimate diff/log output we'd parse here — if
// we hit it, something pathological is happening (binary diff, runaway
// patch-id stream) and killing the child is the right call.
const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;

// A crashed or SIGKILL'd git leaves behind `<path>.lock` files
// (`.git/index.lock`, `.git/HEAD.lock`, `.git/refs/heads/<branch>.lock`)
// which block every subsequent write with a "File exists" error. If
// the lock is older than this threshold no live git process can be
// updating it, so it's safe to clear and retry once.
const STALE_LOCK_RE = /Unable to create '([^']+\.lock)': File exists/;
/// How long a `.git/*.lock` file must have sat untouched before we
/// consider it abandoned and safely delete it. Real git operations
/// finish in well under 100ms, so anything older than ~2s is almost
/// certainly leftover from a crashed or killed process. The earlier
/// 10s threshold was conservative-to-a-fault and caused legitimate
/// stale locks to surface as "switch failed" rows on Reset all.
const STALE_LOCK_THRESHOLD_MS = 2_000;
/// When the lock is *fresh* (created within the stale threshold) we
/// assume an external process — an IDE, terminal git, gh — is briefly
/// holding it. Wait this long between retries and give up after
/// LOCK_RETRY_MAX_ATTEMPTS, so a permanently-stuck external tool
/// surfaces as an error instead of pinning the call forever.
const LOCK_RETRY_DELAY_MS = 150;
const LOCK_RETRY_MAX_ATTEMPTS = 4;

/// Per-repo serialization. Two `run()` calls into the same cwd queue
/// up instead of racing the index/refs locks. This eliminates the
/// in-process collision (status poll firing while sync is mid-merge);
/// external tools racing us are handled by the retry loop below.
const repoLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(cwd) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  repoLocks.set(cwd, next);
  // Drop the entry once we're the tail so the map doesn't grow
  // unboundedly across the process lifetime.
  next.catch(() => {}).finally(() => {
    if (repoLocks.get(cwd) === next) repoLocks.delete(cwd);
  });
  return next;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function run(
  cwd: string,
  args: string[],
  envOverride?: Record<string, string>,
  timeoutMs?: number,
): Promise<RunResult> {
  return withRepoLock(cwd, async () => {
    let last: RunResult | null = null;
    for (let attempt = 0; attempt < LOCK_RETRY_MAX_ATTEMPTS; attempt++) {
      const res = await runOnce(cwd, args, envOverride, timeoutMs);
      if (res.ok) return res;
      const m = STALE_LOCK_RE.exec(res.stderr);
      if (!m) return res;
      const lockPath = m[1];
      let stale = false;
      let gone = false;
      try {
        const stat = fs.statSync(lockPath);
        stale = Date.now() - stat.mtimeMs >= STALE_LOCK_THRESHOLD_MS;
      } catch {
        gone = true;
      }
      if (stale) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Someone else just cleared it — fall through and retry.
        }
        continue;
      }
      if (gone) continue;
      last = res;
      if (attempt < LOCK_RETRY_MAX_ATTEMPTS - 1) {
        await sleep(LOCK_RETRY_DELAY_MS);
      }
    }
    return last ?? (await runOnce(cwd, args, envOverride, timeoutMs));
  });
}

function runOnce(
  cwd: string,
  args: string[],
  envOverride?: Record<string, string>,
  timeoutMs?: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const env = envOverride
      ? { ...process.env, ...envOverride }
      : process.env;
    const child = spawn('git', args, { cwd, env });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated: 'stdout' | 'stderr' | null = null;
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    // Network-bound ops (fetch/pull/push) pass a timeout so a stalled
    // remote or a credential prompt can't pin the workset serial loop
    // forever. Local ops omit it. On timeout we SIGTERM, resolve the
    // promise immediately so the caller doesn't wait, then SIGKILL
    // shortly after if the child is still alive (askpass GUIs and
    // ssh subprocesses ignore SIGTERM in some auth-stuck states).
    const timer = timeoutMs
      ? setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* ignore */
          }
          done({
            ok: false,
            stdout,
            stderr: stderr || `git ${args[0] ?? ''} timed out after ${Math.round(timeoutMs / 1000)}s`,
            code: null,
          });
          setTimeout(() => {
            try {
              if (!child.killed) child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }, 2_000);
        }, timeoutMs)
      : null;
    child.stdout.on('data', (b: Buffer) => {
      if (truncated) return;
      if (stdoutBytes + b.length > MAX_GIT_OUTPUT_BYTES) {
        truncated = 'stdout';
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        return;
      }
      stdoutBytes += b.length;
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      if (truncated) return;
      if (stderrBytes + b.length > MAX_GIT_OUTPUT_BYTES) {
        truncated = 'stderr';
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        return;
      }
      stderrBytes += b.length;
      stderr += b.toString('utf8');
    });
    child.on('close', (code) => {
      if (truncated) {
        done({
          ok: false,
          stdout,
          stderr:
            stderr ||
            `git ${args[0] ?? ''} produced more than ${Math.round(MAX_GIT_OUTPUT_BYTES / (1024 * 1024))} MB on ${truncated} — killed`,
          code: null,
        });
        return;
      }
      done({ ok: code === 0, stdout, stderr, code });
    });
    child.on('error', (err) => {
      done({ ok: false, stdout, stderr: stderr || String(err), code: null });
    });
  });
}

// Network-bound git ops get a hard timeout — local git is fast enough
// that an open-ended wait is fine, but `fetch`/`pull`/`push` can hang on
// a stalled remote, a slow auth prompt, or a tarpitting host.
const NETWORK_TIMEOUT_MS = 90_000;

/// Shared env overlay for every git op that talks to a remote.
/// Disables interactive credential / host-key prompts so the call
/// fails fast with a readable error instead of hanging on stdin or a
/// GUI askpass. LogLevel=ERROR silences the post-quantum-KEX warning
/// macOS 15+ OpenSSH spams on every connect to a non-PQ server.
///
/// We deliberately do NOT enable SSH ControlMaster multiplexing here.
/// It looked attractive (one shared TCP/SSH handshake for N parallel
/// fetches against the same host), but the auto-master path races
/// when several workers start at once: they all see "no socket",
/// they all try to create one, one wins, the rest fail with
/// `mux_client_request_session: session request failed: Session open
/// refused by peer`. The fetches themselves are fast enough without
/// multiplexing; keeping the per-fetch handshake is the safe trade.
const NETWORK_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  SSH_ASKPASS: 'true',
  GIT_SSH_COMMAND:
    process.env.GIT_SSH_COMMAND
    ?? [
      'ssh',
      '-o BatchMode=yes',
      '-o ConnectTimeout=10',
      '-o StrictHostKeyChecking=accept-new',
      '-o LogLevel=ERROR',
    ].join(' '),
};

/// Bounded `Promise.all`. Run `fn` over `items` with at most `limit`
/// invocations in flight. Used by the squash-merge detector so a repo
/// with hundreds of stale branches doesn't fan out hundreds of `git`
/// processes simultaneously and pin the IPC bus.
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const work = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };
  const workers: Promise<void>[] = [];
  const n = Math.min(limit, items.length);
  for (let i = 0; i < n; i += 1) workers.push(work());
  await Promise.all(workers);
  return results;
}

/// Stream `git <logArgs>` output into `git patch-id --stable` via
/// native Node child-process pipes, and parse the patch-id lines as
/// they emit. Critically, the huge `git log -p` output NEVER enters
/// the JS heap — the OS pipes shovel bytes from one subprocess to the
/// other and we only buffer patch-id's tiny output (one "<pid> <sha>"
/// line per commit).
///
/// This is what `runWithInput` does NOT do: the old path buffered the
/// entire log-p stream into a JS string, then wrote that string to
/// patch-id's stdin in one chunk — both moves block the Electron main
/// thread on hundreds of MB of patch data, which is exactly what made
/// every other IPC (workset status, sync, branches) feel glued until
/// squash detection finished.
function pipeGitToPatchId(
  cwd: string,
  logArgs: string[],
): Promise<{ ok: boolean; entries: { pid: string; sha: string }[] }> {
  return new Promise((resolve) => {
    const logChild = spawn('git', logArgs, { cwd, env: process.env });
    const pidChild = spawn('git', ['patch-id', '--stable'], {
      cwd,
      env: process.env,
    });
    let pidStdout = '';
    let pidStdoutBytes = 0;
    let logStderr = '';
    let pidStderr = '';
    let truncated = false;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      const entries: { pid: string; sha: string }[] = [];
      for (const line of pidStdout.split('\n')) {
        const [pid, sha] = line.trim().split(/\s+/);
        if (pid && sha) entries.push({ pid, sha });
      }
      resolve({ ok: ok && entries.length >= 0, entries });
    };
    // Pipe log → patch-id natively. Errors on either pipe are
    // non-fatal — we just resolve with whatever entries we've parsed.
    logChild.stdout.pipe(pidChild.stdin).on('error', () => {
      /* patch-id may have closed early on malformed input; the close
         handlers below will report the final outcome */
    });
    pidChild.stdout.on('data', (b: Buffer) => {
      if (truncated) return;
      if (pidStdoutBytes + b.length > MAX_GIT_OUTPUT_BYTES) {
        truncated = true;
        try {
          logChild.kill('SIGTERM');
          pidChild.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        return;
      }
      pidStdoutBytes += b.length;
      pidStdout += b.toString('utf8');
    });
    logChild.stderr.on('data', (b: Buffer) => {
      logStderr += b.toString('utf8');
    });
    pidChild.stderr.on('data', (b: Buffer) => {
      pidStderr += b.toString('utf8');
    });
    let logExited = false;
    let pidExited = false;
    let logOk = false;
    let pidOk = false;
    logChild.on('close', (code) => {
      logExited = true;
      logOk = code === 0;
      // Close patch-id stdin when log finishes so patch-id flushes.
      try {
        pidChild.stdin.end();
      } catch {
        /* ignore */
      }
      if (pidExited) finish(logOk && pidOk && !truncated);
    });
    pidChild.on('close', (code) => {
      pidExited = true;
      pidOk = code === 0;
      if (logExited) finish(logOk && pidOk && !truncated);
    });
    logChild.on('error', () => {
      finish(false);
    });
    pidChild.on('error', () => {
      finish(false);
    });
    // Silence unused-var lint; the captured stderr is available for
    // future logging without changing the resolve shape.
    void logStderr;
    void pidStderr;
  });
}

/// Run `git <args>` with a string fed to stdin. Used by the squash-merge
/// detector so we can pipe `git log -p` output into `git patch-id`
/// without going through a shell (no quoting, no injection surface).
function runWithInput(cwd: string, args: string[], input: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated: 'stdout' | 'stderr' | null = null;
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    child.stdout.on('data', (b: Buffer) => {
      if (truncated) return;
      if (stdoutBytes + b.length > MAX_GIT_OUTPUT_BYTES) {
        truncated = 'stdout';
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        return;
      }
      stdoutBytes += b.length;
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      if (truncated) return;
      if (stderrBytes + b.length > MAX_GIT_OUTPUT_BYTES) {
        truncated = 'stderr';
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        return;
      }
      stderrBytes += b.length;
      stderr += b.toString('utf8');
    });
    child.on('close', (code) => {
      if (truncated) {
        done({
          ok: false,
          stdout,
          stderr:
            stderr ||
            `git ${args[0] ?? ''} produced more than ${Math.round(MAX_GIT_OUTPUT_BYTES / (1024 * 1024))} MB on ${truncated} — killed`,
          code: null,
        });
        return;
      }
      done({ ok: code === 0, stdout, stderr, code });
    });
    child.on('error', (err) => {
      done({ ok: false, stdout, stderr: stderr || String(err), code: null });
    });
    child.stdin.on('error', () => {
      // patch-id can close stdin early on malformed input; swallow EPIPE
      // and let the close handler report the real exit status.
    });
    child.stdin.end(input);
  });
}

/// Build the env override that pins author + committer for a single
/// `git commit`. Returns undefined when no identity is supplied so
/// `run()` falls through to its default (process.env), letting git
/// resolve user.name / user.email itself.
function identityEnv(identity?: Identity): Record<string, string> | undefined {
  if (!identity) return undefined;
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

/// Read the identity that git would resolve for `git commit` in this
/// repo right now. `scope: 'local'` only consults .git/config (returns
/// nulls when no local override exists); `scope: 'effective'` returns
/// whatever git resolves through its precedence chain (local → global
/// → system). The renderer uses both: local to detect "the repo set
/// itself up", effective as the fallback display value.
async function readGitConfigIdentity(
  repoPath: string,
  scope: 'local' | 'effective',
): Promise<{ name: string | null; email: string | null }> {
  const args = scope === 'local'
    ? ['config', '--local', '--get']
    : ['config', '--get'];
  const [nameRes, emailRes] = await Promise.all([
    run(repoPath, [...args, 'user.name']),
    run(repoPath, [...args, 'user.email']),
  ]);
  const name = nameRes.ok ? nameRes.stdout.trim() : '';
  const email = emailRes.ok ? emailRes.stdout.trim() : '';
  return {
    name: name.length > 0 ? name : null,
    email: email.length > 0 ? email : null,
  };
}

export { readGitConfigIdentity };

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

/// Whitelist of URL schemes overgit will hand to `git clone`. Local-disk
/// paths skip this entirely; for anything that looks like a URL, only
/// these schemes are allowed. Keeps a malicious paste from invoking an
/// arbitrary git transport helper (`ext::sh -c …` etc.).
const ALLOWED_CLONE_SCHEMES = new Set(['https', 'http', 'ssh', 'git', 'file']);
/// `git@github.com:org/repo.git` — scp-like syntax that doesn't parse as
/// a URL but is the most common SSH form. Validated separately.
const SCP_LIKE_URL_RE = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:[^\s]+$/;

export function validateCloneUrl(raw: string): { ok: true } | { ok: false; error: string } {
  const url = raw.trim();
  if (!url) return { ok: false, error: 'URL is required' };
  if (SCP_LIKE_URL_RE.test(url)) return { ok: true };
  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.replace(/:$/, '');
    if (!ALLOWED_CLONE_SCHEMES.has(scheme)) {
      return { ok: false, error: `Unsupported URL scheme "${scheme}"` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Not a valid URL (expected https://, ssh://, or git@host:path)' };
  }
}

/// Default folder name `git clone` would pick when you don't pass one.
/// Used to prefill the form so the user only types when they want
/// something different from the conventional name.
export function defaultCloneFolderName(url: string): string {
  const trimmed = url.trim();
  // scp-like → take the part after the colon
  let tail = trimmed;
  if (SCP_LIKE_URL_RE.test(trimmed)) {
    tail = trimmed.split(':').slice(1).join(':');
  } else {
    try {
      tail = new URL(trimmed).pathname;
    } catch {
      tail = trimmed;
    }
  }
  const last = tail.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
  return last.replace(/\.git$/i, '');
}

interface ClonePending {
  child: ReturnType<typeof spawn>;
  cancelled: boolean;
}
const clonesInFlight = new Map<string, ClonePending>();

/// Spawn `git clone --progress <url> <dest>` and stream stderr lines to
/// `onProgress`. Resolves with `{ ok, error?, cancelled? }`. Doesn't go
/// through the per-repo `withRepoLock` queue because the destination
/// isn't a repo yet; concurrency is bounded by the renderer instead.
export function cloneRepo(
  url: string,
  dest: string,
  opts: { cloneId: string; branch?: string; depth?: number },
  onProgress: (line: string) => void,
): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
  const args = ['clone', '--progress'];
  if (opts.branch && opts.branch.trim()) args.push('--branch', opts.branch.trim());
  if (opts.depth && opts.depth > 0) args.push('--depth', String(Math.floor(opts.depth)));
  args.push('--', url, dest);

  return new Promise((resolve) => {
    const child = spawn('git', args, { env: { ...process.env, ...NETWORK_ENV } });
    const pending: ClonePending = { child, cancelled: false };
    clonesInFlight.set(opts.cloneId, pending);

    let stderrTail = '';
    let buffer = '';
    const emitLines = (chunk: string) => {
      buffer += chunk;
      // git's --progress uses \r to update; treat both \r and \n as line breaks.
      let m: RegExpMatchArray | null;
      while ((m = buffer.match(/[\r\n]/))) {
        const idx = m.index ?? 0;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line) onProgress(line);
      }
    };
    child.stderr.on('data', (b: Buffer) => {
      const s = b.toString('utf8');
      stderrTail = (stderrTail + s).slice(-4096);
      emitLines(s);
    });
    child.stdout.on('data', (b: Buffer) => {
      // git clone is mostly silent on stdout but emit anything that does come.
      emitLines(b.toString('utf8'));
    });
    child.on('error', (err) => {
      clonesInFlight.delete(opts.cloneId);
      resolve({ ok: false, error: String(err) });
    });
    child.on('close', (code) => {
      clonesInFlight.delete(opts.cloneId);
      if (buffer) onProgress(buffer);
      if (pending.cancelled) {
        resolve({ ok: false, cancelled: true, error: 'Clone cancelled' });
        return;
      }
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const tail = stderrTail.trim().split(/\r?\n/).filter(Boolean).pop();
      resolve({ ok: false, error: tail || `git clone exited ${code}` });
    });
  });
}

export function cancelClone(cloneId: string): boolean {
  const pending = clonesInFlight.get(cloneId);
  if (!pending) return false;
  pending.cancelled = true;
  try {
    pending.child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  return true;
}

export async function initRepo(
  repoPath: string,
  opts: { initialBranch?: string },
): Promise<{ ok: boolean; error?: string }> {
  if (!fs.existsSync(repoPath)) return { ok: false, error: 'Folder does not exist' };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(repoPath);
  } catch (err) {
    return { ok: false, error: `Cannot stat folder (${String(err)})` };
  }
  if (!stat.isDirectory()) return { ok: false, error: 'Path is not a folder' };
  if (looksLikeRepo(repoPath)) return { ok: true };
  const args = ['init'];
  const branch = opts.initialBranch?.trim();
  if (branch) args.push('-b', branch);
  const r = await run(repoPath, args);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || `git init exited ${r.code}` };
  return { ok: true };
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
      worktreeAdds: null,
      worktreeDels: null,
      ahead: null,
      behind: null,
      hasUpstream: false,
      upstreamGone: false,
      aheadDefault: null,
      behindDefault: null,
      defaultRef: null,
      inProgress: null,
      conflicts: [],
      error: 'Not a git repo',
    };
  }

  // Status fan-out: HEAD branch, working-tree porcelain, upstream
  // distance, and diff shortstat are all independent reads of the
  // same repo state. Running them serially used to dominate
  // repo-open latency on big repos (each step is 50–500ms of git +
  // disk I/O). Fire in parallel — wall time is now max(steps), not
  // sum(steps). Concurrent git pressure is controlled by the outer
  // fan-out caps (`STATUS_CONCURRENCY=2` in the renderer, `pool(3, …)`
  // in worksetStatus), not by serializing here.
  //
  // Default-branch distance still depends on `branch` (to avoid
  // comparing HEAD to itself when on the default branch), so that
  // piece runs after the initial fan-out resolves.
  const [branchRes, porcelainRes, upstreamRes, shortstatRes] = await Promise.all([
    run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    run(repoPath, ['status', '--porcelain=v1']),
    run(repoPath, ['rev-list', '--left-right', '--count', '@{u}...HEAD']),
    run(repoPath, ['diff', '--shortstat', 'HEAD']),
  ]);

  const rawBranch = branchRes.stdout.trim();
  const branch = rawBranch && rawBranch !== 'HEAD' ? rawBranch : null;

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
  let hasUpstream = false;
  let upstreamGone = false;
  if (branch) {
    if (upstreamRes.ok) {
      hasUpstream = true;
      const [b, a] = upstreamRes.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
      if (Number.isFinite(b) && Number.isFinite(a)) {
        behind = b;
        ahead = a;
      }
    } else {
      // rev-list against @{u} fails for two distinct cases: (1) no
      // upstream ever configured, and (2) upstream was configured but
      // its remote-tracking ref is gone (merged + pruned). Tell them
      // apart by reading config directly — `branch.<name>.merge` sticks
      // around even after `git fetch --prune` removes the ref.
      const cfg = await run(repoPath, ['config', '--get', `branch.${branch}.merge`]);
      if (cfg.ok && cfg.stdout.trim().length > 0) upstreamGone = true;
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
    const [remoteExists, localExists] = await Promise.all([
      run(repoPath, ['show-ref', '--verify', '--quiet', remoteRef]),
      run(repoPath, ['show-ref', '--verify', '--quiet', localRef]),
    ]);
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

  // Working-tree +/- totals vs HEAD. `--shortstat` is one line:
  //   " 5 files changed, 47 insertions(+), 12 deletions(-)"
  // Either insertion or deletion clause can be missing — we parse
  // each independently and default to 0 when absent. Untracked files
  // aren't included; that's `git diff` semantics, not a bug.
  let worktreeAdds: number | null = null;
  let worktreeDels: number | null = null;
  if (branch && shortstatRes.ok) {
    const out = shortstatRes.stdout;
    const ins = out.match(/(\d+)\s+insertion/);
    const del = out.match(/(\d+)\s+deletion/);
    if (ins || del) {
      worktreeAdds = ins ? Number.parseInt(ins[1], 10) : 0;
      worktreeDels = del ? Number.parseInt(del[1], 10) : 0;
    } else if (/files? changed/.test(out)) {
      worktreeAdds = 0;
      worktreeDels = 0;
    }
  }

  return {
    repoId,
    branch,
    dirtyCount,
    worktreeAdds,
    worktreeDels,
    ahead,
    behind,
    hasUpstream,
    upstreamGone,
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

/// Parse `git worktree list --porcelain` into structured rows. Output
/// is a sequence of stanzas separated by blank lines, where each stanza
/// looks like:
///
///   worktree /abs/path
///   HEAD <sha>
///   branch refs/heads/<name>     // present only when on a branch
///   bare                         // present for the bare main worktree
///   detached                     // present in detached-HEAD state
///   locked [reason…]             // optional
///   prunable [reason…]           // optional
///
/// We deliberately skip `bare` worktrees: overgit assumes a working
/// tree, and showing a bare repo in the per-repo worktree list would be
/// misleading.
export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  if (!looksLikeRepo(repoPath)) return [];
  const res = await run(repoPath, ['worktree', 'list', '--porcelain']);
  if (!res.ok) return [];
  const stanzas = res.stdout.split(/\n\n+/);
  const out: Worktree[] = [];
  for (const stanza of stanzas) {
    if (!stanza.trim()) continue;
    let path = '';
    let head: string | null = null;
    let branch: string | null = null;
    let bare = false;
    let locked = false;
    let prunable = false;
    for (const line of stanza.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('worktree ')) path = trimmed.slice('worktree '.length);
      else if (trimmed.startsWith('HEAD ')) head = trimmed.slice('HEAD '.length).trim() || null;
      else if (trimmed.startsWith('branch ')) {
        const ref = trimmed.slice('branch '.length).trim();
        branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      } else if (trimmed === 'bare') bare = true;
      else if (trimmed === 'detached') branch = null;
      else if (trimmed === 'locked' || trimmed.startsWith('locked ')) locked = true;
      else if (trimmed === 'prunable' || trimmed.startsWith('prunable ')) prunable = true;
    }
    if (!path || bare) continue;
    out.push({
      path,
      head,
      branch,
      // The main worktree is the one with the same path as the repo we
      // queried — git always lists it first, but we infer it from the
      // path so the call site works for any repoPath that resolves to
      // the same canonical location.
      isMain: pathsEqual(path, repoPath),
      locked,
      prunable,
    });
  }
  return out;
}

function pathsEqual(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
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

/// Resolve a possibly-miscased branch name to its canonical case by
/// scanning the repo's local heads and `origin/` remote refs. Git
/// itself treats refs as case-sensitive, but on case-insensitive
/// filesystems (macOS APFS) and in casual team usage, a user typing
/// `feature/ib-56` usually means `feature/IB-56`. Returns the actual
/// ref name when a case-insensitive match exists, else null.
async function resolveBranchCase(
  repoPath: string,
  branch: string,
): Promise<string | null> {
  const refs = await run(repoPath, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes/origin',
  ]);
  if (!refs.ok) return null;
  const target = branch.toLowerCase();
  for (const line of refs.stdout.split('\n')) {
    const ref = line.trim();
    if (!ref) continue;
    let name = '';
    if (ref.startsWith('refs/heads/')) name = ref.slice('refs/heads/'.length);
    else if (ref.startsWith('refs/remotes/origin/')) name = ref.slice('refs/remotes/origin/'.length);
    else continue;
    if (name === branch) return name;
    if (name.toLowerCase() === target) return name;
  }
  return null;
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

  let target = branch;
  const head = await run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.ok && head.stdout.trim() === target) {
    return { repoId, result: 'already-on-branch', branch: target };
  }

  // `show-ref --verify --quiet refs/heads/<branch>` is the cheapest
  // existence test for a local branch. Falls back to a remote-tracking
  // ref so the user can switch to a branch they've fetched but not yet
  // checked out locally.
  let localExists = await run(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${target}`]);
  let remoteExists = await run(repoPath, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${target}`,
  ]);

  // Case-insensitive fallback: if neither the typed-case local nor
  // remote ref exists, look across known refs for a case-insensitive
  // match and rebind `target` to the canonical name. This catches the
  // common "user typed `feature/ib-56`, repo has `feature/IB-56`" case
  // without making git's case-sensitive ref model leak into the UI.
  if (!localExists.ok && !remoteExists.ok) {
    const resolved = await resolveBranchCase(repoPath, target);
    if (resolved && resolved !== target) {
      target = resolved;
      if (head.ok && head.stdout.trim() === target) {
        return { repoId, result: 'already-on-branch', branch: target };
      }
      localExists = await run(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${target}`]);
      remoteExists = await run(repoPath, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${target}`,
      ]);
    }
  }

  // Cache miss: ask the actual remote whether it has this branch. A
  // freshly-added repo has no remote-tracking refs until something is
  // fetched, so without this probe a workset checkout would falsely
  // report `missing-branch` for a branch that exists on origin.
  if (!localExists.ok && !remoteExists.ok) {
    const ls = await run(repoPath, ['ls-remote', '--heads', 'origin', target], undefined, NETWORK_TIMEOUT_MS);
    if (ls.ok && ls.stdout.trim().length > 0) {
      const fetchRes = await run(repoPath, ['fetch', 'origin', target], undefined, NETWORK_TIMEOUT_MS);
      if (fetchRes.ok) {
        remoteExists = await run(repoPath, [
          'show-ref',
          '--verify',
          '--quiet',
          `refs/remotes/origin/${target}`,
        ]);
      }
    }
  }

  if (!localExists.ok && !remoteExists.ok) {
    if (!createIfMissing) {
      return { repoId, result: 'missing-branch', branch: target };
    }
    const create = await run(repoPath, ['checkout', '-b', target]);
    if (create.ok) return { repoId, result: 'switched', branch: target };
    return classifyFailure(repoId, target, create);
  }

  // `git switch` refuses to clobber local changes; that's exactly what we
  // want. We use `switch` over `checkout` so the dirty-tree case is
  // unambiguous: switch never silently merges, while plain `checkout`
  // sometimes does.
  //
  // When the local branch is missing, the start-point must be a real ref —
  // `--track <branch>` looks up `<branch>` as a ref, and a bare branch
  // name only resolves to the remote-tracking ref via DWIM. Be explicit
  // with `origin/<branch>` so git doesn't bail with "invalid reference".
  const switchRes = localExists.ok
    ? await run(repoPath, ['switch', target])
    : await run(repoPath, ['switch', '-c', target, '--track', `origin/${target}`]);
  if (switchRes.ok) return { repoId, result: 'switched', branch: target };
  return classifyFailure(repoId, target, switchRes);
}

/// Move a linked worktree's branch into the main checkout. Optionally
/// commits whatever's dirty inside the linked worktree first, so the
/// user doesn't have to choose between losing work and aborting the
/// switch. Then removes the linked worktree (because git refuses to
/// check out a branch that's already in use) and runs `git switch` in
/// the main repo.
///
/// Refuses to touch a dirty main checkout — silently stashing the
/// user's working tree on a button click is too easy to mistake for
/// "nothing happened." For the *worktree* side, the user picks one of:
///   - `commitMessage` set → `git add -A && git commit` runs in the
///     worktree before remove (so the changes survive as a real
///     commit on the worktree's branch).
///   - `forceRemove` true → `git worktree remove --force` discards any
///     uncommitted changes in the worktree directory.
///   - Neither → assume the worktree is clean; remove will fail loudly
///     if it isn't.
export async function adoptWorktreeBranch(
  repoPath: string,
  worktreePath: string,
  branch: string,
  forceRemove: boolean,
  commitMessage?: string,
  identity?: Identity,
): Promise<
  { ok: true } | { ok: false; step: 'precheck' | 'commit' | 'remove' | 'checkout'; error: string }
> {
  if (!looksLikeRepo(repoPath)) {
    return { ok: false, step: 'precheck', error: 'Not a git repo' };
  }
  // Refuse to clobber the main checkout. The user's `git status` output
  // is a better place to see what they need to commit/stash than this
  // dialog box.
  const mainStatus = await run(repoPath, ['status', '--porcelain=v1']);
  if (mainStatus.ok && mainStatus.stdout.trim().length > 0) {
    return {
      ok: false,
      step: 'precheck',
      error:
        'Main checkout has uncommitted changes. Commit, stash, or discard them in the Changes tab first.',
    };
  }
  // Sanity-check that the path we're about to remove is actually one of
  // this repo's worktrees — protects against a stale store entry being
  // passed in.
  const list = await run(repoPath, ['worktree', 'list', '--porcelain']);
  if (!list.ok) {
    return { ok: false, step: 'precheck', error: list.stderr.trim() || 'Could not list worktrees' };
  }
  const known = list.stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim());
  if (!known.includes(worktreePath)) {
    return {
      ok: false,
      step: 'precheck',
      error: `Worktree not found at ${worktreePath}. Refresh and retry.`,
    };
  }
  if (commitMessage !== undefined) {
    if (!commitMessage.trim()) {
      return { ok: false, step: 'precheck', error: 'Commit message required' };
    }
    // Check whether the worktree actually has changes. A commit with
    // nothing staged would fail with "nothing to commit" — we want
    // that to be a no-op, not an error, since the user's intent
    // ("commit anything dirty, then switch") is satisfied either way.
    const wtStatus = await run(worktreePath, ['status', '--porcelain=v1']);
    const dirty = wtStatus.ok && wtStatus.stdout.trim().length > 0;
    if (dirty) {
      const commitRes = await commitAll(worktreePath, commitMessage.trim(), identity);
      if (!commitRes.ok) {
        return {
          ok: false,
          step: 'commit',
          error: commitRes.error ?? 'Commit in worktree failed',
        };
      }
    }
  }
  const removeArgs = ['worktree', 'remove', worktreePath];
  if (forceRemove) removeArgs.push('--force');
  const remove = await run(repoPath, removeArgs);
  if (!remove.ok) {
    return {
      ok: false,
      step: 'remove',
      error: remove.stderr.trim() || `git worktree remove exited ${remove.code}`,
    };
  }
  const switchRes = await run(repoPath, ['switch', branch]);
  if (!switchRes.ok) {
    return {
      ok: false,
      step: 'checkout',
      error:
        switchRes.stderr.trim() ||
        `git switch exited ${switchRes.code}. The worktree was removed; ${branch} is the dangling local branch.`,
    };
  }
  return { ok: true };
}

/// `git worktree remove <path>`. Refuses without --force if the
/// worktree is dirty or has unpushed commits, so the renderer surfaces
/// the failure inline and offers a force option rather than silently
/// destroying work.
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  const res = await run(repoPath, args);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git worktree remove exited ${res.code}` };
}

/// `git worktree prune`. Cleans up administrative entries for
/// worktrees whose directories were deleted out from under git.
export async function pruneWorktrees(
  repoPath: string,
): Promise<{ ok: boolean; error?: string; output?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const res = await run(repoPath, ['worktree', 'prune', '--verbose']);
  if (res.ok) return { ok: true, output: res.stdout.trim() };
  return { ok: false, error: res.stderr.trim() || `git worktree prune exited ${res.code}` };
}

function classifyFailure(repoId: UUID, branch: string, r: RunResult): CheckoutOutcome {
  const combined = `${r.stdout}\n${r.stderr}`;
  const text = combined.toLowerCase();
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
  // `fatal: 'feature/x' is already checked out at '/path/to/worktree'`
  // — a sibling worktree already owns the branch. We surface the path
  // so the renderer can offer to adopt (remove the worktree, switch in
  // main) without the user hand-running git.
  const wt = /already checked out at ['"]([^'"]+)['"]/i.exec(combined);
  if (wt) {
    return {
      repoId,
      result: 'worktree-conflict',
      branch,
      message: r.stderr.trim(),
      worktreePath: wt[1],
    };
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
  paths?: string[],
): Promise<{ ok: boolean; text: string; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, text: '', error: 'Not a git repo' };
  // When the renderer passes an explicit path list, diff those paths
  // against HEAD regardless of `scope`. This mirrors what the eventual
  // commit will contain in select-vs-stage mode, where the user's
  // checkboxes drive the commit content rather than git's index. We
  // include both staged and unstaged hunks for those files because the
  // commit-time staging sync will roll them all in.
  if (paths && paths.length > 0) {
    const res = await run(repoPath, ['diff', '--no-color', 'HEAD', '--', ...paths]);
    if (!res.ok) {
      return { ok: false, text: '', error: res.stderr.trim() || `git exited ${res.code}` };
    }
    return { ok: true, text: res.stdout };
  }
  const args = scope === 'staged'
    ? ['diff', '--cached', '--no-color']
    : ['diff', '--no-color', 'HEAD'];
  const res = await run(repoPath, args);
  if (!res.ok) {
    return { ok: false, text: '', error: res.stderr.trim() || `git exited ${res.code}` };
  }
  return { ok: true, text: res.stdout };
}

/// Shortstat summary of working-tree changes — used as a fallback when
/// a full diff is too large to send to an LLM CLI. Returns the raw
/// `<files> changed, <ins> insertions(+), <dels> deletions(-)` line plus
/// the per-file stat block, which together still give the model useful
/// signal about scope.
export async function diffStat(
  repoPath: string,
): Promise<{ ok: boolean; text: string; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, text: '', error: 'Not a git repo' };
  const res = await run(repoPath, ['diff', '--stat', '--no-color', 'HEAD']);
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
  // 45s is plenty for a normal fetch; a stalled connection should
  // surface fast so the workspace flow can move on to the next repo.
  const FETCH_TIMEOUT_MS = 45_000;
  const res = await run(
    repoPath,
    ['fetch', '--all', '--prune'],
    NETWORK_ENV,
    FETCH_TIMEOUT_MS,
  );
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

/// Cheap "what is HEAD pointing at" lookup for the Changes-tab Amend
/// toggle. A full graph fetch is ~50–500ms on big repos because of the
/// `--all --topo-order` walk plus the trunk-set scan plus lane layout;
/// this single `git log -1` shaves all of that when the user only
/// needs the most recent commit's metadata.
export async function headCommit(repoPath: string): Promise<Commit | null> {
  if (!looksLikeRepo(repoPath)) return null;
  const res = await run(repoPath, ['log', '-1', `--pretty=format:${LOG_FORMAT}`]);
  if (!res.ok) return null;
  const record = res.stdout.split('\x1e')[0]?.replace(/^\s+|\s+$/g, '') ?? '';
  if (!record) return null;
  const [sha, shortSha, parents, subject, author, authorEmail, date, body] =
    record.split('\x1f');
  if (!sha) return null;
  return {
    sha,
    shortSha: shortSha ?? sha.slice(0, 7),
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    subject: subject ?? '',
    author: author ?? '',
    authorEmail: authorEmail ?? '',
    date: date ?? '',
    body: (body ?? '').trim(),
  };
}

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

/// `git log --follow -- <path>` for one file. `--follow` walks
/// through renames so the result includes commits from before the file
/// was at its current path; we record the path each commit knew the
/// file by so the renderer can show "old/path → new/path" on rename
/// commits. Same x1f/x1e record framing as the regular `log` for
/// consistency, plus a `%n` for the path-at-commit (filled in via
/// --name-only).
const FILE_LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e';

export async function fileLog(
  repoPath: string,
  relPath: string,
  limit = 200,
): Promise<FileLogCommit[]> {
  if (!looksLikeRepo(repoPath)) return [];
  // `--name-only` after the format makes git emit the file's path on
  // its own line per record; we parse the path off each record's tail.
  // `--follow` is required for the rename-walking behavior. It only
  // works with a single pathspec, which is what we always pass here.
  const res = await run(repoPath, [
    'log',
    '--follow',
    `-${Math.max(1, Math.min(limit, 1000))}`,
    `--pretty=format:${FILE_LOG_FORMAT}`,
    '--name-only',
    '--',
    relPath,
  ]);
  if (!res.ok) return [];
  const out: FileLogCommit[] = [];
  for (const record of res.stdout.split('\x1e')) {
    const trimmed = record.replace(/^\s+|\s+$/g, '');
    if (!trimmed) continue;
    // Split off the trailing path (everything after the final field of
    // the format). `--name-only` puts the path on its own line, so we
    // peel the last non-empty line as the path and parse the head as
    // the format fields.
    const lines = trimmed.split('\n');
    const pathAtCommit = lines.pop()?.trim() ?? relPath;
    const head = lines.join('\n');
    const [sha, shortSha, author, authorEmail, authorDate, subject] =
      head.split('\x1f');
    if (!sha) continue;
    out.push({
      sha,
      shortSha: shortSha ?? sha.slice(0, 7),
      author: author ?? '',
      authorEmail: authorEmail ?? '',
      authorDate: authorDate ?? '',
      subject: subject ?? '',
      pathAtCommit,
    });
  }
  return out;
}

/// `git blame --porcelain` for one file. The porcelain format is:
///   <sha> <orig-line> <final-line> [<lines-in-this-group>]
///   author <name>
///   author-mail <<email>>
///   author-time <unix-ts>
///   author-tz <+/-HHMM>
///   ...
///   summary <commit subject>
///   filename <repo-rel path>
///   <TAB><file content of this line>
///
/// Subsequent groups attributed to the same sha omit the metadata
/// lines, so we cache them per sha while iterating. We surface only the
/// fields we render; the rest can be added later.
export async function blameFile(
  repoPath: string,
  relPath: string,
): Promise<BlameLine[]> {
  if (!looksLikeRepo(repoPath)) return [];
  const res = await run(repoPath, ['blame', '--porcelain', '--', relPath]);
  if (!res.ok) return [];
  const out: BlameLine[] = [];
  const meta = new Map<
    string,
    { author: string; authorEmail: string; authorDate: string; summary: string }
  >();
  let current: {
    sha: string;
    finalLine: number;
    author?: string;
    authorEmail?: string;
    authorTime?: string;
    summary?: string;
  } | null = null;

  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('\t')) {
      // Content line. Flush the current group with whatever we have,
      // falling back to the cached metadata for repeated shas.
      if (current) {
        const cached = meta.get(current.sha);
        const author = current.author ?? cached?.author ?? '';
        const authorEmail = current.authorEmail ?? cached?.authorEmail ?? '';
        const authorTime = current.authorTime ?? '';
        const authorDate =
          authorTime !== ''
            ? new Date(Number.parseInt(authorTime, 10) * 1000).toISOString()
            : (cached?.authorDate ?? '');
        const summary = current.summary ?? cached?.summary ?? '';
        // Cache the per-sha metadata so subsequent groups attributed
        // to the same commit can render the same gutter without git
        // having to repeat them.
        if (!meta.has(current.sha)) {
          meta.set(current.sha, { author, authorEmail, authorDate, summary });
        }
        out.push({
          lineNumber: current.finalLine,
          content: line.slice(1),
          sha: current.sha,
          shortSha: current.sha.slice(0, 7),
          author,
          authorEmail,
          authorDate,
          summary,
        });
      }
      current = null;
      continue;
    }

    const headMatch = /^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+\d+)?\s*$/.exec(line);
    if (headMatch) {
      // New group header. The "final" line number is the third field —
      // that's what we use for rendering since our gutter mirrors the
      // file at HEAD. Until we hit the content TAB line we collect
      // metadata into `current`.
      current = {
        sha: headMatch[1],
        finalLine: Number.parseInt(headMatch[3], 10),
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('author ')) current.author = line.slice('author '.length);
    else if (line.startsWith('author-mail ')) {
      const raw = line.slice('author-mail '.length).trim();
      current.authorEmail = raw.replace(/^<|>$/g, '');
    } else if (line.startsWith('author-time ')) {
      current.authorTime = line.slice('author-time '.length).trim();
    } else if (line.startsWith('summary ')) {
      current.summary = line.slice('summary '.length);
    }
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
  // blocks during a workset checkout) are stashed instead of being
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

  // Content-merge conflicts ("CONFLICT (content): Merge conflict in foo")
  // print to STDOUT, not stderr — and stderr in that case is often
  // empty or just "error: could not restore index from stash". Without
  // pulling stdout in, the renderer just shows "git stash exited 1".
  // We surface the conflicting files and tell the user the stash
  // partially applied so they know to resolve markers in place. The
  // stash entry is preserved by git in this case (apply OR pop), so
  // we don't conflate this with the untracked-file collision case
  // that the force-overwrite affordance is built for.
  const contentConflicts = parseContentConflicts(res.stdout);
  if (contentConflicts.length) {
    const list = contentConflicts.map((p) => `  • ${p}`).join('\n');
    return {
      ok: false,
      error:
        `Stash applied with conflicts in:\n${list}\n\n` +
        `Resolve the conflict markers, then \`git add\` each file. ` +
        `The stash entry is still in your list — drop it once you're happy.`,
    };
  }

  const stderr = res.stderr.trim() || res.stdout.trim() || `git stash exited ${res.code}`;
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

function parseContentConflicts(stdout: string): string[] {
  // `git stash apply` writes "CONFLICT (content): Merge conflict in <path>"
  // to stdout for each file with merge conflicts. Some conflict types
  // use different parenthetical tags (add/add, modify/delete) — we
  // accept any "CONFLICT (...): ... in <path>" shape.
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^CONFLICT \([^)]+\):.* in (.+)$/);
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
): Promise<{ ok: boolean; error?: string; output?: string; alreadyUpToDate?: boolean }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!branch || /[\s;|`$]/.test(branch)) {
    return { ok: false, error: `Refusing to merge "${branch}"` };
  }
  const flag =
    mode === 'merge' ? '--no-ff' : mode === 'ff-only' ? '--ff-only' : '--squash';
  // `--no-edit` keeps git from spawning an editor for the default merge
  // commit message — Electron child processes have no TTY, so the editor
  // would either hang or silently fail. Belt-and-suspenders: also pin
  // GIT_MERGE_AUTOEDIT=no so any older git that ignores --no-edit still
  // takes the default message.
  const args =
    mode === 'squash' ? ['merge', flag, branch] : ['merge', flag, '--no-edit', branch];
  const res = await run(repoPath, args, { GIT_MERGE_AUTOEDIT: 'no' });
  const output = (res.stdout + res.stderr).trim();
  if (res.ok) {
    const alreadyUpToDate = /already up[\s-]?to[\s-]?date/i.test(output);
    return { ok: true, output, alreadyUpToDate };
  }
  return { ok: false, error: res.stderr.trim() || `git merge exited ${res.code}`, output };
}

/// Resolve a conflicted path by checking out one side wholesale and
/// staging the result. Mirrors `git checkout --ours/--theirs <path>`
/// followed by `git add <path>`.
export async function resolveConflictSide(
  repoPath: string,
  path: string,
  side: 'ours' | 'theirs',
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!path.trim()) return { ok: false, error: 'Path required' };
  const flag = side === 'ours' ? '--ours' : '--theirs';
  const co = await run(repoPath, ['checkout', flag, '--', path]);
  if (!co.ok) {
    return { ok: false, error: co.stderr.trim() || `git checkout ${flag} exited ${co.code}` };
  }
  const add = await run(repoPath, ['add', '--', path]);
  if (!add.ok) {
    return { ok: false, error: add.stderr.trim() || `git add exited ${add.code}` };
  }
  return { ok: true };
}

/// Read `.git/MERGE_MSG`. Returns `message: null` (not an error) when
/// the file doesn't exist — that's the no-merge-in-progress state.
export async function readMergeMsg(
  repoPath: string,
): Promise<{ ok: boolean; message: string | null; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, message: null, error: 'Not a git repo' };
  // `git rev-parse --git-path MERGE_MSG` resolves through worktrees and
  // submodules — preferable to hardcoding `<repo>/.git/MERGE_MSG`.
  const pathRes = await run(repoPath, ['rev-parse', '--git-path', 'MERGE_MSG']);
  if (!pathRes.ok) return { ok: true, message: null };
  const fp = pathRes.stdout.trim();
  if (!fp) return { ok: true, message: null };
  try {
    const fs = await import('node:fs/promises');
    const buf = await fs.readFile(fp, 'utf8');
    return { ok: true, message: buf };
  } catch {
    return { ok: true, message: null };
  }
}

/// Finalize an in-progress merge: `git commit --no-edit` uses MERGE_MSG
/// as written. When the user supplied a custom message we pass `-m`
/// instead so their text wins.
export async function commitMerge(
  repoPath: string,
  message: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const args =
    message && message.trim()
      ? ['commit', '-m', message]
      : ['commit', '--no-edit'];
  const res = await run(repoPath, args, { GIT_EDITOR: 'true' });
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git commit exited ${res.code}` };
}

export async function abortMerge(
  repoPath: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const res = await run(repoPath, ['merge', '--abort']);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git merge --abort exited ${res.code}` };
}

/// Short commit summaries from each side of an in-progress merge. Used
/// to give an LLM the intent of recent work when asking it to resolve
/// a conflict — the diff alone often isn't enough to choose a side.
/// Returns `null` for either side if MERGE_HEAD isn't present or git
/// errors out; callers should treat that as "no extra context available"
/// rather than fatal.
export async function mergeSideLogs(
  repoPath: string,
  limit = 10,
): Promise<{ ours: string[] | null; theirs: string[] | null }> {
  if (!looksLikeRepo(repoPath)) return { ours: null, theirs: null };
  const fmt = '%h %s';
  const [oursRes, theirsRes] = await Promise.all([
    run(repoPath, ['log', `-n${limit}`, `--pretty=format:${fmt}`, 'MERGE_HEAD..HEAD']),
    run(repoPath, ['log', `-n${limit}`, `--pretty=format:${fmt}`, 'HEAD..MERGE_HEAD']),
  ]);
  const lines = (r: RunResult) =>
    r.ok ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : null;
  return { ours: lines(oursRes), theirs: lines(theirsRes) };
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
  identity?: Identity,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const args = ['commit', '--amend'];
  if (message === null) args.push('--no-edit');
  else if (!message.trim()) return { ok: false, error: 'Commit message required' };
  else args.push('-m', message.trim());
  // Amend with an identity override needs --reset-author too — without
  // it, git reuses the original author and only the committer fields
  // (which the user can't see in the log) reflect the env. The user
  // expects "amend as me" to update what's visible in `git log`.
  if (identity) args.push('--reset-author');
  const res = await run(repoPath, args, identityEnv(identity));
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git commit --amend exited ${res.code}` };
}

export async function commitAll(
  repoPath: string,
  message: string,
  identity?: Identity,
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
  const commitRes = await run(repoPath, ['commit', '-m', message.trim()], identityEnv(identity));
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
  // `-uall` expands untracked directories into individual file records.
  // Without it, git collapses an untracked dir into one entry (with a
  // trailing slash), which both hides the per-file changes and breaks
  // "View" — clicking the entry tried to read a directory as a file
  // and surfaced raw EISDIR in the editor pane.
  const res = await run(repoPath, ['status', '--porcelain=v1', '-uall', '-z']);
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

/// Undo the most recent commit while preserving the working tree and
/// keeping the changes staged — `git reset --soft HEAD~1`. Caller is
/// expected to gate on "unpushed only" (we don't check ahead/behind
/// here so this stays a pure local op the caller can also use after a
/// confirm-then-force-push flow). Refuses on the initial commit
/// because HEAD~1 doesn't resolve there.
export async function undoLastCommit(
  repoPath: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const parent = await run(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD~1']);
  if (!parent.ok) return { ok: false, error: 'No previous commit to undo to' };
  const res = await run(repoPath, ['reset', '--soft', 'HEAD~1']);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git reset exited ${res.code}` };
}

/// Commit ONLY what's currently staged. Distinct from `commitAll`, which
/// stages everything first. The renderer's Changes pane drives staging
/// explicitly, so this is the precise commit users expect.
export async function commitStaged(
  repoPath: string,
  message: string,
  identity?: Identity,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!message.trim()) return { ok: false, error: 'Commit message required' };
  const res = await run(repoPath, ['commit', '-m', message.trim()], identityEnv(identity));
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git commit exited ${res.code}` };
}

export async function hasUpstream(repoPath: string): Promise<boolean> {
  // `rev-parse --abbrev-ref @{upstream}` exits 0 with the upstream name
  // when one is configured, and exits non-zero otherwise. The cheapest
  // existence test for upstream tracking.
  const res = await run(repoPath, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  return res.ok && res.stdout.trim().length > 0;
}

/// Push the current branch. The success result reports whether we had
/// to set the upstream on this push — workset push-all surfaces that
/// distinctly so the user knows tracking was just wired ("first push to
/// origin/feature/x"). Single-repo callers that don't care just ignore
/// the extra field.
export async function push(
  repoPath: string,
): Promise<{ ok: true; setUpstream: boolean } | { ok: false; error: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (await hasUpstream(repoPath)) {
    const res = await run(repoPath, ['push'], NETWORK_ENV, NETWORK_TIMEOUT_MS);
    if (res.ok) return { ok: true, setUpstream: false };
    return { ok: false, error: res.stderr.trim() || `git push exited ${res.code}` };
  }
  // No upstream: set it on the first push so subsequent pushes/pulls
  // work without ceremony. We push to `origin` because that's the
  // overwhelming default; users with a different remote setup can run
  // `git push -u <remote> HEAD` themselves once.
  const res = await run(repoPath, ['push', '-u', 'origin', 'HEAD'], NETWORK_ENV, NETWORK_TIMEOUT_MS);
  if (res.ok) return { ok: true, setUpstream: true };
  return { ok: false, error: res.stderr.trim() || `git push exited ${res.code}` };
}

/// Safe sync: fast-forward the current branch to `origin/<branch>`
/// using a targeted `git merge --ff-only refs/remotes/origin/<branch>`.
/// Deliberately avoids `git pull` — pull reads FETCH_HEAD and gets
/// confused on this user's setup ("Cannot fast-forward to multiple
/// branches" / "not something we can merge"); targeting one ref
/// directly is deterministic. Divergence is detected ahead of the
/// merge via rev-list so we can return a clean `diverged: true`
/// instead of a generic FF-refused stderr.
export async function pullFastForward(
  repoPath: string,
): Promise<{
  ok: boolean;
  error?: string;
  alreadyUpToDate?: boolean;
  diverged?: boolean;
}> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  // 1. Current branch (refuse on detached HEAD).
  const head = await run(repoPath, [
    'symbolic-ref',
    '--short',
    '--quiet',
    'HEAD',
  ]);
  if (!head.ok || !head.stdout.trim()) {
    return { ok: false, error: 'Detached HEAD — no upstream to sync.' };
  }
  const branch = head.stdout.trim();
  // 2. Refresh origin's view of this branch. Targeted fetch — no
  // --all — so FETCH_HEAD ends up with at most one entry and the
  // remote-tracking ref we're about to merge against is fresh.
  const fetchRes = await run(
    repoPath,
    ['fetch', 'origin', branch],
    NETWORK_ENV,
    NETWORK_TIMEOUT_MS,
  );
  if (!fetchRes.ok) {
    return {
      ok: false,
      error: fetchRes.stderr.trim() || `git fetch exited ${fetchRes.code}`,
    };
  }
  // 3. Verify the remote-tracking ref now exists.
  const remoteRef = `refs/remotes/origin/${branch}`;
  const remoteCheck = await run(repoPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    remoteRef,
  ]);
  if (!remoteCheck.ok) {
    return {
      ok: false,
      error: `origin/${branch} not found after fetch — branch may have been deleted upstream.`,
    };
  }
  // 4. Diverged? Local has commits not on origin.
  const ahead = await run(repoPath, [
    'rev-list',
    '--count',
    `${remoteRef}..refs/heads/${branch}`,
  ]);
  const aheadN = ahead.ok ? parseInt(ahead.stdout.trim(), 10) || 0 : 0;
  if (aheadN > 0) {
    return {
      ok: false,
      diverged: true,
      error: `Local has ${aheadN} ${aheadN === 1 ? 'commit' : 'commits'} not on origin/${branch} — fast-forward refused.`,
    };
  }
  // 5. Already up to date? No-op so the renderer can label it.
  const behind = await run(repoPath, [
    'rev-list',
    '--count',
    `refs/heads/${branch}..${remoteRef}`,
  ]);
  const behindN = behind.ok ? parseInt(behind.stdout.trim(), 10) || 0 : 0;
  if (behindN === 0) return { ok: true, alreadyUpToDate: true };
  // 6. Merge --ff-only against the specific remote-tracking ref. No
  // FETCH_HEAD involved.
  const merge = await run(repoPath, ['merge', '--ff-only', remoteRef]);
  if (!merge.ok) {
    return {
      ok: false,
      error: merge.stderr.trim() || `git merge --ff-only exited ${merge.code}`,
    };
  }
  return { ok: true };
}

export async function pull(
  repoPath: string,
): Promise<{ ok: boolean; error?: string; conflicts?: string[] }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };

  // No upstream? Wire it up to origin/<branch> if that ref exists so
  // the user doesn't get the cryptic "no tracking information" wall
  // of text. Mirrors push()'s "first push sets tracking" behavior.
  if (!(await hasUpstream(repoPath))) {
    const head = await run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = head.ok ? head.stdout.trim() : '';
    if (!branch || branch === 'HEAD') {
      return { ok: false, error: 'No branch checked out (detached HEAD).' };
    }
    const remoteRef = await run(repoPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${branch}`,
    ]);
    if (!remoteRef.ok) {
      return {
        ok: false,
        error: `No upstream for "${branch}", and origin has no branch with that name. Push first to create it.`,
      };
    }
    const setUp = await run(repoPath, [
      'branch',
      `--set-upstream-to=origin/${branch}`,
      branch,
    ]);
    if (!setUp.ok) {
      return {
        ok: false,
        error: setUp.stderr.trim() || `git branch --set-upstream-to exited ${setUp.code}`,
      };
    }
  }

  const res = await run(repoPath, ['pull', '--no-rebase'], NETWORK_ENV, NETWORK_TIMEOUT_MS);
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

  const pullRes = await run(repoPath, ['pull', '--no-rebase'], NETWORK_ENV, NETWORK_TIMEOUT_MS);
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

/// "Throw away local commits + dirty tree and snap to upstream." Used by
/// the Abandon-local-commits flow when the user accidentally committed
/// to a protected branch (or otherwise wants a hard reset). When
/// `backupBranch` is set we create it first so the discarded commits
/// stay reachable via `git branch backup/…` instead of relying on the
/// reflog. Steps run in this order so a failure leaves the user in a
/// state they can reason about:
///   1. (optional) create the backup branch off HEAD
///   2. fetch the remote (default origin) so upstream tracks current tip
///   3. hard-reset to the upstream ref
///   4. (optional) `git clean -fd` to drop untracked files
/// `upstreamRef` is the symbolic upstream we should snap to (e.g.
/// `origin/master`). The renderer resolves it from `@{upstream}` before
/// the call so the user can see exactly what they're resetting to in
/// the confirmation UI.
export async function resetToUpstream(
  repoPath: string,
  args: {
    upstreamRef: string;
    backupBranch?: string;
    cleanUntracked?: boolean;
  },
): Promise<{
  ok: boolean;
  step?: 'backup' | 'fetch' | 'reset' | 'clean';
  error?: string;
  backupBranch?: string;
}> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const { upstreamRef, backupBranch, cleanUntracked } = args;
  if (!upstreamRef.trim()) {
    return { ok: false, error: 'Missing upstream ref.' };
  }

  if (backupBranch && backupBranch.trim()) {
    const created = await createBranch(repoPath, backupBranch.trim(), false);
    if (!created.ok) {
      return { ok: false, step: 'backup', error: created.error };
    }
  }

  const fetched = await run(
    repoPath,
    ['fetch', '--prune'],
    undefined,
    NETWORK_TIMEOUT_MS,
  );
  if (!fetched.ok) {
    return {
      ok: false,
      step: 'fetch',
      error: fetched.stderr.trim() || `git fetch exited ${fetched.code}`,
    };
  }

  const reset = await run(repoPath, ['reset', '--hard', upstreamRef]);
  if (!reset.ok) {
    return {
      ok: false,
      step: 'reset',
      error: reset.stderr.trim() || `git reset exited ${reset.code}`,
    };
  }

  if (cleanUntracked) {
    const cleaned = await run(repoPath, ['clean', '-fd']);
    if (!cleaned.ok) {
      return {
        ok: false,
        step: 'clean',
        error: cleaned.stderr.trim() || `git clean exited ${cleaned.code}`,
      };
    }
  }

  return {
    ok: true,
    backupBranch: backupBranch?.trim() || undefined,
  };
}

/// What the user is about to throw away when they abandon local commits:
/// the upstream we'd snap to, the unpushed commits, and a summary of any
/// dirty tree changes. Used to populate the Abandon-local-commits sheet
/// so the user sees exactly what's at stake before they click Reset.
export async function abandonLocalPreview(
  repoPath: string,
): Promise<{
  upstream: string | null;
  unpushed: { sha: string; shortSha: string; subject: string; author: string }[];
  dirtyFiles: { path: string; indexStatus: string; worktreeStatus: string }[];
  diffStat: string;
}> {
  if (!looksLikeRepo(repoPath)) {
    return { upstream: null, unpushed: [], dirtyFiles: [], diffStat: '' };
  }
  const upRes = await run(repoPath, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  const upstream = upRes.ok ? upRes.stdout.trim() || null : null;

  const unpushed: {
    sha: string;
    shortSha: string;
    subject: string;
    author: string;
  }[] = [];
  if (upstream) {
    const logRes = await run(repoPath, [
      'log',
      '@{upstream}..HEAD',
      '--pretty=format:%H%x1f%h%x1f%s%x1f%an',
    ]);
    if (logRes.ok) {
      for (const line of logRes.stdout.split('\n')) {
        if (!line.trim()) continue;
        const [sha, shortSha, subject, author] = line.split('\x1f');
        unpushed.push({ sha, shortSha, subject, author });
      }
    }
  }

  const statRes = await run(repoPath, ['status', '--porcelain=v1']);
  const dirtyFiles: { path: string; indexStatus: string; worktreeStatus: string }[] = [];
  if (statRes.ok) {
    for (const line of statRes.stdout.split('\n')) {
      if (line.length < 3) continue;
      const indexStatus = line[0];
      const worktreeStatus = line[1];
      const rest = line.slice(3).trim();
      const arrow = rest.indexOf(' -> ');
      const path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
      if (path) dirtyFiles.push({ path, indexStatus, worktreeStatus });
    }
  }

  const diffRes = await run(repoPath, ['diff', 'HEAD', '--stat']);
  const diffStat = diffRes.ok ? diffRes.stdout : '';

  return { upstream, unpushed, dirtyFiles, diffStat };
}

/// Detect the repo's default branch — the line `origin/main` is on, the
/// branch overgit treats as the "trunk" for compare/PR-base actions.
/// Falls back through three sources: the symbolic HEAD ref of origin
/// (the canonical answer), then a heuristic over `main`/`master`/`develop`.
/// Returns null only when the repo has none of those — at which point
/// the user can pick one in settings.
/// Force-refresh `origin/HEAD` by asking the remote what its current
/// default branch is, then re-resolve it. Used by the workspace
/// reset's "upstream-gone" heal path: if the previously stored
/// default branch no longer exists on the remote, this is what
/// surfaces the new one. Returns null when there's no `origin`
/// remote or the remote refuses (auth/offline) — the caller treats
/// that the same as "couldn't detect."
export async function refreshOriginHead(
  repoPath: string,
): Promise<{ ok: true; defaultBranch: string | null } | { ok: false; error: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const res = await run(
    repoPath,
    ['remote', 'set-head', 'origin', '--auto'],
    NETWORK_ENV,
    NETWORK_TIMEOUT_MS,
  );
  if (!res.ok) {
    return {
      ok: false,
      error: res.stderr.trim() || `git remote set-head exited ${res.code}`,
    };
  }
  return { ok: true, defaultBranch: await detectDefaultBranch(repoPath) };
}

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

/// Detect local branches whose work was squash-merged into the default
/// branch. Squash merges produce a single commit on default whose only
/// parent is default's previous tip — there is no graph edge back to
/// the source branch, so `--merged` (ancestor-based) silently misses
/// them. We instead use git's patch-id equivalence:
///
///   1. For each local branch find merge-base with the trunk and run
///      `git cherry trunk branch`. A line prefixed `-` means that
///      commit's patch-id is already in the upstream — i.e. its work
///      landed there. If every commit on the branch is `-`, the branch
///      was fully absorbed (squash merge or rebase-and-merge).
///   2. Bulk-compute patch-ids for the trunk's first-parent chain since
///      the oldest candidate merge-base, in one `git log -p | git
///      patch-id` pipe.
///   3. For each candidate compute the patch-id of its full diff
///      against the merge-base and look it up in the bulk map. The
///      match is the absorbing commit on trunk.
///
/// `includeAbsorbing` controls whether step 3 runs. The Prune panel
/// only needs the names (skip step 3, much faster); the graph wants
/// the absorbing SHAs to draw advisory lines.
///
/// `skipBranches` lets the caller hand in a pre-computed exclusion set
/// (current branch, default, worktree-checked-out, already-merged).
/// Skipping already-merged branches in particular saves a `git cherry`
/// per branch — they're handled by the ancestor-based `--merged` path
/// and adding squash detection on top of that is pure waste.
async function detectSquashMerges(
  repoPath: string,
  defaultBranch: string | null,
  options?: { includeAbsorbing?: boolean; skipBranches?: Set<string> },
): Promise<{
  branchName: string;
  branchSha: string;
  absorbingSha: string | null;
  trunkTipSha: string | null;
}[]> {
  if (!defaultBranch) return [];

  // Resolve trunk: prefer the remote tracking ref because the local
  // default branch can lag behind by however many times the user
  // forgot to pull.
  let trunkRef: string | null = null;
  let trunkTipSha: string | null = null;
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    const r = await run(repoPath, ['rev-parse', '--verify', ref]);
    if (r.ok) {
      trunkRef = ref;
      trunkTipSha = r.stdout.trim() || null;
      break;
    }
  }
  if (!trunkRef) return [];

  // List local branches with their tip SHAs in one shot.
  const SEP = '\x1f';
  const localsRes = await run(repoPath, [
    'for-each-ref',
    `--format=%(refname:short)${SEP}%(objectname)`,
    'refs/heads',
  ]);
  if (!localsRes.ok) return [];

  // Filter the branch list before we run any per-branch git work —
  // every entry skipped here is two fewer subprocess spawns. Critical
  // for repos with hundreds of stale branches; squash detection used
  // to fan out an O(N) sequential pile of `git merge-base`+`git cherry`
  // calls and dominate the prune flow.
  const skip = options?.skipBranches ?? new Set<string>();
  const branches: { name: string; sha: string }[] = [];
  for (const line of localsRes.stdout.split('\n')) {
    if (!line) continue;
    const [name, sha] = line.split(SEP);
    if (!name || !sha) continue;
    if (name === defaultBranch) continue;
    if (skip.has(name)) continue;
    branches.push({ name, sha });
  }
  if (branches.length === 0) return [];

  // Per-branch detection bounded to 4-wide. Each branch needs two
  // cheap calls (merge-base + cherry). On a repo with 200+ branches,
  // unbounded `Promise.all` would spawn 400+ concurrent `git`
  // processes — Node handles the promises fine but the OS kept
  // dropping us into the "Scanning branches…" spinner for seconds
  // and Activity Monitor would fill with `git` rows. Four wide is
  // enough to overlap I/O without saturating; per-op 30s timeout
  // keeps a hung git from pinning a slot.
  const PER_OP_TIMEOUT_MS = 30_000;
  const trunkRefForLambda = trunkRef;
  const perBranch = await mapBounded(branches, 4, async ({ name, sha }) => {
    const [mb, cherry] = await Promise.all([
      run(repoPath, ['merge-base', trunkRefForLambda, name], undefined, PER_OP_TIMEOUT_MS),
      run(repoPath, ['cherry', trunkRefForLambda, name], undefined, PER_OP_TIMEOUT_MS),
    ]);
    if (!mb.ok || !cherry.ok) return null;
    const mergeBase = mb.stdout.trim();
    if (!mergeBase) return null;
    // Branch tip already in trunk → not a squash case (handled by
    // the regular `--merged` ancestor check upstream of this call).
    if (mergeBase === sha) return null;
    const lines = cherry.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    if (!lines.every((l) => l.startsWith('-'))) return null;
    return { name, sha, mergeBase };
  });
  type Cand = { name: string; sha: string; mergeBase: string };
  const candidates: Cand[] = perBranch.filter((c): c is Cand => c !== null);
  if (candidates.length === 0) return [];

  // The graph caller wants absorbing SHAs; the prune caller doesn't —
  // skipping the patch-id work shaves the slowest piece of this whole
  // detector for the case where it's pure waste.
  if (!options?.includeAbsorbing) {
    return candidates.map((c) => ({
      branchName: c.name,
      branchSha: c.sha,
      absorbingSha: null,
      trunkTipSha,
    }));
  }

  // Build the patch-id lookup over trunk's recent first-parent chain.
  // The oldest merge-base anchors how far back we need to scan; going
  // further is wasted work, going closer would miss old absorbers.
  const oldestRes = await run(repoPath, [
    'rev-list',
    '--topo-order',
    '--reverse',
    ...candidates.map((c) => c.mergeBase),
  ]);
  const oldestMergeBase = oldestRes.ok
    ? (oldestRes.stdout.split('\n').find((l) => l.trim()) ?? candidates[0].mergeBase)
    : candidates[0].mergeBase;

  // Stream `git log -p ...` directly into `git patch-id` via native
  // OS pipes (see `pipeGitToPatchId`). The huge patch stream never
  // enters JS memory, which is what used to lock up the main thread
  // and stall every other IPC for ~30-60s on a busy repo. With
  // streaming we can afford a larger window — 500 first-parent
  // commits covers weeks/months of trunk activity on most repos and
  // catches old squash absorbers again without the responsiveness hit.
  const patchIdToSha = new Map<string, string>();
  const piped = await pipeGitToPatchId(repoPath, [
    'log',
    '-p',
    '--first-parent',
    '--no-merges',
    '--max-count=500',
    '--format=commit %H',
    `${oldestMergeBase}..${trunkRef}`,
  ]);
  for (const { pid, sha } of piped.entries) patchIdToSha.set(pid, sha);

  // Per-candidate patch-id matching, also bounded to 4-wide. Each
  // candidate streams its own `git diff <merge-base>..<tip>` directly
  // into `git patch-id` — same native-pipe pattern as the trunk-log
  // path, so no per-candidate diff (potentially MB on a substantial
  // feature branch) ever lands in JS memory. Without this, even with
  // the trunk-log fix, the per-candidate loop alone could allocate
  // hundreds of MB of strings across 4 concurrent workers and stall
  // every other IPC for the duration.
  return mapBounded(candidates, 4, async (c) => {
    let absorbingSha: string | null = null;
    if (patchIdToSha.size > 0) {
      const piped = await pipeGitToPatchId(repoPath, [
        'diff',
        `${c.mergeBase}..${c.sha}`,
      ]);
      const pid = piped.entries[0]?.pid;
      if (pid) absorbingSha = patchIdToSha.get(pid) ?? null;
    }
    return { branchName: c.name, branchSha: c.sha, absorbingSha, trunkTipSha };
  });
}

/// Public wrapper for the squash-merge detector. Used by the History
/// graph to draw advisory connectors from orphan tips to the commit on
/// trunk that absorbed them.
export async function squashMergeLinks(
  repoPath: string,
  defaultBranch: string | null,
): Promise<{
  branchName: string;
  branchSha: string;
  absorbingSha: string | null;
  trunkTipSha: string | null;
}[]> {
  if (!looksLikeRepo(repoPath)) return [];
  return detectSquashMerges(repoPath, defaultBranch, { includeAbsorbing: true });
}

/// Find local branches likely safe to delete. Three signals combine:
///   1. `[gone]` from `%(upstream:track)` — the branch was tracking a
///      remote ref that no longer exists, the canonical "this PR was
///      merged-and-deleted" footprint.
///   2. `--merged <ref>` against the default branch (preferring its
///      `origin/` upstream so a stale local default doesn't hide
///      already-merged work).
///   3. Squash-merge detection via patch-id equivalence — catches the
///      branches that landed on default as a single squashed commit
///      and so are invisible to `--merged` (which is ancestor-based).
/// Branches checked out in any worktree, the current HEAD, and the
/// default branch itself are never returned — git would refuse the
/// delete anyway and silently skipping them keeps the list trustworthy.
export async function pruneCandidates(
  repoPath: string,
  defaultBranch: string | null,
): Promise<BranchPruneCandidate[]> {
  if (!looksLikeRepo(repoPath)) return [];

  const SEP = '\x1f';
  const fmt = [
    '%(refname:short)',
    '%(objectname)',
    '%(objectname:short)',
    '%(subject)',
    '%(upstream:short)',
    '%(upstream:track)',
  ].join(SEP);

  const [headRes, localsRes, wtRes] = await Promise.all([
    run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    run(repoPath, ['for-each-ref', `--format=${fmt}`, 'refs/heads']),
    run(repoPath, ['worktree', 'list', '--porcelain']),
  ]);

  if (!localsRes.ok) return [];
  const currentBranch = headRes.ok ? headRes.stdout.trim() : '';

  // Branches that are checked out in *any* worktree (including the
  // main one) — `git branch -d` refuses to delete those, so they'd
  // only ever appear as failures in the bulk delete loop.
  const checkedOut = new Set<string>();
  if (wtRes.ok) {
    for (const line of wtRes.stdout.split('\n')) {
      const m = line.match(/^branch\s+refs\/heads\/(.+)$/);
      if (m) checkedOut.add(m[1]);
    }
  }

  type Row = {
    name: string;
    sha: string;
    shortSha: string;
    subject: string;
    upstream: string | null;
    gone: boolean;
  };
  const rows: Row[] = [];
  for (const line of localsRes.stdout.split('\n')) {
    if (!line) continue;
    const [name, sha, shortSha, subject, upstream, track] = line.split(SEP);
    if (!name) continue;
    rows.push({
      name,
      sha: sha ?? '',
      shortSha: shortSha ?? '',
      subject: subject ?? '',
      upstream: upstream && upstream.length > 0 ? upstream : null,
      gone: typeof track === 'string' && track.includes('[gone]'),
    });
  }

  // Prefer `origin/<default>` as the merge target — local default can
  // lag behind, which would hide branches whose work has already
  // landed upstream. Fall back to the local default if the remote
  // tracking ref doesn't exist (offline clone, no remote).
  const mergedSet = new Set<string>();
  if (defaultBranch) {
    for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
      const exists = await run(repoPath, [
        'rev-parse',
        '--verify',
        '--quiet',
        ref,
      ]);
      if (!exists.ok) continue;
      const merged = await run(repoPath, [
        'for-each-ref',
        '--format=%(refname:short)',
        '--merged',
        ref,
        'refs/heads',
      ]);
      if (merged.ok) {
        for (const ln of merged.stdout.split('\n')) {
          const t = ln.trim();
          if (t) mergedSet.add(t);
        }
        break;
      }
    }
  }

  // pruneCandidates intentionally returns ONLY the gone+merged set
  // here. Squash detection is the slow path (per-branch `git cherry`
  // even at bounded concurrency takes seconds on 200-branch repos),
  // so the renderer pulls it from `repo:pruneSquashCandidates` in
  // parallel and merges the results into the panel as they arrive.
  // That keeps the panel interactive within ~200ms regardless of
  // squash detection's depth.
  const out: BranchPruneCandidate[] = [];
  for (const r of rows) {
    if (r.name === currentBranch) continue;
    if (defaultBranch && r.name === defaultBranch) continue;
    if (checkedOut.has(r.name)) continue;
    const reasons: ('gone' | 'merged' | 'squashed')[] = [];
    if (r.gone) reasons.push('gone');
    if (mergedSet.has(r.name)) reasons.push('merged');
    if (reasons.length === 0) continue;
    out.push({
      name: r.name,
      sha: r.sha,
      shortSha: r.shortSha,
      subject: r.subject,
      reasons,
      upstream: r.upstream,
    });
  }
  return out;
}

/// Slow companion to `pruneCandidates` — detects squash-merged
/// branches via patch-id equivalence and returns them in the same
/// `BranchPruneCandidate` shape, so the renderer can merge the two
/// result sets without translating shapes. Uses the same
/// current/default/worktree/already-merged exclusions so the second
/// call doesn't redo work the first call already covered.
export async function pruneSquashCandidates(
  repoPath: string,
  defaultBranch: string | null,
): Promise<BranchPruneCandidate[]> {
  if (!looksLikeRepo(repoPath)) return [];
  if (!defaultBranch) return [];

  const SEP = '\x1f';
  const fmt = [
    '%(refname:short)',
    '%(objectname)',
    '%(objectname:short)',
    '%(subject)',
    '%(upstream:short)',
  ].join(SEP);

  const [headRes, localsRes, wtRes] = await Promise.all([
    run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    run(repoPath, ['for-each-ref', `--format=${fmt}`, 'refs/heads']),
    run(repoPath, ['worktree', 'list', '--porcelain']),
  ]);
  if (!localsRes.ok) return [];
  const currentBranch = headRes.ok ? headRes.stdout.trim() : '';
  const checkedOut = new Set<string>();
  if (wtRes.ok) {
    for (const line of wtRes.stdout.split('\n')) {
      const m = line.match(/^branch\s+refs\/heads\/(.+)$/);
      if (m) checkedOut.add(m[1]);
    }
  }

  const meta = new Map<
    string,
    { sha: string; shortSha: string; subject: string; upstream: string | null }
  >();
  for (const line of localsRes.stdout.split('\n')) {
    if (!line) continue;
    const [name, sha, shortSha, subject, upstream] = line.split(SEP);
    if (!name) continue;
    meta.set(name, {
      sha: sha ?? '',
      shortSha: shortSha ?? '',
      subject: subject ?? '',
      upstream: upstream && upstream.length > 0 ? upstream : null,
    });
  }

  // Compute the already-merged set first (cheap, single git call) so
  // squash detection skips ancestor-merged branches.
  const mergedSet = new Set<string>();
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    const exists = await run(repoPath, ['rev-parse', '--verify', '--quiet', ref]);
    if (!exists.ok) continue;
    const merged = await run(repoPath, [
      'for-each-ref',
      '--format=%(refname:short)',
      '--merged',
      ref,
      'refs/heads',
    ]);
    if (merged.ok) {
      for (const ln of merged.stdout.split('\n')) {
        const t = ln.trim();
        if (t) mergedSet.add(t);
      }
      break;
    }
  }

  const skipSquash = new Set<string>(mergedSet);
  if (currentBranch) skipSquash.add(currentBranch);
  for (const n of checkedOut) skipSquash.add(n);

  const squashed = await detectSquashMerges(repoPath, defaultBranch, {
    skipBranches: skipSquash,
  });

  const out: BranchPruneCandidate[] = [];
  for (const s of squashed) {
    const m = meta.get(s.branchName);
    if (!m) continue;
    out.push({
      name: s.branchName,
      sha: m.sha,
      shortSha: m.shortSha,
      subject: m.subject,
      reasons: ['squashed'],
      upstream: m.upstream,
    });
  }
  return out;
}

/// Rename a branch in place. `force` switches `-m` to `-M` so git will
/// overwrite an existing ref of the new name. When `from` is omitted git
/// renames the current branch.
export async function renameBranch(
  repoPath: string,
  newName: string,
  from: string | null,
  force: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const target = newName.trim();
  if (!target) return { ok: false, error: 'New branch name required' };
  const flag = force ? '-M' : '-m';
  const args = ['branch', flag];
  if (from && from.trim()) args.push(from.trim());
  args.push(target);
  const res = await run(repoPath, args);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git branch exited ${res.code}` };
}

// GraphCommit lives in shared/types.ts so renderer + main share the
// same shape. Re-imported below where it's needed.

const GRAPH_FORMAT = '%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%b%x1e';

/// Fast / List-mode variant of `commitGraph`. Drops `--all`,
/// `--topo-order`, and the trunk-set rev-list. When a `defaultBranch`
/// is supplied AND the current HEAD isn't on it, the result is scoped
/// to commits unique to the current branch (`git log <default>..HEAD`)
/// — what every PR-review tool defaults to showing. On the default
/// branch itself (or when default can't be resolved), falls back to
/// flat `git log -N` since "branch-only" of master vs master is empty.
///
/// All commits come back with lane=0 / parentLanes=[0, …] since the
/// renderer hides the rail in list mode anyway.
export async function commitGraphFast(
  repoPath: string,
  defaultBranch?: string,
  limit = 100,
): Promise<GraphCommit[]> {
  if (!looksLikeRepo(repoPath)) return [];
  const lim = Math.max(1, Math.min(limit, 200));

  // Decide the log range. We try `origin/<default>..HEAD` first
  // because the up-to-date remote tracking ref is what the user
  // actually compares against in PR review (local default may lag).
  // Fall through to the local default ref, then to a plain
  // HEAD-only log when none of the above resolves or when HEAD is
  // already on the default branch.
  const args: string[] = ['log', `-${lim}`, `--pretty=format:${GRAPH_FORMAT}`];
  if (defaultBranch) {
    const headRes = await run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const headBranch = headRes.ok ? headRes.stdout.trim() : '';
    if (headBranch && headBranch !== defaultBranch && headBranch !== 'HEAD') {
      const candidates = [`origin/${defaultBranch}`, defaultBranch];
      let chosenRange: string | null = null;
      for (const ref of candidates) {
        const verify = await run(repoPath, [
          'rev-parse',
          '--verify',
          '--quiet',
          ref,
        ]);
        if (verify.ok) {
          chosenRange = `${ref}..HEAD`;
          break;
        }
      }
      if (chosenRange) args.push(chosenRange);
    }
  }

  const res = await run(repoPath, args);
  if (!res.ok) return [];
  const out: GraphCommit[] = [];
  for (const record of res.stdout.split('\x1e')) {
    const t = record.replace(/^\s+|\s+$/g, '');
    if (!t) continue;
    const [sha, shortSha, parents, subject, author, authorEmail, date, refs, body] =
      t.split('\x1f');
    if (!sha) continue;
    const parentShas = parents ? parents.split(' ').filter(Boolean) : [];
    out.push({
      sha,
      shortSha: shortSha ?? sha.slice(0, 7),
      parents: parentShas,
      subject: subject ?? '',
      author: author ?? '',
      authorEmail: authorEmail ?? '',
      date: date ?? '',
      body: (body ?? '').trim(),
      refs: refs
        ? refs.split(',').map((r) => r.trim()).filter(Boolean)
        : [],
      // Single-lane placeholder. The full `commitGraph` call that
      // races alongside this one will overwrite with real lane data.
      lane: 0,
      parentLanes: parentShas.map(() => 0),
    });
  }
  return out;
}

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
      // Only commits inside `parsed` can be pinned to lane 0, so
      // there's no point walking trunk's full first-parent chain on a
      // monorepo with 100K+ commits on main — that single rev-list
      // dominated graph latency on big repos. Cap to roughly the
      // depth of the parsed graph (with a small buffer so the trunk
      // ref's own head is always included).
      const chain = await run(repoPath, [
        'rev-list',
        '--first-parent',
        `--max-count=${Math.max(200, parsed.length) + 32}`,
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

/// Single-file diff for the Changes pane. `staged` shows index vs HEAD,
/// `unstaged` shows worktree vs index, `combined` shows worktree vs HEAD
/// (the simple-mode view, where the staged/unstaged split is hidden).
/// Untracked files have no index entry / HEAD blob to diff against, so
/// we synthesize an "add" diff against /dev/null using `git diff
/// --no-index`.
export async function diffFile(
  repoPath: string,
  filePath: string,
  side: 'staged' | 'unstaged' | 'combined',
): Promise<FileDiff[]> {
  if (!looksLikeRepo(repoPath)) return [];
  if (side === 'staged') {
    const res = await run(repoPath, ['diff', '--cached', '--no-color', '--', filePath]);
    if (!res.ok) return [];
    return splitDiff(res.stdout).map(parseFileBlock);
  }

  // Unstaged or combined: try a tracked diff first (`git diff` for
  // unstaged → worktree vs index; `git diff HEAD` for combined →
  // worktree vs HEAD). For untracked files this returns nothing, so we
  // fall back to `diff --no-index /dev/null <path>` to synthesize an
  // add-diff. `--no-index` exits 1 when there's a difference (which is
  // the normal case here), so we tolerate exit-1 explicitly.
  const trackedArgs = side === 'combined'
    ? ['diff', 'HEAD', '--no-color', '--', filePath]
    : ['diff', '--no-color', '--', filePath];
  const tracked = await run(repoPath, trackedArgs);
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

// ─── Tags ────────────────────────────────────────────────────────────

/// `git for-each-ref refs/tags/...`. We pass `creatordate` as the sort
/// key so the renderer can show newest tags first; `creator` /
/// `creatordate` use the *underlying commit's* metadata for
/// lightweight tags and the *tag object's* metadata for annotated
/// tags, which matches what users expect to see ("when did this tag
/// land").
const TAG_FORMAT =
  '%(refname:short)%00%(objecttype)%00%(*objectname)%00%(objectname)%00%(*subject)%00%(subject)%00%(creator)%00%(creatordate:iso-strict)';

export async function listTags(repoPath: string): Promise<Tag[]> {
  if (!looksLikeRepo(repoPath)) return [];
  const res = await run(repoPath, [
    'for-each-ref',
    `--format=${TAG_FORMAT}`,
    '--sort=-creatordate',
    'refs/tags',
  ]);
  if (!res.ok) return [];
  const out: Tag[] = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [
      name,
      objectType,
      peeledSha,
      objectSha,
      annotatedSubject,
      lightSubject,
      creator,
      creatorDate,
    ] = line.split('\x00');
    if (!name) continue;
    // Annotated tags have objecttype === 'tag', and the *object* fields
    // hold the underlying commit data (the tag points at the commit
    // through the tag object). Lightweight tags have objecttype ===
    // 'commit' and `*object*` fields are empty.
    const annotated = objectType === 'tag';
    const sha = annotated ? peeledSha : objectSha;
    out.push({
      name,
      kind: annotated ? 'annotated' : 'lightweight',
      sha: sha ?? '',
      shortSha: sha ? sha.slice(0, 7) : '',
      subject: annotated ? (annotatedSubject ?? '') : (lightSubject ?? ''),
      tagger: creator ? creator.replace(/\s+\d+\s+[+-]\d{4}.*$/, '').trim() : '',
      date: creatorDate ?? '',
    });
  }
  return out;
}

export async function createTag(
  repoPath: string,
  args: { name: string; ref: string | null; message: string | null },
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  if (!args.name.trim()) return { ok: false, error: 'Tag name required' };
  const argv = ['tag'];
  if (args.message && args.message.trim().length > 0) {
    // Annotated tag: -a + -m. Wrapping the message in -m ensures git
    // doesn't drop into the editor in environments where one isn't
    // available (Electron renderer-launched git can't open $EDITOR).
    argv.push('-a', '-m', args.message);
  }
  argv.push(args.name);
  if (args.ref) argv.push(args.ref);
  const res = await run(repoPath, argv);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git tag exited ${res.code}` };
}

export async function deleteTag(
  repoPath: string,
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const res = await run(repoPath, ['tag', '-d', name]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git tag -d exited ${res.code}` };
}

export async function pushTag(
  repoPath: string,
  name: string,
  remote: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const res = await run(repoPath, ['push', remote, `refs/tags/${name}`], undefined, NETWORK_TIMEOUT_MS);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git push exited ${res.code}` };
}

// ─── Remotes ─────────────────────────────────────────────────────────

export async function listRemotes(repoPath: string): Promise<Remote[]> {
  if (!looksLikeRepo(repoPath)) return [];
  const res = await run(repoPath, ['remote', '-v']);
  if (!res.ok) return [];
  // `remote -v` emits two lines per remote — one for fetch, one for
  // push: `<name>\t<url> (fetch|push)`. We collapse them by name.
  const byName = new Map<string, { fetchUrl: string; pushUrl: string }>();
  for (const line of res.stdout.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line);
    if (!m) continue;
    const [, name, url, kind] = m;
    const entry = byName.get(name) ?? { fetchUrl: '', pushUrl: '' };
    if (kind === 'fetch') entry.fetchUrl = url;
    else entry.pushUrl = url;
    byName.set(name, entry);
  }
  return [...byName.entries()].map(([name, urls]) => ({ name, ...urls }));
}

export async function addRemote(
  repoPath: string,
  name: string,
  url: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const res = await run(repoPath, ['remote', 'add', name, url]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git remote add exited ${res.code}` };
}

export async function removeRemote(
  repoPath: string,
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const res = await run(repoPath, ['remote', 'remove', name]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git remote remove exited ${res.code}` };
}

export async function setRemoteUrl(
  repoPath: string,
  name: string,
  url: string,
  kind: 'fetch' | 'push',
): Promise<{ ok: boolean; error?: string }> {
  if (!looksLikeRepo(repoPath)) return { ok: false, error: 'Not a git repo' };
  const argv = ['remote', 'set-url'];
  if (kind === 'push') argv.push('--push');
  argv.push(name, url);
  const res = await run(repoPath, argv);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.stderr.trim() || `git remote set-url exited ${res.code}` };
}

// ─── Submodules ──────────────────────────────────────────────────────

/// `git submodule status` emits `<state-char><sha> <path> (<describe>)`
/// per row. Trailing `(...)` is omitted for uninitialized submodules,
/// so we tolerate its absence.
export async function listSubmodules(repoPath: string): Promise<Submodule[]> {
  if (!looksLikeRepo(repoPath)) return [];
  // `--recursive` would walk nested submodules too, but they should be
  // managed at their own repo level — flat is what the user expects.
  const res = await run(repoPath, ['submodule', 'status']);
  if (!res.ok || !res.stdout.trim()) return [];
  const out: Submodule[] = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const stateChar = line[0];
    const rest = line.slice(1);
    // Split on the first whitespace; the path can contain spaces but
    // the sha is always 40 hex chars, so we anchor on length instead.
    const sha = rest.slice(0, 40);
    const tail = rest.slice(40).trimStart();
    const describeIdx = tail.lastIndexOf('(');
    const path =
      describeIdx >= 0 ? tail.slice(0, describeIdx).trim() : tail.trim();
    const describe =
      describeIdx >= 0 ? tail.slice(describeIdx + 1).replace(/\)\s*$/, '') : '';
    const state: Submodule['state'] =
      stateChar === ' '
        ? 'up-to-date'
        : stateChar === '+'
          ? 'modified'
          : stateChar === 'U'
            ? 'conflict'
            : 'uninitialized';
    out.push({
      path,
      sha,
      shortSha: sha.slice(0, 7),
      describe,
      state,
    });
  }
  return out;
}

// ─── LFS ─────────────────────────────────────────────────────────────

/// Best-effort LFS detection: look for `filter=lfs` in `.gitattributes`
/// at the repo root. We don't recurse into per-directory attributes
/// files — projects that use LFS almost always declare their patterns
/// at the root, and this keeps the probe O(1).
export async function lfsStatus(repoPath: string): Promise<LfsStatus> {
  if (!looksLikeRepo(repoPath)) return { enabled: false, patternCount: 0 };
  try {
    const file = path.join(repoPath, '.gitattributes');
    if (!fs.existsSync(file)) return { enabled: false, patternCount: 0 };
    const text = await fs.promises.readFile(file, 'utf8');
    let patternCount = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.includes('filter=lfs')) patternCount += 1;
    }
    return { enabled: patternCount > 0, patternCount };
  } catch {
    return { enabled: false, patternCount: 0 };
  }
}
