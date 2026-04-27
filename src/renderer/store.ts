// Renderer store. Mirrors what's persisted in main, plus ephemeral UI
// state (selected workspace + repo, latest status / log / diff / PR
// snapshots). The "selected" repo is used by the detail pane; the
// "selected" workspace by the workspace pane. They're independent — a
// repo can be open while no workspace is selected, and vice versa.

import { create } from 'zustand';
import type {
  AppSettings,
  BranchSummary,
  CheckoutOutcome,
  CliPresence,
  Commit,
  FileDiff,
  GraphCommit,
  Repo,
  RepoChanges,
  RepoPRs,
  RepoStatus,
  Stash,
  StoreSnapshot,
  UUID,
  Workspace,
} from '@shared/types';

/// Sheet (modal) the user has currently open. `null` means no sheet.
/// Centralized so the title bar's Settings button and the sidebar's
/// "+ New workspace" button can both drive the same single overlay
/// instead of each component owning a useState.
export type Sheet =
  | { kind: 'settings' }
  | { kind: 'about' }
  | { kind: 'newWorkspace' }
  | { kind: 'editWorkspace'; workspaceId: UUID }
  | { kind: 'reviewChanges'; repoId: UUID; scope: 'staged' | 'working' }
  | { kind: 'newBranchInWorkspace'; workspaceId: UUID };

interface OpenFile {
  repoId: UUID;
  path: string;
}

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
  repoBranchSummaries: Record<UUID, BranchSummary[]>;
  repoGraph: Record<UUID, GraphCommit[]>;
  repoFileList: Record<UUID, string[]>;
  repoStashes: Record<UUID, Stash[]>;
  cliPresence: CliPresence | null;

  /// Currently open file in the in-app editor. Per-repo we'd allow many
  /// open files in the future; for v1 a single open slot keeps the UI
  /// readable without a tabbed editor.
  openFile: OpenFile | null;
  openFileContent: string;
  openFileDirty: boolean;
  openFileError: string | null;
  openFileLoading: boolean;

  sheet: Sheet | null;
  /// The Cmd+K command palette is its own overlay (not a Sheet) because
  /// it has its own layout — top-anchored, narrower, no header chrome —
  /// and its own keyboard semantics. One boolean is enough; the
  /// renderer derives the result list from existing store fields.
  paletteOpen: boolean;
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
  refreshRepoBranchSummaries: (id: UUID) => Promise<void>;
  refreshRepoGraph: (id: UUID) => Promise<void>;
  refreshRepoFileList: (id: UUID) => Promise<void>;
  refreshRepoStashes: (id: UUID) => Promise<void>;
  applyStash: (id: UUID, index: number, pop: boolean) => Promise<{ ok: boolean; error?: string }>;
  dropStash: (id: UUID, index: number) => Promise<{ ok: boolean; error?: string }>;
  stashFiles: (id: UUID, paths: string[], message?: string) => Promise<{ ok: boolean; error?: string }>;
  setRepoDefaultBranch: (id: UUID, branch: string | null) => Promise<void>;
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

  openRepoFile: (repoId: UUID, path: string) => Promise<void>;
  closeRepoFile: () => void;
  setOpenFileContent: (content: string) => void;
  saveOpenFile: () => Promise<{ ok: boolean; error?: string }>;

  toggleSidebar: () => void;
  setSidebarWidth: (px: number) => Promise<void>;
  setSheet: (sheet: Sheet | null) => void;
  togglePalette: (open?: boolean) => void;

  removeRepo: (id: UUID) => Promise<void>;
  removeWorkspace: (id: UUID) => Promise<void>;
  updateWorkspace: (id: UUID, patch: Partial<Pick<Workspace, 'name' | 'repoIds'>>) => Promise<void>;
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
  settings: { theme: 'system', sidebarVisible: true, sidebarWidth: 288 },
  selectedWorkspaceId: null,
  selectedRepoId: null,
  workspaceStatuses: {},
  workspacePRs: {},
  repoLog: {},
  repoDiff: {},
  repoChanges: {},
  repoStatus: {},
  repoBranches: {},
  repoBranchSummaries: {},
  repoGraph: {},
  repoFileList: {},
  repoStashes: {},
  cliPresence: null,
  lastCheckout: null,
  openFile: null,
  openFileContent: '',
  openFileDirty: false,
  openFileError: null,
  openFileLoading: false,
  sheet: null,
  paletteOpen: false,

  hydrate: async () => {
    const snap: StoreSnapshot = await window.overgit.invoke('store:load');
    const cli = await window.overgit.invoke('cli:detect');
    // Auto-select the first repo (or workspace, if there are no repos)
    // on launch when nothing is selected. Without this, a fresh-install
    // user lands on the empty "Pick a repo or a workspace" pane even
    // though their library has entries.
    const cur = get();
    const haveSelection =
      (cur.selectedRepoId && snap.repos.some((r) => r.id === cur.selectedRepoId)) ||
      (cur.selectedWorkspaceId && snap.workspaces.some((w) => w.id === cur.selectedWorkspaceId));
    set({
      loaded: true,
      repos: snap.repos,
      workspaces: snap.workspaces,
      settings: snap.settings,
      cliPresence: cli,
    });
    if (!haveSelection) {
      if (snap.repos.length > 0) {
        get().selectRepo(snap.repos[0].id);
      } else if (snap.workspaces.length > 0) {
        get().selectWorkspace(snap.workspaces[0].id);
      }
    }
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

  refreshRepoBranchSummaries: async (id) => {
    const summaries = await window.overgit.invoke('repo:branchSummaries', id);
    set({ repoBranchSummaries: { ...get().repoBranchSummaries, [id]: summaries } });
  },

  setRepoDefaultBranch: async (id, branch) => {
    const repos = get().repos.map((r) =>
      r.id === id ? { ...r, defaultBranch: branch ?? undefined } : r,
    );
    set({ repos });
    await window.overgit.invoke('repo:setDefaultBranch', { repoId: id, branch });
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

  refreshRepoGraph: async (id) => {
    const commits = await window.overgit.invoke('repo:graph', { repoId: id, limit: 200 });
    set({ repoGraph: { ...get().repoGraph, [id]: commits } });
  },

  refreshRepoFileList: async (id) => {
    const files = await window.overgit.invoke('fs:listFiles', id);
    set({ repoFileList: { ...get().repoFileList, [id]: files } });
  },

  refreshRepoStashes: async (id) => {
    const stashes = await window.overgit.invoke('repo:listStashes', id);
    set({ repoStashes: { ...get().repoStashes, [id]: stashes } });
  },

  applyStash: async (id, index, pop) => {
    const res = await window.overgit.invoke('repo:applyStash', { repoId: id, index, pop });
    if (res.ok) {
      // Apply/pop changes the working tree; refresh status + changes so
      // the user sees the result without flipping tabs. Pop also drops
      // the stash, so re-fetch the stash list either way.
      await Promise.all([
        get().refreshRepoStatus(id),
        get().refreshRepoChanges(id),
        get().refreshRepoStashes(id),
      ]);
    }
    return res;
  },

  dropStash: async (id, index) => {
    const res = await window.overgit.invoke('repo:dropStash', { repoId: id, index });
    if (res.ok) await get().refreshRepoStashes(id);
    return res;
  },

  stashFiles: async (id, paths, message) => {
    const res = await window.overgit.invoke('repo:stashFiles', {
      repoId: id,
      paths,
      message,
    });
    if (res.ok) {
      // Stashing removes the listed paths from staged + worktree, so
      // every dependent view (status, changes, stash list) needs to
      // refresh together. The Stash tab is what the user usually
      // navigates to next; that list is now one entry longer.
      await Promise.all([
        get().refreshRepoStatus(id),
        get().refreshRepoChanges(id),
        get().refreshRepoStashes(id),
      ]);
    }
    return res;
  },

  openRepoFile: async (repoId, p) => {
    set({
      openFile: { repoId, path: p },
      openFileContent: '',
      openFileDirty: false,
      openFileError: null,
      openFileLoading: true,
    });
    const res = await window.overgit.invoke('fs:readFile', { repoId, path: p });
    if (res.ok) {
      set({
        openFileContent: res.content,
        openFile: { repoId, path: res.resolvedPath },
        openFileDirty: false,
        openFileError: null,
        openFileLoading: false,
      });
    } else {
      set({
        openFileContent: '',
        openFileDirty: false,
        openFileError: res.error,
        openFileLoading: false,
      });
    }
  },

  closeRepoFile: () => {
    set({
      openFile: null,
      openFileContent: '',
      openFileDirty: false,
      openFileError: null,
      openFileLoading: false,
    });
  },

  setOpenFileContent: (content) => {
    set({ openFileContent: content, openFileDirty: true });
  },

  saveOpenFile: async () => {
    const file = get().openFile;
    if (!file) return { ok: false, error: 'No file open' };
    const res = await window.overgit.invoke('fs:writeFile', {
      repoId: file.repoId,
      path: file.path,
      content: get().openFileContent,
    });
    if (res.ok) {
      set({ openFileDirty: false });
      // Saving a tracked file usually changes its status; refresh both
      // panes so the Changes tab and the working-tree diff are honest.
      await Promise.all([
        get().refreshRepoChanges(file.repoId),
        get().refreshRepoStatus(file.repoId),
      ]);
    }
    return res;
  },

  toggleSidebar: async () => {
    const cur = get().settings;
    const next = { ...cur, sidebarVisible: !cur.sidebarVisible };
    set({ settings: next });
    await window.overgit.invoke('store:saveSettings', next);
  },

  /// Resize handler used by the drag divider. We persist on every
  /// release-equivalent (the caller debounces to one save per drag); the
  /// in-memory update happens synchronously so the layout tracks the
  /// pointer without round-tripping the IPC.
  setSidebarWidth: async (px) => {
    const cur = get().settings;
    if (cur.sidebarWidth === px) return;
    const next = { ...cur, sidebarWidth: px };
    set({ settings: next });
    await window.overgit.invoke('store:saveSettings', next);
  },

  setSheet: (sheet) => set({ sheet }),

  togglePalette: (open) =>
    set((s) => ({ paletteOpen: typeof open === 'boolean' ? open : !s.paletteOpen })),

  removeRepo: async (id) => {
    const repos = get().repos.filter((r) => r.id !== id);
    // Drop the repo from any workspace that referenced it. We don't
    // delete workspaces that empty out — empty workspaces are valid; the
    // user can re-populate or delete them explicitly.
    const workspaces = get().workspaces.map((w) =>
      w.repoIds.includes(id) ? { ...w, repoIds: w.repoIds.filter((r) => r !== id) } : w,
    );
    const patch: Partial<UiState> = { repos, workspaces };
    if (get().selectedRepoId === id) patch.selectedRepoId = null;
    if (get().openFile?.repoId === id) {
      patch.openFile = null;
      patch.openFileContent = '';
      patch.openFileDirty = false;
    }
    set(patch);
    await Promise.all([
      window.overgit.invoke('store:saveRepos', repos),
      window.overgit.invoke('store:saveWorkspaces', workspaces),
    ]);
  },

  removeWorkspace: async (id) => {
    const workspaces = get().workspaces.filter((w) => w.id !== id);
    const patch: Partial<UiState> = { workspaces };
    if (get().selectedWorkspaceId === id) patch.selectedWorkspaceId = null;
    set(patch);
    await window.overgit.invoke('store:saveWorkspaces', workspaces);
  },

  updateWorkspace: async (id, patch) => {
    const workspaces = get().workspaces.map((w) =>
      w.id === id ? { ...w, ...patch } : w,
    );
    set({ workspaces });
    await window.overgit.invoke('store:saveWorkspaces', workspaces);
  },
}));
