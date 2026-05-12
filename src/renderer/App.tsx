import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { RepoDetail, FileDiffBlock } from './RepoDetail';
import { TitleBar } from './TitleBar';
import { SheetHost, ReviewBody, formatBytes } from './Sheets';
import { CommandPalette } from './CommandPalette';
import { Explain } from './Explain';
import type {
  ChangedFile,
  CheckoutOutcome,
  CliPresence,
  FileDiff,
  LlmTool,
  PullRequest,
  Repo,
  RepoPRs,
  RepoStatus,
  ReviewResult,
  SyncAndBranchOutcome,
  UUID,
  Workset,
  WorksetActivity,
  WorksetDiffTruncation,
  Workspace,
  Worktree,
} from '@shared/types';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '@shared/types';

// Stable empty arrays for Zustand selector fallbacks. Using `?? []`
// inside a `useStore` selector returns a NEW array on every call, which
// fails React's useSyncExternalStore snapshot equality check and looks
// like an infinite render loop ("Maximum update depth exceeded").
// Reusing one frozen reference lets the selector return the same value
// across renders when there's no entry yet.
const EMPTY_STATUSES: RepoStatus[] = [];
const EMPTY_PRS: RepoPRs[] = [];
const EMPTY_WORKTREES: Worktree[] = [];
const EMPTY_ACTIVITY: WorksetActivity[] = [];

export function App(): JSX.Element {
  const { loaded, hydrate } = useStore();
  const sidebarVisible = useStore((s) => s.settings.sidebarVisible);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useGlobalShortcuts();
  useSidebarStatusRefresh();
  useSidebarBackgroundFetch();

  if (!loaded) {
    return (
      <div className="flex flex-col h-full">
        <TitleBar />
        <div className="p-6 text-ink-muted text-sm">Loading…</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        {sidebarVisible && <SidebarWithResize />}
        <Main />
      </div>
      <LearningBar />
      <SheetHost />
      <CommandPalette />
      <ConfirmHost />
      <ToastHost />
    </div>
  );
}

/// Persistent thin strip pinned to the bottom of the app shell. Visible
/// only when Settings → Explain mode is on. Reads `learningHint` from
/// the store, which is pushed by `<Explain>` wrappers on hover and by
/// the store after an action runs (so the bar briefly mirrors the last
/// command executed too).
function LearningBar(): JSX.Element | null {
  const explain = useStore((s) => s.settings.explainMode);
  const hint = useStore((s) => s.learningHint);
  if (!explain) return null;
  const idle = !hint;
  const command = hint?.command ?? '';
  const plain = hint?.plain ?? 'Hover any control to see the git command it runs and what it does.';
  return (
    <div
      className={`flex-shrink-0 h-[34px] border-t border-card px-4 flex items-center gap-3 text-[12px] ${
        idle ? 'bg-accent/[0.03]' : 'bg-accent/10'
      }`}
    >
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-accent shrink-0">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent" />
        Learn
      </span>
      <code
        className={`font-mono text-ink bg-card/80 px-2 py-0.5 rounded border border-card shrink-0 max-w-[50%] truncate ${
          command ? '' : 'invisible'
        }`}
      >
        {command || 'placeholder'}
      </code>
      <span className={`min-w-0 truncate ${idle ? 'text-ink-faint italic' : 'text-ink-muted'}`}>
        {plain}
      </span>
    </div>
  );
}

/// Renders the in-flight confirm request, if any. We use the same
/// backdrop-and-card structure as SheetHost but keep this separate so
/// confirms can stack on top of an open sheet (the "Discard hunk?"
/// prompt comes up over the Changes tab without stomping a sheet).
function ConfirmHost(): JSX.Element | null {
  const pending = useStore((s) => s.pendingConfirm);
  const resolve = useStore((s) => s.resolveConfirm);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolve(pending.id, false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        resolve(pending.id, true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, resolve]);

  if (!pending) return null;
  const onCancel = () => resolve(pending.id, false);
  const onConfirm = () => resolve(pending.id, true);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-surface-elevated border border-card rounded-lg shadow-2xl w-[440px] max-w-[92vw] max-h-[85vh] flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-card flex-shrink-0">
          <h2 className="text-sm font-semibold">{pending.title}</h2>
        </div>
        <div className="px-5 py-4 text-[13px] text-ink-muted whitespace-pre-wrap overflow-y-auto flex-1 min-h-0">
          {pending.body}
        </div>
        <div className="px-5 py-3 border-t border-card flex justify-end gap-2 flex-shrink-0">
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
          >
            {pending.cancelLabel}
          </button>
          <button
            autoFocus
            onClick={onConfirm}
            className={`text-xs px-3 py-1.5 rounded text-white ${
              pending.destructive
                ? 'bg-red-600 hover:bg-red-500'
                : 'bg-accent hover:bg-accent-strong'
            }`}
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/// Bottom-right toast stack. Each toast can be dismissed by clicking
/// it; non-sticky toasts also auto-fade. Position is fixed bottom-right
/// because that's where the user's eye lands after a successful action
/// at the top of the panel.
function ToastHost(): JSX.Element | null {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  const tone: Record<string, string> = {
    info: 'bg-card border-card text-ink',
    success: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200',
    warn: 'bg-amber-500/15 border-amber-500/30 text-amber-200',
    error: 'bg-red-500/15 border-red-500/30 text-red-200',
  };
  return (
    <div className="fixed bottom-4 right-4 z-[55] flex flex-col gap-2 w-[420px] max-w-[80vw] pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto text-xs rounded border shadow-lg overflow-hidden ${tone[t.kind] ?? tone.info}`}
        >
          <button
            onClick={() => dismiss(t.id)}
            className="block w-full text-left px-3 py-2 whitespace-pre-wrap hover:bg-black/10"
            title="Click to dismiss"
          >
            {t.message}
          </button>
          {t.details && t.details.length > 0 && (
            <ul className="border-t border-current/20 max-h-[40vh] overflow-y-auto px-3 py-1.5 font-mono text-[11px] leading-relaxed bg-black/15">
              {t.details.map((d, i) => (
                <li key={i} className="py-0.5 break-words">
                  {d}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/// Wraps Sidebar with a fixed-width container and a drag handle. The
/// width lives in settings (persisted), so a relaunch keeps the chosen
/// layout. Clamped to [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH] both on
/// drag and on read so a stale value can't push the sidebar off-screen.
function SidebarWithResize(): JSX.Element {
  const width = useStore((s) => s.settings.sidebarWidth);
  const setWidth = useStore((s) => s.setSidebarWidth);
  const clamped = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width));

  // Drag handle. We track the last persisted width but update via the
  // raw computed value during the drag — the saver on the store is
  // already a no-op for unchanged values, so re-setting on every move
  // doesn't churn the IPC.
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = clamped;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, startW + (ev.clientX - startX)),
      );
      void setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div className="flex shrink-0" style={{ width: clamped }}>
      <Sidebar />
      <div
        role="separator"
        aria-label="Resize sidebar"
        aria-valuenow={clamped}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        onMouseDown={onMouseDown}
        onDoubleClick={() => void setWidth(288)}
        title="Drag to resize · Double-click to reset"
        className="w-1 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
      />
    </div>
  );
}

/// Background freshness for the sidebar dirty / ahead / behind dots
/// AND the currently-selected workset's per-member status. Three
/// triggers, all running the same fan-outs:
///   1. Window focus — the common case. The user did something in a
///      terminal, alt-tabs back, expects the sidebar to reflect reality.
///   2. visibilitychange to "visible" — same idea, covers tab-style
///      hides on platforms where `focus` doesn't fire.
///   3. A 60s interval as a last-ditch backstop, but only while the
///      window is actually visible. We don't want a hidden background
///      window shelling out `git status` across 20 repos every minute.
/// All three converge on the same store actions so duplicate fires
/// (e.g. focus + visibilitychange in quick succession) just race
/// harmlessly toward the same merged state.
///
/// `refreshAllRepoStatuses` populates only the per-repo cache. The
/// workset commit view reads `worksetStatuses[id]`, which is a
/// separate cache populated by `refreshWorksetStatus`. Without
/// re-running that here, a user sitting on the workset's Commit tab
/// would see "all clean" forever after editing files in a terminal,
/// because `selectWorkset` only fires on a fresh re-selection.
function useSidebarStatusRefresh(): void {
  const refreshAll = useStore((s) => s.refreshAllRepoStatuses);
  const refreshWsStatus = useStore((s) => s.refreshWorksetStatus);
  const refreshRepoLog = useStore((s) => s.refreshRepoLog);
  const refreshRepoChanges = useStore((s) => s.refreshRepoChanges);
  const refreshRepoStatus = useStore((s) => s.refreshRepoStatus);
  const refreshRepoBranches = useStore((s) => s.refreshRepoBranches);
  const loaded = useStore((s) => s.loaded);

  useEffect(() => {
    if (!loaded) return;
    let lastRun = 0;
    /// Coalesce bursts (focus + visibilitychange + an interval tick that
    /// happens to land in the same second) so we don't spam git. 2s is
    /// short enough that a deliberate quick-toggle still picks up the
    /// new state, long enough to absorb the natural double-fire.
    const COALESCE_MS = 2_000;
    const run = () => {
      const now = Date.now();
      if (now - lastRun < COALESCE_MS) return;
      lastRun = now;
      void refreshAll();
      const { selectedWorksetId: wsId, selectedRepoId: repoId } = useStore.getState();
      if (wsId) void refreshWsStatus(wsId);
      /// Re-run the same per-repo refresh fan-out `selectRepo` uses
      /// (log / changes / status / branches) for the already-open repo
      /// so RepoDetail picks up changes made in a terminal while
      /// overgit was backgrounded. Without this, the user has to
      /// deselect and reselect the repo to see new commits or dirty files.
      if (repoId) {
        void refreshRepoLog(repoId);
        void refreshRepoChanges(repoId);
        void refreshRepoStatus(repoId);
        void refreshRepoBranches(repoId);
      }
    };
    const onFocus = () => run();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') run();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      run();
    }, 60_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(interval);
    };
  }, [
    loaded,
    refreshAll,
    refreshWsStatus,
    refreshRepoLog,
    refreshRepoChanges,
    refreshRepoStatus,
    refreshRepoBranches,
  ]);
}

/// Background fetch so the sidebar's ahead/behind dots reflect the
/// remote, not just stale local tracking refs. `useSidebarStatusRefresh`
/// alone only re-reads `git rev-list @{u}...HEAD` — it never asks the
/// remote what's new, so a PR merged upstream is invisible until you
/// manually fetch. This hook runs `git fetch` across all repos on a
/// slower cadence (network calls + possible auth prompts make 60s too
/// aggressive), then triggers the existing status fan-out so the dots
/// move. Cadence:
///   - Every 5min while the window is visible.
///   - On focus, but only if the last run was >2min ago. Quick alt-tabs
///     shouldn't kick off a fetch every time.
/// Errors are swallowed in the store action — a flaky remote shouldn't
/// surface as a toast for a background sync.
function useSidebarBackgroundFetch(): void {
  const fetchAll = useStore((s) => s.fetchAllReposQuiet);
  const loaded = useStore((s) => s.loaded);

  useEffect(() => {
    if (!loaded) return;
    const FOCUS_MIN_GAP_MS = 2 * 60_000;
    const INTERVAL_MS = 5 * 60_000;
    let lastRun = 0;
    let inFlight = false;
    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      lastRun = Date.now();
      try {
        await fetchAll();
      } finally {
        inFlight = false;
      }
    };
    const onFocus = () => {
      if (Date.now() - lastRun < FOCUS_MIN_GAP_MS) return;
      void run();
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRun < FOCUS_MIN_GAP_MS) return;
      void run();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void run();
    }, INTERVAL_MS);
    // Kick off one shortly after launch so the dots are honest within a
    // few seconds of opening the app, not 5 minutes later.
    const kickoff = window.setTimeout(() => void run(), 3_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(interval);
      window.clearTimeout(kickoff);
    };
  }, [loaded, fetchAll]);
}

/// Global keyboard shortcuts. We attach one keydown listener and
/// dispatch on Cmd/Ctrl + key. Inputs and textareas are NOT skipped for
/// nav-like shortcuts on purpose — Cmd+1..4 should always switch the
/// repo tab, even while you're typing. We do skip alphabetic shortcuts
/// (Cmd+B, Cmd+N) inside text fields so they don't steal browser
/// behavior in the search box / commit message.
function useGlobalShortcuts(): void {
  const setSheet = useStore((s) => s.setSheet);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const togglePalette = useStore((s) => s.togglePalette);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const selectedWsId = useStore((s) => s.selectedWorksetId);
  const refreshRepoStatus = useStore((s) => s.refreshRepoStatus);
  const refreshRepoChanges = useStore((s) => s.refreshRepoChanges);
  const refreshWsStatus = useStore((s) => s.refreshWorksetStatus);
  const refreshWsPRs = useStore((s) => s.refreshWorksetPRs);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const target = e.target as HTMLElement | null;
      const inField =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      // Cmd+K → command palette. Wins over the inField guard so the
      // user can summon it from anywhere, including the search box.
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        togglePalette();
        return;
      }
      // Repo-scoped action shortcuts. Each fires a window event so the
      // RepoDetail components own the actual git logic; the global
      // handler just routes the keystroke. We ALWAYS preventDefault for
      // Cmd+P even when no repo is open — Electron will otherwise pop
      // the print dialog over the renderer, which is never useful here.
      if ((e.key === 'p' || e.key === 'P') && !e.shiftKey) {
        e.preventDefault();
        if (selectedRepoId) {
          window.dispatchEvent(new CustomEvent('overgit:repoPush'));
        }
        return;
      }
      if ((e.key === 'f' || e.key === 'F') && !e.shiftKey) {
        if (selectedRepoId) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('overgit:repoFetch'));
          return;
        }
      }
      // Cmd+Enter from inside the commit textarea (or anywhere) →
      // commit the current selection. Pass through inField — that's
      // exactly where the shortcut is most useful.
      if (e.key === 'Enter' && selectedRepoId) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('overgit:repoCommit'));
        return;
      }
      // Cmd+, → Settings (matches macOS convention).
      if (e.key === ',') {
        e.preventDefault();
        setSheet({ kind: 'settings' });
        return;
      }
      // Cmd+\ → toggle sidebar.
      if (e.key === '\\') {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      // Cmd+R → refresh whatever's in focus (repo or workset pane).
      // Don't steal in fields — the user might be wanting to undo etc.
      if ((e.key === 'r' || e.key === 'R') && !e.shiftKey && !inField) {
        e.preventDefault();
        if (selectedRepoId) {
          void refreshRepoStatus(selectedRepoId);
          void refreshRepoChanges(selectedRepoId);
        } else if (selectedWsId) {
          void refreshWsStatus(selectedWsId);
          void refreshWsPRs(selectedWsId);
        }
        return;
      }
      // Cmd+N → New branch. Prefer the focused repo when one is open —
      // even if a workset is also selected in the sidebar, the user
      // is looking at the repo detail pane and expects the shortcut to
      // act on what they see. Falls back to the workset-wide sheet
      // only when no repo is selected.
      if ((e.key === 'n' || e.key === 'N') && !e.shiftKey && !inField) {
        if (selectedRepoId) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('overgit:newRepoBranch'));
          return;
        }
        if (selectedWsId) {
          e.preventDefault();
          setSheet({ kind: 'newBranchInWorkset', worksetId: selectedWsId });
          return;
        }
      }
      // Cmd+1..5 dispatch a custom event that RepoDetail listens for.
      // Done this way so the shortcut works regardless of focus and
      // doesn't require lifting tab state into the global store.
      if (selectedRepoId && /^[1-5]$/.test(e.key)) {
        e.preventDefault();
        const tabs = ['changes', 'history', 'files', 'stash', 'branches'] as const;
        window.dispatchEvent(
          new CustomEvent('overgit:setRepoTab', {
            detail: tabs[Number.parseInt(e.key, 10) - 1],
          }),
        );
        return;
      }
      // Cmd+B → open branch picker (RepoDetail listens for this).
      if ((e.key === 'b' || e.key === 'B') && !inField && selectedRepoId) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('overgit:openBranchPicker'));
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    setSheet,
    toggleSidebar,
    selectedRepoId,
    selectedWsId,
    refreshRepoStatus,
    refreshRepoChanges,
    refreshWsStatus,
    refreshWsPRs,
  ]);
}

function Sidebar(): JSX.Element {
  const repos = useStore((s) => s.repos);
  const worksets = useStore((s) => s.worksets);
  const workspaces = useStore((s) => s.workspaces);
  const selectedWs = useStore((s) => s.selectedWorksetId);
  const selectedRepo = useStore((s) => s.selectedRepoId);
  const selectedWorkspace = useStore((s) => s.selectedWorkspaceId);
  const selectWs = useStore((s) => s.selectWorkset);
  const selectRepo = useStore((s) => s.selectRepo);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const pickAndAddRepo = useStore((s) => s.pickAndAddRepo);
  const setSheet = useStore((s) => s.setSheet);
  const removeRepo = useStore((s) => s.removeRepo);
  const removeWorkset = useStore((s) => s.removeWorkset);
  const archiveWorkset = useStore((s) => s.archiveWorkset);
  const unarchiveWorkset = useStore((s) => s.unarchiveWorkset);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const toggleWorkspaceCollapsed = useStore((s) => s.toggleWorkspaceCollapsed);
  const runResetWorkspaceFlow = useStore((s) => s.runResetWorkspaceFlow);
  const fetchAllInWorkspace = useStore((s) => s.fetchAllInWorkspace);
  const requestConfirm = useStore((s) => s.requestConfirm);
  const runResetAllReposFlow = useStore((s) => s.runResetAllReposFlow);
  const [resetting, setResetting] = useState(false);
  /// In-flight per-workspace bulk actions. Key is the workspace id;
  /// value is the human-readable verb ("Resetting…", "Fetching…")
  /// shown inline on the row. Used to disable the row's buttons while
  /// a bulk action is running so the user can't kick off a second one
  /// and create a partial pile-up.
  const [busyWorkspaceVerb, setBusyWorkspaceVerb] = useState<
    Record<UUID, string>
  >({});

  const [search, setSearch] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const query = search.trim().toLowerCase();
  const navRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /// Active row index for keyboard nav. -1 means "no active row" — we
  /// jump to 0 on the first arrow press from the search box, so users
  /// who type → arrow get the obvious behavior.
  const [activeIdx, setActiveIdx] = useState<number>(-1);

  const visibleRepos = useMemo(() => {
    const list = query
      ? repos.filter(
          (r) =>
            r.name.toLowerCase().includes(query) ||
            r.path.toLowerCase().includes(query),
        )
      : repos;
    return [...list].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }, [repos, query]);

  // Lookup table so workspace rows can render their member repos
  // without re-filtering the full repo list per row.
  const repoById = useMemo(() => {
    const m = new Map<UUID, Repo>();
    for (const r of repos) m.set(r.id, r);
    return m;
  }, [repos]);

  // Workspaces are filtered by search by name. When the query matches
  // a workspace, we keep its member list intact (so the user sees what
  // the workspace contains); if the query only matches a repo, the
  // workspace is filtered out but the repo can still surface in
  // "Repos" below.
  const visibleWorkspaces = useMemo(
    () =>
      query
        ? workspaces.filter((w) => w.name.toLowerCase().includes(query))
        : workspaces,
    [workspaces, query],
  );

  // IDs of every repo that lives in at least one *visible* workspace.
  // Used to pull those out of the flat "Repos" section so the sidebar
  // doesn't double-render them under both a group and the bare list.
  // Tracking visibility (not membership-in-any-workspace) so that when
  // a search query hides a workspace, its repos can still surface in
  // "Other repos" by name match. When the user has no workspaces this
  // stays empty and the sidebar behaves exactly as before.
  const groupedRepoIds = useMemo(() => {
    const s = new Set<UUID>();
    for (const w of visibleWorkspaces) for (const id of w.repoIds) s.add(id);
    return s;
  }, [visibleWorkspaces]);

  const ungroupedRepos = useMemo(
    () =>
      groupedRepoIds.size === 0
        ? visibleRepos
        : visibleRepos.filter((r) => !groupedRepoIds.has(r.id)),
    [visibleRepos, groupedRepoIds],
  );

  const visibleWorksets = useMemo(
    () =>
      query
        ? worksets.filter((w) => w.name.toLowerCase().includes(query))
        : worksets,
    [worksets, query],
  );

  const activeWorksets = useMemo(
    () => visibleWorksets.filter((w) => !w.archived),
    [visibleWorksets],
  );
  // Archived list is shown newest-first by creation date. Worksets
  // archived before `createdAt` was tracked have no date — those sort
  // as oldest, with stable sort preserving their relative order so the
  // section doesn't reshuffle on each render.
  const archivedWorksets = useMemo(
    () =>
      [...visibleWorksets.filter((w) => w.archived)].sort((a, b) => {
        const ad = a.createdAt ?? '';
        const bd = b.createdAt ?? '';
        if (ad === bd) return 0;
        return bd.localeCompare(ad);
      }),
    [visibleWorksets],
  );
  // Auto-expand the Archived section when a search query has narrowed the
  // sidebar to archived matches — otherwise the user typed a name they
  // recognize and would just see "no worksets match" while it's there.
  const showArchivedRows = archivedExpanded || query.length > 0;

  // Implicit folder grouping. When the user has a non-trivial number
  // of repos that span multiple parent directories, group the repo list
  // by parent directory. Cheap heuristic — no schema changes — and
  // avoids design-debt of true folders. Filtering disables grouping
  // (the user already narrowed the list).
  const repoGroups = useMemo(
    () => groupReposByParentDir(ungroupedRepos, query.length > 0),
    [ungroupedRepos, query],
  );

  // Flat list of focusable rows in render order. Used by keyboard nav
  // to map `activeIdx` to "what's currently highlighted." We rebuild
  // it whenever the rendered structure changes (search, collapse
  // toggles), and clamp the activeIdx if it falls off the end.
  const flatRows = useMemo(() => {
    const rows: Array<
      | { kind: 'repo'; id: UUID }
      | { kind: 'workspace'; id: UUID }
      | { kind: 'workset'; id: UUID }
    > = [];
    for (const w of visibleWorkspaces) {
      rows.push({ kind: 'workspace', id: w.id });
      if (!w.collapsed) {
        for (const repoId of w.repoIds) {
          if (repoById.has(repoId)) rows.push({ kind: 'repo', id: repoId });
        }
      }
    }
    for (const g of repoGroups) {
      if (g.kind === 'flat') {
        for (const r of g.repos) rows.push({ kind: 'repo', id: r.id });
      } else if (!collapsedFolders.has(g.label)) {
        for (const r of g.repos) rows.push({ kind: 'repo', id: r.id });
      }
    }
    for (const w of activeWorksets) rows.push({ kind: 'workset', id: w.id });
    if (showArchivedRows) {
      for (const w of archivedWorksets) rows.push({ kind: 'workset', id: w.id });
    }
    return rows;
  }, [visibleWorkspaces, repoById, repoGroups, activeWorksets, archivedWorksets, showArchivedRows, collapsedFolders]);

  useEffect(() => {
    if (activeIdx >= flatRows.length) setActiveIdx(flatRows.length - 1);
  }, [flatRows.length, activeIdx]);

  // Sidebar-scoped keyboard nav. Catches ArrowUp/Down/Enter while
  // focus is anywhere inside the sidebar. The search input gets the
  // first arrow press too — that lets users type, then ↓, then Enter
  // without ever taking their hands off the keyboard.
  const onSidebarKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(flatRows.length - 1, (i < 0 ? -1 : i) + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      const row = flatRows[activeIdx];
      if (!row) return;
      e.preventDefault();
      if (row.kind === 'repo') selectRepo(row.id);
      else if (row.kind === 'workspace') selectWorkspace(row.id);
      else selectWs(row.id);
    } else if (e.key === '/' && document.activeElement !== inputRef.current) {
      e.preventDefault();
      inputRef.current?.focus();
    }
  };

  const toggleFolder = (label: string) => {
    setCollapsedFolders((cur) => {
      const next = new Set(cur);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  // Map of repoId → flatRows index. Lets RepoRow know whether it's the
  // keyboard-active row in O(1) without re-scanning flatRows per row.
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < flatRows.length; i++) {
      const r = flatRows[i];
      m.set(`${r.kind}:${r.id}`, i);
    }
    return m;
  }, [flatRows]);

  const onResetAll = async () => {
    if (resetting) return;
    setResetting(true);
    try {
      await runResetAllReposFlow();
    } finally {
      setResetting(false);
    }
  };

  return (
    <aside
      className="flex-1 min-w-0 flex flex-col border-r border-card bg-surface-muted"
      onKeyDown={onSidebarKeyDown}
    >
      <div className="px-2 pt-2 pb-1">
        <input
          ref={inputRef}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setActiveIdx(-1);
          }}
          placeholder="Search · / to focus"
          className="field w-full px-2 py-1 text-xs"
        />
      </div>

      <nav ref={navRef} className="flex-1 min-h-0 overflow-y-auto px-1 pb-2">
        {visibleWorkspaces.length > 0 && (
          <>
            <SectionHeader label="Workspaces" count={visibleWorkspaces.length} />
            {visibleWorkspaces.map((w) => {
              const idx = rowIndex.get(`workspace:${w.id}`) ?? -1;
              const busyVerb = busyWorkspaceVerb[w.id];
              const busy = Boolean(busyVerb);
              const markBusy = (verb: string) =>
                setBusyWorkspaceVerb((s) => ({ ...s, [w.id]: verb }));
              const clearBusy = () =>
                setBusyWorkspaceVerb((s) => {
                  const n = { ...s };
                  delete n[w.id];
                  return n;
                });
              return (
                <WorkspaceSection
                  key={w.id}
                  workspace={w}
                  selected={selectedWorkspace === w.id}
                  keyboardActive={idx === activeIdx}
                  busy={busy}
                  busyLabel={busyVerb}
                  onToggleCollapsed={() => void toggleWorkspaceCollapsed(w.id)}
                  onSelect={() => selectWorkspace(w.id)}
                  onEdit={() => setSheet({ kind: 'editWorkspace', workspaceId: w.id })}
                  onReset={async () => {
                    if (busy) return;
                    markBusy('Resetting…');
                    try {
                      await runResetWorkspaceFlow(w.id);
                    } finally {
                      clearBusy();
                    }
                  }}
                  onFetch={async () => {
                    if (busy) return;
                    markBusy('Fetching…');
                    try {
                      await fetchAllInWorkspace(w.id);
                    } finally {
                      clearBusy();
                    }
                  }}
                  onRemove={async () => {
                    const ok = await requestConfirm({
                      title: `Remove workspace?`,
                      body: `Remove workspace "${w.name}"? The repos themselves are left alone.`,
                      confirmLabel: 'Remove',
                    });
                    if (ok) void removeWorkspace(w.id);
                  }}
                >
                  {!w.collapsed &&
                    w.repoIds
                      .map((id) => repoById.get(id))
                      .filter((r): r is Repo => Boolean(r))
                      .map((r) => {
                        const ridx = rowIndex.get(`repo:${r.id}`) ?? -1;
                        return (
                          <RepoRow
                            key={`${w.id}:${r.id}`}
                            repo={r}
                            selected={selectedRepo === r.id}
                            keyboardActive={ridx === activeIdx}
                            indent
                            onSelect={() => selectRepo(r.id)}
                            onRemove={async () => {
                              const ok = await requestConfirm({
                                title: `Remove ${r.name}?`,
                                body: `Remove "${r.name}" from overgit? The repo on disk is left alone.`,
                                confirmLabel: 'Remove',
                              });
                              if (ok) void removeRepo(r.id);
                            }}
                          />
                        );
                      })}
                </WorkspaceSection>
              );
            })}
          </>
        )}

        {/* Repos on top — that's where users start. */}
        <SectionHeader
          label={workspaces.length > 0 ? 'Other repos' : 'Repos'}
          count={ungroupedRepos.length}
          action={
            repos.length > 0 ? (
              <button
                onClick={onResetAll}
                disabled={resetting}
                title="Fetch, switch to default branch, and pull on every repo. Dirty repos are skipped."
                className="text-[10px] text-ink-faint hover:text-ink px-1.5 py-0.5 rounded hover:bg-card disabled:opacity-50"
              >
                {resetting ? 'Resetting…' : 'Reset all'}
              </button>
            ) : null
          }
        />
        {ungroupedRepos.length === 0 ? (
          <EmptyHint
            text={
              query
                ? 'No repos match.'
                : workspaces.length > 0
                  ? 'Every repo belongs to a workspace.'
                  : 'Add a local git repo to start.'
            }
          />
        ) : (
          repoGroups.map((g) => {
            if (g.kind === 'flat') {
              return g.repos.map((r) => {
                const idx = rowIndex.get(`repo:${r.id}`) ?? -1;
                return (
                  <RepoRow
                    key={r.id}
                    repo={r}
                    selected={selectedRepo === r.id}
                    keyboardActive={idx === activeIdx}
                    onSelect={() => selectRepo(r.id)}
                    onRemove={async () => {
                      const ok = await requestConfirm({
                        title: `Remove ${r.name}?`,
                        body: `Remove "${r.name}" from overgit? The repo on disk is left alone.`,
                        confirmLabel: 'Remove',
                      });
                      if (ok) void removeRepo(r.id);
                    }}
                  />
                );
              });
            }
            const collapsed = collapsedFolders.has(g.label);
            return (
              <div key={g.label}>
                <button
                  onClick={() => toggleFolder(g.label)}
                  className="w-full px-2 py-1 mt-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink-faint hover:text-ink"
                  title={g.label}
                >
                  <span className="font-mono">{collapsed ? '▸' : '▾'}</span>
                  <span className="truncate">{shortenPath(g.label)}</span>
                  <span className="ml-auto">{g.repos.length}</span>
                </button>
                {!collapsed &&
                  g.repos.map((r) => {
                    const idx = rowIndex.get(`repo:${r.id}`) ?? -1;
                    return (
                      <RepoRow
                        key={r.id}
                        repo={r}
                        selected={selectedRepo === r.id}
                        keyboardActive={idx === activeIdx}
                        indent
                        onSelect={() => selectRepo(r.id)}
                        onRemove={async () => {
                          const ok = await requestConfirm({
                            title: `Remove ${r.name}?`,
                            body: `Remove "${r.name}" from overgit? The repo on disk is left alone.`,
                            confirmLabel: 'Remove',
                          });
                          if (ok) void removeRepo(r.id);
                        }}
                      />
                    );
                  })}
              </div>
            );
          })
        )}

        <SectionHeader label="Worksets" count={activeWorksets.length} />
        {activeWorksets.length === 0 ? (
          <EmptyHint
            text={
              query
                ? 'No worksets match.'
                : 'A unit of work across repos — branch, commit, push together. Archive when shipped.'
            }
          />
        ) : (
          activeWorksets.map((w) => {
            const idx = rowIndex.get(`workset:${w.id}`) ?? -1;
            return (
              <WorksetRow
                key={w.id}
                workset={w}
                selected={selectedWs === w.id && !selectedRepo}
                keyboardActive={idx === activeIdx}
                onSelect={() => selectWs(w.id)}
                onEdit={() => setSheet({ kind: 'editWorkset', worksetId: w.id })}
                onArchive={() => void archiveWorkset(w.id)}
                onRemove={async () => {
                  const ok = await requestConfirm({
                    title: `Remove workset?`,
                    body: `Remove workset "${w.name}"?`,
                    confirmLabel: 'Remove',
                  });
                  if (ok) void removeWorkset(w.id);
                }}
              />
            );
          })
        )}

        {archivedWorksets.length > 0 && (
          <>
            <button
              onClick={() => setArchivedExpanded((v) => !v)}
              className="w-full mt-3 px-2 py-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-ink-faint hover:text-ink"
              title={showArchivedRows ? 'Collapse archived' : 'Expand archived'}
            >
              <span className="font-mono">{showArchivedRows ? '▾' : '▸'}</span>
              <span>Archived</span>
              <span className="ml-auto">{archivedWorksets.length}</span>
            </button>
            {showArchivedRows &&
              archivedWorksets.map((w) => {
                const idx = rowIndex.get(`workset:${w.id}`) ?? -1;
                return (
                  <WorksetRow
                    key={w.id}
                    workset={w}
                    archived
                    selected={selectedWs === w.id && !selectedRepo}
                    keyboardActive={idx === activeIdx}
                    onSelect={() => selectWs(w.id)}
                    onReactivate={() => void unarchiveWorkset(w.id)}
                    onRemove={async () => {
                      const ok = await requestConfirm({
                        title: `Remove workset?`,
                        body: `Remove workset "${w.name}"?`,
                        confirmLabel: 'Remove',
                      });
                      if (ok) void removeWorkset(w.id);
                    }}
                  />
                );
              })}
          </>
        )}
      </nav>

      <div className="border-t border-card px-2 py-2 flex flex-col gap-1">
        <button
          onClick={pickAndAddRepo}
          className="text-xs text-ink-muted hover:text-ink py-1 px-2 rounded hover:bg-card text-left"
        >
          + Add repo
        </button>
        <button
          onClick={() => setSheet({ kind: 'newWorkspace' })}
          disabled={repos.length === 0}
          className="text-xs text-ink-muted hover:text-ink py-1 px-2 rounded hover:bg-card text-left disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
        >
          + New workspace
        </button>
        <button
          onClick={() => setSheet({ kind: 'newWorkset' })}
          disabled={repos.length === 0}
          className="text-xs text-ink-muted hover:text-ink py-1 px-2 rounded hover:bg-card text-left disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
        >
          + New workset
        </button>
      </div>
    </aside>
  );
}

/// Group repos by their parent directory ("auto-folders"). Returns a
/// flat list when grouping isn't worth it (filtered, too few repos, or
/// a single shared parent — no signal in that case). Threshold tuned
/// empirically: at 6+ repos with 2+ parents, the directory column is a
/// readable shorthand for ownership; under that, a flat list scans
/// faster. Schema-free — we never persist this; it's pure rendering.
function groupReposByParentDir(
  repos: Repo[],
  filtering: boolean,
):
  | Array<{ kind: 'flat'; repos: Repo[] }>
  | Array<
      | { kind: 'flat'; repos: Repo[] }
      | { kind: 'group'; label: string; repos: Repo[] }
    > {
  if (filtering || repos.length < 6) return [{ kind: 'flat', repos }];
  const byDir = new Map<string, Repo[]>();
  for (const r of repos) {
    const dir = parentDir(r.path);
    const list = byDir.get(dir) ?? [];
    list.push(r);
    byDir.set(dir, list);
  }
  if (byDir.size < 2) return [{ kind: 'flat', repos }];
  // Sort groups by name; keep singletons as a synthetic "Other" flat
  // section so the sidebar isn't dominated by one-row folders.
  const groups: Array<{ kind: 'group'; label: string; repos: Repo[] }> = [];
  const orphans: Repo[] = [];
  for (const [dir, list] of byDir) {
    if (list.length === 1) {
      orphans.push(list[0]);
    } else {
      groups.push({ kind: 'group', label: dir, repos: list });
    }
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  if (orphans.length === 0) return groups;
  return [...groups, { kind: 'flat', repos: orphans }];
}

function parentDir(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  const idx = p.lastIndexOf(sep);
  return idx > 0 ? p.slice(0, idx) : p;
}

/// Trim a directory path for sidebar display: keep the last 2 segments
/// so common prefixes (~/code, /Users/foo/git-services/...) collapse
/// without losing the bit that distinguishes one folder from another.
function shortenPath(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 2) return p;
  return '…' + sep + parts.slice(-2).join(sep);
}

function SectionHeader({
  label,
  count,
  action,
}: {
  label: string;
  count: number;
  /// Optional trailing element rendered right-aligned in the header
  /// row. Used by the Repos section to surface a "Reset all to default"
  /// affordance without bolting another control elsewhere in the
  /// sidebar.
  action?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="mt-3 first:mt-1 px-2 py-1 flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</span>
      <span className="text-[10px] text-ink-faint">{count}</span>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

function EmptyHint({ text }: { text: string }): JSX.Element {
  return <div className="px-2 py-1 text-[11px] text-ink-faint">{text}</div>;
}

function RepoRow({
  repo,
  selected,
  keyboardActive = false,
  indent = false,
  onSelect,
  onRemove,
}: {
  repo: Repo;
  selected: boolean;
  keyboardActive?: boolean;
  indent?: boolean;
  onSelect: () => void;
  onRemove: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const status = useStore((s) => s.repoStatus[repo.id]);
  // Keep the keyboard-active row in view as the cursor moves through
  // a long list. `nearest` avoids jumpy auto-scrolls when the row is
  // already visible.
  useEffect(() => {
    if (keyboardActive) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [keyboardActive]);
  return (
    <div
      ref={ref}
      className={`sidebar-row group flex items-center gap-1.5 rounded text-xs ${
        selected
          ? 'sidebar-row-selected text-ink'
          : keyboardActive
            ? 'bg-card text-ink ring-1 ring-accent/40'
            : 'text-ink-muted hover:bg-card hover:text-ink'
      }`}
    >
      <Explain
        command={`cd ${repo.path}`}
        plain={`Open ${repo.name} — switch the detail pane to this repository's status, history, and branches.`}
      >
        <button
          onClick={onSelect}
          className={`flex items-center gap-1.5 flex-1 min-w-0 text-left py-1 ${
            indent ? 'pl-5 pr-2' : 'px-2'
          }`}
          title={repo.path}
        >
          <RepoIcon />
          <span className="truncate">{repo.name}</span>
          <RepoStatusBadge status={status} />
        </button>
      </Explain>
      <button
        onClick={onRemove}
        title="Remove from overgit"
        className="w-5 h-5 flex items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 hover:text-red-300 hover:bg-card"
      >
        <span className="text-[11px]">×</span>
      </button>
    </div>
  );
}

/// Compact dirty / upstream indicator for the sidebar. Shown only when
/// there's something to flag — a clean, in-sync repo gets nothing so
/// the list stays quiet. We split the visual treatment so the user can
/// scan: amber dot = local changes, ↑/↓ counts = drift vs upstream,
/// red ⚠ = an in-progress merge/rebase the user paused on.
function RepoStatusBadge({ status }: { status?: RepoStatus }): JSX.Element | null {
  if (!status) return null;
  const dirty = status.dirtyCount > 0;
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  const inProgress = !!status.inProgress;
  if (!dirty && ahead === 0 && behind === 0 && !inProgress) return null;

  const tip: string[] = [];
  if (dirty) tip.push(`${status.dirtyCount} uncommitted ${status.dirtyCount === 1 ? 'change' : 'changes'}`);
  if (ahead > 0) tip.push(`${ahead} ahead of upstream`);
  if (behind > 0) tip.push(`${behind} behind upstream`);
  if (inProgress) tip.push(`${status.inProgress} in progress`);

  return (
    <span
      className="ml-auto flex items-center gap-1 shrink-0 text-[10px] font-mono"
      title={tip.join(' · ')}
    >
      {inProgress && <span className="text-red-400">⚠</span>}
      {dirty && (
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" aria-label="dirty" />
      )}
      {ahead > 0 && <span className="text-emerald-400">↑{ahead}</span>}
      {behind > 0 && <span className="text-sky-400">↓{behind}</span>}
    </span>
  );
}

function WorksetRow({
  workset,
  selected,
  keyboardActive = false,
  archived = false,
  onSelect,
  onEdit,
  onArchive,
  onReactivate,
  onRemove,
}: {
  workset: Workset;
  selected: boolean;
  keyboardActive?: boolean;
  /// Render in muted "archived" treatment with a Reactivate button instead
  /// of Edit/Archive. Archived rows are still selectable so a power user
  /// who expanded the section can peek at one without reactivating first.
  archived?: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onArchive?: () => void;
  onReactivate?: () => void;
  onRemove: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (keyboardActive) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [keyboardActive]);
  return (
    <div
      ref={ref}
      className={`sidebar-row group flex items-center gap-1.5 rounded text-xs ${
        selected
          ? 'sidebar-row-selected text-ink'
          : keyboardActive
            ? 'bg-card text-ink ring-1 ring-accent/40'
            : archived
              ? 'text-ink-faint hover:bg-card hover:text-ink-muted'
              : 'text-ink-muted hover:bg-card hover:text-ink'
      }`}
    >
      <button
        onClick={onSelect}
        className="flex items-center gap-2 flex-1 min-w-0 text-left px-2 py-1.5"
        title={
          workset.preferredBranch
            ? `${workset.name} · ${workset.preferredBranch}`
            : workset.name
        }
      >
        <WorksetIcon />
        <div className="flex-1 min-w-0 flex flex-col leading-tight">
          <span className="truncate font-medium">{workset.name}</span>
          {workset.preferredBranch && (
            <span className="truncate font-mono text-[10px] text-ink-faint mt-0.5">
              {workset.preferredBranch}
            </span>
          )}
        </div>
        <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
          {workset.repoIds.length}
        </span>
      </button>
      {archived ? (
        onReactivate && (
          <button
            onClick={onReactivate}
            title="Reactivate workset"
            className="w-5 h-5 flex items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink hover:bg-card"
          >
            <ReactivateIcon />
          </button>
        )
      ) : (
        <>
          {onEdit && (
            <button
              onClick={onEdit}
              title="Edit workset"
              className="w-5 h-5 flex items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink hover:bg-card"
            >
              <PencilIcon />
            </button>
          )}
          {onArchive && (
            <button
              onClick={onArchive}
              title="Archive workset"
              className="w-5 h-5 flex items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink hover:bg-card"
            >
              <ArchiveIcon />
            </button>
          )}
        </>
      )}
      <button
        onClick={onRemove}
        title="Remove workset"
        className="w-5 h-5 flex items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 hover:text-red-300 hover:bg-card"
      >
        <span className="text-[11px]">×</span>
      </button>
    </div>
  );
}

/// One Workspace block in the sidebar — a collapsible header
/// followed by its member RepoRow children (passed as `children` so
/// the parent keeps repo lookup + selection logic in one place). The
/// chevron toggles collapse; clicking the name selects the workspace
/// (opens its detail page in the main pane). Hover-only action
/// buttons fan out Reset / Fetch / Edit / Remove for the whole group.
function WorkspaceSection({
  workspace,
  selected,
  keyboardActive = false,
  busy = false,
  busyLabel,
  onToggleCollapsed,
  onSelect,
  onEdit,
  onReset,
  onFetch,
  onRemove,
  children,
}: {
  workspace: Workspace;
  selected: boolean;
  keyboardActive?: boolean;
  busy?: boolean;
  /// Short verb shown next to the workspace name when a bulk action
  /// is in flight ("Resetting…", "Fetching…"). Replaces the repo
  /// count badge so the row is unambiguous about what's happening.
  busyLabel?: string;
  onToggleCollapsed: () => void;
  onSelect: () => void;
  onEdit: () => void;
  onReset: () => void;
  onFetch: () => void;
  onRemove: () => void;
  children?: React.ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (keyboardActive) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [keyboardActive]);
  return (
    <div className="mt-1 first:mt-0">
      <div
        ref={ref}
        className={`group flex items-center gap-0.5 pr-1 rounded text-xs ${
          selected
            ? 'sidebar-row-selected text-ink'
            : keyboardActive
              ? 'bg-card text-ink ring-1 ring-accent/40'
              : 'text-ink-muted hover:bg-card hover:text-ink'
        }`}
      >
        <button
          onClick={onToggleCollapsed}
          className="w-5 h-5 flex items-center justify-center shrink-0 rounded text-ink-faint hover:text-ink hover:bg-white/[0.06]"
          title={
            workspace.collapsed
              ? `Expand ${workspace.name}`
              : `Collapse ${workspace.name}`
          }
          aria-label={workspace.collapsed ? 'Expand' : 'Collapse'}
        >
          <span className="font-mono text-[10px]">
            {workspace.collapsed ? '▸' : '▾'}
          </span>
        </button>
        <button
          onClick={onSelect}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left py-1.5"
          title={`Open ${workspace.name}`}
        >
          <span className="truncate font-medium">{workspace.name}</span>
          {busy && busyLabel ? (
            <span className="ml-auto shrink-0 flex items-center gap-1 text-[10px] text-accent">
              <SpinnerDot />
              <span>{busyLabel}</span>
            </span>
          ) : (
            <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
              {workspace.repoIds.length}
            </span>
          )}
        </button>
        <Explain
          command={`for repo in <${workspace.name}>: git fetch && git switch <default> && git pull`}
          plain={`Bring every repo in "${workspace.name}" back to its default branch — fetch, switch, pull. Dirty repos are skipped.`}
        >
          <button
            onClick={onReset}
            disabled={busy}
            title="Fetch, switch to default, and pull on every repo in this workspace. Dirty repos are skipped."
            className="w-5 h-5 flex items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink hover:bg-card disabled:opacity-40"
          >
            <ResetIcon />
          </button>
        </Explain>
        <Explain
          command={`for repo in <${workspace.name}>: git fetch`}
          plain={`Run git fetch in every repo in "${workspace.name}" so ahead/behind dots reflect the remote.`}
        >
          <button
            onClick={onFetch}
            disabled={busy}
            title="Fetch every repo in this workspace"
            className="w-5 h-5 flex items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink hover:bg-card disabled:opacity-40"
          >
            <FetchIcon />
          </button>
        </Explain>
        <Explain
          command="(rename or change members)"
          plain={`Edit the workspace — rename "${workspace.name}" or change which repos belong to it. No git commands run.`}
        >
          <button
            onClick={onEdit}
            title="Edit workspace"
            className="w-5 h-5 flex items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink hover:bg-card"
          >
            <PencilIcon />
          </button>
        </Explain>
        <Explain
          command="(delete grouping)"
          plain={`Remove the workspace from overgit. The repos themselves are left alone on disk; only the grouping is dropped.`}
        >
          <button
            onClick={onRemove}
            title="Remove workspace"
            className="w-5 h-5 flex items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 hover:text-red-300 hover:bg-card"
          >
            <span className="text-[11px]">×</span>
          </button>
        </Explain>
      </div>
      {children}
    </div>
  );
}

function SpinnerDot(): JSX.Element {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" className="animate-spin" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.25" />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function ResetIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <path
        d="M3 8a5 5 0 1 0 1.5-3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M5 5H2V2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function FetchIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <path
        d="M8 3v7m0 0L5 7m3 3l3-3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3 12h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function ArchiveIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <rect x="2" y="3" width="12" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3 6.5v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.5 9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function ReactivateIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <path
        d="M3 8a5 5 0 1 1 1.5 3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M3 5v3h3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function RepoIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-ink-muted flex-shrink-0">
      <path
        d="M3.5 2.5h7l1 1v9.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M6 8 7.5 9.5 10 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WorksetIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-ink-muted flex-shrink-0">
      <path
        d="M3.5 2.5H5.7L6.7 3.6H12.5V5.5H3.5V2.5Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.2"
      />
      <path
        d="M1.5 5.5H4L5 6.5H14.5V13.3A1 1 0 0113.5 14.3H2.5A1 1 0 011.5 13.3V5.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BranchGlyph(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <circle cx="4" cy="3.5" r="1.4" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12.5" r="1.4" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="6.5" r="1.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5v6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M11.5 8c0 2.2-1.8 4-4 4H6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function PencilIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 20 20" fill="currentColor" className="flex-shrink-0">
      <path d="M12.793 2.793a1 1 0 0 1 1.414 0l2 2a1 1 0 0 1 0 1.414l-8.2 8.2a2.5 2.5 0 0 1-1.14.63l-2.26.566a.75.75 0 0 1-.91-.91l.566-2.26a2.5 2.5 0 0 1 .63-1.14l8.2-8.2Z" />
    </svg>
  );
}

function Main(): JSX.Element {
  const selectedRepo = useStore((s) => s.selectedRepoId);
  const selectedWs = useStore((s) => s.selectedWorksetId);
  const selectedWorkspace = useStore((s) => s.selectedWorkspaceId);
  const worksets = useStore((s) => s.worksets);
  const workspaces = useStore((s) => s.workspaces);
  const ws = useMemo(
    () => worksets.find((w) => w.id === selectedWs) ?? null,
    [worksets, selectedWs],
  );
  const wsp = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspace) ?? null,
    [workspaces, selectedWorkspace],
  );

  if (selectedRepo) return <RepoDetail repoId={selectedRepo} />;

  if (wsp) return <WorkspaceDetail key={wsp.id} workspaceId={wsp.id} />;

  if (!ws) {
    return (
      <main className="flex-1 flex items-center justify-center text-ink-muted">
        <div className="text-center max-w-sm">
          <div className="text-base font-medium mb-1">Pick a repo, workspace, or workset</div>
          <p className="text-xs text-ink-faint">
            Workspaces are durable groups (an org / client / initiative) with
            a health overview and bulk actions. Worksets are units of in-flight
            work across repos. Repos are the per-repo working pane.
          </p>
        </div>
      </main>
    );
  }

  return <WorksetView key={ws.id} worksetId={ws.id} />;
}

/// Workspace detail page. A durable-group overview: per-repo status
/// table (branch, dirty count, ahead/behind) + bulk maintenance
/// actions in the header (Reset all / Fetch all / Edit / Remove).
/// Deliberately leaner than WorksetView — workspaces aren't about
/// a piece of work, they're about a stable inventory, so this pane
/// surfaces health and shortcuts and not commit/push flows.
function WorkspaceDetail({ workspaceId }: { workspaceId: UUID }): JSX.Element {
  const workspace = useStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId) ?? null,
  );
  const repos = useStore((s) => s.repos);
  const repoStatuses = useStore((s) => s.repoStatus);
  const refreshAllRepoStatuses = useStore((s) => s.refreshAllRepoStatuses);
  const runResetWorkspaceFlow = useStore((s) => s.runResetWorkspaceFlow);
  const fetchAllInWorkspace = useStore((s) => s.fetchAllInWorkspace);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const requestConfirm = useStore((s) => s.requestConfirm);
  const setSheet = useStore((s) => s.setSheet);
  const selectRepo = useStore((s) => s.selectRepo);
  const [busy, setBusy] = useState<'reset' | 'fetch' | null>(null);

  // Refresh statuses on mount so the table is honest the moment the
  // pane opens, not whatever was cached from the last sidebar tick.
  useEffect(() => {
    void refreshAllRepoStatuses();
  }, [workspaceId, refreshAllRepoStatuses]);

  const members = useMemo(() => {
    if (!workspace) return [];
    const byId = new Map(repos.map((r) => [r.id, r] as const));
    return workspace.repoIds
      .map((id) => byId.get(id))
      .filter((r): r is Repo => Boolean(r));
  }, [workspace, repos]);

  const aggregate = useMemo(() => {
    let dirty = 0;
    let ahead = 0;
    let behind = 0;
    let detached = 0;
    let noUpstream = 0;
    for (const r of members) {
      const st = repoStatuses[r.id];
      if (!st) continue;
      if (!st.branch) detached++;
      if (st.dirtyCount > 0) dirty++;
      if ((st.ahead ?? 0) > 0) ahead++;
      if ((st.behind ?? 0) > 0) behind++;
      if (!st.hasUpstream && st.branch) noUpstream++;
    }
    return { dirty, ahead, behind, detached, noUpstream, total: members.length };
  }, [members, repoStatuses]);

  if (!workspace) {
    return (
      <main className="flex-1 flex items-center justify-center text-ink-muted text-sm">
        Workspace not found.
      </main>
    );
  }

  const onReset = async () => {
    if (busy) return;
    setBusy('reset');
    try {
      await runResetWorkspaceFlow(workspaceId);
    } finally {
      setBusy(null);
    }
  };
  const onFetch = async () => {
    if (busy) return;
    setBusy('fetch');
    try {
      await fetchAllInWorkspace(workspaceId);
    } finally {
      setBusy(null);
    }
  };
  const onRemove = async () => {
    const ok = await requestConfirm({
      title: 'Remove workspace?',
      body: `Remove workspace "${workspace.name}"? The repos themselves are left alone on disk; only the grouping is dropped.`,
      confirmLabel: 'Remove',
    });
    if (ok) void removeWorkspace(workspaceId);
  };

  return (
    <main className="flex-1 min-w-0 flex flex-col">
      <header className="px-6 pt-5 pb-4 border-b border-card flex flex-col gap-3">
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <h1 className="text-xl font-semibold text-ink truncate">
                {workspace.name}
              </h1>
              <span className="text-[11px] uppercase tracking-wider text-ink-faint">
                Workspace
              </span>
            </div>
            <p className="text-[12px] text-ink-faint mt-1">
              {members.length} {members.length === 1 ? 'repo' : 'repos'} in this
              workspace. Aggregate health below; click any row to open the repo.
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={onReset}
              disabled={busy !== null || members.length === 0}
              className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
              title="Reset every repo to origin's tip of its default branch."
            >
              {busy === 'reset' ? 'Resetting…' : 'Reset all'}
            </button>
            <button
              onClick={onFetch}
              disabled={busy !== null || members.length === 0}
              className="text-xs px-3 py-1.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card disabled:opacity-50"
              title="Run git fetch on every repo so ahead/behind reflects the remote."
            >
              {busy === 'fetch' ? 'Fetching…' : 'Fetch all'}
            </button>
            {aggregate.behind > 0 && (
              <button
                onClick={() => {
                  const behindIds = members
                    .filter((r) => (repoStatuses[r.id]?.behind ?? 0) > 0)
                    .map((r) => r.id);
                  if (behindIds.length === 0) return;
                  setSheet({
                    kind: 'syncBehindProgress',
                    workspaceId,
                    repoIds: behindIds,
                  });
                }}
                disabled={busy !== null}
                className="text-xs px-3 py-1.5 rounded border border-accent/40 text-accent hover:bg-accent/10 disabled:opacity-50"
                title="Fast-forward every behind repo to its upstream. Diverged branches are reported, never merged."
              >
                Sync {aggregate.behind} behind
              </button>
            )}
            <button
              onClick={() => setSheet({ kind: 'editWorkspace', workspaceId })}
              className="text-xs px-3 py-1.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card"
              title="Rename or change members."
            >
              Edit
            </button>
            <button
              onClick={onRemove}
              className="text-xs px-3 py-1.5 rounded border border-card text-ink-faint hover:text-red-300 hover:bg-card"
              title="Remove this workspace from overgit. Repos are unaffected."
            >
              Remove
            </button>
          </div>
        </div>

        <div className="flex items-center gap-4 text-[11px] tabular-nums text-ink-faint">
          <WorkspaceStatPill
            label="Dirty"
            count={aggregate.dirty}
            tone={aggregate.dirty > 0 ? 'amber' : 'neutral'}
          />
          <WorkspaceStatPill
            label="Ahead"
            count={aggregate.ahead}
            tone={aggregate.ahead > 0 ? 'accent' : 'neutral'}
          />
          <WorkspaceStatPill
            label="Behind"
            count={aggregate.behind}
            tone={aggregate.behind > 0 ? 'accent' : 'neutral'}
          />
          {aggregate.detached > 0 && (
            <WorkspaceStatPill
              label="Detached"
              count={aggregate.detached}
              tone="amber"
            />
          )}
          {aggregate.noUpstream > 0 && (
            <WorkspaceStatPill
              label="No upstream"
              count={aggregate.noUpstream}
              tone="amber"
            />
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {members.length === 0 ? (
          <div className="text-sm text-ink-faint">
            This workspace has no repos yet. Click <strong>Edit</strong> to
            add members.
          </div>
        ) : (
          <div className="rounded-md bg-black/10 ring-1 ring-white/[0.04] divide-y divide-white/[0.03]">
            <div className={`${WORKSPACE_TABLE_COLS} px-3 py-1.5 text-[10px] uppercase tracking-wider text-ink-faint`}>
              <span>Repo</span>
              <span className="text-right">Branch</span>
              <span className="text-right">Dirty</span>
              <span className="text-right">Ahead</span>
              <span className="text-right">Behind</span>
            </div>
            {members.map((r) => (
              <WorkspaceMemberRow
                key={r.id}
                repo={r}
                status={repoStatuses[r.id]}
                onOpen={() => selectRepo(r.id)}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function WorkspaceStatPill({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: 'neutral' | 'accent' | 'amber';
}): JSX.Element {
  const color =
    tone === 'amber'
      ? 'text-amber-300/90'
      : tone === 'accent'
        ? 'text-accent'
        : 'text-ink-faint';
  return (
    <span className={`flex items-center gap-1 ${color}`}>
      <span className="font-semibold">{count}</span>
      <span className="uppercase tracking-wider text-[10px]">{label}</span>
    </span>
  );
}

/// Shared column template for the workspace member table. Header
/// and row buttons both apply this class so the columns line up
/// across rows — the previous `auto`-sized columns let each row
/// size its own branch column to whatever string it contained, so
/// the header label and the data drifted apart.
const WORKSPACE_TABLE_COLS =
  'grid grid-cols-[minmax(0,1fr)_minmax(120px,200px)_56px_56px_56px] gap-x-4';

function WorkspaceMemberRow({
  repo,
  status,
  onOpen,
}: {
  repo: Repo;
  status: RepoStatus | undefined;
  onOpen: () => void;
}): JSX.Element {
  const branch = status?.branch ?? null;
  const dirty = status?.dirtyCount ?? 0;
  const ahead = status?.ahead ?? null;
  const behind = status?.behind ?? null;
  return (
    <button
      onClick={onOpen}
      className={`${WORKSPACE_TABLE_COLS} w-full text-left px-3 py-2 items-baseline hover:bg-white/[0.03] transition-colors`}
    >
      <div className="min-w-0">
        <div className="truncate text-[13px] text-ink">{repo.name}</div>
        <div className="truncate text-[10px] text-ink-faint/80 font-mono leading-tight mt-0.5">
          {repo.path}
        </div>
      </div>
      <div className="text-[12px] text-ink-muted font-mono tabular-nums text-right truncate">
        {branch ?? <span className="text-amber-300/80">detached</span>}
      </div>
      <div
        className={`text-[12px] tabular-nums text-right ${
          dirty > 0 ? 'text-amber-300/90' : 'text-ink-faint'
        }`}
      >
        {dirty > 0 ? dirty : '·'}
      </div>
      <div
        className={`text-[12px] tabular-nums text-right ${
          (ahead ?? 0) > 0 ? 'text-accent' : 'text-ink-faint'
        }`}
      >
        {ahead === null ? '·' : ahead > 0 ? `↑${ahead}` : '·'}
      </div>
      <div
        className={`text-[12px] tabular-nums text-right ${
          (behind ?? 0) > 0 ? 'text-accent' : 'text-ink-faint'
        }`}
      >
        {behind === null ? '·' : behind > 0 ? `↓${behind}` : '·'}
      </div>
    </button>
  );
}

function WorksetView({ worksetId }: { worksetId: UUID }): JSX.Element {
  const ws = useStore((s) => s.worksets.find((w) => w.id === worksetId));
  const repos = useStore((s) => s.repos);
  const statuses = useStore((s) => s.worksetStatuses[worksetId] ?? EMPTY_STATUSES);
  const prs = useStore((s) => s.worksetPRs[worksetId] ?? EMPTY_PRS);
  const activity = useStore((s) => s.worksetActivity[worksetId] ?? EMPTY_ACTIVITY);
  const lastSeen = useStore(
    (s) => s.settings.worksetLastSeen?.[worksetId] ?? null,
  );
  const lastCheckout = useStore((s) => s.lastCheckout);
  const cli = useStore((s) => s.cliPresence);
  const refresh = useStore((s) => s.refreshWorksetStatus);
  const refreshPRs = useStore((s) => s.refreshWorksetPRs);
  const refreshWorktrees = useStore((s) => s.refreshWorksetWorktrees);
  const refreshActivity = useStore((s) => s.refreshWorksetActivity);
  const markSeen = useStore((s) => s.markWorksetSeen);
  const fetchWs = useStore((s) => s.fetchWorkset);
  const selectRepo = useStore((s) => s.selectRepo);
  const setSheet = useStore((s) => s.setSheet);
  const archiveWs = useStore((s) => s.archiveWorkset);
  const requestConfirm = useStore((s) => s.requestConfirm);
  const pushToast = useStore((s) => s.pushToast);
  const dismissToast = useStore((s) => s.dismissToast);

  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'overview' | 'commit'>('overview');
  const [showAllWorktrees, setShowAllWorktrees] = useState(false);
  /// `seenAtOpen` freezes the lastSeen value at mount so the "new
  /// since" pip remains visible while the user is on the pane. Without
  /// this, marking-seen on open would immediately wipe the indicators
  /// the user just came in to look at. We mark-seen on unmount instead
  /// (or on explicit dismiss).
  const [seenAtOpen] = useState<string | null>(lastSeen);

  useEffect(() => {
    refresh(worksetId);
    refreshPRs(worksetId);
    refreshWorktrees(worksetId);
    refreshActivity(worksetId);
  }, [refresh, refreshPRs, refreshWorktrees, refreshActivity, worksetId]);

  // On unmount (or workset switch), advance lastSeen so the next
  // visit only highlights things that landed after this one.
  useEffect(() => {
    return () => {
      void markSeen(worksetId);
    };
  }, [markSeen, worksetId]);

  // Overview tiles, computed BEFORE any early return so React's hook
  // order stays stable. The previous version put this useMemo after
  // `if (!ws) return …` — the crash that left the whole app rendering
  // blank when a freshly-created workset momentarily lagged the
  // selector. Falls back to zeroes when ws hasn't materialized yet.
  const summary = useMemo(() => {
    const total = ws?.repoIds.length ?? 0;
    const loaded = statuses.length;
    const dirty = statuses.filter((s) => s.dirtyCount > 0).length;
    const ahead = statuses.filter((s) => (s.ahead ?? 0) > 0).length;
    const behind = statuses.filter((s) => (s.behind ?? 0) > 0).length;
    // "Needs first push" — branch exists, hasn't been pushed yet
    // (no upstream tracking ref), AND has at least one commit beyond
    // the repo's default branch. `git push -u origin HEAD` would
    // wire it up; the workset-level Push handler reports these
    // back as `pushed-new-upstream`, so the button should enable
    // for them even though `ahead` reads as null.
    //
    // Branches with no commits beyond default (just-created and never
    // committed to) are excluded — pushing them publishes nothing
    // useful, and gating the lifecycle on them traps the user when
    // they want to abandon an empty workset.
    const needsFirstPush = statuses.filter(
      (s) =>
        s.branch !== null &&
        !s.hasUpstream &&
        !s.upstreamGone &&
        (s.aheadDefault ?? 0) > 0,
    ).length;
    // PR-eligible: on a non-default branch (we don't probe gh here
    // for already-open PRs — that's the per-row outcome's job).
    const prCandidates = statuses.filter((s) => {
      if (s.branch === null) return false;
      const repo = repos.find((r) => r.id === s.repoId);
      const def = repo?.defaultBranch;
      return !def || s.branch !== def;
    }).length;
    // Repos in the middle of a merge / rebase / cherry-pick. Surfaced
    // in the overview because a workset-wide op (rebase the workset
    // onto main) can leave several repos paused on conflicts at once;
    // burying that in the per-row status cell makes it easy to miss.
    const inProgress = statuses.filter((s) => s.inProgress !== null).length;
    const conflictedFiles = statuses.reduce(
      (acc, s) => acc + (s.conflicts?.length ?? 0),
      0,
    );
    const branchTally = new Map<string, number>();
    for (const s of statuses) {
      const b = s.branch ?? '(detached)';
      branchTally.set(b, (branchTally.get(b) ?? 0) + 1);
    }
    const sortedBranches = [...branchTally.entries()].sort((a, b) => b[1] - a[1]);
    return {
      total,
      loaded,
      dirty,
      ahead,
      behind,
      needsFirstPush,
      prCandidates,
      inProgress,
      conflictedFiles,
      sortedBranches,
    };
  }, [ws?.repoIds.length, statuses, repos]);

  if (!ws) return <main className="flex-1" />;

  const reposById = new Map(repos.map((r) => [r.id, r]));

  // The workset's "common branch" — the branch the user is treating
  // as the workset's coordinated feature branch. Prefer the explicit
  // preferredBranch if set; else infer from the dominant branch held by
  // a majority of loaded statuses. Returns null when no clear winner
  // exists so we don't mistake "everyone happens to be on main" for an
  // intentional cross-repo branch.
  const commonBranch: string | null = (() => {
    if (ws.preferredBranch) return ws.preferredBranch;
    if (summary.sortedBranches.length === 0) return null;
    const [topBranch, topCount] = summary.sortedBranches[0];
    if (topBranch === '(detached)') return null;
    // Need at least 2 repos and a majority for it to count as "common".
    if (topCount < 2) return null;
    if (topCount * 2 < summary.loaded) return null;
    return topBranch;
  })();

  // Drift gate for the workset-wide write actions (Commit all / Push all
  // / Open PRs). When a member is off the bound branch, those actions
  // would commit / push / PR off the wrong branch — almost certainly not
  // what the workset implies. We disable them and steer the user to
  // Resume first. Only applies when a branch is explicitly bound — for
  // legacy worksets relying on inference, behavior stays as before.
  const drifters =
    ws.preferredBranch && summary.loaded > 0
      ? summary.loaded - statuses.filter((s) => s.branch === ws.preferredBranch).length
      : 0;
  const hasDrift = ws.preferredBranch !== undefined && drifters > 0;
  const driftTooltip = hasDrift
    ? `Resume the workset first — ${drifters} of ${summary.loaded} ${
        summary.loaded === 1 ? 'repo is' : 'repos are'
      } off ${ws.preferredBranch}.`
    : null;

  return (
    <main className="flex-1 overflow-y-auto p-6">
      <header className="flex items-start justify-between mb-4 gap-4">
        <div className="min-w-0 flex flex-col gap-1.5">
          <h1 className="text-lg font-semibold truncate">{ws.name}</h1>
          <div className="flex items-center gap-2 flex-wrap">
            {commonBranch && (
              <span
                className={`inline-flex items-center gap-1.5 text-[12px] font-mono px-2.5 py-1 rounded-md bg-card ${
                  ws.preferredBranch ? 'text-accent' : 'text-ink-muted'
                }`}
                title={
                  ws.preferredBranch
                    ? 'Bound branch — workset lives here'
                    : 'Inferred from members — open Edit to bind it'
                }
              >
                <BranchGlyph />
                <span className="truncate max-w-[260px]">{commonBranch}</span>
              </span>
            )}
            <span className="text-[11px] text-ink-faint">
              {ws.repoIds.length} {ws.repoIds.length === 1 ? 'repo' : 'repos'} · CLIs: {cliSummary(cli)}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {/* "New branch" only makes sense before the workset is settled
              on its bound branch. Once preferredBranch is set and every
              loaded member is on it, branching again is ambiguous —
              it'd either rebind the workset (surprising) or fork a
              sibling (no first-class semantic). Hide it; the lifecycle
              tells the user to commit / push / archive instead. */}
          {(!ws.preferredBranch || drifters > 0 || summary.loaded === 0) && (
            <Explain
              command="for repo in workset; do git checkout default && git pull && git checkout -b <new>; done"
              plain="Sync every repo to its default branch, pull, and create a shared new branch in each."
            >
              <button
                onClick={() => setSheet({ kind: 'newBranchInWorkset', worksetId })}
                disabled={ws.repoIds.length === 0}
                title="Sync each repo to its default branch, pull, and create a new branch — all in one go"
                className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
              >
                + New branch
              </button>
            </Explain>
          )}
          {/* Toolbar buttons hide when the action would be a no-op.
              The lifecycle stepper above already tells the user *why*
              they can't act (drift, dirty, ahead, etc.), so disabled
              greyed-out buttons here add noise without information. */}
          {summary.dirty > 0 && !hasDrift && (
            <Explain
              command='for repo in dirty; do git add -A && git commit -m "…"; done'
              plain="Stage every change in every dirty repo and commit them all with a shared message."
            >
              <button
                onClick={() => setSheet({ kind: 'commitAllInWorkset', worksetId })}
                title={`Stage and commit every dirty repo with a shared message (${summary.dirty} dirty)`}
                className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
              >
                Commit all
              </button>
            </Explain>
          )}
          {!hasDrift && (summary.ahead > 0 || summary.needsFirstPush > 0) && (
            <Explain
              command="for repo in ahead; do git push; done"
              plain="Send local commits up to the remote for every repo that's ahead of upstream."
            >
              <button
                onClick={() => setSheet({ kind: 'pushAllInWorkset', worksetId })}
                title={
                  summary.needsFirstPush > 0 && summary.ahead === 0
                    ? `Push ${summary.needsFirstPush} ${summary.needsFirstPush === 1 ? 'repo' : 'repos'} for the first time (sets upstream)`
                    : `Push every repo whose branch is ahead of upstream (${summary.ahead} ahead${summary.needsFirstPush > 0 ? `, ${summary.needsFirstPush} first-push` : ''})`
                }
                className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong"
              >
                Push all
                {summary.ahead > 0 ? ` ↑${summary.ahead}` : ''}
                {summary.needsFirstPush > 0 ? ` ↑${summary.needsFirstPush}*` : ''}
              </button>
            </Explain>
          )}
          {!hasDrift && summary.prCandidates > 0 && (
            <Explain
              command="gh pr create"
              plain="Open a pull request for each repo using a shared title and body. GitHub repos run gh; Bitbucket repos open the create-PR form in your browser."
            >
              <button
                onClick={() => setSheet({ kind: 'openPRsInWorkset', worksetId })}
                title={
                  !cli?.gh
                    ? 'GitHub needs gh installed; Bitbucket opens in the browser'
                    : 'Open a PR per repo with a shared title and body'
                }
                className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
              >
                Open PRs
              </button>
            </Explain>
          )}
          <Explain
            command=""
            plain="Add or remove repos in this workset, rename it, or pick a default branch."
          >
            <button
              onClick={() => setSheet({ kind: 'editWorkset', worksetId })}
              className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
            >
              Edit
            </button>
          </Explain>
          <Explain
            command="for repo in workset; do git fetch; done"
            plain="Ask each remote what's new — doesn't change any branch in any repo."
          >
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await fetchWs(worksetId);
                } finally {
                  setBusy(false);
                }
              }}
              className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {busy ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" className="animate-spin" aria-hidden>
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" fill="none" />
                    <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
                  </svg>
                  <span>Fetching all…</span>
                </>
              ) : (
                'Fetch all'
              )}
            </button>
          </Explain>
          <Explain
            command="git status (per repo)"
            plain="Re-read every repo's status and re-fetch open PRs without touching git remotes."
          >
            <button
              disabled={busy}
              onClick={() => {
                refresh(worksetId);
                refreshPRs(worksetId);
              }}
              className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-50"
            >
              Refresh
            </button>
          </Explain>
        </div>
      </header>

      <ResumeBanner
        worksetId={worksetId}
        boundBranch={ws.preferredBranch ?? null}
        statuses={statuses}
      />

      <LifecycleStepper
        boundBranch={ws.preferredBranch ?? null}
        onBoundBranchCount={
          ws.preferredBranch
            ? statuses.filter((s) => s.branch === ws.preferredBranch).length
            : 0
        }
        summary={summary}
        onArchive={async () => {
          const memberCount = ws.repoIds.length;
          const ok = await requestConfirm({
            title: 'Archive workset?',
            body: `Reset all ${memberCount} ${memberCount === 1 ? 'repo' : 'repos'} to its default branch with a fresh pull, then hide "${ws.name}" from the active list. Reactivate from the sidebar to bring the workset back (members stay on default).`,
            confirmLabel: 'Reset & archive',
          });
          if (!ok) return;
          // Long-running per-repo loop (fetch + checkout + pull on each
          // member can run 10–60s on a big workset). Two visible signals:
          // a sticky "in progress" toast that's globally visible, plus
          // the Archive button's own busy spinner. Without these, the
          // confirm modal closes and the user sees no movement until
          // archiveWs runs and the view disappears.
          const progressId = pushToast({
            kind: 'info',
            sticky: true,
            message: `Resetting ${memberCount} ${memberCount === 1 ? 'repo' : 'repos'} to default — fetching, switching, pulling…`,
          });
          let outcomes;
          try {
            outcomes = await window.overgit.invoke(
              'workset:resetToDefault',
              { worksetId, cleanupBranch: ws.preferredBranch },
            );
          } catch (err) {
            dismissToast(progressId);
            pushToast({
              kind: 'error',
              message: `Reset failed: ${
                err instanceof Error ? err.message : String(err)
              }. Workset not archived — restart the app if you just updated.`,
              sticky: true,
            });
            return;
          }
          dismissToast(progressId);
          const failed = outcomes.filter((o) => o.result !== 'reset');
          const cleanedCount = outcomes.filter((o) => o.cleanedUpBranch).length;
          const cleanupSuffix = cleanedCount > 0
            ? ` Removed empty branch from ${cleanedCount} ${cleanedCount === 1 ? 'repo' : 'repos'}.`
            : '';
          if (failed.length > 0) {
            const summaryStr = failed
              .map((o) => {
                const name = reposById.get(o.repoId)?.name ?? o.repoId;
                return `${name}: ${o.result}`;
              })
              .join(', ');
            pushToast({
              kind: 'warn',
              message: `Archived. ${failed.length} of ${outcomes.length} ${
                failed.length === 1 ? 'repo' : 'repos'
              } not reset — ${summaryStr}.${cleanupSuffix}`,
              sticky: true,
            });
          } else {
            pushToast({
              kind: 'success',
              message: `Archived. All ${outcomes.length} ${
                outcomes.length === 1 ? 'repo is' : 'repos are'
              } back on default.${cleanupSuffix}`,
            });
          }
          void archiveWs(worksetId);
        }}
      />

      <div className="mb-4 flex gap-1 border-b border-card">
        {(['overview', 'commit'] as const).map((v) => (
          <Explain
            key={v}
            command={v === 'overview' ? '' : 'git status (per repo)'}
            plain={
              v === 'overview'
                ? 'See workset-wide status, PRs, and recent activity at a glance.'
                : 'Stage and commit changes across every dirty repo from one pane.'
            }
          >
            <button
              onClick={() => setView(v)}
              className={`text-xs px-3 py-1.5 -mb-px border-b-2 ${
                view === v
                  ? 'border-accent text-ink'
                  : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {v === 'overview' ? 'Overview' : `Commit${summary.dirty > 0 ? ` (${summary.dirty})` : ''}`}
            </button>
          </Explain>
        ))}
      </div>

      {view === 'commit' ? (
        <WorksetUnifiedCommit worksetId={worksetId} />
      ) : (
        <>

      {/* Overview tiles. Always render so a freshly-created workset
          has visible content while statuses load. */}
      <section className="mb-4 grid grid-cols-2 md:grid-cols-4 gap-2">
        <OverviewTile label="Repos" value={summary.total.toString()} hint={
          summary.loaded < summary.total
            ? `Loading ${summary.loaded}/${summary.total}…`
            : 'all loaded'
        } />
        <OverviewTile
          label="Dirty"
          value={summary.dirty.toString()}
          hint={summary.dirty === 0 ? 'all clean' : 'have local changes'}
          tone={summary.dirty > 0 ? 'warn' : 'muted'}
        />
        <OverviewTile
          label="Ahead / Behind"
          value={`${summary.ahead} / ${summary.behind}`}
          hint="vs upstream"
          tone={summary.ahead + summary.behind > 0 ? 'warn' : 'muted'}
        />
        {summary.inProgress > 0 ? (
          <OverviewTile
            label="In progress"
            value={summary.inProgress.toString()}
            hint={
              summary.conflictedFiles > 0
                ? `${summary.conflictedFiles} conflicted ${
                    summary.conflictedFiles === 1 ? 'file' : 'files'
                  }`
                : 'no conflicts'
            }
            tone="warn"
          />
        ) : (
          <OverviewTile
            label="Branch spread"
            value={
              summary.sortedBranches.length === 0
                ? '—'
                : summary.sortedBranches[0][0]
            }
            hint={
              summary.sortedBranches.length <= 1
                ? `${summary.sortedBranches[0]?.[1] ?? 0} ${
                    (summary.sortedBranches[0]?.[1] ?? 0) === 1 ? 'repo' : 'repos'
                  }`
                : `${summary.sortedBranches.length} different branches`
            }
            tone={summary.sortedBranches.length > 1 ? 'warn' : 'muted'}
          />
        )}
      </section>

      {lastCheckout && lastCheckout.worksetId === worksetId && (() => {
        // Drop failure outcomes whose repo has since landed on the
        // target branch — the user resolved the situation via another
        // path (branch picker, "Create from default", external git)
        // and the stale row would otherwise nag forever.
        const visibleOutcomes = lastCheckout.outcomes.filter((o) => {
          if (o.result === 'switched' || o.result === 'already-on-branch') return true;
          const st = statuses.find((s) => s.repoId === o.repoId);
          return !st || st.branch !== lastCheckout.branch;
        });
        if (visibleOutcomes.length === 0) return null;
        return (
          <section className="mb-6 p-3 rounded-lg bg-card border border-card">
            <div className="text-[10px] uppercase tracking-wide text-ink-faint mb-2">
              Last switch · {lastCheckout.branch}
            </div>
            <ul className="flex flex-col gap-1.5">
              {visibleOutcomes.map((o) => (
                <CheckoutOutcomeRow
                  key={o.repoId}
                  outcome={o}
                  repoName={reposById.get(o.repoId)?.name ?? o.repoId}
                  worksetId={worksetId}
                  branch={lastCheckout.branch}
                />
              ))}
            </ul>
          </section>
        );
      })()}

      {/* PRs only show when gh is installed AND at least one repo
          successfully returned PR data. If every entry errored (no
          GitHub remote, gh not authenticated), we can't *determine*
          PRs — better to hide than misleadingly say "No open PRs". */}
      {cli?.gh && prs.some((p) => p.prs !== null) && (
        <PRSection prs={prs} reposById={reposById} cli={cli} />
      )}

      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[10px] uppercase tracking-wide text-ink-faint">Status</h2>
          {commonBranch && (
            <label
              className="text-[10px] text-ink-faint flex items-center gap-1.5 cursor-pointer hover:text-ink-muted"
              title={`Show worktrees on branches other than ${commonBranch}. Off by default — only worktrees on this workset's branch are relevant to its work.`}
            >
              <input
                type="checkbox"
                checked={showAllWorktrees}
                onChange={(e) => setShowAllWorktrees(e.target.checked)}
                className="accent-accent"
              />
              <span>Show all worktrees</span>
            </label>
          )}
        </div>
        {ws.repoIds.length === 0 && (
          <div className="text-xs text-ink-faint p-3 rounded border border-card bg-card">
            This workset has no repos yet. Click "Edit" to add some.
          </div>
        )}
        <ul className="flex flex-col gap-1">
          {ws.repoIds.map((id) => {
            const repo = reposById.get(id);
            const st = statuses.find((s) => s.repoId === id);
            return (
              <li
                key={id}
                className="flex flex-col gap-1.5 px-3 py-2 rounded border border-card bg-card"
              >
                <div className="flex items-center gap-3">
                  <Explain
                    command=""
                    plain="Open this repo's detail view — Changes, History, Files, Stash, Branches."
                  >
                    <button
                      onClick={() => selectRepo(id)}
                      className="min-w-0 flex-1 text-left hover:underline"
                      title="Open repo detail"
                    >
                      <div className="text-sm font-medium truncate">{repo?.name ?? id}</div>
                      <div className="text-[11px] text-ink-faint truncate font-mono">{repo?.path}</div>
                    </button>
                  </Explain>
                  <StatusCell status={st} />
                  <SyncToCommonBranchButton
                    repoId={id}
                    worksetId={worksetId}
                    currentBranch={st?.branch ?? null}
                    commonBranch={commonBranch}
                  />
                </div>
                <WorktreeList
                  repoId={id}
                  mainPath={repo?.path}
                  commonBranch={commonBranch}
                  showAll={showAllWorktrees}
                />
              </li>
            );
          })}
        </ul>
      </section>

      <ActivitySection
        items={activity}
        reposById={reposById}
        seenAtOpen={seenAtOpen}
        onSelectRepo={selectRepo}
      />
        </>
      )}
    </main>
  );
}

/// Unified commit view across every dirty repo in the workset.
///
/// Goal: one pane to stage and commit instead of clicking into each
/// repo. Each repo gets its own collapsible card with a checklist of
/// changed files; a top "broadcast message" textarea is the default
/// (shared across all selected repos), but each card can opt into a
/// per-repo override when the change story differs.
///
/// Detached-HEAD repos are skipped — committing onto a detached HEAD
/// orphans the commit, same rule the existing WorksetCommitAllSheet
/// follows. Clean repos are not shown.
function WorksetUnifiedCommit({
  worksetId,
}: {
  worksetId: UUID;
}): JSX.Element {
  const repos = useStore((s) => s.repos);
  const statuses = useStore((s) => s.worksetStatuses[worksetId] ?? EMPTY_STATUSES);
  const repoChanges = useStore((s) => s.repoChanges);
  const refreshRepoChanges = useStore((s) => s.refreshRepoChanges);
  const refreshWorksetStatus = useStore((s) => s.refreshWorksetStatus);
  const stage = useStore((s) => s.stageFiles);
  const unstage = useStore((s) => s.unstageFiles);
  const commitRepo = useStore((s) => s.commitRepo);
  const pushToast = useStore((s) => s.pushToast);
  const cli = useStore((s) => s.cliPresence);

  // Inline diff cache, keyed by `${repoId}::${path}`. Populated lazily
  // when the user expands a file row — the workset commit pane defaults
  // to a file list and only fetches diffs for what the user actually
  // wants to inspect, since worksets can have many repos × many files
  // and pre-fetching everything would be wasteful.
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [fileDiffs, setFileDiffs] = useState<Record<string, FileDiff[] | 'loading' | 'error'>>({});
  const fileKey = (repoId: UUID, path: string) => `${repoId}::${path}`;
  const toggleFileExpanded = (repoId: UUID, path: string) => {
    const k = fileKey(repoId, path);
    setExpandedFiles((cur) => {
      const next = new Set(cur);
      if (next.has(k)) {
        next.delete(k);
        return next;
      }
      next.add(k);
      // Fire the diff fetch on first expand. Using `combined` so the
      // body the user sees is the same union of staged + unstaged that
      // a checked file actually commits.
      if (fileDiffs[k] === undefined) {
        setFileDiffs((d) => ({ ...d, [k]: 'loading' }));
        void window.overgit
          .invoke('repo:diffFile', { repoId, path, side: 'combined' })
          .then((files) => setFileDiffs((d) => ({ ...d, [k]: files })))
          .catch(() => setFileDiffs((d) => ({ ...d, [k]: 'error' })));
      }
      return next;
    });
  };

  const dirtyOnBranch = useMemo(
    () => statuses.filter((s) => s.dirtyCount > 0 && s.branch !== null),
    [statuses],
  );
  const dirtyDetached = useMemo(
    () => statuses.filter((s) => s.dirtyCount > 0 && s.branch === null),
    [statuses],
  );
  const reposById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);

  // Pull each dirty repo's file list once on mount, and after each
  // commit run finishes. We don't subscribe to per-keystroke changes —
  // a manual refresh button covers the "I just edited a file" case.
  useEffect(() => {
    for (const s of dirtyOnBranch) void refreshRepoChanges(s.repoId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyOnBranch.map((s) => s.repoId).join(',')]);

  // Per-repo: which file paths to include in this commit. Default: all
  // files for the repo. As files appear (e.g. user edits more), they
  // auto-include — same behavior as ChangesTab simple mode.
  const [checked, setChecked] = useState<Record<UUID, Set<string>>>({});
  useEffect(() => {
    setChecked((cur) => {
      const next: Record<UUID, Set<string>> = {};
      for (const s of dirtyOnBranch) {
        const ch = repoChanges[s.repoId];
        if (!ch) {
          next[s.repoId] = cur[s.repoId] ?? new Set();
          continue;
        }
        const present = new Set<string>();
        for (const f of ch.staged) present.add(f.path);
        for (const f of ch.unstaged) present.add(f.path);
        const prior = cur[s.repoId] ?? new Set();
        const merged = new Set<string>();
        for (const p of prior) if (present.has(p)) merged.add(p);
        for (const p of present) if (!prior.has(p)) merged.add(p);
        next[s.repoId] = merged;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoChanges, dirtyOnBranch.map((s) => s.repoId).join(',')]);

  const [collapsed, setCollapsed] = useState<Set<UUID>>(new Set());
  const toggleCollapsed = (id: UUID) => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const [sharedMessage, setSharedMessage] = useState('');
  const [perRepoMessage, setPerRepoMessage] = useState<Record<UUID, string>>({});
  // When a repo overrides the shared message it appears in this set.
  // Non-overriding repos commit with whatever's in `sharedMessage`.
  const [overrides, setOverrides] = useState<Set<UUID>>(new Set());
  const toggleOverride = (id: UUID) => {
    setOverrides((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  type Outcome =
    | { kind: 'committed' }
    | { kind: 'skipped-empty' }
    | { kind: 'failed'; message: string };
  const [outcomes, setOutcomes] = useState<Record<UUID, Outcome>>({});
  const [busy, setBusy] = useState(false);

  /// True while a refresh fan-out (workset status + per-repo changes
  /// for every dirty member) is in flight. Surfaced in the toolbar so
  /// the user doesn't think they're staring at stale data — the focus
  /// handler fires this silently when they re-enter the window.
  const [refreshing, setRefreshing] = useState(false);
  const runRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshWorksetStatus(worksetId);
      /// Re-read after the status fan-out so we fetch changes for the
      /// *current* dirty set, not whatever the render-time closure of
      /// `dirtyOnBranch` happened to capture. This is what was missing
      /// before — a repo that was already dirty but gained new files
      /// while overgit was backgrounded never had its changes re-pulled
      /// because the effect below keys on the repo-id list, not contents.
      const latest = useStore.getState().worksetStatuses[worksetId] ?? [];
      const dirty = latest.filter((s) => s.dirtyCount > 0 && s.branch !== null);
      await Promise.all(dirty.map((s) => refreshRepoChanges(s.repoId)));
    } finally {
      setRefreshing(false);
    }
  }, [worksetId, refreshWorksetStatus, refreshRepoChanges]);

  /// Refresh on tab focus / window visibility — covers "I edited files
  /// in a terminal while overgit was in the background." A 1.5s coalesce
  /// absorbs the natural focus + visibilitychange double-fire. Also
  /// kicks once on mount so switching to the Commit tab re-reads even
  /// if the global focus handler ran in the last 2s window.
  useEffect(() => {
    let last = 0;
    const COALESCE_MS = 1_500;
    const tick = () => {
      const now = Date.now();
      if (now - last < COALESCE_MS) return;
      last = now;
      void runRefresh();
    };
    tick();
    const onFocus = () => tick();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [runRefresh]);

  // LLM affordances. The list of detected tools comes from cliPresence —
  // we hide the whole bar when no tool is installed so the UI doesn't
  // tease features the user can't reach. State machine mirrors the one
  // in WorksetCommitAllSheet so the affordance behaves identically
  // whether the user invokes it inline or from the sheet.
  const availableTools: LlmTool[] = useMemo(() => {
    const out: LlmTool[] = [];
    if (cli?.claude) out.push('claude');
    if (cli?.codex) out.push('codex');
    if (cli?.gemini) out.push('gemini');
    return out;
  }, [cli]);
  const [tool, setTool] = useState<LlmTool | null>(availableTools[0] ?? null);
  useEffect(() => {
    if (!tool && availableTools.length > 0) setTool(availableTools[0]);
  }, [tool, availableTools]);
  type CliStatus =
    | { kind: 'idle' }
    | { kind: 'drafting'; tool: LlmTool }
    | { kind: 'reviewing'; tool: LlmTool }
    | { kind: 'drafted'; tool: LlmTool }
    | { kind: 'err'; message: string };
  const [cliStatus, setCliStatus] = useState<CliStatus>({ kind: 'idle' });
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [truncated, setTruncated] = useState<WorksetDiffTruncation[]>([]);
  const cliBusy = cliStatus.kind === 'drafting' || cliStatus.kind === 'reviewing';
  useEffect(() => {
    if (cliStatus.kind !== 'drafted') return;
    const t = setTimeout(() => setCliStatus({ kind: 'idle' }), 2500);
    return () => clearTimeout(t);
  }, [cliStatus]);

  const messageFor = (id: UUID) =>
    overrides.has(id) ? perRepoMessage[id] ?? '' : sharedMessage;

  // A repo is committable iff it has at least one checked file AND
  // either a shared or override message that's non-empty.
  const committable = useMemo(() => {
    return dirtyOnBranch.filter((s) => {
      const ck = checked[s.repoId];
      if (!ck || ck.size === 0) return false;
      return messageFor(s.repoId).trim().length > 0;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyOnBranch, checked, sharedMessage, perRepoMessage, overrides]);

  const onCommitAll = async () => {
    if (committable.length === 0) return;
    setBusy(true);
    setOutcomes({});
    try {
      for (const s of committable) {
        const ch = repoChanges[s.repoId];
        if (!ch) {
          setOutcomes((o) => ({ ...o, [s.repoId]: { kind: 'failed', message: 'changes not loaded' } }));
          continue;
        }
        const checkedSet = checked[s.repoId] ?? new Set<string>();
        // Build the union of every changed path so we can sync the
        // index to exactly the checked set — anything checked gets
        // staged, anything not checked but currently in the index gets
        // pulled out. Same idea as ChangesTab simple mode.
        const allPaths = new Set<string>();
        for (const f of ch.staged) allPaths.add(f.path);
        for (const f of ch.unstaged) allPaths.add(f.path);
        const toStage: string[] = [];
        const toUnstage: string[] = [];
        for (const p of allPaths) {
          if (checkedSet.has(p)) toStage.push(p);
          else toUnstage.push(p);
        }
        try {
          if (toUnstage.length > 0) await unstage(s.repoId, toUnstage);
          if (toStage.length > 0) await stage(s.repoId, toStage);
          const res = await commitRepo(s.repoId, messageFor(s.repoId).trim());
          if (!res.ok) {
            setOutcomes((o) => ({
              ...o,
              [s.repoId]: { kind: 'failed', message: res.error ?? 'Commit failed' },
            }));
            continue;
          }
          setOutcomes((o) => ({ ...o, [s.repoId]: { kind: 'committed' } }));
        } catch (err: unknown) {
          setOutcomes((o) => ({
            ...o,
            [s.repoId]: { kind: 'failed', message: String(err) },
          }));
        }
      }
      // After running, refresh the workset + per-repo changes so the
      // pane reflects what's left (clean repos drop off the list).
      await refreshWorksetStatus(worksetId);
      await Promise.all(
        committable.map((s) => refreshRepoChanges(s.repoId)),
      );
    } finally {
      setBusy(false);
    }
  };

  const onDraftMessage = async () => {
    if (!tool || dirtyOnBranch.length === 0) return;
    setCliStatus({ kind: 'drafting', tool });
    try {
      const res = await window.overgit.invoke('workset:suggestCommitMessage', {
        worksetId,
        tool,
      });
      setTruncated(res.truncated);
      if (!res.ok) {
        setCliStatus({ kind: 'err', message: res.error });
        return;
      }
      setSharedMessage(res.message);
      setCliStatus({ kind: 'drafted', tool: res.tool });
    } catch (err: unknown) {
      setCliStatus({ kind: 'err', message: String(err) });
    }
  };

  const onReviewChanges = async () => {
    if (!tool || dirtyOnBranch.length === 0) return;
    setReview(null);
    setCliStatus({ kind: 'reviewing', tool });
    try {
      const res = await window.overgit.invoke('workset:reviewChanges', {
        worksetId,
        tool,
      });
      setTruncated(res.truncated);
      setReview(res);
      setCliStatus({ kind: 'idle' });
    } catch (err: unknown) {
      setCliStatus({ kind: 'err', message: String(err) });
    }
  };

  if (dirtyOnBranch.length === 0 && dirtyDetached.length === 0) {
    return (
      <div className="text-xs text-ink-faint p-4 rounded border border-card bg-card">
        Every repo in this workset is clean — nothing to commit.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="p-3 rounded-lg border border-card bg-card flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="uppercase tracking-wide text-ink-faint">
              Shared commit message
            </span>
            {cliStatus.kind === 'drafting' && (
              <span className="text-ink-faint">
                Drafting with <span className="font-mono">{cliStatus.tool}</span>…
              </span>
            )}
            {cliStatus.kind === 'reviewing' && (
              <span className="text-ink-faint">
                Reviewing with <span className="font-mono">{cliStatus.tool}</span>…
              </span>
            )}
            {cliStatus.kind === 'drafted' && (
              <span className="text-emerald-400">
                ✓ drafted with <span className="font-mono">{cliStatus.tool}</span>
              </span>
            )}
            {cliStatus.kind === 'err' && (
              <span className="text-red-400 truncate" title={cliStatus.message}>
                {cliStatus.message}
              </span>
            )}
          </div>
          <textarea
            value={sharedMessage}
            onChange={(e) => setSharedMessage(e.target.value)}
            disabled={busy}
            rows={3}
            placeholder="Used for every repo below — toggle a repo to write its own message instead"
            className="field px-2 py-1.5 text-sm resize-none"
          />
        </label>
        {availableTools.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-[10px] uppercase tracking-wide text-ink-faint">
              CLI
            </span>
            <div className="flex gap-1">
              {availableTools.map((t) => (
                <button
                  key={t}
                  onClick={() => setTool(t)}
                  disabled={cliBusy}
                  className={`text-[11px] font-mono px-2 py-0.5 rounded border ${
                    tool === t
                      ? 'bg-accent text-white border-accent'
                      : 'border-card hover:bg-surface-elevated'
                  } disabled:opacity-50`}
                >
                  {t}
                </button>
              ))}
            </div>
            <button
              onClick={() => void onDraftMessage()}
              disabled={cliBusy || busy || !tool || dirtyOnBranch.length === 0}
              className={`text-[11px] px-2 py-0.5 rounded border disabled:opacity-50 ${
                cliStatus.kind === 'drafting'
                  ? 'border-accent/60 bg-accent/15 text-accent animate-pulse'
                  : 'border-card hover:bg-surface-elevated'
              }`}
              title="Draft a shared commit message from the aggregated workset diff"
            >
              {cliStatus.kind === 'drafting'
                ? `✨ Drafting with ${cliStatus.tool}…`
                : '✨ Draft message'}
            </button>
            <button
              onClick={() => void onReviewChanges()}
              disabled={cliBusy || busy || !tool || dirtyOnBranch.length === 0}
              className={`text-[11px] px-2 py-0.5 rounded border disabled:opacity-50 ${
                cliStatus.kind === 'reviewing'
                  ? 'border-accent/60 bg-accent/15 text-accent animate-pulse'
                  : 'border-card hover:bg-surface-elevated'
              }`}
              title="Pipe the aggregated workset diff to the CLI for review"
            >
              {cliStatus.kind === 'reviewing'
                ? `Reviewing with ${cliStatus.tool}…`
                : 'Review changes'}
            </button>
            <span className="ml-auto text-[10px] text-ink-faint">
              Aggregates dirty diffs across {dirtyOnBranch.length}{' '}
              {dirtyOnBranch.length === 1 ? 'repo' : 'repos'} into one prompt.
            </span>
          </div>
        )}
        {truncated.length > 0 && (
          <div className="text-[11px] text-amber-400 bg-amber-500/[0.06] border border-amber-700/40 rounded px-3 py-2">
            Diff too large for {truncated.length}{' '}
            {truncated.length === 1 ? 'repo' : 'repos'} — sent shortstat summary
            instead of full diff:{' '}
            {truncated
              .map((t) => `${t.repoName} (${formatBytes(t.originalBytes)})`)
              .join(', ')}
            .
          </div>
        )}
        <div className="flex items-center justify-between gap-2 text-[11px] text-ink-faint">
          <span>
            {committable.length} of {dirtyOnBranch.length} repos ready to commit
            {committable.length < dirtyOnBranch.length && ' — check files and add a message for the rest'}
          </span>
          <div className="flex gap-2 items-center">
            {refreshing && (
              <span
                className="flex items-center gap-1 text-[11px] text-accent"
                aria-live="polite"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  className="animate-spin"
                  aria-hidden
                >
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" fill="none" />
                  <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
                </svg>
                Refreshing…
              </span>
            )}
            <button
              onClick={() => void runRefresh()}
              disabled={busy || refreshing}
              className="text-[11px] px-2 py-1 rounded border border-card hover:bg-surface-elevated disabled:opacity-50"
            >
              Refresh
            </button>
            <button
              onClick={() => void onCommitAll()}
              disabled={busy || committable.length === 0}
              className="text-xs px-3 py-1 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
            >
              {busy
                ? 'Committing…'
                : `Commit ${committable.length} ${committable.length === 1 ? 'repo' : 'repos'}`}
            </button>
          </div>
        </div>
      </section>

      {review && (
        <section className="p-3 rounded-lg border border-card bg-card flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-ink-faint">
              Review
            </span>
            <button
              onClick={() => setReview(null)}
              className="text-ink-faint hover:text-ink text-xs"
              title="Dismiss review"
            >
              ✕
            </button>
          </div>
          <ReviewBody result={review} />
        </section>
      )}

      {dirtyDetached.length > 0 && (
        <div className="text-[11px] text-amber-400 bg-amber-500/[0.06] border border-amber-700/40 rounded px-3 py-2">
          Skipping {dirtyDetached.length} detached-HEAD{' '}
          {dirtyDetached.length === 1 ? 'repo' : 'repos'} —{' '}
          {dirtyDetached.map((s) => reposById.get(s.repoId)?.name ?? s.repoId).join(', ')}.
          Committing onto detached HEAD orphans the commit; resolve
          manually.
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {dirtyOnBranch.map((s) => {
          const repo = reposById.get(s.repoId);
          const ch = repoChanges[s.repoId];
          const allFiles: ChangedFile[] = ch
            ? (() => {
                const map = new Map<string, ChangedFile>();
                for (const f of ch.staged) map.set(f.path, f);
                for (const f of ch.unstaged) map.set(f.path, f);
                return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
              })()
            : [];
          const ck = checked[s.repoId] ?? new Set<string>();
          const outcome = outcomes[s.repoId];
          const isCollapsed = collapsed.has(s.repoId);
          const overrideOn = overrides.has(s.repoId);

          const allChecked = allFiles.length > 0 && allFiles.every((f) => ck.has(f.path));
          const noneChecked = ck.size === 0;
          const toggleAll = () => {
            setChecked((cur) => {
              const next = { ...cur };
              if (allChecked) next[s.repoId] = new Set();
              else next[s.repoId] = new Set(allFiles.map((f) => f.path));
              return next;
            });
          };
          const toggleOne = (p: string) => {
            setChecked((cur) => {
              const next = { ...cur };
              const set = new Set(next[s.repoId] ?? []);
              if (set.has(p)) set.delete(p);
              else set.add(p);
              next[s.repoId] = set;
              return next;
            });
          };

          return (
            <li
              key={s.repoId}
              className="rounded-lg border border-card bg-card flex flex-col"
            >
              <header className="flex items-center gap-2 px-3 py-2">
                <button
                  onClick={() => toggleCollapsed(s.repoId)}
                  className="text-ink-faint hover:text-ink text-xs w-4"
                  title={isCollapsed ? 'Expand' : 'Collapse'}
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {repo?.name ?? s.repoId}
                  </div>
                  <div className="text-[11px] text-ink-faint truncate font-mono">
                    {s.branch} · {ck.size}/{allFiles.length} checked
                  </div>
                </div>
                {outcome?.kind === 'committed' && (
                  <span className="font-mono text-[11px] text-emerald-400">committed</span>
                )}
                {outcome?.kind === 'failed' && (
                  <span
                    className="font-mono text-[11px] text-red-400 truncate max-w-[40%]"
                    title={outcome.message}
                  >
                    failed: {outcome.message}
                  </span>
                )}
                <label
                  className="flex items-center gap-1 text-[11px] text-ink-muted cursor-pointer"
                  title="Write a different commit message just for this repo"
                >
                  <input
                    type="checkbox"
                    checked={overrideOn}
                    onChange={() => toggleOverride(s.repoId)}
                    disabled={busy}
                  />
                  own message
                </label>
              </header>

              {!isCollapsed && (
                <div className="px-3 pb-3 flex flex-col gap-2">
                  {overrideOn && (
                    <textarea
                      value={perRepoMessage[s.repoId] ?? ''}
                      onChange={(e) =>
                        setPerRepoMessage((cur) => ({ ...cur, [s.repoId]: e.target.value }))
                      }
                      disabled={busy}
                      rows={2}
                      placeholder={`Commit message for ${repo?.name ?? 'this repo'}`}
                      className="field px-2 py-1.5 text-xs resize-none"
                    />
                  )}
                  {!ch && (
                    <div className="text-[11px] text-ink-faint">Loading changes…</div>
                  )}
                  {ch && allFiles.length === 0 && (
                    <div className="text-[11px] text-ink-faint">No changed files.</div>
                  )}
                  {ch && allFiles.length > 0 && (
                    <>
                      <div className="flex items-center gap-2 text-[11px]">
                        <button
                          onClick={toggleAll}
                          disabled={busy}
                          className="px-2 py-0.5 rounded border border-card hover:bg-surface-elevated disabled:opacity-50"
                        >
                          {allChecked ? 'Uncheck all' : noneChecked ? 'Check all' : 'Check all'}
                        </button>
                        <span className="text-ink-faint">
                          {ck.size} of {allFiles.length} files included
                        </span>
                      </div>
                      <ul className="flex flex-col">
                        {allFiles.map((f) => {
                          const k = fileKey(s.repoId, f.path);
                          const fileExpanded = expandedFiles.has(k);
                          const diff = fileDiffs[k];
                          return (
                            <li key={f.path} className="flex flex-col">
                              <div className="flex items-center gap-2 py-0.5 text-[12px]">
                                <input
                                  type="checkbox"
                                  checked={ck.has(f.path)}
                                  onChange={() => toggleOne(f.path)}
                                  disabled={busy}
                                />
                                <UnifiedFileBadge file={f} />
                                <button
                                  onClick={() => toggleFileExpanded(s.repoId, f.path)}
                                  className="font-mono truncate text-left hover:underline min-w-0 flex-1"
                                  title={`${f.path} — click to ${fileExpanded ? 'hide' : 'show'} diff`}
                                >
                                  {f.path}
                                </button>
                                {f.origPath && (
                                  <span className="text-[11px] text-ink-faint italic truncate">
                                    ← {f.origPath}
                                  </span>
                                )}
                                <span className="text-[10px] text-ink-faint w-3 text-right">
                                  {fileExpanded ? '▾' : '▸'}
                                </span>
                              </div>
                              {fileExpanded && (
                                <div className="ml-6 my-1">
                                  {diff === undefined || diff === 'loading' ? (
                                    <div className="text-[11px] text-ink-faint px-3 py-2 border border-card rounded bg-card/40">
                                      Loading diff…
                                    </div>
                                  ) : diff === 'error' ? (
                                    <div className="text-[11px] text-red-400 px-3 py-2 border border-red-500/30 rounded bg-red-500/[0.06]">
                                      Failed to load diff for {f.path}
                                    </div>
                                  ) : diff.length === 0 ? (
                                    <div className="text-[11px] text-ink-faint px-3 py-2 border border-card rounded bg-card/40">
                                      No diff body — likely a binary or rename-only change.
                                    </div>
                                  ) : (
                                    diff.map((fd) => (
                                      <FileDiffBlock key={fd.path} file={fd} />
                                    ))
                                  )}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function UnifiedFileBadge({ file }: { file: ChangedFile }): JSX.Element {
  const ch =
    file.indexStatus !== ' ' && file.indexStatus !== '?'
      ? file.indexStatus
      : file.worktreeStatus;
  const map: Record<string, string> = {
    A: 'bg-emerald-500/20 text-emerald-300',
    M: 'bg-amber-500/20 text-amber-300',
    D: 'bg-red-500/20 text-red-300',
    R: 'bg-sky-500/20 text-sky-300',
    C: 'bg-sky-500/20 text-sky-300',
    '?': 'bg-card text-ink-muted',
  };
  const cls = map[ch] ?? 'bg-card text-ink-muted';
  return (
    <span className={`inline-block px-1.5 rounded text-[10px] font-mono ${cls}`}>
      {ch === '?' ? 'U' : ch}
    </span>
  );
}

function OverviewTile({
  label,
  value,
  hint,
  tone = 'muted',
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'muted' | 'warn';
}): JSX.Element {
  return (
    <div className="p-3 rounded-lg border border-card bg-card">
      <div className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div
        className={`text-lg font-mono mt-0.5 truncate ${
          tone === 'warn' ? 'text-amber-300' : 'text-ink'
        }`}
        title={value}
      >
        {value}
      </div>
      <div className="text-[10px] text-ink-faint mt-0.5">{hint}</div>
    </div>
  );
}

/// "Pick up where you left off" banner. Shows when entering a workset
/// whose bound branch differs from where its members currently are. One
/// click runs `workset:checkoutBranch` across all members; per-repo
/// outcomes (dirty / missing-branch / etc) surface in the existing
/// `lastCheckout` table below the overview, where the user can stash &
/// retry, commit & retry, or skip.
function ResumeBanner({
  worksetId,
  boundBranch,
  statuses,
}: {
  worksetId: UUID;
  boundBranch: string | null;
  statuses: RepoStatus[];
}): JSX.Element | null {
  const resume = useStore((s) => s.resumeWorksetBranch);
  const [busy, setBusy] = useState(false);
  if (!boundBranch || statuses.length === 0) return null;
  const drifters = statuses.filter((s) => s.branch !== boundBranch);
  if (drifters.length === 0) return null;
  const all = drifters.length === statuses.length;
  const summary = all
    ? `All ${statuses.length} ${statuses.length === 1 ? 'repo is' : 'repos are'} on a different branch.`
    : `${drifters.length} of ${statuses.length} repos drifted off this branch.`;
  return (
    <section className="mb-3 px-3 py-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 flex items-center gap-3">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 text-amber-400">
        <path
          d="M8 1.5l6.5 11.25H1.5L8 1.5z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path d="M8 6v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="8" cy="11.5" r="0.6" fill="currentColor" />
      </svg>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-ink">Pick up where you left off</div>
        <div className="text-[11px] text-ink-faint truncate">
          {summary} Resume to checkout{' '}
          <span className="font-mono text-ink-muted">{boundBranch}</span> across them.
        </div>
      </div>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await resume(worksetId, boundBranch);
          } finally {
            setBusy(false);
          }
        }}
        className="shrink-0 text-xs px-3 py-1.5 rounded bg-amber-500/90 text-white hover:bg-amber-500 disabled:opacity-50 inline-flex items-center gap-1.5"
        title={`Checkout ${boundBranch} across the ${drifters.length} drifted ${drifters.length === 1 ? 'repo' : 'repos'}. Dirty repos surface inline so you can stash, commit, or skip per-repo.`}
      >
        {busy && (
          <svg width="11" height="11" viewBox="0 0 24 24" className="animate-spin" aria-hidden>
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" fill="none" />
            <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
          </svg>
        )}
        <span>{busy ? 'Resuming…' : 'Resume'}</span>
      </button>
    </section>
  );
}

/// Workset lifecycle stepper. Reads cleanly left-to-right as the four
/// states a workset moves through: Branch (every member on the bound
/// branch) → Commit (all working trees clean) → Push (all pushed to
/// upstream) → Archive (work shipped, hide from active list).
///
/// Each step is "met" when its predecessor is met AND its own condition
/// holds. That ordering means the stepper reads as a progress bar rather
/// than four independent green-lights, which matches the actual workflow.
///
/// Branch step is strict: it requires `boundBranch` to be set AND every
/// loaded member to be on it. A single drifter is what surfaces here — by
/// design, since the per-row Sync button is the recovery affordance.
function LifecycleStepper({
  boundBranch,
  onBoundBranchCount,
  summary,
  onArchive,
}: {
  boundBranch: string | null;
  onBoundBranchCount: number;
  summary: { dirty: number; ahead: number; needsFirstPush: number; loaded: number };
  onArchive: () => Promise<void> | void;
}): JSX.Element {
  const [archiving, setArchiving] = useState(false);
  const branchMet =
    boundBranch !== null &&
    summary.loaded > 0 &&
    onBoundBranchCount === summary.loaded;
  const commitMet = branchMet && summary.dirty === 0;
  const pushMet =
    commitMet && summary.ahead === 0 && summary.needsFirstPush === 0;
  const canArchive = pushMet;

  const branchHint = !boundBranch
    ? 'No branch bound — Edit to set'
    : summary.loaded === 0
      ? boundBranch
      : onBoundBranchCount === summary.loaded
        ? boundBranch
        : `${onBoundBranchCount}/${summary.loaded} on ${boundBranch}`;
  const commitHint = !branchMet
    ? 'Branch first'
    : summary.dirty > 0
      ? `${summary.dirty} dirty`
      : 'all clean';
  const pushHint = !commitMet
    ? 'Commit first'
    : summary.ahead > 0 && summary.needsFirstPush > 0
      ? `${summary.ahead} ahead · ${summary.needsFirstPush} unpushed`
      : summary.ahead > 0
        ? `${summary.ahead} ahead`
        : summary.needsFirstPush > 0
          ? `${summary.needsFirstPush} ${summary.needsFirstPush === 1 ? 'branch' : 'branches'} unpushed`
          : 'all pushed';

  return (
    <section className="mb-4 px-3 py-2.5 rounded-lg border border-card bg-card/40 flex items-center gap-3">
      <Step label="Branch" met={branchMet} hint={branchHint} />
      <StepConnector met={commitMet} />
      <Step label="Commit" met={commitMet} hint={commitHint} />
      <StepConnector met={pushMet} />
      <Step label="Push" met={pushMet} hint={pushHint} />
      <StepConnector met={canArchive} />
      <button
        onClick={async () => {
          if (archiving) return;
          setArchiving(true);
          try {
            await onArchive();
          } finally {
            setArchiving(false);
          }
        }}
        disabled={!canArchive || archiving}
        title={
          archiving
            ? 'Resetting members to default and archiving…'
            : canArchive
              ? 'Archive — reset every member to default with a fresh pull, then hide from the active list (reversible)'
              : 'Branch, commit, and push everywhere before archiving'
        }
        className={`text-xs px-3 py-1.5 rounded font-medium inline-flex items-center gap-1.5 ${
          archiving
            ? 'bg-emerald-600/70 text-white cursor-wait'
            : canArchive
              ? 'bg-emerald-600 text-white hover:bg-emerald-500'
              : 'bg-card text-ink-faint cursor-not-allowed'
        }`}
      >
        {archiving && (
          <svg width="11" height="11" viewBox="0 0 24 24" className="animate-spin" aria-hidden>
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" fill="none" />
            <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
          </svg>
        )}
        <span>{archiving ? 'Archiving…' : 'Archive'}</span>
      </button>
    </section>
  );
}

function Step({
  label,
  met,
  hint,
}: {
  label: string;
  met: boolean;
  hint: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span
        className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold ${
          met
            ? 'bg-emerald-600 text-white'
            : 'bg-card border border-card text-ink-faint'
        }`}
      >
        {met ? '✓' : '·'}
      </span>
      <div className="flex flex-col min-w-0">
        <span className={`text-xs font-medium ${met ? 'text-ink' : 'text-ink-muted'}`}>
          {label}
        </span>
        <span className="text-[10px] text-ink-faint truncate" title={hint}>
          {hint}
        </span>
      </div>
    </div>
  );
}

function StepConnector({ met }: { met: boolean }): JSX.Element {
  return (
    <span
      className={`flex-1 h-px ${met ? 'bg-emerald-600/60' : 'bg-card'}`}
      aria-hidden
    />
  );
}

function CheckoutOutcomeRow({
  outcome,
  repoName,
  worksetId,
  branch,
}: {
  outcome: CheckoutOutcome;
  repoName: string;
  /// Optional context: when present, a `missing-branch` row gets a
  /// "Create from default" action that runs the sync-and-branch flow
  /// (fetch → switch default → pull → create branch) for just this repo.
  worksetId?: UUID;
  branch?: string;
}): JSX.Element {
  const stash = useStore((s) => s.stashRepo);
  const commitAll = useStore((s) => s.commitAllRepo);
  const retry = useStore((s) => s.retryCheckoutRepo);
  const adopt = useStore((s) => s.adoptWorktreeBranch);
  const pushToast = useStore((s) => s.pushToast);
  const refreshWs = useStore((s) => s.refreshWorksetStatus);

  const [showCommit, setShowCommit] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  // Local override so that after a successful "Create from default" the
  // row updates in place — the lastCheckout entry stored in the renderer
  // is frozen, so we can't mutate it from here without restructuring
  // the whole shape. Local state is the cheapest way to reflect the
  // new state for just this row.
  const [createdResult, setCreatedResult] = useState<
    { kind: 'idle' } | { kind: 'creating' } | { kind: 'done'; ok: boolean; label: string; message?: string }
  >({ kind: 'idle' });

  const onStash = async () => {
    setBusy(true);
    try {
      const res = await stash(outcome.repoId);
      if (!res.ok) {
        pushToast({ kind: 'error', message: res.error ?? 'Stash failed' });
        return;
      }
      await retry(outcome.repoId);
    } finally {
      setBusy(false);
    }
  };

  const onCommit = async () => {
    if (!message.trim()) return;
    setBusy(true);
    try {
      const res = await commitAll(outcome.repoId, message.trim());
      if (!res.ok) {
        pushToast({ kind: 'error', message: res.error ?? 'Commit failed' });
        return;
      }
      setShowCommit(false);
      setMessage('');
      await retry(outcome.repoId);
    } finally {
      setBusy(false);
    }
  };

  const onAdopt = async () => {
    if (outcome.result !== 'worktree-conflict' || !outcome.worktreePath) return;
    setBusy(true);
    try {
      const res = await adopt(
        outcome.repoId,
        outcome.worktreePath,
        outcome.branch,
        false,
        undefined,
      );
      if (!res.ok) {
        pushToast({
          kind: 'error',
          message:
            res.step === 'precheck'
              ? res.error
              : `Adopt failed (${res.step}): ${res.error}`,
        });
        return;
      }
      // Adopt already ran `git switch` in the main repo. Retry to refresh
      // the row and let the rest of the workset status catch up.
      await retry(outcome.repoId);
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async () => {
    if (!branch) return;
    setCreatedResult({ kind: 'creating' });
    const res = await window.overgit.invoke('workset:syncMemberToBranch', {
      repoId: outcome.repoId,
      branch,
    });
    if ('result' in res && res.result === 'created') {
      setCreatedResult({
        kind: 'done',
        ok: true,
        label: 'created',
        message: 'message' in res ? res.message : undefined,
      });
      if (worksetId) await refreshWs(worksetId);
    } else {
      setCreatedResult({
        kind: 'done',
        ok: false,
        label: res.result,
        message: 'message' in res ? res.message : undefined,
      });
    }
  };

  return (
    <li className="text-[11px] flex flex-col gap-1">
      <div className="flex gap-2 items-center">
        <span className="text-ink-faint w-40 truncate">{repoName}</span>
        {createdResult.kind === 'idle' && <CheckoutBadge outcome={outcome} />}
        {createdResult.kind === 'creating' && (
          <span className="text-ink-faint font-mono inline-flex items-center gap-1.5">
            <svg width="10" height="10" viewBox="0 0 24 24" className="animate-spin" aria-hidden>
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" fill="none" />
              <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
            </svg>
            creating…
          </span>
        )}
        {createdResult.kind === 'done' && (
          <span className={`font-mono ${createdResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {createdResult.label}
          </span>
        )}
        {createdResult.kind === 'idle' && outcome.message && (
          <span className="text-ink-faint truncate flex-1">— {outcome.message}</span>
        )}
        {createdResult.kind === 'done' && createdResult.message && (
          <span className="text-ink-faint truncate flex-1">— {createdResult.message}</span>
        )}
        {createdResult.kind === 'idle' && outcome.result === 'dirty' && !showCommit && (
          <div className="flex gap-1">
            <button
              disabled={busy}
              onClick={onStash}
              className="px-2 py-0.5 rounded border border-card hover:bg-card disabled:opacity-50"
            >
              Stash & retry
            </button>
            <button
              disabled={busy}
              onClick={() => setShowCommit(true)}
              className="px-2 py-0.5 rounded border border-card hover:bg-card disabled:opacity-50"
            >
              Commit & retry
            </button>
          </div>
        )}
        {createdResult.kind === 'idle' && outcome.result === 'missing-branch' && branch && (
          <button
            onClick={onCreate}
            title={`Fetch, switch this repo to its default branch, pull, then create ${branch} off it`}
            className="px-2 py-0.5 rounded border border-card hover:bg-card"
          >
            Create from default
          </button>
        )}
        {createdResult.kind === 'idle' &&
          outcome.result === 'worktree-conflict' &&
          outcome.worktreePath && (
            <button
              disabled={busy}
              onClick={onAdopt}
              title={`Remove the worktree at ${outcome.worktreePath} and check out ${outcome.branch} here.`}
              className="px-2 py-0.5 rounded border border-card hover:bg-card disabled:opacity-50"
            >
              {busy ? 'Adopting…' : 'Adopt & retry'}
            </button>
          )}
      </div>
      {outcome.result === 'dirty' && showCommit && (
        <div className="flex gap-1 ml-40 pl-2">
          <input
            autoFocus
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="commit message"
            className="field flex-1 px-2 py-1 text-[11px]"
          />
          <button
            disabled={busy || !message.trim()}
            onClick={onCommit}
            className="px-2 py-1 rounded bg-accent text-white text-[11px] hover:bg-accent-strong disabled:opacity-50"
          >
            Commit
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setShowCommit(false);
              setMessage('');
            }}
            className="px-2 py-1 rounded border border-card text-[11px] hover:bg-card disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

function PRSection({
  prs,
  reposById,
  cli,
}: {
  prs: RepoPRs[];
  reposById: Map<UUID, { name: string }>;
  cli: CliPresence | null;
}): JSX.Element {
  const flat: { repoId: UUID; repoName: string; pr: PullRequest }[] = [];
  for (const entry of prs) {
    if (!entry.prs) continue;
    const repoName = reposById.get(entry.repoId)?.name ?? entry.repoId;
    for (const pr of entry.prs) flat.push({ repoId: entry.repoId, repoName, pr });
  }
  flat.sort((a, b) => (a.pr.updatedAt < b.pr.updatedAt ? 1 : -1));
  const errored = prs.filter((p) => p.error && p.prs === null);

  return (
    <section className="mb-6">
      <h2 className="text-[10px] uppercase tracking-wide text-ink-faint mb-2">
        Open pull requests
      </h2>
      {!cli?.gh ? (
        <div className="text-[11px] text-ink-faint p-3 rounded border border-card bg-card">
          Install <span className="font-mono">gh</span> to surface PRs across the workset.
        </div>
      ) : flat.length === 0 ? (
        <div className="text-[11px] text-ink-faint p-3 rounded border border-card bg-card">
          No open PRs in this workset.
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {flat.map(({ repoId, repoName, pr }) => (
            <li
              key={`${repoId}:${pr.number}`}
              className="flex items-center gap-3 px-3 py-2 rounded border border-card bg-card text-xs"
            >
              <span className="text-ink-faint w-40 truncate">{repoName}</span>
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="font-medium hover:underline truncate flex-1"
              >
                #{pr.number} {pr.title}
              </a>
              {pr.isDraft && (
                <span className="text-[10px] uppercase font-mono text-ink-faint">
                  draft
                </span>
              )}
              <span className="text-[11px] text-ink-faint font-mono">
                {pr.headBranch} → {pr.baseBranch}
              </span>
              <span className="text-[11px] text-ink-faint">{pr.author}</span>
            </li>
          ))}
        </ul>
      )}
      {errored.length > 0 && cli?.gh && (
        <p className="text-[10px] text-ink-faint mt-1">
          {errored.length} {errored.length === 1 ? 'repo' : 'repos'} skipped (no
          GitHub remote or gh not authenticated).
        </p>
      )}
    </section>
  );
}

/// "Recent" feed across the workset. Merges commits and PR events
/// into one timeline (see WorksetActivity in shared/types.ts) and
/// flags rows newer than the user's last visit with a small dot. We
/// don't paginate — the backend caps the per-repo log length, which
/// already keeps the list short for the workset sizes overgit
/// targets.
function ActivitySection({
  items,
  reposById,
  seenAtOpen,
  onSelectRepo,
}: {
  items: WorksetActivity[];
  reposById: Map<UUID, Repo>;
  seenAtOpen: string | null;
  onSelectRepo: (id: UUID) => void;
}): JSX.Element | null {
  if (items.length === 0) return null;
  // Cap rendered rows. The backend can return up to N×perRepo commits
  // plus PRs, which is a lot of DOM if a workset has 20 repos.
  // Recent is a glance — scoped to a small window so it doesn't crowd
  // the Status section above it.
  const MAX = 20;
  const visible = items.slice(0, MAX);
  const newSinceLast = seenAtOpen
    ? items.filter((it) => it.at > seenAtOpen).length
    : items.length;

  return (
    <section className="mb-6">
      <h2 className="text-[10px] uppercase tracking-wide text-ink-faint mb-2 flex items-center gap-2">
        <span>Recent</span>
        {newSinceLast > 0 && (
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/20 text-accent"
            title={
              seenAtOpen
                ? `Since you last looked (${formatDateRelative(seenAtOpen)})`
                : 'Since first opening this workset'
            }
          >
            {newSinceLast} new
          </span>
        )}
      </h2>
      <ul className="flex flex-col gap-1">
        {visible.map((it) => (
          <li
            key={
              it.kind === 'commit'
                ? `c:${it.repoId}:${it.sha}`
                : `p:${it.repoId}:${it.number}`
            }
            className="flex items-center gap-3 px-3 py-1.5 rounded border border-card bg-card text-xs"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                seenAtOpen && it.at > seenAtOpen ? 'bg-accent' : 'bg-transparent'
              }`}
              aria-hidden
            />
            <button
              onClick={() => onSelectRepo(it.repoId)}
              className="text-ink-faint w-32 truncate text-left hover:text-ink"
              title={reposById.get(it.repoId)?.path ?? ''}
            >
              {it.repoName}
            </button>
            {it.kind === 'commit' ? (
              <>
                <span className="font-mono text-[10px] text-ink-faint shrink-0">
                  {it.shortSha}
                </span>
                <span className="truncate flex-1" title={it.subject}>
                  {it.subject}
                </span>
                <span className="text-[10px] text-ink-faint shrink-0 truncate max-w-[160px]">
                  {it.author}
                </span>
              </>
            ) : (
              <>
                <span className="font-mono text-[10px] text-ink-faint shrink-0">
                  PR #{it.number}
                </span>
                <a
                  href={it.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate flex-1 hover:underline"
                  title={it.title}
                >
                  {it.title}
                </a>
                <span className="text-[10px] font-mono shrink-0 text-ink-faint">
                  {it.state.toLowerCase()}
                </span>
              </>
            )}
            <span className="text-[10px] text-ink-faint shrink-0 w-16 text-right">
              {formatDateRelative(it.at)}
            </span>
          </li>
        ))}
      </ul>
      {items.length > visible.length && (
        <p className="text-[10px] text-ink-faint mt-1">
          {items.length - visible.length} older items hidden.
        </p>
      )}
    </section>
  );
}

/// Tiny relative-time helper, scoped to this file. Avoids pulling in
/// dayjs/date-fns just for one row format.
function formatDateRelative(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toISOString().slice(0, 10);
}

/// Inline list of *additional* git worktrees for a repo. Hidden when
/// the repo has only one worktree (the common case) so we don't waste
/// screen real-estate. The main worktree is omitted from the rendered
/// list because it's already represented by the row this lives under;
/// showing it again is redundant and confusing.
///
/// In a workset, by default the list filters to worktrees whose branch
/// matches the workset's `commonBranch` — anything else is unrelated
/// work and just adds noise to the "what's in flight here" view. The
/// caller flips `showAll` (a section-level toggle) when the user wants
/// every worktree regardless of branch.
function WorktreeList({
  repoId,
  mainPath,
  commonBranch,
  showAll,
}: {
  repoId: UUID;
  mainPath: string | undefined;
  commonBranch: string | null;
  showAll: boolean;
}): JSX.Element | null {
  const wts = useStore((s) => s.worksetWorktrees[repoId] ?? EMPTY_WORKTREES);
  const siblings = useMemo(() => wts.filter((w) => !w.isMain), [wts]);
  const visible = useMemo(() => {
    if (showAll || !commonBranch) return siblings;
    return siblings.filter((w) => w.branch === commonBranch);
  }, [siblings, showAll, commonBranch]);
  if (siblings.length === 0) return null;
  if (visible.length === 0) {
    // The repo has worktrees, but none on the workset's branch. Tell the
    // user the row is intentionally empty (vs. broken) so they know the
    // toggle exists.
    return (
      <ul className="flex flex-col gap-0.5 pl-3 border-l border-card ml-1">
        <li className="text-[10px] text-ink-faint italic">
          {siblings.length} other {siblings.length === 1 ? 'worktree' : 'worktrees'} hidden — toggle "Show all" to view
        </li>
      </ul>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5 pl-3 border-l border-card ml-1">
      <li className="text-[10px] uppercase tracking-wide text-ink-faint">
        {visible.length} {showAll || !commonBranch ? '' : 'matching '}
        {visible.length === 1 ? 'worktree' : 'worktrees'}
        {!showAll && commonBranch && visible.length < siblings.length && (
          <span className="ml-1 normal-case tracking-normal text-ink-faint/70">
            ({siblings.length - visible.length} hidden)
          </span>
        )}
      </li>
      {visible.map((w) => (
        <li
          key={w.path}
          className="flex items-center gap-2 text-[11px] text-ink-faint font-mono"
          title={w.path}
        >
          <span className="text-ink-faint/60">└</span>
          <span className="truncate flex-1">
            {mainPath && w.path.startsWith(mainPath) ? '.' + w.path.slice(mainPath.length) : w.path}
          </span>
          <span className={w.branch ? 'text-ink-muted' : 'text-amber-400'}>
            {w.branch ?? '(detached)'}
          </span>
          {w.locked && <span className="text-amber-400" title="git worktree lock">🔒</span>}
          {w.prunable && (
            <span className="text-red-400" title="missing on disk — git worktree prune">✗</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/// Compact "Sync to <branch>" action shown next to a repo whose
/// current branch differs from the workset's common branch. Runs the
/// fetch → switch default → pull → create/checkout flow for that one
/// repo and refreshes status when done.
function SyncToCommonBranchButton({
  repoId,
  worksetId,
  currentBranch,
  commonBranch,
}: {
  repoId: UUID;
  worksetId: UUID;
  currentBranch: string | null;
  commonBranch: string | null;
}): JSX.Element | null {
  const refresh = useStore((s) => s.refreshWorksetStatus);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SyncAndBranchOutcome | null>(null);
  if (!commonBranch) return null;
  if (currentBranch === commonBranch) return null;
  return (
    <div className="flex items-center gap-2 shrink-0">
      <Explain
        command={`git fetch && git checkout ${commonBranch} && git pull`}
        plain={`Fetch, switch this repo to ${commonBranch}, and pull the latest commits.`}
      >
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setOutcome(null);
            try {
              const res = await window.overgit.invoke('workset:syncMemberToBranch', {
                repoId,
                branch: commonBranch,
              });
              if ('repoId' in res) setOutcome(res);
              await refresh(worksetId);
            } finally {
              setBusy(false);
            }
          }}
          title={`Fetch, sync default, pull, then check out ${commonBranch} in this repo`}
          className="text-[10px] px-2 py-1 rounded border border-card hover:bg-card disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {busy && (
            <svg width="10" height="10" viewBox="0 0 24 24" className="animate-spin" aria-hidden>
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" fill="none" />
              <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
            </svg>
          )}
          <span>{busy ? 'Syncing…' : `Sync to ${commonBranch}`}</span>
        </button>
      </Explain>
      {outcome && outcome.result !== 'created' && (
        <span
          className="text-[10px] text-amber-400 max-w-[200px] truncate"
          title={outcome.message ?? outcome.result}
        >
          {outcome.result}
        </span>
      )}
    </div>
  );
}

function StatusCell({ status }: { status?: RepoStatus }): JSX.Element {
  if (!status) return <span className="text-[11px] text-ink-faint">…</span>;
  if (status.error) {
    return <span className="text-[11px] text-red-400">{status.error}</span>;
  }
  return (
    <div className="flex items-center gap-3 text-[11px]">
      <span className="font-mono">{status.branch ?? '(detached)'}</span>
      {status.inProgress && (
        <span
          className="text-amber-300 font-mono"
          title={`${status.inProgress} in progress${
            status.conflicts.length > 0
              ? ` · ${status.conflicts.length} conflicted ${
                  status.conflicts.length === 1 ? 'file' : 'files'
                }`
              : ''
          }`}
        >
          {status.inProgress}
          {status.conflicts.length > 0 ? ` · ${status.conflicts.length}⚠` : ''}
        </span>
      )}
      {status.dirtyCount > 0 && (
        <span className="text-amber-400">{status.dirtyCount} dirty</span>
      )}
      {status.ahead !== null && status.ahead > 0 && (
        <span className="text-emerald-400">↑{status.ahead}</span>
      )}
      {status.behind !== null && status.behind > 0 && (
        <span className="text-sky-400">↓{status.behind}</span>
      )}
    </div>
  );
}

function CheckoutBadge({ outcome }: { outcome: CheckoutOutcome }): JSX.Element {
  const styles: Record<CheckoutOutcome['result'], string> = {
    switched: 'text-emerald-400',
    'already-on-branch': 'text-ink-muted',
    'missing-branch': 'text-amber-400',
    dirty: 'text-amber-400',
    'worktree-conflict': 'text-amber-400',
    error: 'text-red-400',
  };
  return <span className={`font-mono ${styles[outcome.result]}`}>{outcome.result}</span>;
}

function cliSummary(cli: CliPresence | null): string {
  if (!cli) return 'detecting…';
  const parts: string[] = [];
  if (cli.gh) parts.push('gh');
  if (cli.glab) parts.push('glab');
  if (cli.jj) parts.push('jj');
  return parts.length ? parts.join(', ') : 'none';
}
