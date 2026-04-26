// Workspace coordinator. This is the heart of overgit's overlay model:
// every operation here is "for each repo in the workspace, do X". There
// is NO synthetic root, NO metadata file living inside member repos, NO
// state owned by overgit beyond the workspace-membership list in the
// store. A repo opened in another tool sees no trace of overgit.

import { CheckoutOutcome, Repo, RepoPRs, RepoStatus, UUID, Workspace } from '../shared/types';
import { checkoutBranch, fetch as gitFetch, status as gitStatus } from './git';
import { listOpenPRs } from './cli';

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
  return Promise.all(members.map((r) => gitStatus(r.id, r.path)));
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
