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
  LandingOutcome,
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
  WorksetCollision,
  WorksetLandingReport,
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
  gitVersion,
  supportsMergeTree,
  mergePreflight,
  resolveDefaultRef,
  isSafeRefArg,
  type MergePreflight,
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

/// Bounded parallel map. Used for hot-path fan-outs (status, PR list,
/// worktrees, activity) so a 24-repo workset doesn't fire 24 simultaneous
/// subprocesses — credential helpers, gh's auth probing, and the OS
/// process budget all dislike that. Three is enough to overlap network
/// latency without thrashing.
async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  if (items.length === 0) return out;
  let next = 0;
  const width = Math.max(1, Math.min(concurrency, items.length));
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

/// Local-only GitHub-remote check. Avoids spawning `gh` for repos that
/// will never have a PR — bitbucket-only repos, internal git servers,
/// freshly-init'd local repos. `gh` itself takes ~0.5–2s per call even
/// when it bails out with "not a GitHub repository", which compounds
/// painfully across a workset.
async function hasGitHubRemote(repoPath: string): Promise<boolean> {
  const provider = await detectProvider(repoPath);
  return provider.kind === 'github';
}

export async function worksetStatus(
  worksetId: UUID,
  worksets: Workset[],
  repos: Repo[],
): Promise<RepoStatus[]> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  // Status calls are independent and read-only — fan them out, but
  // bound to 3 in flight. Each `gitStatus` spawns ~4 parallel git
  // subprocesses (status, rev-list, shortstat, show-ref); unbounded
  // fan-out on a 20-repo workset = 80 concurrent git processes,
  // which pegs CPU and stalls everything else (sidebar refresh, the
  // user's branch-tab click). 3 wide × 4 sub = 12 concurrent gits,
  // which keeps wall time low without saturating.
  return pool(members, 3, (r) => gitStatus(r.id, r.path, r.defaultBranch));
}

/// merge-tree is pure with respect to (repo, oursSha, theirsSha): if
/// neither tip moved, the answer cannot have changed. Memoize so the
/// ambient 5-minute re-check costs zero merge-tree subprocesses on a
/// quiet repo, and so the unreachable objects merge-tree writes are
/// created once, not once per poll. Ref *names* are deliberately not
/// in the key — the output depends only on the two commits. LRU by
/// re-insertion: Map preserves insertion order, so evicting
/// keys().next() is a true least-recently-used eviction.
const PREFLIGHT_MEMO_MAX = 500;
/// A repo shared by many active worksets could otherwise fan out into
/// dozens of pairwise merges; nobody has that many parallel tickets on
/// one repo, so cap it rather than budget for it.
const MAX_COLLISION_PAIRS_PER_REPO = 10;
const preflightMemo = new Map<string, MergePreflight>();

function preflightKey(repoPath: string, oursSha: string, theirsSha: string): string {
  return `${repoPath}\0${oursSha}\0${theirsSha}`;
}

async function memoizedPreflight(
  repoPath: string,
  oursRef: string,
  theirsRef: string,
  oursSha: string,
  theirsSha: string,
  force = false,
): Promise<MergePreflight> {
  const key = preflightKey(repoPath, oursSha, theirsSha);
  if (!force) {
    const hit = preflightMemo.get(key);
    if (hit) {
      preflightMemo.delete(key);
      preflightMemo.set(key, hit);
      return hit;
    }
  }
  const value = await mergePreflight(repoPath, oursRef, theirsRef);
  // Only real answers are memoized. An `error` is usually transient —
  // a 30s timeout on a huge tree, a stale-lock retry that ran out —
  // and caching it would pin "Landing check failed" on the row until
  // the next commit moved a SHA.
  if (value.status !== 'error') {
    preflightMemo.set(key, value);
    while (preflightMemo.size > PREFLIGHT_MEMO_MAX) {
      preflightMemo.delete(preflightMemo.keys().next().value!);
    }
  }
  return value;
}

/// Drop every memoized preflight that produced `treeOid`. Called when
/// a preview read fails: `git gc --prune` has collected the unreachable
/// merge tree, so the cached answer's treeOid is dead and the next
/// check must run merge-tree again to regenerate it.
export function evictPreflightTree(repoPath: string, treeOid: string): void {
  for (const [key, value] of preflightMemo) {
    if (value.treeOid === treeOid && key.startsWith(`${repoPath}\0`)) preflightMemo.delete(key);
  }
}

function landingBase(
  repoId: UUID,
  result: LandingOutcome['result'],
  branch: string | null = null,
  baseRef: string | null = null,
): LandingOutcome {
  return {
    repoId,
    result,
    branch,
    baseRef,
    conflictFiles: [],
    treeOid: null,
    aheadOfBase: null,
    behindBase: null,
  };
}

/// One member repo's landing answer. Typical cost is six spawns
/// (branch name, two ref probes, left-right count, batched rev-parse,
/// merge-tree) and five on a memo hit. No `git status` here on
/// purpose — uncommitted-file counts come from the renderer's status
/// cache, and merge-tree only sees committed work anyway.
async function landingOutcomeFor(repo: Repo, force: boolean): Promise<LandingOutcome> {
  // `--abbrev-ref HEAD` prints the branch name, or the literal "HEAD"
  // when detached. It can't be batched with the SHA read below:
  // --abbrev-ref applies to every following arg.
  const br = await run(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = br.stdout.trim();
  if (!br.ok) {
    return { ...landingBase(repo.id, 'error'), message: br.stderr.trim() || 'No commits yet' };
  }
  if (!branch || branch === 'HEAD') {
    return { ...landingBase(repo.id, 'error'), message: 'Detached HEAD — nothing to land' };
  }
  const def = repo.defaultBranch ?? (await detectDefaultBranch(repo.path));
  if (!def) return landingBase(repo.id, 'no-default-ref', branch);
  if (branch === def) return landingBase(repo.id, 'on-default', branch, def);
  const baseRef = await resolveDefaultRef(repo.path, def);
  if (!baseRef) {
    return {
      ...landingBase(repo.id, 'no-default-ref', branch),
      message: `origin/${def} and ${def} both missing`,
    };
  }
  // `<behind>\t<ahead>` in one call — the same idiom status() uses.
  // Replaces both a merge-base --is-ancestor probe and a rev-list
  // --count.
  const count = await run(repo.path, ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`]);
  const [behind, ahead] = count.stdout.trim().split(/\s+/).map(Number);
  if (!count.ok || !Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return {
      ...landingBase(repo.id, 'error', branch, baseRef),
      message: count.stderr.trim() || 'Could not compare refs',
    };
  }
  const common = { aheadOfBase: ahead, behindBase: behind };
  // Nothing of ours is missing from base: either the tips are identical
  // or every commit already landed. Both read as "nothing left to land".
  if (ahead === 0) {
    return { ...landingBase(repo.id, behind ? 'merged' : 'nothing-to-land', branch, baseRef), ...common };
  }
  // Both SHAs in one call, one per line.
  const shas = await run(repo.path, ['rev-parse', 'HEAD', baseRef]);
  const [oursSha, theirsSha] = shas.stdout.trim().split(/\s+/);
  if (!shas.ok || !oursSha || !theirsSha) {
    return {
      ...landingBase(repo.id, 'error', branch, baseRef),
      ...common,
      message: shas.stderr.trim() || 'Could not resolve refs',
    };
  }
  const p = await memoizedPreflight(repo.path, branch, baseRef, oursSha, theirsSha, force);
  return {
    ...landingBase(repo.id, p.status, branch, baseRef),
    ...common,
    conflictFiles: p.conflictFiles,
    treeOid: p.treeOid,
    message: p.message,
  };
}

/// Pairwise preflight between this workset's bound branch and every
/// other *active* workset's bound branch, for each repo they share —
/// the "human branch and agent branch will merge cleanly into a broken
/// build" case, surfaced before either is pushed. A pair (A,B) is
/// computed once from A's view and again from B's; with the SHA memo
/// the second is pure Map lookups, and per-workset scoping is what
/// lets the section render the moment a workset opens.
async function landingCollisionsFor(
  ws: Workset,
  members: Repo[],
  worksets: Workset[],
  force: boolean,
): Promise<WorksetCollision[]> {
  const aBranch = ws.preferredBranch;
  if (!aBranch || !isSafeRefArg(aBranch)) return [];
  const others = worksets.filter(
    (w) =>
      w.id !== ws.id &&
      !w.archived &&
      !!w.preferredBranch &&
      w.preferredBranch !== aBranch &&
      isSafeRefArg(w.preferredBranch),
  );
  if (others.length === 0) return [];

  // `rev-parse --verify --quiet refs/heads/<b>` is an existence check
  // (exit 1, empty stdout when missing) and a SHA read in one spawn.
  // Hoist the A side once per repo; a repo without the branch locally
  // has no pairs to check.
  const ours = await pool(members, 3, async (repo) => {
    try {
      const ref = await run(repo.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${aBranch}`]);
      const sha = ref.stdout.trim();
      return ref.ok && sha ? { repo, sha } : null;
    } catch {
      return null;
    }
  });
  // One pair per (repo, other branch). Two worksets bound to the same
  // branch would otherwise produce identical rows — and identical
  // merge-tree work — so collapse them and carry every workset name.
  const pairs = ours.flatMap((entry) => {
    if (!entry) return [];
    const byBranch = new Map<string, Array<{ id: UUID; name: string }>>();
    for (const other of others) {
      if (!other.repoIds.includes(entry.repo.id)) continue;
      const bBranch = other.preferredBranch!;
      const list = byBranch.get(bBranch) ?? [];
      list.push({ id: other.id, name: other.name });
      byBranch.set(bBranch, list);
    }
    return [...byBranch.entries()]
      .slice(0, MAX_COLLISION_PAIRS_PER_REPO)
      .map(([bBranch, bWorksets]) => ({ ...entry, bBranch, bWorksets }));
  });
  const checked = await pool(
    pairs,
    3,
    async ({ repo, sha, bBranch, bWorksets }): Promise<WorksetCollision | null> => {
      const base = {
        repoId: repo.id,
        aWorksetId: ws.id,
        aWorksetName: ws.name,
        aBranch,
        bBranch,
        bWorksets,
      };
      try {
        const b = await run(repo.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${bBranch}`]);
        const bSha = b.stdout.trim();
        if (!b.ok || !bSha) return null;
        const p = await memoizedPreflight(repo.path, aBranch, bBranch, sha, bSha, force);
        return { ...base, result: p.status, conflictFiles: p.conflictFiles, treeOid: p.treeOid, message: p.message };
      } catch (err) {
        return { ...base, result: 'error', conflictFiles: [], treeOid: null, message: String(err) };
      }
    },
  );
  return checked.filter((c): c is WorksetCollision => c !== null);
}

/// Zero-mutation "will this workset land?" report. Every member gets a
/// typed outcome and a single repo's failure never aborts the batch —
/// the same discipline as every other fan-out in this file. `force`
/// bypasses the SHA memo; the explicit Re-check passes it so a pruned
/// merge tree or a one-off error is always recomputed on demand.
export async function worksetLanding(
  worksetId: UUID,
  worksets: Workset[],
  repos: Repo[],
  force = false,
): Promise<WorksetLandingReport> {
  const ws = worksets.find((w) => w.id === worksetId);
  const checkedAt = new Date().toISOString();
  if (!ws) return { worksetId, checkedAt, gitVersion: null, supported: false, outcomes: [], collisions: [] };
  const ver = await gitVersion();
  const supported = supportsMergeTree(ver);
  const members = reposFor(ws, repos);
  if (!supported) {
    return {
      worksetId,
      checkedAt,
      gitVersion: ver?.text ?? null,
      supported,
      outcomes: members.map((r) => landingBase(r.id, 'unsupported')),
      collisions: [],
    };
  }
  // Width 3 — the same budget worksetStatus documents.
  const outcomes = await pool(members, 3, async (repo): Promise<LandingOutcome> => {
    try {
      return await landingOutcomeFor(repo, force);
    } catch (err) {
      return { ...landingBase(repo.id, 'error'), message: String(err) };
    }
  });
  const collisions = await landingCollisionsFor(ws, members, worksets, force);
  return { worksetId, checkedAt, gitVersion: ver?.text ?? null, supported, outcomes, collisions };
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
    out.push(await syncRepoToBranchStep(r, branch, syncDefault, pullBeforeBranch, 'checkout'));
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

  // 5. Fast path: already on the default branch, no force flag.
  // The common case for a workspace reset is "20 clean repos, half
  // on master, please sync them all" — so we want this path to be
  // as few git spawns as possible. Skip the explicit
  // branchExistsOnOrigin + countUnpushedOnBranch probes that the
  // checkout -B path needs; `git merge --ff-only` itself fails
  // distinctly on each error mode and we parse the stderr to map it
  // back to the user-facing outcome shape.
  //
  // `preStatus.branch` from step 1 already knows the current branch
  // (no extra rev-parse spawn). Cumulative win: 3 git spawns instead
  // of 5 per "on default" repo, which adds up across 20+ repos.
  if (preStatus.branch === defaultBranch && !opts.forceLoseUnpushed) {
    const ff = await run(r.path, [
      'merge',
      '--ff-only',
      `origin/${defaultBranch}`,
    ]);
    if (ff.ok) {
      return { repoId: r.id, defaultBranch, result: 'reset' };
    }
    const errBlob = `${ff.stderr ?? ''}\n${ff.stdout ?? ''}`;
    // ff-only refuses on diverged history — could be unpushed local
    // commits or a non-fast-forwardable rewrite. Run the cheaper
    // ahead-count query now (only on this failure branch, not on the
    // happy path) so the user gets a "N unpushed commits" message
    // instead of a raw git error.
    if (/non-fast-forward|Not possible to fast-forward|refusing to merge unrelated/.test(errBlob)) {
      const unpushed = await countUnpushedOnBranch(r.path, defaultBranch);
      return {
        repoId: r.id,
        defaultBranch,
        result: 'unpushed-commits',
        message:
          unpushed > 0
            ? `${unpushed} local ${unpushed === 1 ? 'commit' : 'commits'} on ${defaultBranch} not pushed to origin. Force reset will discard them.`
            : `Local ${defaultBranch} has diverged from origin/${defaultBranch}. Force reset will discard the divergence.`,
        unpushedCount: unpushed,
      };
    }
    // Origin ref missing (typical when the upstream branch was
    // renamed). Surface the existing 'upstream-gone' outcome so the
    // reset-progress UI can prompt to re-detect default.
    if (/unknown revision|bad revision|ambiguous argument|not.*valid object/.test(errBlob)) {
      return {
        repoId: r.id,
        defaultBranch,
        result: 'upstream-gone',
        message: `origin/${defaultBranch} not found — pick a new default in Settings or open the repo to investigate.`,
        staleRef: defaultBranch,
      };
    }
    // Unknown ff failure — fall through to the hard-reset path,
    // which has better diagnostics for edge cases (worktree locks,
    // permission issues, etc.).
  }

  // 6. Refuse to discard unpushed local commits unless forced. Only
  // reached when we're NOT on the default branch (the fast path
  // above handles the on-default case via the ff-merge result).
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

  // 7. Hard-reset local default to origin's tip.
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
/// to 6-wide. Each per-repo job is dominated by the `git fetch`
/// network round-trip, not CPU — so we can run more in flight than
/// the status/squash fan-outs (which are CPU-bound on the main
/// thread). 6 keeps a 20-repo workspace reset under ~3 batches
/// while staying gentle on credential helpers and remote rate
/// limits; pushing higher risks server-side throttling against
/// Bitbucket / GitLab without commensurate wall-time savings.
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
  const concurrency = Math.min(8, repos.length);
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

  // Preflight in parallel: `gitStatus` and `hasUpstream` are read-only
  // and don't prompt for credentials, so there's no reason to serialize
  // them. The actual `gitPush` call below stays serial because that one
  // can prompt (ssh-agent, gpg) and interleaving prompts is unworkable.
  // On a 19-repo workset this turns ~38 sequential git invocations into
  // one batch, which is the difference between "instant" and "several
  // seconds of stuck Pushing… spinner" when nothing actually needs to
  // be pushed.
  const preflight = await Promise.all(
    members.map(async (r) => {
      const st = await gitStatus(r.id, r.path, r.defaultBranch);
      const upstreamSet = st.branch === null ? false : await hasUpstream(r.path);
      return { repo: r, st, upstreamSet };
    }),
  );

  for (const { repo: r, st, upstreamSet } of preflight) {
    if (st.branch === null) {
      out.push({ repoId: r.id, result: 'detached', message: 'Detached HEAD — skipped' });
      continue;
    }
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
/// (current branch only — per-branch tracking is a future-pass thing).
/// PR items are merged in by the renderer from the separately-fetched
/// `worksetPRs` state — fetching them here too would double the gh
/// calls on every workset open. Sorted newest-first. Read-only and
/// best-effort: a repo we can't reach (missing on disk, git not in
/// PATH for that path, etc.) just contributes no items.
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

  // Commits — bounded fan-out. Local-only git commands, so we can
  // afford a wider pool than the gh calls. Branch name is fetched via
  // a single rev-parse instead of full `git status` (which is the hot
  // path's status refresh and would be duplicate work here).
  const commitFanout = await pool(members, 5, async (r) => {
    const branchRes = await run(r.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const raw = branchRes.ok ? branchRes.stdout.trim() : '';
    const branch = !raw || raw === 'HEAD' ? '(detached)' : raw;
    const commits = await gitLog(r.path, perRepo);
    return { repo: r, branch, commits };
  });
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
  // Bounded fan-out: `git worktree list` is fast individually, but a
  // 20-member workset firing all 20 at once still pegs CPU. 5-wide
  // is plenty for this cheap op without crowding the other workset
  // IPCs (status, PRs, activity) that fire in parallel.
  return pool(members, 5, async (r) => ({
    repoId: r.id,
    worktrees: await listWorktrees(r.path),
  }));
}

export async function worksetListPRs(
  worksetId: UUID,
  worksets: Workset[],
  repos: Repo[],
): Promise<RepoPRs[]> {
  const ws = worksets.find((w) => w.id === worksetId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  // gh is the slow part of opening a workset — bound concurrency so a
  // 20-repo workset doesn't fire 20 simultaneous network/auth probes.
  // Skip repos with no GitHub remote entirely; gh would just return
  // "not a GitHub repository" after a network round-trip.
  return pool(members, 3, async (r): Promise<RepoPRs> => {
    if (!(await hasGitHubRemote(r.path))) {
      return { repoId: r.id, prs: null };
    }
    const result = await listOpenPRs(r.path);
    return { repoId: r.id, prs: result.prs, error: result.error };
  });
}
