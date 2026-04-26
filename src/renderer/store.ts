// Renderer store. Mirrors what's persisted in main, plus ephemeral UI
// state (selected workspace + repo, latest status / log / diff / PR
// snapshots). The "selected" repo is used by the detail pane; the
// "selected" workspace by the workspace pane. They're independent — a
// repo can be open while no workspace is selected, and vice versa.

import { create } from 'zustand';
import type {
  AppSettings,
  CheckoutOutcome,
  CliPresence,
  Commit,
  FileDiff,
  Repo,
  RepoChanges,
  RepoPRs,
  RepoStatus,
  StoreSnapshot,
  UUID,
  Workspace,
} from '@shared/types';

interface UiState {
  loaded: boolean;
  repos: Repo[];
  workspaces: Workspace[];
  settings: AppSettings;
  selectedWorkspaceId: UUID | null;
  selectedRepoId: UUID | null;
  workspaceStatuses: Record<UUID, RepoStatus[]>;
  workspacePRs: Record<UUID, RepoPRs[]>;
  repoLog: Record<UUID, Commit[]>;
  repoDiff: Record<UUID, { key: string; files: FileDiff[] }>;
  repoChanges: Record<UUID, RepoChanges>;
  repoStatus: Record<UUID, RepoStatus>;
  repoBranches: Record<UUID, { local: string[]; remote: string[] }>;
  cliPresence: CliPresence | null;
  /// The most recent workspace-checkout result, kept around so the UI
  /// can show per-repo outcomes and offer Stash/Commit affordances on
  /// repos that came back dirty.
  lastCheckout: { workspaceId: UUID; branch: string; outcomes: CheckoutOutcome[] } | null;

  hydrate: () => Promise<void>;
  pickAndAddRepo: () => Promise<void>;
  createWorkspace: (name: string, repoIds: UUID[]) => Promise<void>;
  selectWorkspace: (id: UUID | null) => void;
  selectRepo: (id: UUID | null) => void;
  refreshWorkspaceStatus: (id: UUID) => Promise<void>;
  refreshWorkspacePRs: (id: UUID) => Promise<void>;
  checkoutWorkspaceBranch: (id: UUID, branch: string, createIfMissing: boolean) => Promise<void>;
  fetchWorkspace: (id: UUID) => Promise<void>;
  refreshRepoLog: (id: UUID) => Promise<void>;
  refreshRepoDiff: (id: UUID, sha?: string) => Promise<void>;
  stashRepo: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
  commitAllRepo: (id: UUID, message: string) => Promise<{ ok: boolean; error?: string }>;
  retryCheckoutRepo: (id: UUID) => Promise<void>;

  refreshRepoChanges: (id: UUID) => Promise<void>;
  refreshRepoStatus: (id: UUID) => Promise<void>;
  refreshRepoBranches: (id: UUID) => Promise<void>;
  stageFiles: (id: UUID, paths: string[]) => Promise<void>;
  unstageFiles: (id: UUID, paths: string[]) => Promise<void>;
  discardFiles: (id: UUID, paths: string[]) => Promise<void>;
  commitRepo: (id: UUID, message: string) => Promise<{ ok: boolean; error?: string }>;
  pushRepo: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
  pullRepo: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
  fetchRepo: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
  checkoutRepo: (id: UUID, branch: string, createIfMissing: boolean) => Promise<CheckoutOutcome>;
  createRepoBranch: (id: UUID, name: string, checkout: boolean) => Promise<{ ok: boolean; error?: string }>;
  deleteRepoBranch: (id: UUID, name: string, force: boolean) => Promise<{ ok: boolean; error?: string }>;
  loadRepoFileDiff: (id: UUID, path: string, side: 'staged' | 'unstaged') => Promise<void>;
}

function uuid(): UUID {
  return crypto.randomUUID();
}

function diffKey(sha: string | undefined): string {
  return sha ?? '__working__';
}

export const useStore = create<UiState>((set, get) => ({
  loaded: false,
  repos: [],
  workspaces: [],
  settings: { theme: 'system' },
  selectedWorkspaceId: null,
  selectedRepoId: null,
  workspaceStatuses: {},
  workspacePRs: {},
  repoLog: {},
  repoDiff: {},
  repoChanges: {},
  repoStatus: {},
  repoBranches: {},
  cliPresence: null,
  lastCheckout: null,

  hydrate: async () => {
    const snap: StoreSnapshot = await window.overgit.invoke('store:load');
    const cli = await window.overgit.invoke('cli:detect');
    set({
      loaded: true,
      repos: snap.repos,
      workspaces: snap.workspaces,
      settings: snap.settings,
      cliPresence: cli,
    });
  },

  pickAndAddRepo: async () => {
    const result = await window.overgit.invoke('repo:pickAndAdd');
    if (!result.ok) {
      if ('cancelled' in result) return;
      alert(result.error);
      return;
    }
    const repos = [...get().repos.filter((r) => r.id !== result.repo.id), result.repo];
    set({ repos });
    await window.overgit.invoke('store:saveRepos', repos);
  },

  createWorkspace: async (name, repoIds) => {
    const ws: Workspace = { id: uuid(), name, repoIds };
    const workspaces = [...get().workspaces, ws];
    set({ workspaces, selectedWorkspaceId: ws.id, selectedRepoId: null });
    await window.overgit.invoke('store:saveWorkspaces', workspaces);
  },

  selectWorkspace: (id) => {
    set({ selectedWorkspaceId: id, selectedRepoId: null });
    if (id) {
      get().refreshWorkspaceStatus(id);
      get().refreshWorkspacePRs(id);
    }
  },

  selectRepo: (id) => {
    set({ selectedRepoId: id });
    if (id) {
      get().refreshRepoLog(id);
      get().refreshRepoChanges(id);
      get().refreshRepoStatus(id);
      get().refreshRepoBranches(id);
    }
  },

  refreshWorkspaceStatus: async (id) => {
    const statuses = await window.overgit.invoke('workspace:status', id);
    set({ workspaceStatuses: { ...get().workspaceStatuses, [id]: statuses } });
  },

  refreshWorkspacePRs: async (id) => {
    const prs = await window.overgit.invoke('workspace:listPRs', id);
    set({ workspacePRs: { ...get().workspacePRs, [id]: prs } });
  },

  checkoutWorkspaceBranch: async (id, branch, createIfMissing) => {
    const outcomes = await window.overgit.invoke('workspace:checkoutBranch', {
      workspaceId: id,
      branch,
      createIfMissing,
    });
    set({ lastCheckout: { workspaceId: id, branch, outcomes } });
    await get().refreshWorkspaceStatus(id);
  },

  fetchWorkspace: async (id) => {
    await window.overgit.invoke('workspace:fetchAll', id);
    await Promise.all([get().refreshWorkspaceStatus(id), get().refreshWorkspacePRs(id)]);
  },

  refreshRepoLog: async (id) => {
    const commits = await window.overgit.invoke('repo:log', { repoId: id, limit: 100 });
    set({ repoLog: { ...get().repoLog, [id]: commits } });
  },

  refreshRepoDiff: async (id, sha) => {
    const files = await window.overgit.invoke('repo:diff', { repoId: id, sha });
    set({ repoDiff: { ...get().repoDiff, [id]: { key: diffKey(sha), files } } });
  },

  stashRepo: async (id) => {
    const res = await window.overgit.invoke('repo:stash', { repoId: id });
    return res;
  },

  commitAllRepo: async (id, message) => {
    const res = await window.overgit.invoke('repo:commitAll', { repoId: id, message });
    return res;
  },

  /// After a stash/commit succeeds we want to retry the checkout for
  /// just that repo — but only if there's a `lastCheckout` to retry
  /// against. Replaces the matching outcome in place so the workspace
  /// outcome list shows the new result instead of the stale dirty one.
  retryCheckoutRepo: async (id) => {
    const last = get().lastCheckout;
    if (!last) return;
    const outcome = await window.overgit.invoke('repo:retryCheckout', {
      repoId: id,
      branch: last.branch,
      createIfMissing: false,
    });
    const outcomes = last.outcomes.map((o) => (o.repoId === id ? outcome : o));
    set({ lastCheckout: { ...last, outcomes } });
    await get().refreshWorkspaceStatus(last.workspaceId);
  },

  refreshRepoChanges: async (id) => {
    const ch = await window.overgit.invoke('repo:changes', id);
    set({ repoChanges: { ...get().repoChanges, [id]: ch } });
  },

  refreshRepoStatus: async (id) => {
    const st = await window.overgit.invoke('repo:status', id);
    set({ repoStatus: { ...get().repoStatus, [id]: st } });
  },

  refreshRepoBranches: async (id) => {
    const br = await window.overgit.invoke('repo:listBranches', id);
    set({ repoBranches: { ...get().repoBranches, [id]: br } });
  },

  stageFiles: async (id, paths) => {
    const res = await window.overgit.invoke('repo:stageFiles', { repoId: id, paths });
    if (!res.ok) alert(res.error ?? 'Stage failed');
    await get().refreshRepoChanges(id);
    await get().refreshRepoStatus(id);
  },

  unstageFiles: async (id, paths) => {
    const res = await window.overgit.invoke('repo:unstageFiles', { repoId: id, paths });
    if (!res.ok) alert(res.error ?? 'Unstage failed');
    await get().refreshRepoChanges(id);
    await get().refreshRepoStatus(id);
  },

  discardFiles: async (id, paths) => {
    const res = await window.overgit.invoke('repo:discardFiles', { repoId: id, paths });
    if (!res.ok) alert(res.error ?? 'Discard failed');
    await get().refreshRepoChanges(id);
    await get().refreshRepoStatus(id);
  },

  commitRepo: async (id, message) => {
    const res = await window.overgit.invoke('repo:commit', { repoId: id, message });
    if (res.ok) {
      // Refresh log + changes + status; the new commit changes all three.
      await Promise.all([
        get().refreshRepoLog(id),
        get().refreshRepoChanges(id),
        get().refreshRepoStatus(id),
      ]);
    }
    return res;
  },

  pushRepo: async (id) => {
    const res = await window.overgit.invoke('repo:push', id);
    if (res.ok) await get().refreshRepoStatus(id);
    return res;
  },

  pullRepo: async (id) => {
    const res = await window.overgit.invoke('repo:pull', id);
    if (res.ok) {
      await Promise.all([
        get().refreshRepoLog(id),
        get().refreshRepoChanges(id),
        get().refreshRepoStatus(id),
      ]);
    }
    return res;
  },

  fetchRepo: async (id) => {
    const res = await window.overgit.invoke('repo:fetch', id);
    if (res.ok) await get().refreshRepoStatus(id);
    return res;
  },

  checkoutRepo: async (id, branch, createIfMissing) => {
    const outcome = await window.overgit.invoke('repo:checkout', {
      repoId: id,
      branch,
      createIfMissing,
    });
    if (outcome.result === 'switched' || outcome.result === 'already-on-branch') {
      await Promise.all([
        get().refreshRepoStatus(id),
        get().refreshRepoChanges(id),
        get().refreshRepoLog(id),
      ]);
    }
    return outcome;
  },

  createRepoBranch: async (id, name, checkout) => {
    const res = await window.overgit.invoke('repo:createBranch', {
      repoId: id,
      name,
      checkout,
    });
    if (res.ok) {
      await Promise.all([get().refreshRepoBranches(id), get().refreshRepoStatus(id)]);
    }
    return res;
  },

  deleteRepoBranch: async (id, name, force) => {
    const res = await window.overgit.invoke('repo:deleteBranch', {
      repoId: id,
      name,
      force,
    });
    if (res.ok) await get().refreshRepoBranches(id);
    return res;
  },

  loadRepoFileDiff: async (id, p, side) => {
    const files = await window.overgit.invoke('repo:diffFile', {
      repoId: id,
      path: p,
      side,
    });
    set({ repoDiff: { ...get().repoDiff, [id]: { key: `${side}:${p}`, files } } });
  },
}));
