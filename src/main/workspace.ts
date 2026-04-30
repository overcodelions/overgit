// Workspace coordinator. This is the heart of overgit's overlay model:
// every operation here is "for each repo in the workspace, do X". There
// is NO synthetic root, NO metadata file living inside member repos, NO
// state owned by overgit beyond the workspace-membership list in the
// store. A repo opened in another tool sees no trace of overgit.

import {
  CheckoutOutcome,
  CommitAllOutcome,
  Repo,
  RepoPRs,
  RepoStatus,
  SyncAndBranchOutcome,
  UUID,
  Workspace,
  WorkspaceDiffTruncation,
  WorkspaceOpenPROutcome,
  WorkspacePushOutcome,
  Worktree,
} from '../shared/types';
import {
  checkoutBranch,
  commitAll as gitCommitAll,
  createBranch,
  detectDefaultBranch,
  fetch as gitFetch,
  hasUpstream,
  listWorktrees,
  pull as gitPull,
  push as gitPush,
  rawDiff,
  diffStat,
  status as gitStatus,
} from './git';
import { createPRWithGh, findOpenPRForCurrentBranch, listOpenPRs } from './cli';

function reposFor(workspace: Workspace, repos: Repo[]): Repo[] {
  const byId = new Map(repos.map((r) => [r.id, r]));
  return workspace.repoIds.map((id) => byId.get(id)).filter((r): r is Repo => !!r);
}

export async function workspaceStatus(
  workspaceId: UUID,
  workspaces: Workspace[],
  repos: Repo[],
): Promise<RepoStatus[]> {
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  // Status calls are independent and read-only — fan them out so
  // workspaces with many repos don't take linear time to refresh.
  return Promise.all(members.map((r) => gitStatus(r.id, r.path, r.defaultBranch)));
}

export async function workspaceCheckout(
  workspaceId: UUID,
  branch: string,
  createIfMissing: boolean,
  workspaces: Workspace[],
  repos: Repo[],
): Promise<CheckoutOutcome[]> {
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  // Sequential, not parallel: a workspace-wide checkout is a coordinated
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

export async function workspaceFetch(
  workspaceId: UUID,
  workspaces: Workspace[],
  repos: Repo[],
): Promise<{ repoId: UUID; ok: boolean; error?: string }[]> {
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  return Promise.all(
    members.map(async (r) => ({ repoId: r.id, ...(await gitFetch(r.path)) })),
  );
}

/// "Get latest, then branch" workflow for a workspace. For each repo,
/// optionally switch to its default branch, optionally pull, then
/// create the new branch from there. We run repos sequentially (not
/// parallel) so that a stash prompt or a pull conflict in one repo
/// doesn't get interleaved with another repo's output — the user gets
/// a clean per-repo outcome list to act on.
export async function workspaceSyncAndBranch(
  workspaceId: UUID,
  branch: string,
  syncDefault: boolean,
  pullBeforeBranch: boolean,
  workspaces: Workspace[],
  repos: Repo[],
): Promise<SyncAndBranchOutcome[]> {
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  const out: SyncAndBranchOutcome[] = [];

  for (const r of members) {
    // Resolve the default branch: trust the user's saved value, else
    // probe the repo. A repo with no detected default still proceeds —
    // we'll create the new branch off whatever HEAD is, which is the
    // documented "no default" fallback in the renderer.
    const defaultBranch =
      r.defaultBranch ?? (await detectDefaultBranch(r.path)) ?? null;

    if (syncDefault && defaultBranch) {
      const switchRes = await checkoutBranch(r.id, r.path, defaultBranch, false);
      if (switchRes.result === 'dirty') {
        out.push({
          repoId: r.id,
          branch,
          defaultBranch,
          result: 'dirty',
          message: switchRes.message,
        });
        continue;
      }
      if (switchRes.result === 'error' || switchRes.result === 'missing-branch') {
        out.push({
          repoId: r.id,
          branch,
          defaultBranch,
          result: 'switch-failed',
          message: switchRes.message ?? `Could not switch to ${defaultBranch}`,
        });
        continue;
      }
    } else if (syncDefault && !defaultBranch) {
      // We were asked to sync default, but no default exists. Skip the
      // sync and let the create still happen from the current HEAD —
      // the user can revisit the default-branch setting later.
      out.push({
        repoId: r.id,
        branch,
        defaultBranch: null,
        result: 'no-default-branch',
        message: 'No default branch configured — branched from current HEAD instead.',
      });
      // Don't `continue` — we still want the create to run.
    }

    if (pullBeforeBranch) {
      const pullRes = await gitPull(r.path);
      if (!pullRes.ok) {
        out.push({
          repoId: r.id,
          branch,
          defaultBranch,
          result: 'pull-failed',
          message: pullRes.error,
        });
        continue;
      }
    }

    const createRes = await createBranch(r.path, branch, true);
    if (!createRes.ok) {
      out.push({
        repoId: r.id,
        branch,
        defaultBranch,
        result: 'create-failed',
        message: createRes.error,
      });
      continue;
    }
    // Push a "created" outcome only if we didn't already push a
    // "no-default-branch" warning — the warning IS the outcome in that
    // path, since the new branch was still made.
    if (!out.some((o) => o.repoId === r.id)) {
      out.push({ repoId: r.id, branch, defaultBranch, result: 'created' });
    }
  }
  return out;
}

/// Stage and commit every dirty repo with a shared message. Detached-
/// HEAD repos are skipped — committing onto detached HEAD orphans the
/// commit, which is rarely what someone clicking "Commit all" means.
/// Clean repos come back as `clean` so the result table is symmetric
/// (matches the user's mental model of "I just ran this on N repos").
/// Sequential, like syncAndBranch — one repo's commit failure should
/// be readable in context, not interleaved with others.
export async function workspaceCommitAll(
  workspaceId: UUID,
  message: string,
  workspaces: Workspace[],
  repos: Repo[],
): Promise<CommitAllOutcome[]> {
  const ws = workspaces.find((w) => w.id === workspaceId);
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
    const res = await gitCommitAll(r.path, message);
    if (res.ok) out.push({ repoId: r.id, result: 'committed' });
    else out.push({ repoId: r.id, result: 'commit-failed', message: res.error });
  }
  return out;
}

/// Default byte budget for the concatenated workspace diff sent to LLM
/// CLIs. Sized to comfortably fit inside Claude/Codex/Gemini one-shot
/// context windows after the prompt header. Repos whose diff would push
/// the total past this cap are replaced with their `--stat` summary.
const WORKSPACE_DIFF_BYTE_CAP = 200_000;

/// Concatenate every dirty on-branch repo's working-tree diff into one
/// blob with `=== <repo name> ===` headers, capped at WORKSPACE_DIFF_BYTE_CAP.
/// Repos whose diff would overflow are replaced with their shortstat
/// summary and reported in `truncated`. Detached-HEAD and clean repos
/// are excluded — they'd be skipped by `commitAll` anyway, so reviewing
/// or summarizing them would mislead the model about what's about to
/// land.
export async function aggregateWorkspaceDirtyDiff(
  workspaceId: UUID,
  workspaces: Workspace[],
  repos: Repo[],
): Promise<{ text: string; truncated: WorkspaceDiffTruncation[] }> {
  const ws = workspaces.find((w) => w.id === workspaceId);
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
  const truncated: WorkspaceDiffTruncation[] = [];
  let used = 0;

  for (const { repo } of eligible) {
    const diff = await rawDiff(repo.path, 'working');
    if (!diff.ok || !diff.text) continue;

    const header = `=== ${repo.name} ===\n`;
    const headerCost = Buffer.byteLength(header, 'utf8');
    const diffCost = Buffer.byteLength(diff.text, 'utf8');

    if (used + headerCost + diffCost <= WORKSPACE_DIFF_BYTE_CAP) {
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

/// Push every workspace repo whose branch is ahead of upstream (or has
/// no upstream — first push). Sequential, not parallel: pushes can
/// prompt for credentials (ssh agent unlock, gpg signing key) and
/// interleaving prompts across repos is unworkable. The loop is fast
/// enough for the workspace sizes overgit targets (single digits to
/// low double digits) that serial network calls don't feel slow.
export async function workspacePushAll(
  workspaceId: UUID,
  workspaces: Workspace[],
  repos: Repo[],
): Promise<WorkspacePushOutcome[]> {
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  const out: WorkspacePushOutcome[] = [];
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

/// Open a GitHub PR per workspace repo. Each repo's PR is created
/// against that repo's `defaultBranch` (probed if not set). The shared
/// title / body / draft-flag is reused across all of them — the killer
/// flow is "I just landed a coordinated change across N repos and want
/// the team to see one cohesive set of PRs," so a uniform message is
/// the default. Runs sequentially because gh can prompt for auth, and
/// because per-repo failure modes (unpushed, no-remote) need to be
/// readable in order rather than interleaved.
export async function workspaceOpenPRs(
  workspaceId: UUID,
  title: string,
  body: string,
  draft: boolean,
  workspaces: Workspace[],
  repos: Repo[],
): Promise<WorkspaceOpenPROutcome[]> {
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  const out: WorkspaceOpenPROutcome[] = [];
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
    // Probe gh first. If gh isn't even installed, surface that once per
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
      const result: WorkspaceOpenPROutcome['result'] =
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

export async function workspaceWorktrees(
  workspaceId: UUID,
  workspaces: Workspace[],
  repos: Repo[],
): Promise<{ repoId: UUID; worktrees: Worktree[] }[]> {
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  return Promise.all(
    members.map(async (r) => ({ repoId: r.id, worktrees: await listWorktrees(r.path) })),
  );
}

export async function workspaceListPRs(
  workspaceId: UUID,
  workspaces: Workspace[],
  repos: Repo[],
): Promise<RepoPRs[]> {
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) return [];
  const members = reposFor(ws, repos);
  return Promise.all(
    members.map(async (r): Promise<RepoPRs> => {
      const result = await listOpenPRs(r.path);
      return { repoId: r.id, prs: result.prs, error: result.error };
    }),
  );
}
