// Workset coordinator. This is the heart of overgit's overlay model:
// every operation here is "for each repo in the workset, do X". There
// is NO synthetic root, NO metadata file living inside member repos, NO
// state owned by overgit beyond the workset-membership list in the
// store. A repo opened in another tool sees no trace of overgit.

import {
  AppSettings,
  CheckoutOutcome,
  CommitAllOutcome,
  Identity,
  Repo,
  RepoPRs,
  RepoStatus,
  SyncAndBranchOutcome,
  UUID,
  Workset,
  WorksetActivity,
  WorksetDiffTruncation,
  WorksetOpenPROutcome,
  WorksetPushOutcome,
  WorksetResetOutcome,
  Worktree,
} from '../shared/types';
import {
  changes as gitChanges,
  checkoutBranch,
  commitAll as gitCommitAll,
  createBranch,
  deleteBranch,
  detectDefaultBranch,
  fetch as gitFetch,
  hasUpstream,
  listBranches,
  listRemotes,
  listWorktrees,
  log as gitLog,
  pull as gitPull,
  push as gitPush,
  rawDiff,
  readGitConfigIdentity,
  refreshOriginHead,
  run,
  diffStat,
  status as gitStatus,
} from './git';

/// Detect the "FETCH_HEAD doesn't have what we want to merge" family
/// of pull errors. Returns the stale ref name when we can pluck one
/// out, an empty string when we can confirm the error but not the
/// ref, or undefined when this isn't the failure pattern.
function parseStaleMergeRef(stderr: string): string | undefined {
  if (!/not something we can merge/i.test(stderr)) return undefined;
  // Most common shape: `fatal: '<ref>' is not something we can merge`
  // or `fatal: not something we can merge in .git/FETCH_HEAD: <text>`
  // where <text> is a FETCH_HEAD-style "branch '<name>' of <url>" line.
  const quoted = stderr.match(/['"]([^'"\n]+?)['"]\s+(?:is\s+not|of\s+\S+)/);
  if (quoted) return quoted[1];
  const branchOf = stderr.match(/branch\s+['"]([^'"\n]+?)['"]/i);
  if (branchOf) return branchOf[1];
  return '';
}

/// Dedup of a `git status` parse into a single ordered list of
/// repo-relative paths, preferring `origPath → path` for renames so
/// the user sees "old → new" rather than just the new name.
function uniqueDirtyPaths(ch: {
  staged: { path: string; origPath?: string }[];
  unstaged: { path: string; origPath?: string }[];
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...ch.staged, ...ch.unstaged]) {
    const label = f.origPath ? `${f.origPath} → ${f.path}` : f.path;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/// Same precedence as main/index.ts:pickCommitIdentity, lifted here so
/// the workset commit-all loop doesn't need to round-trip through
/// the IPC layer for every member repo.
async function pickIdentityFor(repo: Repo, settings: AppSettings): Promise<Identity | undefined> {
  if (repo.identity) return repo.identity;
  const local = await readGitConfigIdentity(repo.path, 'local');
  if (local.name && local.email) return undefined;
  return settings.defaultIdentity;
}
import { createPRWithGh, findOpenPRForCurrentBranch, listOpenPRs } from './cli';

/// Identify the hosting provider for a remote URL. Used by the Open
/// PRs flow to dispatch: GitHub → `gh pr create`, Bitbucket → web URL,
/// anything else → fall through to the no-remote path.
type RemoteProvider =
  | { kind: 'github'; owner: string; repo: string }
  | { kind: 'bitbucket'; workset: string; repo: string }
  | { kind: 'unknown' };

function parseRemoteUrl(url: string): RemoteProvider {
  const trimmed = url.trim().replace(/\.git$/, '');
  // SSH form: git@host:owner/repo  (or :owner/repo for some hosts)
  const sshMatch = /^(?:ssh:\/\/)?(?:[^@\s]+@)?([^:/\s]+)[:/](.+?)$/.exec(trimmed);
  // HTTPS form: https://host/owner/repo
  const httpsMatch = /^https?:\/\/(?:[^@\s]+@)?([^/\s]+)\/(.+?)$/.exec(trimmed);
  const m = sshMatch ?? httpsMatch;
  if (!m) return { kind: 'unknown' };
  const host = m[1].toLowerCase();
  const path = m[2];
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return { kind: 'unknown' };
  const owner = segments[0];
  const repo = segments[segments.length - 1];
  if (host === 'github.com' || host.endsWith('.github.com')) {
    return { kind: 'github', owner, repo };
  }
  if (host === 'bitbucket.org' || host.endsWith('.bitbucket.org')) {
    return { kind: 'bitbucket', workset: owner, repo };
  }
  return { kind: 'unknown' };
}

async function detectProvider(repoPath: string): Promise<RemoteProvider> {
  const remotes = await listRemotes(repoPath);
  // Prefer `origin` because that's where pushes go by default; fall
  // back to the first remote if origin isn't configured (rare but
  // possible — fork workflows, multi-remote setups).
  const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
  if (!origin) return { kind: 'unknown' };
  return parseRemoteUrl(origin.fetchUrl || origin.pushUrl);
}

function buildBitbucketCreatePRUrl(args: {
  workset: string;
  repo: string;
  source: string;
  dest: string;
  title?: string;
}): string {
  // Bitbucket Cloud accepts source/dest via query string; title isn't
  // an officially supported param but Bitbucket's create form pre-fills
  // its title from the latest commit subject anyway, so the user gets
  // the same UX without us forcing it.
  const params = new URLSearchParams({
    source: args.source,
    dest: args.dest,
  });
  if (args.title) params.set('t', args.title);
  return `https://bitbucket.org/${encodeURIComponent(args.workset)}/${encodeURIComponent(
    args.repo,
  )}/pull-requests/new?${params.toString()}`;
}

function reposFor(workset: Workset, repos: Repo[]): Repo[] {
  const byId = new Map(repos.map((r) => [r.id, r]));
  return workset.repoIds.map((id) => byId.get(id)).filter((r): r is Repo => !!r);
}

export async function worksetStatus(
  worksetId: UUID,
  worksets: Workset[],
  repos: Repo[],
): Promise<RepoStatus[]> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  // Status calls are independent and read-only — fan them out so
  // worksets with many repos don't take linear time to refresh.
  return Promise.all(members.map((r) => gitStatus(r.id, r.path, r.defaultBranch)));
}

export async function worksetCheckout(
  worksetId: UUID,
  branch: string,
  createIfMissing: boolean,
  worksets: Workset[],
  repos: Repo[],
): Promise<CheckoutOutcome[]> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  // Sequential, not parallel: a workset-wide checkout is a coordinated
  // action the user expects to be able to interrupt and reason about.
  // If we parallelize and three of five repos fail with "dirty tree",
  // the user can't tell what order they happened in or which to fix
  // first. Serial keeps the result list narrate-able.
  const outcomes: CheckoutOutcome[] = [];
  for (const r of members) {
    outcomes.push(await checkoutBranch(r.id, r.path, branch, createIfMissing));
  }
  return outcomes;
}

/// Aggregate every branch name that exists across the workset's
/// repos so the renderer can offer a typeahead before the user commits
/// to a `Switch all`. We coalesce local heads and remote-tracking refs
/// into bare branch names (so `origin/feature/x` and the local
/// `feature/x` are the same suggestion) and count how many member
/// repos carry each one. The renderer uses that count to surface the
/// "X/Y repos have this branch" hint and to default the `create if
/// missing` toggle sensibly.
export async function worksetBranchSuggestions(
  worksetId: UUID,
  worksets: Workset[],
  repos: Repo[],
): Promise<{ branch: string; repoCount: number; total: number }[]> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  const total = members.length;
  if (total === 0) return [];

  // Per-repo branch listings are independent and read-only; fan out.
  const perRepo = await Promise.all(
    members.map(async (r) => {
      const { local, remote } = await listBranches(r.path);
      const names = new Set<string>();
      for (const n of local) names.add(n);
      // `origin/feature/x` → `feature/x`. We strip the first path
      // segment (the remote name); subsequent slashes belong to the
      // branch name itself.
      for (const n of remote) {
        const slash = n.indexOf('/');
        if (slash > 0) names.add(n.slice(slash + 1));
      }
      return { repoId: r.id, names };
    }),
  );

  const tally = new Map<string, Set<UUID>>();
  for (const { repoId, names } of perRepo) {
    for (const name of names) {
      let s = tally.get(name);
      if (!s) {
        s = new Set();
        tally.set(name, s);
      }
      s.add(repoId);
    }
  }

  return [...tally.entries()]
    .map(([branch, set]) => ({ branch, repoCount: set.size, total }))
    .sort(
      (a, b) => b.repoCount - a.repoCount || a.branch.localeCompare(b.branch),
    );
}

export async function worksetFetch(
  worksetId: UUID,
  worksets: Workset[],
  repos: Repo[],
): Promise<{ repoId: UUID; ok: boolean; error?: string }[]> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  return Promise.all(
    members.map(async (r) => ({ repoId: r.id, ...(await gitFetch(r.path)) })),
  );
}

/// Single-repo "sync default branch and switch/create the workset
/// branch" step. Shared between the workset-wide syncAndBranch loop
/// and the "bring this one new member into the workset's common
/// branch" flow used after adding a project to a live workset.
///
/// `existingBranchAction` controls what happens if `branch` already
/// exists in the repo: 'checkout' switches to it (used when a workset
/// is already on a shared branch and the new member just needs to
/// catch up), 'skip-create' returns 'created' without re-creating it.
async function syncRepoToBranchStep(
  repo: Repo,
  branch: string,
  syncDefault: boolean,
  pullBeforeBranch: boolean,
  existingBranchAction: 'create-fail' | 'checkout' = 'create-fail',
): Promise<SyncAndBranchOutcome> {
  // Resolve the default branch: trust the user's saved value, else
  // probe the repo. A repo with no detected default still proceeds —
  // we'll create the new branch off whatever HEAD is, which is the
  // documented "no default" fallback in the renderer.
  const defaultBranch =
    repo.defaultBranch ?? (await detectDefaultBranch(repo.path)) ?? null;

  let warning: SyncAndBranchOutcome | null = null;

  if (syncDefault && defaultBranch) {
    const switchRes = await checkoutBranch(repo.id, repo.path, defaultBranch, false);
    if (switchRes.result === 'dirty') {
      return {
        repoId: repo.id,
        branch,
        defaultBranch,
        result: 'dirty',
        message: switchRes.message,
      };
    }
    if (switchRes.result === 'error' || switchRes.result === 'missing-branch') {
      return {
        repoId: repo.id,
        branch,
        defaultBranch,
        result: 'switch-failed',
        message: switchRes.message ?? `Could not switch to ${defaultBranch}`,
      };
    }
  } else if (syncDefault && !defaultBranch) {
    // We were asked to sync default, but no default exists. Skip the
    // sync and let the create still happen from the current HEAD —
    // the user can revisit the default-branch setting later.
    warning = {
      repoId: repo.id,
      branch,
      defaultBranch: null,
      result: 'no-default-branch',
      message: 'No default branch configured — branched from current HEAD instead.',
    };
  }

  if (pullBeforeBranch) {
    const pullRes = await gitPull(repo.path);
    if (!pullRes.ok) {
      return {
        repoId: repo.id,
        branch,
        defaultBranch,
        result: 'pull-failed',
        message: pullRes.error,
      };
    }
  }

  const createRes = await createBranch(repo.path, branch, true);
  if (!createRes.ok) {
    // If the branch already exists locally, optionally just check it
    // out instead of failing — that's the "new member catching up to
    // an existing workset branch" case.
    if (
      existingBranchAction === 'checkout' &&
      /already exists/i.test(createRes.error ?? '')
    ) {
      const co = await checkoutBranch(repo.id, repo.path, branch, false);
      if (co.result === 'switched' || co.result === 'already-on-branch') {
        return warning ?? { repoId: repo.id, branch, defaultBranch, result: 'created' };
      }
      return {
        repoId: repo.id,
        branch,
        defaultBranch,
        result: 'switch-failed',
        message: co.message ?? `Could not switch to ${branch}`,
      };
    }
    return {
      repoId: repo.id,
      branch,
      defaultBranch,
      result: 'create-failed',
      message: createRes.error,
    };
  }
  return warning ?? { repoId: repo.id, branch, defaultBranch, result: 'created' };
}

/// "Get latest, then branch" workflow for a workset. For each repo,
/// optionally switch to its default branch, optionally pull, then
/// create the new branch from there. We run repos sequentially (not
/// parallel) so that a stash prompt or a pull conflict in one repo
/// doesn't get interleaved with another repo's output — the user gets
/// a clean per-repo outcome list to act on.
export async function worksetSyncAndBranch(
  worksetId: UUID,
  branch: string,
  syncDefault: boolean,
  pullBeforeBranch: boolean,
  worksets: Workset[],
  repos: Repo[],
): Promise<SyncAndBranchOutcome[]> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  const out: SyncAndBranchOutcome[] = [];
  for (const r of members) {
    out.push(await syncRepoToBranchStep(r, branch, syncDefault, pullBeforeBranch));
  }
  return out;
}

/// "Reset to default" workflow for the Archive flow. For each member,
/// Reset a single repo to its detected default branch: fetch → switch
/// → pull. Pulled out of `worksetResetToDefault` so we can reuse the
/// per-repo step from a global "reset all repos" action that doesn't
/// belong to any one workset.
export async function resetRepoToDefault(
  r: Repo,
  cleanupBranch?: string,
  opts: { forceLoseUnpushed?: boolean } = {},
): Promise<WorksetResetOutcome> {
  // Reset's semantics are now literal: put the repo on the tip of
  // `origin/<default>`, regardless of what merge / tracking weirdness
  // the local config has accumulated. Pipeline:
  //
  //   1. pre-flight dirty check (refuse if uncommitted work)
  //   2. resolve the target default branch (stored / origin/HEAD /
  //      main / master)
  //   3. fetch origin
  //   4. confirm `origin/<default>` exists; if not, refresh
  //      origin/HEAD and try the new name
  //   5. check the local default branch for unpushed commits and
  //      refuse if any (unless `forceLoseUnpushed`)
  //   6. `git checkout -B <default> origin/<default>` — create or
  //      hard-reset the local default to point at the remote tip
  //
  // We deliberately avoid `git pull`. Pull's merge layer interacts
  // with FETCH_HEAD / branch.X.merge config in ways that have failed
  // mysteriously even on repos with normal-looking config; the
  // checkout -B approach is a single deterministic operation: "make
  // the local branch equal origin's branch."
  //
  // 1. Pre-flight dirty check
  const preStatus = await gitStatus(r.id, r.path, r.defaultBranch);
  if (preStatus.dirtyCount > 0) {
    const ch = await gitChanges(r.path);
    const paths = uniqueDirtyPaths(ch);
    return {
      repoId: r.id,
      defaultBranch: r.defaultBranch ?? null,
      result: 'dirty',
      message:
        paths.length > 0
          ? `Uncommitted changes in ${paths.length} ${paths.length === 1 ? 'file' : 'files'}.`
          : 'Working tree has uncommitted changes.',
      dirtyPaths: paths,
    };
  }

  // 2. Resolve the target default branch
  let defaultBranch =
    r.defaultBranch ?? (await detectDefaultBranch(r.path)) ?? null;

  // 3. Fetch origin
  const fetchRes = await gitFetch(r.path);
  if (!fetchRes.ok) {
    return {
      repoId: r.id,
      defaultBranch,
      result: 'fetch-failed',
      message: fetchRes.error,
    };
  }

  // 2b. If we still don't have a default, try refreshing origin/HEAD
  // now that we've talked to the remote.
  if (!defaultBranch) {
    const refreshed = await refreshOriginHead(r.path);
    if (refreshed.ok) defaultBranch = refreshed.defaultBranch;
  }
  if (!defaultBranch) {
    return {
      repoId: r.id,
      defaultBranch: null,
      result: 'no-default-branch',
      message:
        'No default branch detected — set one in repo Settings or check origin/HEAD.',
    };
  }

  // 4. Confirm origin/<default> exists. If not, try a one-shot heal
  // via origin/HEAD before giving up — the stored default may have
  // been renamed on the remote.
  let remoteExists = await branchExistsOnOrigin(r.path, defaultBranch);
  if (!remoteExists) {
    const refreshed = await refreshOriginHead(r.path);
    const newDefault = refreshed.ok ? refreshed.defaultBranch : null;
    if (newDefault && newDefault !== defaultBranch) {
      defaultBranch = newDefault;
      remoteExists = await branchExistsOnOrigin(r.path, defaultBranch);
    }
    if (!remoteExists) {
      return {
        repoId: r.id,
        defaultBranch,
        result: 'upstream-gone',
        message: `origin/${defaultBranch} not found — pick a new default in Settings or open the repo to investigate.`,
        staleRef: defaultBranch,
      };
    }
  }

  // 5. Refuse to discard unpushed local commits unless forced.
  if (!opts.forceLoseUnpushed) {
    const unpushed = await countUnpushedOnBranch(r.path, defaultBranch);
    if (unpushed > 0) {
      return {
        repoId: r.id,
        defaultBranch,
        result: 'unpushed-commits',
        message: `${unpushed} local ${unpushed === 1 ? 'commit' : 'commits'} on ${defaultBranch} not pushed to origin. Force reset will discard them.`,
        unpushedCount: unpushed,
      };
    }
  }

  // 6. Hard-reset local default to origin's tip.
  // `git checkout -B <default> origin/<default>` does both "create or
  // reset the local branch" and "switch to it" atomically. If we're
  // currently on the default already, it resets it; if we're on a
  // different branch, it switches; if the local branch doesn't exist,
  // it creates it from origin. Single command, deterministic outcome.
  const checkoutRes = await run(r.path, [
    'checkout',
    '-B',
    defaultBranch,
    `origin/${defaultBranch}`,
  ]);
  if (!checkoutRes.ok) {
    return {
      repoId: r.id,
      defaultBranch,
      result: 'switch-failed',
      message:
        checkoutRes.stderr.trim() || `git checkout exited ${checkoutRes.code}`,
    };
  }

  // Best-effort branch sweep. `git branch -d` (safe delete) refuses
  // any branch with unmerged commits, so passing through here can
  // never lose work — empty workset branches go away, branches with
  // unpushed work stay put. Skip when no cleanup branch was requested
  // or when the branch IS the default (nothing to delete).
  let cleanedUpBranch = false;
  if (cleanupBranch && cleanupBranch !== defaultBranch) {
    const del = await deleteBranch(r.path, cleanupBranch, false);
    if (del.ok) cleanedUpBranch = true;
  }
  return { repoId: r.id, defaultBranch, result: 'reset', cleanedUpBranch };
}

async function branchExistsOnOrigin(
  repoPath: string,
  branch: string,
): Promise<boolean> {
  const res = await run(repoPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}`,
  ]);
  return res.ok;
}

async function countUnpushedOnBranch(
  repoPath: string,
  branch: string,
): Promise<number> {
  // No local branch yet? Nothing to lose.
  const localExists = await run(repoPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);
  if (!localExists.ok) return 0;
  const ahead = await run(repoPath, [
    'rev-list',
    '--count',
    `refs/remotes/origin/${branch}..refs/heads/${branch}`,
  ]);
  if (!ahead.ok) return 0;
  const n = parseInt(ahead.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/// Fan out `resetRepoToDefault` over every repo in the list. Bounded
/// to 3-wide so a 24-repo workset doesn't fire 24 simultaneous
/// `git fetch` operations against the same remotes — credential
/// helpers, rate-limited hosts, and the OS process budget all dislike
/// that. Three is enough to overlap network latency without thrashing.
export async function resetReposToDefault(
  repos: Repo[],
  cleanupBranch?: string,
): Promise<WorksetResetOutcome[]> {
  const out: WorksetResetOutcome[] = new Array(repos.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= repos.length) return;
      out[i] = await resetRepoToDefault(repos[i], cleanupBranch);
    }
  };
  const concurrency = Math.min(3, repos.length);
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

/// fetch → switch to its detected default branch → pull. Result is each
/// repo on a clean tip-of-default state, ready for the next workset.
/// The Archive button is gated on the workset being clean + pushed, so
/// dirty/conflict outcomes here are exceptional — but we surface them
/// rather than failing silently because a stash the user forgot about
/// could still be in play.
export async function worksetResetToDefault(
  worksetId: UUID,
  worksets: Workset[],
  repos: Repo[],
  cleanupBranch?: string,
): Promise<WorksetResetOutcome[]> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return [];
  // Default the cleanup target to the workset's bound branch — the
  // Archive flow's intent is "this workset is done", and the bound
  // branch is exactly what should go with it.
  const branch = cleanupBranch ?? ws.preferredBranch;
  return resetReposToDefault(reposFor(ws, repos), branch);
}

/// Bring a single repo into the workset's common branch. Used after
/// a new project is added to a workset that's already coordinating
/// on a shared feature branch: fetch, sync default, pull, then create
/// (or check out, if it exists) the workset branch. Returns the same
/// per-repo outcome shape so the renderer can reuse the result row.
export async function worksetSyncMemberToBranch(
  repoId: UUID,
  branch: string,
  repos: Repo[],
): Promise<SyncAndBranchOutcome | { result: 'unknown-repo' }> {
  const repo = repos.find((r) => r.id === repoId);
  if (!repo) return { result: 'unknown-repo' };
  // Best-effort fetch first so the default branch and the workset
  // branch can both reach origin's tip. A failed fetch isn't fatal —
  // pull will surface the same network problem with a better message.
  await gitFetch(repo.path);
  return syncRepoToBranchStep(repo, branch, true, true, 'checkout');
}

/// Stage and commit every dirty repo with a shared message. Detached-
/// HEAD repos are skipped — committing onto detached HEAD orphans the
/// commit, which is rarely what someone clicking "Commit all" means.
/// Clean repos come back as `clean` so the result table is symmetric
/// (matches the user's mental model of "I just ran this on N repos").
/// Sequential, like syncAndBranch — one repo's commit failure should
/// be readable in context, not interleaved with others.
export async function worksetCommitAll(
  worksetId: UUID,
  message: string,
  worksets: Workset[],
  repos: Repo[],
  settings: AppSettings,
): Promise<CommitAllOutcome[]> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  const out: CommitAllOutcome[] = [];
  for (const r of members) {
    const st = await gitStatus(r.id, r.path, r.defaultBranch);
    if (st.branch === null) {
      out.push({ repoId: r.id, result: 'detached', message: 'Detached HEAD — skipped' });
      continue;
    }
    if (st.dirtyCount === 0) {
      out.push({ repoId: r.id, result: 'clean' });
      continue;
    }
    const identity = await pickIdentityFor(r, settings);
    const res = await gitCommitAll(r.path, message, identity);
    if (res.ok) out.push({ repoId: r.id, result: 'committed' });
    else out.push({ repoId: r.id, result: 'commit-failed', message: res.error });
  }
  return out;
}

/// Default byte budget for the concatenated workset diff sent to LLM
/// CLIs. Sized to comfortably fit inside Claude/Codex/Gemini one-shot
/// context windows after the prompt header. Repos whose diff would push
/// the total past this cap are replaced with their `--stat` summary.
const WORKSET_DIFF_BYTE_CAP = 200_000;

/// Concatenate every dirty on-branch repo's working-tree diff into one
/// blob with `=== <repo name> ===` headers, capped at WORKSET_DIFF_BYTE_CAP.
/// Repos whose diff would overflow are replaced with their shortstat
/// summary and reported in `truncated`. Detached-HEAD and clean repos
/// are excluded — they'd be skipped by `commitAll` anyway, so reviewing
/// or summarizing them would mislead the model about what's about to
/// land.
export async function aggregateWorksetDirtyDiff(
  worksetId: UUID,
  worksets: Workset[],
  repos: Repo[],
): Promise<{ text: string; truncated: WorksetDiffTruncation[] }> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return { text: '', truncated: [] };
  const members = reposFor(ws, repos);

  // Filter to repos that commit-all would actually touch. Status calls
  // are read-only — fan them out.
  const statuses = await Promise.all(
    members.map(async (r) => ({
      repo: r,
      status: await gitStatus(r.id, r.path, r.defaultBranch),
    })),
  );
  const eligible = statuses.filter(
    ({ status }) => status.dirtyCount > 0 && status.branch !== null,
  );

  const parts: string[] = [];
  const truncated: WorksetDiffTruncation[] = [];
  let used = 0;

  for (const { repo } of eligible) {
    const diff = await rawDiff(repo.path, 'working');
    if (!diff.ok || !diff.text) continue;

    const header = `=== ${repo.name} ===\n`;
    const headerCost = Buffer.byteLength(header, 'utf8');
    const diffCost = Buffer.byteLength(diff.text, 'utf8');

    if (used + headerCost + diffCost <= WORKSET_DIFF_BYTE_CAP) {
      parts.push(header + diff.text);
      used += headerCost + diffCost;
      continue;
    }

    // Doesn't fit — fall back to a stat summary so the model still sees
    // the repo exists in this commit and what files moved.
    const stat = await diffStat(repo.path);
    const summary =
      `(diff truncated — ${diffCost.toLocaleString()} bytes; showing --stat instead)\n` +
      (stat.ok ? stat.text : '(could not read --stat)\n');
    parts.push(header + summary);
    used += headerCost + Buffer.byteLength(summary, 'utf8');
    truncated.push({ repoId: repo.id, repoName: repo.name, originalBytes: diffCost });
  }

  return { text: parts.join('\n'), truncated };
}

/// Push every workset repo whose branch is ahead of upstream (or has
/// no upstream — first push). Sequential, not parallel: pushes can
/// prompt for credentials (ssh agent unlock, gpg signing key) and
/// interleaving prompts across repos is unworkable. The loop is fast
/// enough for the workset sizes overgit targets (single digits to
/// low double digits) that serial network calls don't feel slow.
export async function worksetPushAll(
  worksetId: UUID,
  worksets: Workset[],
  repos: Repo[],
): Promise<WorksetPushOutcome[]> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  const out: WorksetPushOutcome[] = [];
  for (const r of members) {
    const st = await gitStatus(r.id, r.path, r.defaultBranch);
    if (st.branch === null) {
      out.push({ repoId: r.id, result: 'detached', message: 'Detached HEAD — skipped' });
      continue;
    }
    const upstreamSet = await hasUpstream(r.path);
    // Already in sync: skip the push round-trip entirely. We treat
    // ahead === null as "unknown — try anyway" since `status` returns
    // null when there's no upstream tracking; that case is covered by
    // the upstream check below where we'll set up tracking.
    if (upstreamSet && (st.ahead ?? 0) === 0) {
      out.push({
        repoId: r.id,
        branch: st.branch,
        result: 'up-to-date',
        ahead: 0,
      });
      continue;
    }
    const ahead = st.ahead ?? 0;
    const res = await gitPush(r.path);
    if (res.ok) {
      out.push({
        repoId: r.id,
        branch: st.branch,
        result: res.setUpstream ? 'pushed-new-upstream' : 'pushed',
        ahead,
      });
    } else {
      out.push({
        repoId: r.id,
        branch: st.branch,
        result: 'push-failed',
        ahead,
        message: res.error,
      });
    }
  }
  return out;
}

/// Open a GitHub PR per workset repo. Each repo's PR is created
/// against that repo's `defaultBranch` (probed if not set). The shared
/// title / body / draft-flag is reused across all of them — the killer
/// flow is "I just landed a coordinated change across N repos and want
/// the team to see one cohesive set of PRs," so a uniform message is
/// the default. Runs sequentially because gh can prompt for auth, and
/// because per-repo failure modes (unpushed, no-remote) need to be
/// readable in order rather than interleaved.
export async function worksetOpenPRs(
  worksetId: UUID,
  title: string,
  body: string,
  draft: boolean,
  worksets: Workset[],
  repos: Repo[],
): Promise<WorksetOpenPROutcome[]> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  const out: WorksetOpenPROutcome[] = [];
  for (const r of members) {
    const st = await gitStatus(r.id, r.path, r.defaultBranch);
    if (st.branch === null) {
      out.push({ repoId: r.id, result: 'detached', message: 'Detached HEAD — skipped' });
      continue;
    }
    // Resolve the base branch up front. We never want to open a PR from
    // a repo's default branch back into itself; flag that as its own
    // outcome so the user can see why it was skipped.
    const baseBranch = r.defaultBranch ?? (await detectDefaultBranch(r.path)) ?? 'main';
    if (st.branch === baseBranch) {
      out.push({
        repoId: r.id,
        branch: st.branch,
        baseBranch,
        result: 'on-default-branch',
        message: `On ${baseBranch} — nothing to PR.`,
      });
      continue;
    }
    // Branch by provider. GitHub goes through `gh pr create`; Bitbucket
    // (no first-class CLI we trust) gets a pre-filled web URL the user
    // finishes in the browser. Anything else falls through to the
    // existing no-remote path.
    const provider = await detectProvider(r.path);
    if (provider.kind === 'bitbucket') {
      const url = buildBitbucketCreatePRUrl({
        workset: provider.workset,
        repo: provider.repo,
        source: st.branch,
        dest: baseBranch,
        title,
      });
      out.push({
        repoId: r.id,
        branch: st.branch,
        baseBranch,
        result: 'opened-in-browser',
        url,
        message:
          'Bitbucket — opening browser to create PR (title pre-filled from latest commit)',
      });
      continue;
    }
    // Probe gh next. If gh isn't even installed, surface that once per
    // repo (not once globally) so the renderer's row treatment is
    // uniform — every row gets a result, not a banner.
    const existing = await findOpenPRForCurrentBranch(r.path);
    if (existing.kind === 'no-gh') {
      out.push({
        repoId: r.id,
        branch: st.branch,
        baseBranch,
        result: 'no-gh',
        message: 'gh CLI not found — install gh to open PRs.',
      });
      continue;
    }
    if (existing.kind === 'no-remote') {
      out.push({
        repoId: r.id,
        branch: st.branch,
        baseBranch,
        result: 'no-remote',
        message: 'No GitHub remote.',
      });
      continue;
    }
    if (existing.kind === 'found') {
      out.push({
        repoId: r.id,
        branch: st.branch,
        baseBranch,
        result: 'already-open',
        url: existing.url,
        number: existing.number,
      });
      continue;
    }
    if (existing.kind === 'error') {
      out.push({
        repoId: r.id,
        branch: st.branch,
        baseBranch,
        result: 'create-failed',
        message: existing.message,
      });
      continue;
    }
    // existing.kind === 'none' — proceed to create.
    const created = await createPRWithGh(r.path, {
      base: baseBranch,
      title,
      body,
      draft,
    });
    if (created.ok) {
      out.push({
        repoId: r.id,
        branch: st.branch,
        baseBranch,
        result: 'created',
        url: created.url,
        number: created.number,
      });
    } else {
      const result: WorksetOpenPROutcome['result'] =
        created.kind === 'unpushed'
          ? 'unpushed'
          : created.kind === 'no-remote'
            ? 'no-remote'
            : created.kind === 'no-gh'
              ? 'no-gh'
              : 'create-failed';
      out.push({
        repoId: r.id,
        branch: st.branch,
        baseBranch,
        result,
        message: created.error,
      });
    }
  }
  return out;
}

/// Aggregated workset timeline: recent commits across all repos
/// (current branch only — per-branch tracking is a future-pass thing)
/// merged with the workset's open PR list. Sorted newest-first.
/// Read-only and best-effort: a repo we can't reach (missing on disk,
/// git not in PATH for that path, etc.) just contributes no items.
export async function worksetActivity(
  worksetId: UUID,
  perRepo: number,
  worksets: Workset[],
  repos: Repo[],
): Promise<WorksetActivity[]> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  const out: WorksetActivity[] = [];

  // Commits — fan out, every repo is independent. We use the repo's
  // current branch as the source; a future pass could walk every
  // tracked branch but that's overkill for a "what's new" surface.
  const commitFanout = await Promise.all(
    members.map(async (r) => {
      const st = await gitStatus(r.id, r.path, r.defaultBranch);
      const branch = st.branch ?? '(detached)';
      const commits = await gitLog(r.path, perRepo);
      return { repo: r, branch, commits };
    }),
  );
  for (const { repo, branch, commits } of commitFanout) {
    for (const c of commits) {
      out.push({
        kind: 'commit',
        repoId: repo.id,
        repoName: repo.name,
        sha: c.sha,
        shortSha: c.shortSha,
        branch,
        subject: c.subject,
        author: c.author,
        at: c.date,
      });
    }
  }

  // PRs — listOpenPRs already gates on `gh` being installed and
  // returns null when there's no GitHub remote. Skip null results
  // silently; we surface gh-presence in the dedicated PR UI.
  const prFanout = await Promise.all(
    members.map(async (r) => ({ repo: r, prs: (await listOpenPRs(r.path)).prs })),
  );
  for (const { repo, prs } of prFanout) {
    if (!prs) continue;
    for (const pr of prs) {
      out.push({
        kind: 'pr',
        repoId: repo.id,
        repoName: repo.name,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        author: pr.author,
        at: pr.updatedAt,
      });
    }
  }

  // Newest first. Lexicographic sort on ISO 8601 happens to coincide
  // with chronological order, so no Date construction needed.
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out;
}

export async function worksetWorktrees(
  worksetId: UUID,
  worksets: Workset[],
  repos: Repo[],
): Promise<{ repoId: UUID; worktrees: Worktree[] }[]> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  return Promise.all(
    members.map(async (r) => ({ repoId: r.id, worktrees: await listWorktrees(r.path) })),
  );
}

export async function worksetListPRs(
  worksetId: UUID,
  worksets: Workset[],
  repos: Repo[],
): Promise<RepoPRs[]> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  return Promise.all(
    members.map(async (r): Promise<RepoPRs> => {
      const result = await listOpenPRs(r.path);
      return { repoId: r.id, prs: result.prs, error: result.error };
    }),
  );
}
