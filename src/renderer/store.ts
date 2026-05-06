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
  CommitAllOutcome,
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
  WorkspaceActivity,
  WorkspaceOpenPROutcome,
  WorkspacePushOutcome,
  Worktree,
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
  | { kind: 'newBranchInWorkspace'; workspaceId: UUID }
  | { kind: 'commitAllInWorkspace'; workspaceId: UUID }
  | { kind: 'pushAllInWorkspace'; workspaceId: UUID }
  | { kind: 'openPRsInWorkspace'; workspaceId: UUID }
  | { kind: 'fileHistory'; repoId: UUID; path: string; tab: 'history' | 'blame' }
  | { kind: 'manageRepo'; repoId: UUID; tab: 'tags' | 'remotes' | 'submodules' | 'identity' }
  | { kind: 'pullConflict'; repoId: UUID; conflicts: string[]; rawError: string }
  | { kind: 'initRepo'; path: string; reason: string }
  | { kind: 'resolveConflict'; repoId: UUID; path: string };

interface OpenFile {
  repoId: UUID;
  path: string;
}

/// Lightweight notification surface. Replaces ad-hoc `alert(...)` calls
/// scattered across the renderer; `alert` blocks the renderer thread
/// in Electron, so any async work behind it stalls until the user
/// dismisses the dialog. Toasts auto-hide unless `sticky` is set.
export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  message: string;
  sticky?: boolean;
}

/// Modeless confirmation request. `requestConfirm` returns a promise so
/// callers read the same as `window.confirm` (`if (await ...)`), but
/// it's resolved by the in-app sheet rather than blocking the renderer.
/// We keep `resolve` on the store entry so the host component can call
/// it from button handlers without prop-drilling.
export interface ConfirmRequest {
  id: string;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  /// Renders the confirm button in the destructive (red) treatment.
  destructive: boolean;
  resolve: (ok: boolean) => void;
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
  /// Activity-feed cache per workspace. Each refresh replaces the full
  /// list; we don't paginate or merge historical fetches because the
  /// "what's new since I last looked" model only needs the most recent
  /// snapshot.
  workspaceActivity: Record<UUID, WorkspaceActivity[]>;
  /// Cached `git worktree list` output per repo. Keyed by repoId, not
  /// workspaceId, because worktrees belong to repos and the same repo
  /// can appear in multiple workspaces — caching by workspace would
  /// duplicate the data and risk drift between views.
  workspaceWorktrees: Record<UUID, Worktree[]>;
  repoLog: Record<UUID, Commit[]>;
  repoDiff: Record<UUID, { key: string; files: FileDiff[] }>;
  repoChanges: Record<UUID, RepoChanges>;
  repoStatus: Record<UUID, RepoStatus>;
  repoBranches: Record<UUID, { local: string[]; remote: string[] }>;
  repoBranchSummaries: Record<UUID, BranchSummary[]>;
  repoGraph: Record<UUID, GraphCommit[]>;
  repoFileList: Record<UUID, Array<{ path: string; ignored: boolean }>>;
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
  /// Active toast notifications. Newest are pushed to the end; the host
  /// renders them top-to-bottom so the most recent is visible without
  /// scrolling.
  toasts: Toast[];
  /// Pending confirmation, if any. Renderer's <ConfirmHost /> watches
  /// this and renders the modal. Single-slot — only one confirm at a
  /// time, which matches what `window.confirm` allowed.
  pendingConfirm: ConfirmRequest | null;
  /// The most recent workspace-checkout result, kept around so the UI
  /// can show per-repo outcomes and offer Stash/Commit affordances on
  /// repos that came back dirty.
  lastCheckout: { workspaceId: UUID; branch: string; outcomes: CheckoutOutcome[] } | null;
  /// Current contents of the bottom learning bar. Set by `<Explain>` on
  /// hover. `null` puts the bar in its idle prompt. Single slot — only
  /// the most recently hovered element is shown.
  learningHint: { command: string; plain: string } | null;

  hydrate: () => Promise<void>;
  pickAndAddRepo: () => Promise<void>;
  /// Run `git init` at `path` (with optional initial branch) and add the
  /// resulting repo to the library. Used by the InitRepo sheet that the
  /// "Add repo" flow opens when the picked folder is not yet a git repo.
  initAndAddRepo: (
    path: string,
    initialBranch: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  createWorkspace: (name: string, repoIds: UUID[], preferredBranch?: string) => Promise<void>;
  selectWorkspace: (id: UUID | null) => void;
  selectRepo: (id: UUID | null) => void;
  refreshWorkspaceStatus: (id: UUID) => Promise<void>;
  refreshWorkspacePRs: (id: UUID) => Promise<void>;
  refreshWorkspaceWorktrees: (id: UUID) => Promise<void>;
  refreshWorkspaceActivity: (id: UUID) => Promise<void>;
  /// Stamp the workspace's `lastSeen` to "now". Called when the user
  /// opens the workspace pane so the activity feed's "new since" pip
  /// shifts forward — and on explicit "Mark all read" too.
  markWorkspaceSeen: (id: UUID) => Promise<void>;
  refreshRepoWorktrees: (id: UUID) => Promise<void>;
  adoptWorktreeBranch: (
    id: UUID,
    worktreePath: string,
    branch: string,
    forceRemove: boolean,
    commitMessage?: string,
  ) => Promise<
    | { ok: true }
    | { ok: false; step: 'precheck' | 'commit' | 'remove' | 'checkout'; error: string }
  >;
  removeWorktree: (
    id: UUID,
    worktreePath: string,
    force: boolean,
  ) => Promise<{ ok: boolean; error?: string }>;
  pruneWorktrees: (id: UUID) => Promise<{ ok: boolean; error?: string; output?: string }>;
  commitAllWorkspace: (id: UUID, message: string) => Promise<CommitAllOutcome[]>;
  pushAllWorkspace: (id: UUID) => Promise<WorkspacePushOutcome[]>;
  openPRsWorkspace: (
    id: UUID,
    args: { title: string; body: string; draft: boolean },
  ) => Promise<WorkspaceOpenPROutcome[]>;
  checkoutWorkspaceBranch: (id: UUID, branch: string, createIfMissing: boolean) => Promise<void>;
  fetchWorkspace: (id: UUID) => Promise<void>;
  refreshRepoLog: (id: UUID) => Promise<void>;
  refreshRepoDiff: (id: UUID, sha?: string) => Promise<void>;
  stashRepo: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
  commitAllRepo: (id: UUID, message: string) => Promise<{ ok: boolean; error?: string }>;
  retryCheckoutRepo: (id: UUID) => Promise<void>;

  refreshRepoChanges: (id: UUID) => Promise<void>;
  refreshRepoStatus: (id: UUID) => Promise<void>;
  /// Fan out `repo:status` for every known repo so the sidebar can flag
  /// dirty / ahead / behind state without the user having to click into
  /// each one. Failures on individual repos are swallowed — a single
  /// broken repo shouldn't blank out the markers for the rest.
  refreshAllRepoStatuses: () => Promise<void>;
  /// Fan out `git fetch` for every known repo so the sidebar's
  /// ahead/behind dots reflect the remote, not just the stale local
  /// tracking refs. Errors are swallowed — a flaky remote or auth
  /// prompt shouldn't surface as a toast for a background sync. Calls
  /// `refreshAllRepoStatuses` when done so the dots actually move.
  fetchAllReposQuiet: () => Promise<void>;
  refreshRepoBranches: (id: UUID) => Promise<void>;
  refreshRepoBranchSummaries: (id: UUID) => Promise<void>;
  refreshRepoGraph: (id: UUID) => Promise<void>;
  refreshRepoFileList: (id: UUID) => Promise<void>;
  refreshRepoStashes: (id: UUID) => Promise<void>;
  applyStash: (
    id: UUID,
    index: number,
    pop: boolean,
  ) => Promise<{ ok: boolean; error?: string; conflicts?: string[] }>;
  applyStashForce: (
    id: UUID,
    index: number,
    pop: boolean,
  ) => Promise<{ ok: boolean; error?: string; removed?: string[] }>;
  dropStash: (id: UUID, index: number) => Promise<{ ok: boolean; error?: string }>;
  stashFiles: (id: UUID, paths: string[], message?: string) => Promise<{ ok: boolean; error?: string }>;
  applyPatch: (
    id: UUID,
    patch: string,
    mode: 'stage' | 'unstage' | 'discard',
  ) => Promise<{ ok: boolean; error?: string }>;
  amendCommit: (id: UUID, message: string | null) => Promise<{ ok: boolean; error?: string }>;
  mergeBranch: (
    id: UUID,
    branch: string,
    mode: 'merge' | 'ff-only' | 'squash',
  ) => Promise<{ ok: boolean; error?: string; output?: string; alreadyUpToDate?: boolean }>;
  abortMerge: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
  resolveConflictSide: (
    id: UUID,
    path: string,
    side: 'ours' | 'theirs',
  ) => Promise<{ ok: boolean; error?: string }>;
  readMergeMsg: (id: UUID) => Promise<{ ok: boolean; message: string | null; error?: string }>;
  commitMerge: (id: UUID, message: string | null) => Promise<{ ok: boolean; error?: string }>;
  rebaseOnto: (id: UUID, onto: string) => Promise<{ ok: boolean; error?: string }>;
  abortRebase: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
  continueRebase: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
  abortCherryPick: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
  continueCherryPick: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
  markResolved: (
    id: UUID,
    paths: string[],
  ) => Promise<{ ok: boolean; remaining: string[]; error?: string }>;
  setRepoDefaultBranch: (id: UUID, branch: string | null) => Promise<void>;
  stageFiles: (id: UUID, paths: string[]) => Promise<void>;
  unstageFiles: (id: UUID, paths: string[]) => Promise<void>;
  discardFiles: (id: UUID, paths: string[]) => Promise<void>;
  commitRepo: (id: UUID, message: string) => Promise<{ ok: boolean; error?: string }>;
  pushRepo: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
  pullRepo: (id: UUID) => Promise<{ ok: boolean; error?: string; conflicts?: string[] }>;
  pullForce: (
    id: UUID,
    conflicts: string[],
    strategy: 'stash' | 'discard',
  ) => Promise<{ ok: boolean; error?: string; stashed?: boolean }>;
  fetchRepo: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
  checkoutRepo: (id: UUID, branch: string, createIfMissing: boolean) => Promise<CheckoutOutcome>;
  createRepoBranch: (
    id: UUID,
    name: string,
    checkout: boolean,
    from?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  deleteRepoBranch: (id: UUID, name: string, force: boolean) => Promise<{ ok: boolean; error?: string }>;
  renameRepoBranch: (
    id: UUID,
    from: string | null,
    to: string,
    force: boolean,
  ) => Promise<{ ok: boolean; error?: string }>;
  loadRepoFileDiff: (id: UUID, path: string, side: 'staged' | 'unstaged' | 'combined') => Promise<void>;

  openRepoFile: (repoId: UUID, path: string) => Promise<void>;
  closeRepoFile: () => void;
  setOpenFileContent: (content: string) => void;
  saveOpenFile: () => Promise<{ ok: boolean; error?: string }>;

  toggleSidebar: () => void;
  setSidebarWidth: (px: number) => Promise<void>;
  setHistoryAsideWidth: (px: number) => Promise<void>;
  setSheet: (sheet: Sheet | null) => void;
  togglePalette: (open?: boolean) => void;

  removeRepo: (id: UUID) => Promise<void>;
  removeWorkspace: (id: UUID) => Promise<void>;
  updateWorkspace: (id: UUID, patch: Partial<Pick<Workspace, 'name' | 'repoIds' | 'preferredBranch'>>) => Promise<void>;
  /// Hide the workspace from the active sidebar list. Member repos are
  /// untouched on disk; the working set just disappears from view until
  /// reactivated. Deselects if it was the current workspace.
  archiveWorkspace: (id: UUID) => Promise<void>;
  /// Restore an archived workspace and select it (the "reopen" half of
  /// the lifecycle).
  unarchiveWorkspace: (id: UUID) => Promise<void>;

  setLearningHint: (hint: { command: string; plain: string } | null) => void;

  pushToast: (toast: Omit<Toast, 'id'>) => string;
  dismissToast: (id: string) => void;
  /// Replacement for `window.confirm`. Returns true when the user
  /// confirms, false on cancel or escape. Reasonable defaults so most
  /// call sites just need to pass `body`.
  requestConfirm: (args: {
    title?: string;
    body: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
  }) => Promise<boolean>;
  resolveConfirm: (id: string, ok: boolean) => void;
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
  settings: {
    theme: 'system',
    sidebarVisible: true,
    sidebarWidth: 288,
    historyAsideWidth: 480,
    stagingMode: 'simple',
    explainMode: true,
  },
  selectedWorkspaceId: null,
  selectedRepoId: null,
  workspaceStatuses: {},
  workspacePRs: {},
  workspaceActivity: {},
  workspaceWorktrees: {},
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
  learningHint: null,
  openFile: null,
  openFileContent: '',
  openFileDirty: false,
  openFileError: null,
  openFileLoading: false,
  sheet: null,
  paletteOpen: false,
  toasts: [],
  pendingConfirm: null,

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
      } else {
        const firstActive = snap.workspaces.find((w) => !w.archived);
        if (firstActive) get().selectWorkspace(firstActive.id);
      }
    }
    // Background-refresh statuses for every repo so the sidebar can
    // surface dirty / ahead / behind dots without waiting for the user
    // to click each one. Don't await — the rest of the UI should render
    // immediately even if this fan-out is slow on a big library.
    void get().refreshAllRepoStatuses();
  },

  pickAndAddRepo: async () => {
    const result = await window.overgit.invoke('repo:pickAndAdd');
    if (!result.ok) {
      if ('cancelled' in result) return;
      get().pushToast({ kind: 'error', message: result.error });
      return;
    }
    if (result.repos.length === 0) {
      // Nothing matched. If the user picked a single folder that just
      // isn't a git repo yet, offer to `git init` it instead of just
      // toasting why nothing was added.
      const first = result.skipped[0];
      if (first) {
        get().setSheet({ kind: 'initRepo', path: first.path, reason: first.reason });
        if (result.skipped.length > 1) {
          get().pushToast({
            kind: 'warn',
            message: `${result.skipped.length - 1} other folder(s) skipped — re-add to initialize.`,
          });
        }
        return;
      }
      get().pushToast({ kind: 'warn', message: 'No repositories found in the chosen folders.' });
      return;
    }
    // Merge: drop any existing entries with the same ids (the main
    // process returns existing repos as-is when a duplicate path is
    // picked) and append the picked ones in their dialog order.
    const ids = new Set(result.repos.map((r) => r.id));
    const merged = [...get().repos.filter((r) => !ids.has(r.id)), ...result.repos];
    set({ repos: merged });
    await window.overgit.invoke('store:saveRepos', merged);
    if (result.repos.length === 1) {
      get().pushToast({ kind: 'success', message: `Added ${result.repos[0].name}.` });
    } else {
      get().pushToast({
        kind: 'success',
        message: `Added ${result.repos.length} repositories.`,
      });
    }
    if (result.skipped.length > 0) {
      get().pushToast({
        kind: 'warn',
        message: `Skipped ${result.skipped.length} folder(s) — no repos found.`,
      });
    }
    // Auto-select the first newly added repo so the detail pane
    // populates immediately, matching the previous single-pick UX.
    if (result.repos[0]) get().selectRepo(result.repos[0].id);
    // Pick up sidebar dirty/upstream markers for the freshly added
    // repos without waiting for the next launch.
    void get().refreshAllRepoStatuses();
  },

  initAndAddRepo: async (path, initialBranch) => {
    const res = await window.overgit.invoke('repo:init', {
      path,
      initialBranch: initialBranch.trim() || undefined,
    });
    if (!res.ok) {
      get().pushToast({ kind: 'error', message: res.error });
      return { ok: false, error: res.error };
    }
    const ids = new Set([res.repo.id]);
    const merged = [...get().repos.filter((r) => !ids.has(r.id)), res.repo];
    set({ repos: merged });
    await window.overgit.invoke('store:saveRepos', merged);
    get().pushToast({ kind: 'success', message: `Initialized ${res.repo.name}.` });
    get().selectRepo(res.repo.id);
    void get().refreshAllRepoStatuses();
    return { ok: true };
  },

  createWorkspace: async (name, repoIds, preferredBranch) => {
    const ws: Workspace = { id: uuid(), name, repoIds };
    if (preferredBranch && preferredBranch.trim()) {
      ws.preferredBranch = preferredBranch.trim();
    }
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

  refreshWorkspaceWorktrees: async (id) => {
    const rows = await window.overgit.invoke('workspace:worktrees', id);
    const next = { ...get().workspaceWorktrees };
    for (const row of rows) next[row.repoId] = row.worktrees;
    set({ workspaceWorktrees: next });
  },

  refreshWorkspaceActivity: async (id) => {
    const items = await window.overgit.invoke('workspace:activity', {
      workspaceId: id,
    });
    set({ workspaceActivity: { ...get().workspaceActivity, [id]: items } });
  },

  markWorkspaceSeen: async (id) => {
    const settings = get().settings;
    const next: AppSettings = {
      ...settings,
      workspaceLastSeen: {
        ...(settings.workspaceLastSeen ?? {}),
        [id]: new Date().toISOString(),
      },
    };
    set({ settings: next });
    await window.overgit.invoke('store:saveSettings', next);
  },

  refreshRepoWorktrees: async (id) => {
    const wts = await window.overgit.invoke('repo:worktrees', id);
    set({ workspaceWorktrees: { ...get().workspaceWorktrees, [id]: wts } });
  },

  removeWorktree: async (id, worktreePath, force) => {
    const res = await window.overgit.invoke('repo:removeWorktree', {
      repoId: id,
      worktreePath,
      force,
    });
    if (res.ok) await get().refreshRepoWorktrees(id);
    return res;
  },

  pruneWorktrees: async (id) => {
    const res = await window.overgit.invoke('repo:pruneWorktrees', id);
    if (res.ok) await get().refreshRepoWorktrees(id);
    return res;
  },

  adoptWorktreeBranch: async (id, worktreePath, branch, forceRemove, commitMessage) => {
    const res = await window.overgit.invoke('repo:adoptWorktreeBranch', {
      repoId: id,
      worktreePath,
      branch,
      forceRemove,
      commitMessage,
    });
    if (res.ok) {
      // The worktree is gone and HEAD moved — refresh everything that
      // could reflect the change.
      await Promise.all([
        get().refreshRepoWorktrees(id),
        get().refreshRepoStatus(id),
        get().refreshRepoChanges(id),
        get().refreshRepoBranches(id),
        get().refreshRepoBranchSummaries(id),
      ]);
    }
    return res;
  },

  commitAllWorkspace: async (id, message) => {
    const outcomes = await window.overgit.invoke('workspace:commitAll', {
      workspaceId: id,
      message,
    });
    // Refresh status so the dirty count drops on each row that committed.
    await get().refreshWorkspaceStatus(id);
    return outcomes;
  },

  pushAllWorkspace: async (id) => {
    const outcomes = await window.overgit.invoke('workspace:pushAll', id);
    // After a push, ahead counters drop and upstream may have just been
    // set — refresh status so the workspace overview is accurate. If
    // a single repo is also open, refresh its log + graph too so the
    // History tab's ref labels track the new upstream.
    await get().refreshWorkspaceStatus(id);
    const selectedRepoId = get().selectedRepoId;
    if (selectedRepoId) {
      await Promise.all([
        get().refreshRepoLog(selectedRepoId),
        get().refreshRepoGraph(selectedRepoId),
        get().refreshRepoBranchSummaries(selectedRepoId),
      ]);
    }
    return outcomes;
  },

  openPRsWorkspace: async (id, { title, body, draft }) => {
    const outcomes = await window.overgit.invoke('workspace:openPRs', {
      workspaceId: id,
      title,
      body,
      draft,
    });
    // Newly created PRs should show up in the workspace PR list
    // immediately. Refresh after the call so the user sees their work
    // reflected without a manual refresh click.
    await get().refreshWorkspacePRs(id);
    return outcomes;
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
    // Branch-summary cache must follow a successful retry too — same
    // staleness story as `checkoutRepo`.
    await Promise.all([
      get().refreshWorkspaceStatus(last.workspaceId),
      get().refreshRepoStatus(id),
      get().refreshRepoBranchSummaries(id),
    ]);
  },

  refreshRepoChanges: async (id) => {
    const ch = await window.overgit.invoke('repo:changes', id);
    set({ repoChanges: { ...get().repoChanges, [id]: ch } });
  },

  refreshRepoStatus: async (id) => {
    const st = await window.overgit.invoke('repo:status', id);
    set({ repoStatus: { ...get().repoStatus, [id]: st } });
  },

  refreshAllRepoStatuses: async () => {
    const ids = get().repos.map((r) => r.id);
    if (ids.length === 0) return;
    const results = await Promise.all(
      ids.map((id) =>
        window.overgit
          .invoke('repo:status', id)
          .then((st) => [id, st] as const)
          .catch(() => null),
      ),
    );
    const next = { ...get().repoStatus };
    for (const row of results) {
      if (!row) continue;
      next[row[0]] = row[1];
    }
    set({ repoStatus: next });
  },

  fetchAllReposQuiet: async () => {
    const ids = get().repos.map((r) => r.id);
    if (ids.length === 0) return;
    // No status refresh per repo — we batch one `refreshAllRepoStatuses`
    // at the end so we don't fire N status calls during the fan-out.
    // `repo:fetch` already passes a network timeout so a stalled remote
    // can't pin this forever.
    await Promise.all(
      ids.map((id) =>
        window.overgit.invoke('repo:fetch', id).catch(() => undefined),
      ),
    );
    await get().refreshAllRepoStatuses();
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
    if (!res.ok) get().pushToast({ kind: 'error', message: res.error ?? 'Stage failed' });
    await get().refreshRepoChanges(id);
    await get().refreshRepoStatus(id);
  },

  unstageFiles: async (id, paths) => {
    const res = await window.overgit.invoke('repo:unstageFiles', { repoId: id, paths });
    if (!res.ok) get().pushToast({ kind: 'error', message: res.error ?? 'Unstage failed' });
    await get().refreshRepoChanges(id);
    await get().refreshRepoStatus(id);
  },

  discardFiles: async (id, paths) => {
    const res = await window.overgit.invoke('repo:discardFiles', { repoId: id, paths });
    if (!res.ok) get().pushToast({ kind: 'error', message: res.error ?? 'Discard failed' });
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
    if (res.ok) {
      // Push moves the upstream ref (and may set tracking on first
      // push), so the History tab's ref labels and ahead/behind line
      // are stale until log + graph + branch summaries refresh too.
      await Promise.all([
        get().refreshRepoStatus(id),
        get().refreshRepoLog(id),
        get().refreshRepoGraph(id),
        get().refreshRepoBranchSummaries(id),
      ]);
    }
    return res;
  },

  pullRepo: async (id) => {
    const res = await window.overgit.invoke('repo:pull', id);
    if (res.ok) {
      await Promise.all([
        get().refreshRepoLog(id),
        get().refreshRepoGraph(id),
        get().refreshRepoChanges(id),
        get().refreshRepoStatus(id),
        get().refreshRepoBranchSummaries(id),
      ]);
    }
    return res;
  },

  pullForce: async (id, conflicts, strategy) => {
    const res = await window.overgit.invoke('repo:pullForce', {
      repoId: id,
      conflicts,
      strategy,
    });
    // Whether pull succeeded or not, status changed (the stash got
    // created or files were reset). Refresh everything that could
    // visibly differ so the UI is honest immediately.
    await Promise.all([
      get().refreshRepoStatus(id),
      get().refreshRepoChanges(id),
      get().refreshRepoLog(id),
      get().refreshRepoGraph(id),
      get().refreshRepoStashes(id),
    ]);
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
      // Branch summaries carry the `isCurrent` flag the picker uses to
      // render the "ON" badge — without refreshing them here, the
      // picker keeps showing the old branch as current after a switch
      // until the user manually re-fetches. Same logic for branches +
      // graph (HEAD pill / lane assignments are branch-dependent).
      await Promise.all([
        get().refreshRepoStatus(id),
        get().refreshRepoChanges(id),
        get().refreshRepoLog(id),
        get().refreshRepoBranches(id),
        get().refreshRepoBranchSummaries(id),
        get().refreshRepoGraph(id),
      ]);
    }
    return outcome;
  },

  createRepoBranch: async (id, name, checkout, from) => {
    const res = await window.overgit.invoke('repo:createBranch', {
      repoId: id,
      name,
      checkout,
      from,
    });
    if (res.ok) {
      await Promise.all([
        get().refreshRepoBranches(id),
        get().refreshRepoStatus(id),
        get().refreshRepoBranchSummaries(id),
        get().refreshRepoGraph(id),
      ]);
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

  renameRepoBranch: async (id, from, to, force) => {
    const res = await window.overgit.invoke('repo:renameBranch', {
      repoId: id,
      from,
      to,
      force,
    });
    if (res.ok) {
      await Promise.all([
        get().refreshRepoBranches(id),
        get().refreshRepoStatus(id),
        get().refreshRepoBranchSummaries(id),
        get().refreshRepoGraph(id),
      ]);
    }
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
    const files = await window.overgit.invoke('fs:listRepoFiles', id);
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

  applyStashForce: async (id, index, pop) => {
    const res = await window.overgit.invoke('repo:applyStashForce', {
      repoId: id,
      index,
      pop,
    });
    if (res.ok) {
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

  applyPatch: async (id, patch, mode) => {
    const res = await window.overgit.invoke('repo:applyPatch', {
      repoId: id,
      patch,
      mode,
    });
    if (res.ok) {
      // Hunk-level changes affect both staged + unstaged sides; refresh
      // changes + status so the diff pane shows the new shape and
      // counts update everywhere.
      await Promise.all([
        get().refreshRepoChanges(id),
        get().refreshRepoStatus(id),
      ]);
    }
    return res;
  },

  mergeBranch: async (id, branch, mode) => {
    const res = await window.overgit.invoke('repo:merge', { repoId: id, branch, mode });
    // Whether merge succeeded or not, status changed (conflict marker
    // files dropped, or a new commit landed). Always refresh.
    await Promise.all([
      get().refreshRepoStatus(id),
      get().refreshRepoChanges(id),
      get().refreshRepoLog(id),
      get().refreshRepoGraph(id),
    ]);
    return res;
  },

  abortMerge: async (id) => {
    const res = await window.overgit.invoke('repo:abortMerge', id);
    await Promise.all([
      get().refreshRepoStatus(id),
      get().refreshRepoChanges(id),
    ]);
    return res;
  },

  resolveConflictSide: async (id, path, side) => {
    const res = await window.overgit.invoke('repo:resolveConflictSide', {
      repoId: id,
      path,
      side,
    });
    if (res.ok) {
      await Promise.all([
        get().refreshRepoStatus(id),
        get().refreshRepoChanges(id),
      ]);
    }
    return res;
  },

  readMergeMsg: async (id) => {
    return window.overgit.invoke('repo:readMergeMsg', id);
  },

  commitMerge: async (id, message) => {
    const res = await window.overgit.invoke('repo:commitMerge', {
      repoId: id,
      message,
    });
    if (res.ok) {
      await Promise.all([
        get().refreshRepoStatus(id),
        get().refreshRepoChanges(id),
        get().refreshRepoLog(id),
        get().refreshRepoGraph(id),
      ]);
    }
    return res;
  },

  rebaseOnto: async (id, onto) => {
    const res = await window.overgit.invoke('repo:rebase', { repoId: id, onto });
    await Promise.all([
      get().refreshRepoStatus(id),
      get().refreshRepoChanges(id),
      get().refreshRepoLog(id),
      get().refreshRepoGraph(id),
    ]);
    return res;
  },

  abortRebase: async (id) => {
    const res = await window.overgit.invoke('repo:abortRebase', id);
    await Promise.all([
      get().refreshRepoStatus(id),
      get().refreshRepoChanges(id),
    ]);
    return res;
  },

  continueRebase: async (id) => {
    const res = await window.overgit.invoke('repo:continueRebase', id);
    await Promise.all([
      get().refreshRepoStatus(id),
      get().refreshRepoChanges(id),
      get().refreshRepoLog(id),
      get().refreshRepoGraph(id),
    ]);
    return res;
  },

  abortCherryPick: async (id) => {
    const res = await window.overgit.invoke('repo:abortCherryPick', id);
    await Promise.all([
      get().refreshRepoStatus(id),
      get().refreshRepoChanges(id),
    ]);
    return res;
  },

  continueCherryPick: async (id) => {
    const res = await window.overgit.invoke('repo:continueCherryPick', id);
    await Promise.all([
      get().refreshRepoStatus(id),
      get().refreshRepoChanges(id),
      get().refreshRepoLog(id),
      get().refreshRepoGraph(id),
    ]);
    return res;
  },

  markResolved: async (id, paths) => {
    const res = await window.overgit.invoke('repo:markResolved', { repoId: id, paths });
    await Promise.all([
      get().refreshRepoStatus(id),
      get().refreshRepoChanges(id),
    ]);
    return res;
  },

  amendCommit: async (id, message) => {
    const res = await window.overgit.invoke('repo:amendCommit', {
      repoId: id,
      message,
    });
    if (res.ok) {
      // Amend rewrites HEAD; refresh the log + graph so History shows
      // the new commit, and reset changes since `--amend` typically
      // consumed the staged set.
      await Promise.all([
        get().refreshRepoChanges(id),
        get().refreshRepoStatus(id),
        get().refreshRepoLog(id),
        get().refreshRepoGraph(id),
      ]);
    }
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

  setHistoryAsideWidth: async (px) => {
    const cur = get().settings;
    if (cur.historyAsideWidth === px) return;
    const next = { ...cur, historyAsideWidth: px };
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

  archiveWorkspace: async (id) => {
    const workspaces = get().workspaces.map((w) =>
      w.id === id ? { ...w, archived: true } : w,
    );
    const patch: Partial<UiState> = { workspaces };
    if (get().selectedWorkspaceId === id) patch.selectedWorkspaceId = null;
    set(patch);
    await window.overgit.invoke('store:saveWorkspaces', workspaces);
  },

  unarchiveWorkspace: async (id) => {
    const workspaces = get().workspaces.map((w) =>
      w.id === id ? { ...w, archived: false } : w,
    );
    set({ workspaces });
    await window.overgit.invoke('store:saveWorkspaces', workspaces);
    get().selectWorkspace(id);
  },

  setLearningHint: (hint) => set({ learningHint: hint }),

  pushToast: (t) => {
    const id = uuid();
    const toast: Toast = { id, ...t };
    set({ toasts: [...get().toasts, toast] });
    if (!t.sticky) {
      // Auto-dismiss after 5s for transient feedback. Errors that the
      // user might need to copy/paste should be flagged sticky by the
      // caller.
      const ms = t.kind === 'error' ? 8000 : 4000;
      setTimeout(() => get().dismissToast(id), ms);
    }
    return id;
  },

  dismissToast: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  requestConfirm: ({
    title = 'Are you sure?',
    body,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
  }) =>
    new Promise<boolean>((resolve) => {
      set({
        pendingConfirm: {
          id: uuid(),
          title,
          body,
          confirmLabel,
          cancelLabel,
          destructive,
          resolve,
        },
      });
    }),

  resolveConfirm: (id, ok) => {
    const cur = get().pendingConfirm;
    if (!cur || cur.id !== id) return;
    cur.resolve(ok);
    set({ pendingConfirm: null });
  },
}));
