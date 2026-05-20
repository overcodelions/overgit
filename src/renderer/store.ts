// Renderer store. Mirrors what's persisted in main, plus ephemeral UI
// state (selected workset + repo, latest status / log / diff / PR
// snapshots). The "selected" repo is used by the detail pane; the
// "selected" workset by the workset pane. They're independent — a
// repo can be open while no workset is selected, and vice versa.

import { create } from 'zustand';
import type {
  AppSettings,
  BranchPruneCandidate,
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
  SquashMergeLink,
  Stash,
  StoreSnapshot,
  UUID,
  Workset,
  WorksetActivity,
  WorksetOpenPROutcome,
  WorksetPushOutcome,
  WorksetResetOutcome,
  Workspace,
  Worktree,
} from '@shared/types';

/// Sheet (modal) the user has currently open. `null` means no sheet.
/// Centralized so the title bar's Settings button and the sidebar's
/// "+ New workset" button can both drive the same single overlay
/// instead of each component owning a useState.
export type Sheet =
  | { kind: 'settings' }
  | { kind: 'about' }
  | { kind: 'newWorkset' }
  | { kind: 'editWorkset'; worksetId: UUID }
  | { kind: 'reviewChanges'; repoId: UUID; scope: 'staged' | 'working' }
  | { kind: 'newBranchInWorkset'; worksetId: UUID }
  | { kind: 'commitAllInWorkset'; worksetId: UUID }
  | { kind: 'pushAllInWorkset'; worksetId: UUID }
  | { kind: 'openPRsInWorkset'; worksetId: UUID }
  | { kind: 'newWorkspace' }
  | { kind: 'editWorkspace'; workspaceId: UUID }
  | { kind: 'resetWorkspaceProgress'; workspaceId: UUID; repoIds: UUID[] }
  | { kind: 'fetchWorkspaceProgress'; workspaceId: UUID; repoIds: UUID[] }
  | { kind: 'syncBehindProgress'; workspaceId: UUID; repoIds: UUID[] }
  | { kind: 'fileHistory'; repoId: UUID; path: string; tab: 'history' | 'blame' }
  | { kind: 'manageRepo'; repoId: UUID; tab: 'tags' | 'remotes' | 'submodules' | 'identity' }
  | { kind: 'pullConflict'; repoId: UUID; conflicts: string[]; rawError: string }
  | { kind: 'initRepo'; path: string; reason: string }
  | { kind: 'resolveConflict'; repoId: UUID; path: string }
  | { kind: 'abandonLocal'; repoId: UUID };

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
  /// Optional per-line detail strings, rendered below `message` in a
  /// monospace, scrollable list. Lets bulk-action results (e.g. a
  /// prune that failed on 12 branches) stay readable without cramming
  /// every entry into a single wrapped paragraph.
  details?: string[];
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
  worksets: Workset[];
  /// Durable repo groupings. Rendered as collapsible sections in the
  /// sidebar; bulk actions (Reset all, Fetch all) hang off the header.
  /// Orthogonal to worksets — a repo can be in many of either.
  workspaces: Workspace[];
  settings: AppSettings;
  selectedWorksetId: UUID | null;
  selectedRepoId: UUID | null;
  /// Workspace currently shown in the main pane. Mutually exclusive
  /// with `selectedRepoId` / `selectedWorksetId` — the main pane
  /// shows one of the three at a time. Selecting a workspace doesn't
  /// affect sidebar collapse state; collapse is a separate prop on
  /// the Workspace itself.
  selectedWorkspaceId: UUID | null;
  worksetStatuses: Record<UUID, RepoStatus[]>;
  /// True while `refreshWorksetStatus(id)` is in flight. Lets the
  /// overview surface a "Refreshing…" hint when statuses are cached
  /// from a prior visit so the user knows the displayed counts are
  /// about to update rather than stale-and-stuck.
  worksetRefreshing: Record<UUID, boolean>;
  worksetPRs: Record<UUID, RepoPRs[]>;
  /// Activity-feed cache per workset. Each refresh replaces the full
  /// list; we don't paginate or merge historical fetches because the
  /// "what's new since I last looked" model only needs the most recent
  /// snapshot.
  worksetActivity: Record<UUID, WorksetActivity[]>;
  /// Cached `git worktree list` output per repo. Keyed by repoId, not
  /// worksetId, because worktrees belong to repos and the same repo
  /// can appear in multiple worksets — caching by workset would
  /// duplicate the data and risk drift between views.
  worksetWorktrees: Record<UUID, Worktree[]>;
  repoDiff: Record<UUID, { key: string; files: FileDiff[] }>;
  repoChanges: Record<UUID, RepoChanges>;
  repoStatus: Record<UUID, RepoStatus>;
  /// HEAD commit per repo, populated for the Changes-tab Amend toggle.
  /// Kept separate from `repoGraph` because the graph is gated behind
  /// the History tab — fetching the full graph just to show the last
  /// commit's subject on the Changes tab was the second-biggest cost
  /// on initial repo open after the graph itself.
  repoHeadCommit: Record<UUID, Commit | null>;
  repoBranchSummaries: Record<UUID, BranchSummary[]>;
  repoGraph: Record<UUID, GraphCommit[]>;
  /// Advisory squash-merge links per repo. Refreshed alongside the
  /// graph so the History view can render dashed connectors from
  /// orphan branch tips to the absorbing commit on default.
  repoSquashLinks: Record<UUID, SquashMergeLink[]>;
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
  /// The most recent workset-checkout result, kept around so the UI
  /// can show per-repo outcomes and offer Stash/Commit affordances on
  /// repos that came back dirty.
  lastCheckout: { worksetId: UUID; branch: string; outcomes: CheckoutOutcome[] } | null;
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
  createWorkset: (name: string, repoIds: UUID[], preferredBranch?: string) => Promise<void>;
  selectWorkset: (id: UUID | null) => void;
  selectRepo: (id: UUID | null) => void;
  selectWorkspace: (id: UUID | null) => void;
  refreshWorksetStatus: (id: UUID, force?: boolean) => Promise<void>;
  refreshWorksetPRs: (id: UUID, force?: boolean) => Promise<void>;
  refreshWorksetWorktrees: (id: UUID, force?: boolean) => Promise<void>;
  refreshWorksetActivity: (id: UUID, force?: boolean) => Promise<void>;
  /// Stamp the workset's `lastSeen` to "now". Called when the user
  /// opens the workset pane so the activity feed's "new since" pip
  /// shifts forward — and on explicit "Mark all read" too.
  markWorksetSeen: (id: UUID) => Promise<void>;
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
  commitAllWorkset: (id: UUID, message: string) => Promise<CommitAllOutcome[]>;
  pushAllWorkset: (id: UUID) => Promise<WorksetPushOutcome[]>;
  openPRsWorkset: (
    id: UUID,
    args: { title: string; body: string; draft: boolean },
  ) => Promise<WorksetOpenPROutcome[]>;
  checkoutWorksetBranch: (id: UUID, branch: string, createIfMissing: boolean) => Promise<void>;
  /// "Pick up where you left off." If the workset's bound branch exists in
  /// at least one member repo, this is a plain checkout (missing-branch
  /// rows surface inline). If the branch exists nowhere, fall back to
  /// syncAndBranch so the click that says "resume" can actually create
  /// the branch in every repo that needs it. Outcomes are normalized to
  /// CheckoutOutcome shape so the existing "Last switch" table renders.
  resumeWorksetBranch: (id: UUID, branch: string) => Promise<void>;
  fetchWorkset: (id: UUID) => Promise<void>;
  refreshRepoDiff: (id: UUID, sha?: string) => Promise<void>;
  stashRepo: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
  commitAllRepo: (id: UUID, message: string) => Promise<{ ok: boolean; error?: string }>;
  retryCheckoutRepo: (id: UUID) => Promise<void>;

  refreshRepoChanges: (id: UUID) => Promise<void>;
  refreshRepoStatus: (id: UUID) => Promise<void>;
  refreshRepoHeadCommit: (id: UUID, force?: boolean) => Promise<void>;
  /// Fan out `repo:status` for every known repo so the sidebar can flag
  /// dirty / ahead / behind state without the user having to click into
  /// each one. Failures on individual repos are swallowed — a single
  /// broken repo shouldn't blank out the markers for the rest.
  refreshAllRepoStatuses: (force?: boolean) => Promise<void>;
  /// Same fan-out as `refreshAllRepoStatuses` but scoped to a specific
  /// set of repo ids. Used by the workspace pane so opening a workspace
  /// doesn't kick off status calls for every repo overgit knows about —
  /// archived ones, repos in other workspaces, repos in worksets, etc.
  refreshRepoStatuses: (ids: UUID[]) => Promise<void>;
  /// Fan out fetch → switch to default → pull across every repo in
  /// the sidebar. Returns per-repo outcomes so the caller can surface
  /// dirty/failed reasons.
  resetAllReposToDefault: () => Promise<WorksetResetOutcome[]>;
  /// User-facing wrapper around `resetAllReposToDefault` — handles
  /// the dirty-repo pre-flight confirm, the in-flight progress toast,
  /// and the per-outcome result toast. Used by both the Sidebar
  /// header button and the command palette so the UX stays in one
  /// place.
  runResetAllReposFlow: () => Promise<void>;
  /// Workspace CRUD. `createWorkspace` returns the new id so callers
  /// (the New Workspace sheet) can route the user to its edit form
  /// or select it. `toggleWorkspaceCollapsed` persists the sidebar
  /// fold state through to disk.
  createWorkspace: (name: string, repoIds: UUID[]) => Promise<UUID>;
  updateWorkspace: (
    id: UUID,
    patch: Partial<Pick<Workspace, 'name' | 'repoIds'>>,
  ) => Promise<void>;
  removeWorkspace: (id: UUID) => Promise<void>;
  toggleWorkspaceCollapsed: (id: UUID) => Promise<void>;
  /// Reset every repo in one workspace to its default branch (fetch
  /// → switch → pull). Returns per-repo outcomes; the user-facing
  /// flow wrapper handles confirms + toasts.
  resetWorkspaceToDefault: (id: UUID) => Promise<WorksetResetOutcome[]>;
  /// Single-repo reset: hard-set local default to origin's tip.
  /// Used by the workspace reset progress sheet to drive the loop
  /// in the renderer, animating each row as it completes. `force`
  /// skips the unpushed-commits guard — only pass when the user has
  /// explicitly confirmed in the row's expanded panel.
  resetRepoToDefault: (id: UUID, force?: boolean) => Promise<WorksetResetOutcome>;
  /// Single-repo fast-forward — runs `git pull --ff-only` against
  /// the configured upstream. Diverged branches come back with
  /// `diverged: true` so the sync flow can label them distinctly.
  fastForwardRepo: (id: UUID) => Promise<{
    ok: boolean;
    error?: string;
    alreadyUpToDate?: boolean;
    diverged?: boolean;
  }>;
  /// Refresh `origin/HEAD` for a repo and persist the new default
  /// branch into the store. Returns the new default branch (or an
  /// error). Used by the "Re-detect default & retry" action on
  /// upstream-gone rows in the reset progress sheet.
  refreshRepoDefaultBranch: (
    id: UUID,
  ) => Promise<
    | { ok: true; defaultBranch: string | null }
    | { ok: false; error: string }
  >;
  /// User-facing wrapper: confirm, then open the live progress sheet
  /// that drives the per-repo loop. Falls back to the toast-only
  /// flow when there's nothing to track (zero/one members).
  runResetWorkspaceFlow: (id: UUID) => Promise<void>;
  /// Fan out `git fetch` for every repo in one workspace, then
  /// refresh statuses so the sidebar's ahead/behind dots track the
  /// fresh remote refs.
  fetchAllInWorkspace: (id: UUID) => Promise<void>;
  /// Fan out `git fetch` for every known repo so the sidebar's
  /// ahead/behind dots reflect the remote, not just the stale local
  /// tracking refs. Errors are swallowed — a flaky remote or auth
  /// prompt shouldn't surface as a toast for a background sync. Calls
  /// `refreshAllRepoStatuses` when done so the dots actually move.
  fetchAllReposQuiet: () => Promise<void>;
  refreshRepoBranchSummaries: (id: UUID, force?: boolean) => Promise<void>;
  refreshRepoGraph: (id: UUID) => Promise<void>;
  /// Fast-path graph fetch used by the History tab's "List" mode.
  /// Drops `--all` + `--topo-order` + trunk-set walk; just a flat
  /// `git log -100` of the current branch. 3-5× faster on big repos.
  refreshRepoGraphFast: (id: UUID) => Promise<void>;
  refreshRepoSquashLinks: (id: UUID) => Promise<void>;
  setRepoHistoryMode: (id: UUID, mode: 'graph' | 'list') => Promise<void>;
  refreshRepoFileList: (id: UUID) => Promise<void>;
  refreshRepoStashes: (id: UUID, force?: boolean) => Promise<void>;
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
  undoLastCommit: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
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
  fetchBranchPruneCandidates: (id: UUID) => Promise<BranchPruneCandidate[]>;
  fetchBranchPruneSquashCandidates: (id: UUID) => Promise<BranchPruneCandidate[]>;
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
  setChangesAsideWidth: (px: number) => Promise<void>;
  setSheet: (sheet: Sheet | null) => void;
  togglePalette: (open?: boolean) => void;

  removeRepo: (id: UUID) => Promise<void>;
  removeWorkset: (id: UUID) => Promise<void>;
  updateWorkset: (id: UUID, patch: Partial<Pick<Workset, 'name' | 'repoIds' | 'preferredBranch'>>) => Promise<void>;
  /// Hide the workset from the active sidebar list. Member repos are
  /// untouched on disk; the working set just disappears from view until
  /// reactivated. Deselects if it was the current workset.
  archiveWorkset: (id: UUID) => Promise<void>;
  /// Restore an archived workset and select it (the "reopen" half of
  /// the lifecycle).
  unarchiveWorkset: (id: UUID) => Promise<void>;

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

/// TTL + in-flight dedupe shared by the "refresh on selection" actions
/// (worksetStatus, worksetPRs, worksetWorktrees, worksetActivity,
/// repoBranchSummaries, repoStashes). Two problems we're solving:
///
///   1. Rapid clicks — bouncing between two worksets fires the full
///      fan-out twice. With dedupe, the second click reuses the
///      in-flight promise instead of spawning another wave of git/gh.
///   2. Repeat opens — clicking the same workset twice within a few
///      seconds repaints with already-fresh data; the IPC roundtrip
///      adds nothing but latency. Skip when last refresh is recent.
///
/// Callers pass `force: true` after a mutation (commit, push, fetch)
/// because the cached data is now stale even if the timestamp is fresh.
const _inflight = new Map<string, Promise<unknown>>();
const _lastRefresh = new Map<string, number>();

async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  force = false,
): Promise<T | undefined> {
  if (!force) {
    const last = _lastRefresh.get(key) ?? 0;
    if (Date.now() - last < ttlMs) return undefined;
    const existing = _inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
  }
  const p = fn();
  _inflight.set(key, p);
  try {
    const result = await p;
    _lastRefresh.set(key, Date.now());
    return result;
  } finally {
    if (_inflight.get(key) === p) _inflight.delete(key);
  }
}

/// Invalidate cache entries so the next refresh actually fires. Used
/// after operations that mutate underlying state in ways the caller
/// didn't directly refresh (e.g., a workset checkout invalidates every
/// per-repo branch-summary cache).
function invalidateCache(prefix: string): void {
  for (const key of _lastRefresh.keys()) {
    if (key.startsWith(prefix)) _lastRefresh.delete(key);
  }
}

export const useStore = create<UiState>((set, get) => ({
  loaded: false,
  repos: [],
  worksets: [],
  workspaces: [],
  settings: {
    theme: 'system',
    sidebarVisible: true,
    sidebarWidth: 288,
    historyAsideWidth: 480,
    changesAsideWidth: 360,
    stagingMode: 'simple',
    explainMode: true,
  },
  selectedWorksetId: null,
  selectedRepoId: null,
  selectedWorkspaceId: null,
  worksetStatuses: {},
  worksetRefreshing: {},
  worksetPRs: {},
  worksetActivity: {},
  worksetWorktrees: {},
  repoDiff: {},
  repoChanges: {},
  repoStatus: {},
  repoHeadCommit: {},
  repoBranchSummaries: {},
  repoGraph: {},
  repoSquashLinks: {},
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
    // Auto-select something on launch so a fresh user doesn't land on
    // the empty "Pick a …" pane when there's clearly content. Order:
    //   1. keep the user's last selection if it still exists,
    //   2. first workspace (the durable overview is the better
    //      landing page than a single repo when one exists),
    //   3. first repo,
    //   4. first active workset.
    const cur = get();
    const workspaces = snap.workspaces ?? [];
    const haveSelection =
      (cur.selectedRepoId && snap.repos.some((r) => r.id === cur.selectedRepoId)) ||
      (cur.selectedWorksetId && snap.worksets.some((w) => w.id === cur.selectedWorksetId)) ||
      (cur.selectedWorkspaceId && workspaces.some((w) => w.id === cur.selectedWorkspaceId));
    set({
      loaded: true,
      repos: snap.repos,
      worksets: snap.worksets,
      workspaces,
      settings: snap.settings,
      cliPresence: cli,
    });
    if (!haveSelection) {
      if (workspaces.length > 0) {
        get().selectWorkspace(workspaces[0].id);
      } else if (snap.repos.length > 0) {
        get().selectRepo(snap.repos[0].id);
      } else {
        const firstActive = snap.worksets.find((w) => !w.archived);
        if (firstActive) get().selectWorkset(firstActive.id);
      }
    }
    // Background-refresh statuses for every repo so the sidebar can
    // surface dirty / ahead / behind dots without waiting for the user
    // to click each one. Deferred ~600ms after init so the user's
    // first click (workset, repo, branches tab) gets a clean lane —
    // otherwise 25+ repos × ~5 git subprocesses each competes with
    // the foreground IPCs and everything feels glued. The TTL cache
    // on `refreshAllRepoStatuses` keeps repeat triggers cheap.
    window.setTimeout(() => {
      void get().refreshAllRepoStatuses();
    }, 600);
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

  createWorkset: async (name, repoIds, preferredBranch) => {
    const ws: Workset = { id: uuid(), name, repoIds, createdAt: new Date().toISOString() };
    if (preferredBranch && preferredBranch.trim()) {
      ws.preferredBranch = preferredBranch.trim();
    }
    const worksets = [...get().worksets, ws];
    set({
      worksets,
      selectedWorksetId: ws.id,
      selectedRepoId: null,
      selectedWorkspaceId: null,
    });
    await window.overgit.invoke('store:saveWorksets', worksets);
    void get().refreshWorksetStatus(ws.id);
    void get().refreshWorksetPRs(ws.id);
  },

  selectWorkset: (id) => {
    set({ selectedWorksetId: id, selectedRepoId: null, selectedWorkspaceId: null });
    if (id) {
      get().refreshWorksetStatus(id);
      get().refreshWorksetPRs(id);
    }
  },

  selectWorkspace: (id) => {
    set({
      selectedWorkspaceId: id,
      selectedWorksetId: null,
      selectedRepoId: null,
    });
  },

  selectRepo: (id) => {
    set({ selectedRepoId: id, selectedWorkspaceId: null });
    if (id) {
      get().refreshRepoChanges(id);
      get().refreshRepoStatus(id);
    }
  },

  refreshWorksetStatus: async (id, force = false) => {
    await cached(
      `worksetStatus:${id}`,
      5_000,
      async () => {
        const ws = get().worksets.find((w) => w.id === id);
        if (!ws || ws.repoIds.length === 0) {
          set({ worksetStatuses: { ...get().worksetStatuses, [id]: [] } });
          return;
        }
        const repos = get().repos;
        const memberIds = ws.repoIds.filter((rid) => repos.some((r) => r.id === rid));
        if (memberIds.length === 0) {
          set({ worksetStatuses: { ...get().worksetStatuses, [id]: [] } });
          return;
        }

        set({ worksetRefreshing: { ...get().worksetRefreshing, [id]: true } });
        try {
          // Progressive fan-out: stream each member's status into the
          // store as it completes so the overview lights up row by row
          // instead of staring at "Loading 0/N…" until the slowest
          // repo finishes. We bypass the `workset:status` IPC (which
          // was an all-or-nothing batch) in favor of per-repo
          // `repo:status` invocations from the renderer. 3 in flight
          // is the same bound the main-process `pool(3, …)` enforced;
          // it keeps concurrent git pressure manageable while letting
          // the user see real data within ~250ms of clicking the
          // workset, even on cold start.
          //
          // Cached entries (from a prior visit) are seeded into the
          // working map so the UI doesn't visibly clear during refresh
          // — they get overwritten as fresh data arrives.
          const byRepoId = new Map<UUID, RepoStatus>(
            (get().worksetStatuses[id] ?? []).map((s) => [s.repoId, s]),
          );
          const orderedSnapshot = (): RepoStatus[] =>
            memberIds
              .map((rid) => byRepoId.get(rid))
              .filter((s): s is RepoStatus => !!s);

          let next = 0;
          const worker = async () => {
            while (true) {
              const i = next++;
              if (i >= memberIds.length) return;
              const rid = memberIds[i];
              try {
                const st = await window.overgit.invoke('repo:status', rid);
                byRepoId.set(rid, st);
                set({
                  worksetStatuses: {
                    ...get().worksetStatuses,
                    [id]: orderedSnapshot(),
                  },
                });
              } catch {
                /* leave whatever was already cached for this repo */
              }
            }
          };
          await Promise.all(
            Array.from({ length: Math.min(3, memberIds.length) }, worker),
          );
        } finally {
          set({ worksetRefreshing: { ...get().worksetRefreshing, [id]: false } });
        }
      },
      force,
    );
  },

  refreshWorksetPRs: async (id, force = false) => {
    // PRs change rarely and `gh pr list` is the slowest fan-out by far;
    // a 30s TTL means navigating between worksets feels instant without
    // hiding PR updates that the user actually cares about.
    await cached(
      `worksetPRs:${id}`,
      30_000,
      async () => {
        const prs = await window.overgit.invoke('workset:listPRs', id);
        set({ worksetPRs: { ...get().worksetPRs, [id]: prs } });
      },
      force,
    );
  },

  refreshWorksetWorktrees: async (id, force = false) => {
    await cached(
      `worksetWorktrees:${id}`,
      10_000,
      async () => {
        const rows = await window.overgit.invoke('workset:worktrees', id);
        const next = { ...get().worksetWorktrees };
        for (const row of rows) next[row.repoId] = row.worktrees;
        set({ worksetWorktrees: next });
      },
      force,
    );
  },

  refreshWorksetActivity: async (id, force = false) => {
    await cached(
      `worksetActivity:${id}`,
      10_000,
      async () => {
        const items = await window.overgit.invoke('workset:activity', {
          worksetId: id,
        });
        set({ worksetActivity: { ...get().worksetActivity, [id]: items } });
      },
      force,
    );
  },

  markWorksetSeen: async (id) => {
    const settings = get().settings;
    const next: AppSettings = {
      ...settings,
      worksetLastSeen: {
        ...(settings.worksetLastSeen ?? {}),
        [id]: new Date().toISOString(),
      },
    };
    set({ settings: next });
    await window.overgit.invoke('store:saveSettings', next);
  },

  refreshRepoWorktrees: async (id) => {
    const wts = await window.overgit.invoke('repo:worktrees', id);
    set({ worksetWorktrees: { ...get().worksetWorktrees, [id]: wts } });
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
        get().refreshRepoBranchSummaries(id, true),
      ]);
    }
    return res;
  },

  commitAllWorkset: async (id, message) => {
    const outcomes = await window.overgit.invoke('workset:commitAll', {
      worksetId: id,
      message,
    });
    // Refresh status so the dirty count drops on each row that committed.
    await get().refreshWorksetStatus(id, true);
    return outcomes;
  },

  pushAllWorkset: async (id) => {
    const outcomes = await window.overgit.invoke('workset:pushAll', id);
    // After a push, ahead counters drop and upstream may have just been
    // set — refresh status so the workset overview is accurate. If
    // a single repo is also open, refresh its log + graph too so the
    // History tab's ref labels track the new upstream.
    await get().refreshWorksetStatus(id, true);
    const selectedRepoId = get().selectedRepoId;
    if (selectedRepoId) {
      await Promise.all([
        get().refreshRepoGraph(selectedRepoId),
        get().refreshRepoBranchSummaries(selectedRepoId, true),
      ]);
    }
    return outcomes;
  },

  openPRsWorkset: async (id, { title, body, draft }) => {
    const outcomes = await window.overgit.invoke('workset:openPRs', {
      worksetId: id,
      title,
      body,
      draft,
    });
    // Newly created PRs should show up in the workset PR list
    // immediately. Refresh after the call so the user sees their work
    // reflected without a manual refresh click.
    await get().refreshWorksetPRs(id, true);
    return outcomes;
  },

  checkoutWorksetBranch: async (id, branch, createIfMissing) => {
    const ws = get().worksets.find((w) => w.id === id);
    const repoCount = ws ? ws.repoIds.length : 0;
    const progressId = get().pushToast({
      kind: 'info',
      sticky: true,
      message: `Switching to ${branch} across ${repoCount} ${repoCount === 1 ? 'repo' : 'repos'}…`,
    });
    try {
      const outcomes = await window.overgit.invoke('workset:checkoutBranch', {
        worksetId: id,
        branch,
        createIfMissing,
      });
      set({ lastCheckout: { worksetId: id, branch, outcomes } });
      await get().refreshWorksetStatus(id, true);
      const problems = outcomes.filter(
        (o) => o.result !== 'switched' && o.result !== 'already-on-branch',
      );
      if (problems.length === 0) {
        get().pushToast({
          kind: 'success',
          message: `Switched ${outcomes.length} ${outcomes.length === 1 ? 'repo' : 'repos'} to ${branch}.`,
        });
      } else {
        get().pushToast({
          kind: 'warn',
          message: `${outcomes.length - problems.length} switched, ${problems.length} need attention.`,
        });
      }
    } catch (err) {
      get().pushToast({
        kind: 'error',
        message: `Switch failed: ${err instanceof Error ? err.message : String(err)}`,
        sticky: true,
      });
    } finally {
      get().dismissToast(progressId);
    }
  },

  resumeWorksetBranch: async (id, branch) => {
    // Probe whether the branch exists in any member repo. If it does
    // anywhere, plain checkout is the right move (cheaper, and per-row
    // "Create from default" handles the holdouts). If it exists in zero
    // repos, the workset was never actually branched — fall back to
    // syncAndBranch so a single click creates it everywhere.
    const suggestions = await window.overgit.invoke(
      'workset:branchSuggestions',
      id,
    );
    const existsSomewhere = suggestions.some(
      (s) => s.branch === branch && s.repoCount > 0,
    );
    if (existsSomewhere) {
      await get().checkoutWorksetBranch(id, branch, false);
      return;
    }
    const syncOutcomes = await window.overgit.invoke(
      'workset:syncAndBranch',
      { worksetId: id, branch, syncDefault: true, pullBeforeBranch: true },
    );
    // Convert SyncAndBranchOutcome → CheckoutOutcome so the existing
    // "Last switch" table renders without a parallel UI. `created` is
    // the success case (we just branched and are now on it), `dirty`
    // preserves the inline Stash & retry affordance, everything else
    // collapses to `error` with the original step in the message.
    const outcomes: CheckoutOutcome[] = syncOutcomes.map((o) => {
      if (o.result === 'created') {
        return { repoId: o.repoId, result: 'switched', branch };
      }
      if (o.result === 'dirty') {
        return {
          repoId: o.repoId,
          result: 'dirty',
          branch,
          message: o.message,
        };
      }
      return {
        repoId: o.repoId,
        result: 'error',
        branch,
        message: o.message ?? o.result,
      };
    });
    set({ lastCheckout: { worksetId: id, branch, outcomes } });
    await get().refreshWorksetStatus(id, true);
  },

  fetchWorkset: async (id) => {
    const ws = get().worksets.find((w) => w.id === id);
    const repoCount = ws ? ws.repoIds.length : 0;
    const progressId = get().pushToast({
      kind: 'info',
      sticky: true,
      message: `Fetching ${repoCount} ${repoCount === 1 ? 'repo' : 'repos'} from remote…`,
    });
    try {
      await window.overgit.invoke('workset:fetchAll', id);
      await Promise.all([
        get().refreshWorksetStatus(id, true),
        get().refreshWorksetPRs(id, true),
      ]);
    } finally {
      get().dismissToast(progressId);
    }
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
  /// against. Replaces the matching outcome in place so the workset
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
      get().refreshWorksetStatus(last.worksetId, true),
      get().refreshRepoStatus(id),
      get().refreshRepoBranchSummaries(id, true),
    ]);
  },

  refreshRepoChanges: async (id) => {
    // TTL=0 means we only get the in-flight dedupe behavior, not the
    // skip-if-recent behavior. The original 2s TTL existed to collapse
    // `selectRepo` + `RepoDetail mount` firing in the same tick — but
    // those run synchronously and the in-flight check alone handles
    // that case. A 2s skip-gate was silently swallowing post-mutation
    // refreshes (checkout, pull, etc.) when the user had just clicked
    // in to the repo, leaving the changes pane stale.
    await cached(`repoChanges:${id}`, 0, async () => {
      const ch = await window.overgit.invoke('repo:changes', id);
      set({ repoChanges: { ...get().repoChanges, [id]: ch } });
    });
  },

  refreshRepoStatus: async (id) => {
    // Same story as `refreshRepoChanges`: TTL=0 keeps in-flight
    // dedupe (concurrent fires share one IPC) but doesn't block
    // fresh post-mutation refreshes. The 2s gate was the real reason
    // the History tab showed stale commits after a branch switch —
    // checkoutRepo's `refreshRepoStatus` was being eaten by TTL, so
    // `status.branch` never updated and the branch-change watcher
    // in HistoryTab never fired.
    await cached(`repoStatus:${id}`, 0, async () => {
      const st = await window.overgit.invoke('repo:status', id);
      set({ repoStatus: { ...get().repoStatus, [id]: st } });
    });
  },

  refreshRepoHeadCommit: async (id, force = false) => {
    await cached(
      `repoHeadCommit:${id}`,
      5_000,
      async () => {
        const c = await window.overgit.invoke('repo:headCommit', id);
        set({ repoHeadCommit: { ...get().repoHeadCommit, [id]: c } });
      },
      force,
    );
  },

  resetAllReposToDefault: async () => {
    return window.overgit.invoke('repos:resetAllToDefault');
  },

  runResetAllReposFlow: async () => {
    const state = get();
    const repos = state.repos;
    if (repos.length === 0) return;
    const dirty = repos.filter(
      (r) => (state.repoStatus[r.id]?.dirtyCount ?? 0) > 0,
    );
    const dirtyList = dirty
      .slice(0, 12)
      .map((r) => `  • ${r.name}`)
      .join('\n');
    const dirtyMore = dirty.length - 12;
    const body =
      `Fetch, switch to default branch, and pull on every repo (${repos.length}). ` +
      `Repos with uncommitted changes will be skipped.` +
      (dirty.length > 0
        ? `\n\nWill skip ${dirty.length} dirty ${dirty.length === 1 ? 'repo' : 'repos'}:\n${dirtyList}` +
          (dirtyMore > 0 ? `\n  …and ${dirtyMore} more` : '')
        : '');
    const ok = await state.requestConfirm({
      title: 'Reset all repos to default?',
      body,
      confirmLabel: 'Reset all',
    });
    if (!ok) return;

    const progressId = state.pushToast({
      kind: 'info',
      sticky: true,
      message: `Resetting ${repos.length} ${repos.length === 1 ? 'repo' : 'repos'} to default — fetching, switching, pulling…`,
    });
    try {
      const outcomes = await get().resetAllReposToDefault();
      get().dismissToast(progressId);
      const reposById = new Map(get().repos.map((r) => [r.id, r] as const));
      const failed = outcomes.filter((o) => o.result !== 'reset');
      if (failed.length === 0) {
        get().pushToast({
          kind: 'success',
          message: `All ${outcomes.length} ${outcomes.length === 1 ? 'repo is' : 'repos are'} on default.`,
        });
      } else {
        const succeeded = outcomes.length - failed.length;
        get().pushToast({
          kind: failed.length === outcomes.length ? 'error' : 'warn',
          message:
            succeeded > 0
              ? `${succeeded} reset, ${failed.length} skipped or failed.`
              : `${failed.length} of ${outcomes.length} ${failed.length === 1 ? 'repo' : 'repos'} not reset.`,
          details: failed.map((o) => {
            const name = reposById.get(o.repoId)?.name ?? o.repoId;
            return `${name} — ${o.result}${o.message ? `: ${o.message}` : ''}`;
          }),
          sticky: true,
        });
      }
      void get().refreshAllRepoStatuses();
    } catch (err) {
      get().dismissToast(progressId);
      get().pushToast({
        kind: 'error',
        message: `Reset failed: ${err instanceof Error ? err.message : String(err)}`,
        sticky: true,
      });
    }
  },

  createWorkspace: async (name, repoIds) => {
    const ws: Workspace = {
      id: uuid(),
      name,
      repoIds,
      createdAt: new Date().toISOString(),
    };
    const workspaces = [...get().workspaces, ws];
    set({ workspaces });
    await window.overgit.invoke('store:saveWorkspaces', workspaces);
    return ws.id;
  },

  updateWorkspace: async (id, patch) => {
    const workspaces = get().workspaces.map((w) =>
      w.id === id ? { ...w, ...patch } : w,
    );
    set({ workspaces });
    await window.overgit.invoke('store:saveWorkspaces', workspaces);
  },

  removeWorkspace: async (id) => {
    const workspaces = get().workspaces.filter((w) => w.id !== id);
    const patch: Partial<UiState> = { workspaces };
    if (get().selectedWorkspaceId === id) patch.selectedWorkspaceId = null;
    set(patch);
    await window.overgit.invoke('store:saveWorkspaces', workspaces);
  },

  toggleWorkspaceCollapsed: async (id) => {
    const workspaces = get().workspaces.map((w) =>
      w.id === id ? { ...w, collapsed: !w.collapsed } : w,
    );
    set({ workspaces });
    await window.overgit.invoke('store:saveWorkspaces', workspaces);
  },

  resetWorkspaceToDefault: async (id) => {
    return window.overgit.invoke('workspace:resetToDefault', { workspaceId: id });
  },

  resetRepoToDefault: async (id, force) => {
    return window.overgit.invoke('repo:resetToDefault', {
      repoId: id,
      force,
    });
  },

  /// Single-repo fast-forward. Used by the workspace detail page's
  /// "Sync N behind" flow — drives the progress sheet's per-row loop.
  fastForwardRepo: async (id) => {
    return window.overgit.invoke('repo:fastForward', { repoId: id });
  },

  /// Re-detect a repo's default branch via `git remote set-head
  /// origin --auto` and sync the new value into the in-memory repo
  /// list (main persists it on its side). Used by the workspace
  /// reset's upstream-gone heal path.
  refreshRepoDefaultBranch: async (id) => {
    const res = await window.overgit.invoke('repo:refreshDefaultBranch', id);
    if (res.ok) {
      const repos = get().repos.map((r) =>
        r.id === id ? { ...r, defaultBranch: res.defaultBranch ?? undefined } : r,
      );
      set({ repos });
    }
    return res;
  },

  runResetWorkspaceFlow: async (id) => {
    const state = get();
    const ws = state.workspaces.find((w) => w.id === id);
    if (!ws) return;
    const members = state.repos.filter((r) => ws.repoIds.includes(r.id));
    if (members.length === 0) {
      state.pushToast({
        kind: 'warn',
        message: `${ws.name} has no repos to reset.`,
      });
      return;
    }
    const dirty = members.filter(
      (r) => (state.repoStatus[r.id]?.dirtyCount ?? 0) > 0,
    );
    const dirtyList = dirty
      .slice(0, 12)
      .map((r) => `  • ${r.name}`)
      .join('\n');
    const dirtyMore = dirty.length - 12;
    const body =
      `Fetch, switch to default branch, and pull on every repo in ${ws.name} (${members.length}). ` +
      `Repos with uncommitted changes will be skipped.` +
      (dirty.length > 0
        ? `\n\nWill skip ${dirty.length} dirty ${dirty.length === 1 ? 'repo' : 'repos'}:\n${dirtyList}` +
          (dirtyMore > 0 ? `\n  …and ${dirtyMore} more` : '')
        : '');
    const ok = await state.requestConfirm({
      title: `Reset ${ws.name} to default?`,
      body,
      confirmLabel: 'Reset all',
    });
    if (!ok) return;
    // Hand off to the live progress sheet. It runs the per-repo
    // loop itself and pushes a final summary toast when done so
    // this wrapper doesn't have to wait or duplicate result UI.
    get().setSheet({
      kind: 'resetWorkspaceProgress',
      workspaceId: id,
      repoIds: members.map((r) => r.id),
    });
  },

  fetchAllInWorkspace: async (id) => {
    const state = get();
    const ws = state.workspaces.find((w) => w.id === id);
    if (!ws) return;
    if (ws.repoIds.length === 0) {
      state.pushToast({
        kind: 'warn',
        message: `${ws.name} has no repos to fetch.`,
      });
      return;
    }
    // Hand off to the live progress sheet — the renderer drives the
    // loop with one `repo:fetch` per row so the user sees which repo
    // is currently being fetched instead of a single aggregate toast.
    get().setSheet({
      kind: 'fetchWorkspaceProgress',
      workspaceId: id,
      repoIds: [...ws.repoIds],
    });
  },

  refreshAllRepoStatuses: async (force = false) => {
    // TTL'd: a startup + a post-add + a focus-tick can all fire this
    // within seconds, and each pass is 25+ status fan-outs. Coalesce
    // bursts so the sidebar doesn't get re-walked 3 times in a row.
    await cached(
      'refreshAllRepoStatuses',
      15_000,
      () => get().refreshRepoStatuses(get().repos.map((r) => r.id)),
      force,
    );
  },

  refreshRepoStatuses: async (ids) => {
    if (ids.length === 0) return;
    // Bound the fan-out. Each `gitStatus` spawns ~4 parallel git
    // subprocesses; STATUS_CONCURRENCY=3 = ~12 concurrent gits worst
    // case, which a modern Mac handles fine without saturating. We
    // tried 4 (16 concurrent) — that pegged CPU and starved
    // foreground IPCs. 3 fills a 19-repo workspace in ~2s instead of
    // ~4s, with headroom for the user's next click to land on time.
    //
    // Routes through `refreshRepoStatus(id)` rather than calling
    // `repo:status` raw so the 2s TTL + in-flight dedupe on that
    // action collapses overlapping fan-outs — startup's all-repo
    // sweep and a workspace's per-member sweep no longer double-walk
    // the repos they share. Statuses still merge into the store as
    // each one resolves (the inner refreshRepoStatus is the one
    // doing the `set`), so rows light up progressively.
    const STATUS_CONCURRENCY = 3;
    const refresh = get().refreshRepoStatus;
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= ids.length) return;
        try {
          await refresh(ids[i]);
        } catch {
          /* leave existing status alone */
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(STATUS_CONCURRENCY, ids.length) }, worker),
    );
  },

  fetchAllReposQuiet: async () => {
    const ids = get().repos.map((r) => r.id);
    if (ids.length === 0) return;
    // No status refresh per repo — we batch one `refreshAllRepoStatuses`
    // at the end so we don't fire N status calls during the fan-out.
    // `repo:fetch` already passes a network timeout so a stalled remote
    // can't pin this forever.
    const FETCH_CONCURRENCY = 3;
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= ids.length) return;
        await window.overgit.invoke('repo:fetch', ids[i]).catch(() => undefined);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(FETCH_CONCURRENCY, ids.length) }, worker),
    );
    await get().refreshAllRepoStatuses();
  },

  refreshRepoBranchSummaries: async (id, force = false) => {
    // Branch summaries are the most expensive read on monorepos with
    // thousands of remote refs (`for-each-ref` walks every ref and
    // sorts by committerdate). 10s TTL keeps re-opening the picker
    // instant without staleness that the user would actually notice.
    await cached(
      `repoBranchSummaries:${id}`,
      10_000,
      async () => {
        const summaries = await window.overgit.invoke('repo:branchSummaries', id);
        set({ repoBranchSummaries: { ...get().repoBranchSummaries, [id]: summaries } });
      },
      force,
    );
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
      // Refresh changes + status; the new commit clears the staging
      // area and may move ahead-of-upstream counters. HEAD moved too,
      // so the Amend target needs refreshing.
      await Promise.all([
        get().refreshRepoChanges(id),
        get().refreshRepoStatus(id),
        get().refreshRepoHeadCommit(id, true),
      ]);
    }
    return res;
  },

  undoLastCommit: async (id) => {
    const res = await window.overgit.invoke('repo:undoLastCommit', { repoId: id });
    if (res.ok) {
      // Soft reset rewinds HEAD and re-stages the commit's tree, so
      // graph, status, head-commit, and the Changes pane all shift.
      await Promise.all([
        get().refreshRepoGraph(id),
        get().refreshRepoChanges(id),
        get().refreshRepoStatus(id),
        get().refreshRepoHeadCommit(id, true),
      ]);
    }
    return res;
  },

  pushRepo: async (id) => {
    const res = await window.overgit.invoke('repo:push', id);
    if (res.ok) {
      // Push moves the upstream ref (and may set tracking on first
      // push), so the History tab's ref labels and ahead/behind line
      // are stale until graph + branch summaries refresh too.
      await Promise.all([
        get().refreshRepoStatus(id),
        get().refreshRepoGraph(id),
        get().refreshRepoBranchSummaries(id, true),
      ]);
    }
    return res;
  },

  pullRepo: async (id) => {
    const res = await window.overgit.invoke('repo:pull', id);
    if (res.ok) {
      await Promise.all([
        get().refreshRepoGraph(id),
        get().refreshRepoChanges(id),
        get().refreshRepoStatus(id),
        get().refreshRepoBranchSummaries(id, true),
        get().refreshRepoHeadCommit(id, true),
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
      get().refreshRepoGraph(id),
      get().refreshRepoStashes(id, true),
      get().refreshRepoHeadCommit(id, true),
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
      // until the user manually re-fetches. Graph also depends on HEAD
      // for lane assignment, and HEAD moved so the Amend target shifts.
      await Promise.all([
        get().refreshRepoStatus(id),
        get().refreshRepoChanges(id),
        get().refreshRepoBranchSummaries(id, true),
        get().refreshRepoGraph(id),
        get().refreshRepoHeadCommit(id, true),
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
        get().refreshRepoStatus(id),
        get().refreshRepoBranchSummaries(id, true),
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
    if (res.ok) await get().refreshRepoBranchSummaries(id, true);
    return res;
  },

  fetchBranchPruneCandidates: async (id) => {
    return window.overgit.invoke('repo:pruneCandidates', { repoId: id });
  },

  fetchBranchPruneSquashCandidates: async (id) => {
    return window.overgit.invoke('repo:pruneSquashCandidates', { repoId: id });
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
        get().refreshRepoStatus(id),
        get().refreshRepoBranchSummaries(id, true),
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
    // Single graph-refresh entry point. Picks the fast HEAD-only
    // variant when the user's in list mode for this repo, otherwise
    // the full `--all --topo-order` graph for rail rendering.
    // Centralizing this here means every HEAD-moving action
    // (checkout, pull, merge, rebase, amend, undo…) automatically
    // refreshes with the right shape — without this, list mode kept
    // getting `--all` data spliced in by mutation handlers and the
    // user saw extra refs appear and then disappear on tab toggle.
    //
    // 100 commits is the sweet spot for "recent history at a glance":
    // covers a few weeks of activity on most repos without forcing
    // `git log --all --topo-order` to walk deeper than necessary.
    // The trunk-set cap in commitGraph() adapts to whatever limit
    // is in flight, so this is the only knob to twist.
    const mode = get().settings.historyMode?.[id] ?? 'list';
    const channel = mode === 'list' ? 'repo:graphFast' : 'repo:graph';
    const commits = await window.overgit.invoke(channel, { repoId: id, limit: 100 });
    set({ repoGraph: { ...get().repoGraph, [id]: commits } });
  },

  refreshRepoGraphFast: async (id) => {
    // Kept as a direct alias for the HEAD-only variant — used by
    // HistoryTab's mount effect when it knows it's in list mode and
    // wants to bypass the mode-lookup in `refreshRepoGraph`.
    const commits = await window.overgit.invoke('repo:graphFast', { repoId: id, limit: 100 });
    set({ repoGraph: { ...get().repoGraph, [id]: commits } });
  },

  refreshRepoSquashLinks: async (id) => {
    const links = await window.overgit.invoke('repo:squashMergeLinks', { repoId: id });
    set({ repoSquashLinks: { ...get().repoSquashLinks, [id]: links } });
  },

  setRepoHistoryMode: async (id, mode) => {
    const next: AppSettings = {
      ...get().settings,
      historyMode: { ...(get().settings.historyMode ?? {}), [id]: mode },
    };
    set({ settings: next });
    await window.overgit.invoke('store:saveSettings', next);
  },

  refreshRepoFileList: async (id) => {
    const files = await window.overgit.invoke('fs:listRepoFiles', id);
    set({ repoFileList: { ...get().repoFileList, [id]: files } });
  },

  refreshRepoStashes: async (id, force = false) => {
    await cached(
      `repoStashes:${id}`,
      5_000,
      async () => {
        const stashes = await window.overgit.invoke('repo:listStashes', id);
        set({ repoStashes: { ...get().repoStashes, [id]: stashes } });
      },
      force,
    );
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
        get().refreshRepoStashes(id, true),
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
        get().refreshRepoStashes(id, true),
      ]);
    }
    return res;
  },

  dropStash: async (id, index) => {
    const res = await window.overgit.invoke('repo:dropStash', { repoId: id, index });
    if (res.ok) await get().refreshRepoStashes(id, true);
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
      get().refreshRepoGraph(id),
      get().refreshRepoHeadCommit(id, true),
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
        get().refreshRepoGraph(id),
        get().refreshRepoHeadCommit(id, true),
      ]);
    }
    return res;
  },

  rebaseOnto: async (id, onto) => {
    const res = await window.overgit.invoke('repo:rebase', { repoId: id, onto });
    await Promise.all([
      get().refreshRepoStatus(id),
      get().refreshRepoChanges(id),
      get().refreshRepoGraph(id),
      get().refreshRepoHeadCommit(id, true),
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
      get().refreshRepoGraph(id),
      get().refreshRepoHeadCommit(id, true),
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
      get().refreshRepoGraph(id),
      get().refreshRepoHeadCommit(id, true),
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
      // Amend rewrites HEAD; refresh the graph so History shows
      // the new commit, reset changes since `--amend` typically
      // consumed the staged set, and refresh the head-commit cache
      // so the Amend toggle subject updates in place.
      await Promise.all([
        get().refreshRepoChanges(id),
        get().refreshRepoStatus(id),
        get().refreshRepoGraph(id),
        get().refreshRepoHeadCommit(id, true),
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
        get().refreshRepoStashes(id, true),
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

  setChangesAsideWidth: async (px) => {
    const cur = get().settings;
    if (cur.changesAsideWidth === px) return;
    const next = { ...cur, changesAsideWidth: px };
    set({ settings: next });
    await window.overgit.invoke('store:saveSettings', next);
  },

  setSheet: (sheet) => set({ sheet }),

  togglePalette: (open) =>
    set((s) => ({ paletteOpen: typeof open === 'boolean' ? open : !s.paletteOpen })),

  removeRepo: async (id) => {
    const repos = get().repos.filter((r) => r.id !== id);
    // Drop the repo from any workset / workspace that referenced it.
    // Empty groupings are valid — the user can re-populate or delete
    // them explicitly.
    const worksets = get().worksets.map((w) =>
      w.repoIds.includes(id) ? { ...w, repoIds: w.repoIds.filter((r) => r !== id) } : w,
    );
    const workspaces = get().workspaces.map((w) =>
      w.repoIds.includes(id) ? { ...w, repoIds: w.repoIds.filter((r) => r !== id) } : w,
    );
    const patch: Partial<UiState> = { repos, worksets, workspaces };
    if (get().selectedRepoId === id) patch.selectedRepoId = null;
    if (get().openFile?.repoId === id) {
      patch.openFile = null;
      patch.openFileContent = '';
      patch.openFileDirty = false;
    }
    set(patch);
    await Promise.all([
      window.overgit.invoke('store:saveRepos', repos),
      window.overgit.invoke('store:saveWorksets', worksets),
      window.overgit.invoke('store:saveWorkspaces', workspaces),
    ]);
  },

  removeWorkset: async (id) => {
    const worksets = get().worksets.filter((w) => w.id !== id);
    const patch: Partial<UiState> = { worksets };
    if (get().selectedWorksetId === id) patch.selectedWorksetId = null;
    set(patch);
    await window.overgit.invoke('store:saveWorksets', worksets);
  },

  updateWorkset: async (id, patch) => {
    const worksets = get().worksets.map((w) =>
      w.id === id ? { ...w, ...patch } : w,
    );
    set({ worksets });
    await window.overgit.invoke('store:saveWorksets', worksets);
  },

  archiveWorkset: async (id) => {
    const archivedAt = new Date().toISOString();
    const worksets = get().worksets.map((w) =>
      w.id === id ? { ...w, archived: true, archivedAt } : w,
    );
    const patch: Partial<UiState> = { worksets };
    if (get().selectedWorksetId === id) patch.selectedWorksetId = null;
    set(patch);
    await window.overgit.invoke('store:saveWorksets', worksets);
  },

  unarchiveWorkset: async (id) => {
    const worksets = get().worksets.map((w) =>
      w.id === id ? { ...w, archived: false, archivedAt: undefined } : w,
    );
    set({ worksets });
    await window.overgit.invoke('store:saveWorksets', worksets);
    get().selectWorkset(id);
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
