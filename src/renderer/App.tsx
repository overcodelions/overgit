import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { RepoDetail } from './RepoDetail';
import { TitleBar } from './TitleBar';
import { SheetHost } from './Sheets';
import { CommandPalette } from './CommandPalette';
import type {
  CheckoutOutcome,
  CliPresence,
  PullRequest,
  Repo,
  RepoPRs,
  RepoStatus,
  UUID,
  Workspace,
  WorkspaceActivity,
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
const EMPTY_ACTIVITY: WorkspaceActivity[] = [];

export function App(): JSX.Element {
  const { loaded, hydrate } = useStore();
  const sidebarVisible = useStore((s) => s.settings.sidebarVisible);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useGlobalShortcuts();

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
      <SheetHost />
      <CommandPalette />
      <ConfirmHost />
      <ToastHost />
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
      <div className="bg-surface-elevated border border-card rounded-lg shadow-2xl w-[440px] max-w-[92vw] overflow-hidden">
        <div className="px-5 py-3 border-b border-card">
          <h2 className="text-sm font-semibold">{pending.title}</h2>
        </div>
        <div className="px-5 py-4 text-[13px] text-ink-muted whitespace-pre-wrap">
          {pending.body}
        </div>
        <div className="px-5 py-3 border-t border-card flex justify-end gap-2">
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
    <div className="fixed bottom-4 right-4 z-[55] flex flex-col gap-2 w-[360px] max-w-[80vw] pointer-events-none">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto text-left text-xs px-3 py-2 rounded border shadow-lg whitespace-pre-wrap ${tone[t.kind] ?? tone.info}`}
          title="Click to dismiss"
        >
          {t.message}
        </button>
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
  const selectedWsId = useStore((s) => s.selectedWorkspaceId);
  const refreshRepoStatus = useStore((s) => s.refreshRepoStatus);
  const refreshRepoChanges = useStore((s) => s.refreshRepoChanges);
  const refreshWsStatus = useStore((s) => s.refreshWorkspaceStatus);
  const refreshWsPRs = useStore((s) => s.refreshWorkspacePRs);

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
      // Cmd+P is deliberately NOT bound: in an Electron renderer it
      // also fires the system Print dialog, and we'd rather not
      // silently steal that on a diff or file view. Cmd+K alone is
      // the documented shortcut.
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        togglePalette();
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
      // Cmd+R → refresh whatever's in focus (repo or workspace pane).
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
      // Cmd+N → New branch (workspace-wide if a workspace is open;
      // otherwise we let the repo's BranchPicker handle it via Cmd+B).
      if ((e.key === 'n' || e.key === 'N') && !e.shiftKey && !inField && selectedWsId) {
        e.preventDefault();
        setSheet({ kind: 'newBranchInWorkspace', workspaceId: selectedWsId });
        return;
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
  const workspaces = useStore((s) => s.workspaces);
  const selectedWs = useStore((s) => s.selectedWorkspaceId);
  const selectedRepo = useStore((s) => s.selectedRepoId);
  const selectWs = useStore((s) => s.selectWorkspace);
  const selectRepo = useStore((s) => s.selectRepo);
  const pickAndAddRepo = useStore((s) => s.pickAndAddRepo);
  const setSheet = useStore((s) => s.setSheet);
  const removeRepo = useStore((s) => s.removeRepo);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const requestConfirm = useStore((s) => s.requestConfirm);

  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();

  const visibleRepos = useMemo(
    () =>
      query
        ? repos.filter(
            (r) =>
              r.name.toLowerCase().includes(query) ||
              r.path.toLowerCase().includes(query),
          )
        : repos,
    [repos, query],
  );

  const visibleWorkspaces = useMemo(
    () =>
      query
        ? workspaces.filter((w) => w.name.toLowerCase().includes(query))
        : workspaces,
    [workspaces, query],
  );

  return (
    <aside className="flex-1 min-w-0 flex flex-col border-r border-card bg-surface-muted">
      <div className="px-2 pt-2 pb-1">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search"
          className="field w-full px-2 py-1 text-xs"
        />
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto px-1 pb-2">
        {/* Repos on top — that's where users start. */}
        <SectionHeader label="Repos" count={visibleRepos.length} />
        {visibleRepos.length === 0 ? (
          <EmptyHint
            text={query ? 'No repos match.' : 'Add a local git repo to start.'}
          />
        ) : (
          visibleRepos.map((r) => (
            <RepoRow
              key={r.id}
              repo={r}
              selected={selectedRepo === r.id}
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
          ))
        )}

        <SectionHeader label="Workspaces" count={visibleWorkspaces.length} />
        {visibleWorkspaces.length === 0 ? (
          <EmptyHint
            text={
              query
                ? 'No workspaces match.'
                : 'Group repos that you switch together.'
            }
          />
        ) : (
          visibleWorkspaces.map((w) => (
            <WorkspaceRow
              key={w.id}
              workspace={w}
              selected={selectedWs === w.id && !selectedRepo}
              onSelect={() => selectWs(w.id)}
              onEdit={() => setSheet({ kind: 'editWorkspace', workspaceId: w.id })}
              onRemove={async () => {
                const ok = await requestConfirm({
                  title: `Remove workspace?`,
                  body: `Remove workspace "${w.name}"?`,
                  confirmLabel: 'Remove',
                });
                if (ok) void removeWorkspace(w.id);
              }}
            />
          ))
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
      </div>
    </aside>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }): JSX.Element {
  return (
    <div className="mt-3 first:mt-1 px-2 py-1 flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</span>
      <span className="text-[10px] text-ink-faint">{count}</span>
    </div>
  );
}

function EmptyHint({ text }: { text: string }): JSX.Element {
  return <div className="px-2 py-1 text-[11px] text-ink-faint">{text}</div>;
}

function RepoRow({
  repo,
  selected,
  onSelect,
  onRemove,
}: {
  repo: Repo;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div
      className={`sidebar-row group flex items-center gap-1.5 rounded text-xs ${
        selected ? 'sidebar-row-selected text-ink' : 'text-ink-muted hover:bg-card hover:text-ink'
      }`}
    >
      <button
        onClick={onSelect}
        className="flex items-center gap-1.5 flex-1 min-w-0 text-left px-2 py-1"
        title={repo.path}
      >
        <RepoIcon />
        <span className="truncate">{repo.name}</span>
      </button>
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

function WorkspaceRow({
  workspace,
  selected,
  onSelect,
  onEdit,
  onRemove,
}: {
  workspace: Workspace;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div
      className={`sidebar-row group flex items-center gap-1.5 rounded text-xs ${
        selected ? 'sidebar-row-selected text-ink' : 'text-ink-muted hover:bg-card hover:text-ink'
      }`}
    >
      <button
        onClick={onSelect}
        className="flex items-center gap-1.5 flex-1 min-w-0 text-left px-2 py-1"
      >
        <WorkspaceIcon />
        <span className="truncate">{workspace.name}</span>
        <span className="text-[10px] text-ink-faint">
          {workspace.repoIds.length}
        </span>
      </button>
      <button
        onClick={onEdit}
        title="Edit workspace"
        className="w-5 h-5 flex items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink hover:bg-card"
      >
        <PencilIcon />
      </button>
      <button
        onClick={onRemove}
        title="Remove workspace"
        className="w-5 h-5 flex items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 hover:text-red-300 hover:bg-card"
      >
        <span className="text-[11px]">×</span>
      </button>
    </div>
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

function WorkspaceIcon(): JSX.Element {
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

function PencilIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 20 20" fill="currentColor" className="flex-shrink-0">
      <path d="M12.793 2.793a1 1 0 0 1 1.414 0l2 2a1 1 0 0 1 0 1.414l-8.2 8.2a2.5 2.5 0 0 1-1.14.63l-2.26.566a.75.75 0 0 1-.91-.91l.566-2.26a2.5 2.5 0 0 1 .63-1.14l8.2-8.2Z" />
    </svg>
  );
}

function Main(): JSX.Element {
  const selectedRepo = useStore((s) => s.selectedRepoId);
  const selectedWs = useStore((s) => s.selectedWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const ws = useMemo(
    () => workspaces.find((w) => w.id === selectedWs) ?? null,
    [workspaces, selectedWs],
  );

  if (selectedRepo) return <RepoDetail repoId={selectedRepo} />;

  if (!ws) {
    return (
      <main className="flex-1 flex items-center justify-center text-ink-muted">
        <div className="text-center max-w-sm">
          <div className="text-base font-medium mb-1">Pick a repo or a workspace</div>
          <p className="text-xs text-ink-faint">
            Repos give you a single-repo working pane (changes, history, files,
            graph). Workspaces fan operations across many repos at once.
          </p>
        </div>
      </main>
    );
  }

  return <WorkspaceView key={ws.id} workspaceId={ws.id} />;
}

function WorkspaceView({ workspaceId }: { workspaceId: UUID }): JSX.Element {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const repos = useStore((s) => s.repos);
  const statuses = useStore((s) => s.workspaceStatuses[workspaceId] ?? EMPTY_STATUSES);
  const prs = useStore((s) => s.workspacePRs[workspaceId] ?? EMPTY_PRS);
  const activity = useStore((s) => s.workspaceActivity[workspaceId] ?? EMPTY_ACTIVITY);
  const lastSeen = useStore(
    (s) => s.settings.workspaceLastSeen?.[workspaceId] ?? null,
  );
  const lastCheckout = useStore((s) => s.lastCheckout);
  const cli = useStore((s) => s.cliPresence);
  const refresh = useStore((s) => s.refreshWorkspaceStatus);
  const refreshPRs = useStore((s) => s.refreshWorkspacePRs);
  const refreshWorktrees = useStore((s) => s.refreshWorkspaceWorktrees);
  const refreshActivity = useStore((s) => s.refreshWorkspaceActivity);
  const markSeen = useStore((s) => s.markWorkspaceSeen);
  const fetchWs = useStore((s) => s.fetchWorkspace);
  const checkout = useStore((s) => s.checkoutWorkspaceBranch);
  const selectRepo = useStore((s) => s.selectRepo);
  const setSheet = useStore((s) => s.setSheet);

  const [branch, setBranch] = useState('');
  const [createIfMissing, setCreateIfMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  /// `seenAtOpen` freezes the lastSeen value at mount so the "new
  /// since" pip remains visible while the user is on the pane. Without
  /// this, marking-seen on open would immediately wipe the indicators
  /// the user just came in to look at. We mark-seen on unmount instead
  /// (or on explicit dismiss).
  const [seenAtOpen] = useState<string | null>(lastSeen);

  useEffect(() => {
    refresh(workspaceId);
    refreshPRs(workspaceId);
    refreshWorktrees(workspaceId);
    refreshActivity(workspaceId);
  }, [refresh, refreshPRs, refreshWorktrees, refreshActivity, workspaceId]);

  // On unmount (or workspace switch), advance lastSeen so the next
  // visit only highlights things that landed after this one.
  useEffect(() => {
    return () => {
      void markSeen(workspaceId);
    };
  }, [markSeen, workspaceId]);

  // Overview tiles, computed BEFORE any early return so React's hook
  // order stays stable. The previous version put this useMemo after
  // `if (!ws) return …` — the crash that left the whole app rendering
  // blank when a freshly-created workspace momentarily lagged the
  // selector. Falls back to zeroes when ws hasn't materialized yet.
  const summary = useMemo(() => {
    const total = ws?.repoIds.length ?? 0;
    const loaded = statuses.length;
    const dirty = statuses.filter((s) => s.dirtyCount > 0).length;
    const ahead = statuses.filter((s) => (s.ahead ?? 0) > 0).length;
    const behind = statuses.filter((s) => (s.behind ?? 0) > 0).length;
    // Repos in the middle of a merge / rebase / cherry-pick. Surfaced
    // in the overview because a workspace-wide op (rebase the workspace
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
    return { total, loaded, dirty, ahead, behind, inProgress, conflictedFiles, sortedBranches };
  }, [ws?.repoIds.length, statuses]);

  if (!ws) return <main className="flex-1" />;

  const reposById = new Map(repos.map((r) => [r.id, r]));

  return (
    <main className="flex-1 overflow-y-auto p-6">
      <header className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-base font-semibold">{ws.name}</h1>
          <p className="text-[11px] text-ink-faint">
            {ws.repoIds.length} {ws.repoIds.length === 1 ? 'repo' : 'repos'} ·
            CLIs: {cliSummary(cli)}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setSheet({ kind: 'newBranchInWorkspace', workspaceId })}
            disabled={ws.repoIds.length === 0}
            title="Sync each repo to its default branch, pull, and create a new branch — all in one go"
            className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
          >
            + New branch
          </button>
          <button
            onClick={() => setSheet({ kind: 'commitAllInWorkspace', workspaceId })}
            disabled={summary.dirty === 0}
            title={
              summary.dirty === 0
                ? 'Nothing to commit — all repos are clean'
                : `Stage and commit every dirty repo with a shared message (${summary.dirty} dirty)`
            }
            className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-50"
          >
            Commit all
          </button>
          <button
            onClick={() => setSheet({ kind: 'pushAllInWorkspace', workspaceId })}
            disabled={summary.ahead === 0 && summary.total > 0}
            title={
              summary.ahead === 0
                ? 'Nothing to push — every repo is already in sync'
                : `Push every repo whose branch is ahead of upstream (${summary.ahead} ahead)`
            }
            className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-50"
          >
            Push all{summary.ahead > 0 ? ` ↑${summary.ahead}` : ''}
          </button>
          <button
            onClick={() => setSheet({ kind: 'openPRsInWorkspace', workspaceId })}
            disabled={!cli?.gh || ws.repoIds.length === 0}
            title={
              !cli?.gh
                ? 'Install gh to open PRs from overgit'
                : 'Open a GitHub PR per repo with a shared title and body'
            }
            className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-50"
          >
            Open PRs
          </button>
          <button
            onClick={() => setSheet({ kind: 'editWorkspace', workspaceId })}
            className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
          >
            Edit
          </button>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await fetchWs(workspaceId);
              } finally {
                setBusy(false);
              }
            }}
            className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-50"
          >
            Fetch all
          </button>
          <button
            disabled={busy}
            onClick={() => {
              refresh(workspaceId);
              refreshPRs(workspaceId);
            }}
            className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </header>

      {/* Overview tiles. Always render so a freshly-created workspace
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

      <section className="mb-6 p-3 rounded-lg bg-card border border-card">
        <div className="text-[10px] uppercase tracking-wide text-ink-faint mb-2">
          Bring workspace to a branch
        </div>
        <div className="flex gap-2 items-center">
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="branch name"
            className="field flex-1 px-2 py-1.5 text-xs"
          />
          <label className="flex items-center gap-1 text-[11px] text-ink-muted">
            <input
              type="checkbox"
              checked={createIfMissing}
              onChange={(e) => setCreateIfMissing(e.target.checked)}
            />
            create if missing
          </label>
          <button
            disabled={busy || !branch.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await checkout(workspaceId, branch.trim(), createIfMissing);
              } finally {
                setBusy(false);
              }
            }}
            className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
          >
            Switch all
          </button>
        </div>
        {lastCheckout && lastCheckout.workspaceId === workspaceId && lastCheckout.outcomes.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5">
            {lastCheckout.outcomes.map((o) => (
              <CheckoutOutcomeRow
                key={o.repoId}
                outcome={o}
                repoName={reposById.get(o.repoId)?.name ?? o.repoId}
              />
            ))}
          </ul>
        )}
      </section>

      {prs.length > 0 && <PRSection prs={prs} reposById={reposById} cli={cli} />}

      <ActivitySection
        items={activity}
        reposById={reposById}
        seenAtOpen={seenAtOpen}
        onSelectRepo={selectRepo}
      />

      <section>
        <h2 className="text-[10px] uppercase tracking-wide text-ink-faint mb-2">Status</h2>
        {ws.repoIds.length === 0 && (
          <div className="text-xs text-ink-faint p-3 rounded border border-card bg-card">
            This workspace has no repos yet. Click "Edit" to add some.
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
                  <button
                    onClick={() => selectRepo(id)}
                    className="min-w-0 flex-1 text-left hover:underline"
                    title="Open repo detail"
                  >
                    <div className="text-sm font-medium truncate">{repo?.name ?? id}</div>
                    <div className="text-[11px] text-ink-faint truncate font-mono">{repo?.path}</div>
                  </button>
                  <StatusCell status={st} />
                </div>
                <WorktreeList repoId={id} mainPath={repo?.path} />
              </li>
            );
          })}
        </ul>
      </section>
    </main>
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

function CheckoutOutcomeRow({
  outcome,
  repoName,
}: {
  outcome: CheckoutOutcome;
  repoName: string;
}): JSX.Element {
  const stash = useStore((s) => s.stashRepo);
  const commitAll = useStore((s) => s.commitAllRepo);
  const retry = useStore((s) => s.retryCheckoutRepo);
  const pushToast = useStore((s) => s.pushToast);

  const [showCommit, setShowCommit] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

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

  return (
    <li className="text-[11px] flex flex-col gap-1">
      <div className="flex gap-2 items-center">
        <span className="text-ink-faint w-40 truncate">{repoName}</span>
        <CheckoutBadge outcome={outcome} />
        {outcome.message && (
          <span className="text-ink-faint truncate flex-1">— {outcome.message}</span>
        )}
        {outcome.result === 'dirty' && !showCommit && (
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
          Install <span className="font-mono">gh</span> to surface PRs across the workspace.
        </div>
      ) : flat.length === 0 ? (
        <div className="text-[11px] text-ink-faint p-3 rounded border border-card bg-card">
          No open PRs in this workspace.
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

/// "Recent" feed across the workspace. Merges commits and PR events
/// into one timeline (see WorkspaceActivity in shared/types.ts) and
/// flags rows newer than the user's last visit with a small dot. We
/// don't paginate — the backend caps the per-repo log length, which
/// already keeps the list short for the workspace sizes overgit
/// targets.
function ActivitySection({
  items,
  reposById,
  seenAtOpen,
  onSelectRepo,
}: {
  items: WorkspaceActivity[];
  reposById: Map<UUID, Repo>;
  seenAtOpen: string | null;
  onSelectRepo: (id: UUID) => void;
}): JSX.Element | null {
  if (items.length === 0) return null;
  // Cap rendered rows. The backend can return up to N×perRepo commits
  // plus PRs, which is a lot of DOM if a workspace has 20 repos.
  const MAX = 60;
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
                : 'Since first opening this workspace'
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
function WorktreeList({
  repoId,
  mainPath,
}: {
  repoId: UUID;
  mainPath: string | undefined;
}): JSX.Element | null {
  const wts = useStore((s) => s.workspaceWorktrees[repoId] ?? EMPTY_WORKTREES);
  const siblings = useMemo(() => wts.filter((w) => !w.isMain), [wts]);
  if (siblings.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 pl-3 border-l border-card ml-1">
      <li className="text-[10px] uppercase tracking-wide text-ink-faint">
        {siblings.length} additional {siblings.length === 1 ? 'worktree' : 'worktrees'}
      </li>
      {siblings.map((w) => (
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
