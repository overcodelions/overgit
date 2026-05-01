import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { FileEditor } from './FileEditor';
import { BranchPicker } from './BranchPicker';
import type {
  ChangedFile,
  Commit,
  FileDiff,
  GraphCommit,
  LlmTool,
  RepoStatus,
  ResolvedIdentity,
  UUID,
  Worktree,
} from '@shared/types';
import { HISTORY_ASIDE_MAX_WIDTH, HISTORY_ASIDE_MIN_WIDTH } from '@shared/types';

// Stable fallback for the history-tab log selector. See App.tsx for the
// rationale — a fresh `[]` per render breaks Zustand's snapshot
// equality and triggers an infinite-render bail-out in React.
const EMPTY_COMMITS: Commit[] = [];

/// Join a repo root with a repo-relative path. Git always emits paths
/// using `/`, so on Windows we'd otherwise produce a mixed-separator
/// string when concatenating with a backslashed root. We pick the
/// separator the root is using and rewrite the relative half to match.
function joinRepoPath(repoRoot: string, relPath: string): string {
  const sep = repoRoot.includes('\\') ? '\\' : '/';
  const trimmedRoot = repoRoot.endsWith(sep) ? repoRoot.slice(0, -1) : repoRoot;
  const normalized = sep === '\\' ? relPath.replace(/\//g, sep) : relPath;
  return `${trimmedRoot}${sep}${normalized}`;
}

type Tab = 'changes' | 'history' | 'files' | 'stash' | 'branches';

/// Detail view for a single repo. Two tabs:
/// - Changes: stage / unstage / discard / commit (the standard daily flow)
/// - History: commit log + per-commit diff
/// The header carries cross-tab actions (branch picker, fetch / pull / push)
/// because all of them apply regardless of which tab is active.
export function RepoDetail({ repoId }: { repoId: UUID }): JSX.Element {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId));
  const refreshLog = useStore((s) => s.refreshRepoLog);
  const refreshChanges = useStore((s) => s.refreshRepoChanges);
  const refreshStatus = useStore((s) => s.refreshRepoStatus);
  const refreshBranches = useStore((s) => s.refreshRepoBranches);

  const [tab, setTab] = useState<Tab>('changes');

  useEffect(() => {
    refreshLog(repoId);
    refreshChanges(repoId);
    refreshStatus(repoId);
    refreshBranches(repoId);
  }, [refreshLog, refreshChanges, refreshStatus, refreshBranches, repoId]);

  if (!repo) return <main className="flex-1" />;

  // Global Cmd+1..4 shortcuts are dispatched as a custom event from App;
  // we just listen and update local tab state. Same story for Cmd+B
  // which RepoHeader picks up — the RepoDetail level forwards that
  // event by re-dispatching on a header-local element via a simple
  // boolean ping that RepoHeader subscribes to.
  useEffect(() => {
    const onTab = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (
        detail === 'changes' ||
        detail === 'history' ||
        detail === 'files' ||
        detail === 'stash' ||
        detail === 'branches'
      ) {
        setTab(detail);
      }
    };
    window.addEventListener('overgit:setRepoTab', onTab);
    return () => window.removeEventListener('overgit:setRepoTab', onTab);
  }, []);

  return (
    <main className="flex-1 grid grid-rows-[auto_auto_1fr] overflow-hidden">
      <RepoHeader repoId={repoId} />
      <Tabs tab={tab} onChange={setTab} />
      {tab === 'changes' && <ChangesTab repoId={repoId} />}
      {tab === 'history' && <HistoryTab repoId={repoId} />}
      {tab === 'files' && <FileEditor repoId={repoId} />}
      {tab === 'stash' && <StashTab repoId={repoId} />}
      {tab === 'branches' && <BranchesTab repoId={repoId} />}
    </main>
  );
}

function RepoHeader({ repoId }: { repoId: UUID }): JSX.Element {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId))!;
  const status = useStore((s) => s.repoStatus[repoId]);
  const fetchRepo = useStore((s) => s.fetchRepo);
  const pullRepo = useStore((s) => s.pullRepo);
  const pushRepo = useStore((s) => s.pushRepo);
  const pushToast = useStore((s) => s.pushToast);

  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /// When set, the picker mounts directly into "create branch" mode.
  /// Reset when the picker closes so the next Cmd+B opens to the list.
  const [pickerInitialMode, setPickerInitialMode] = useState<'create' | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Cmd+B shortcut → toggle the picker. The global handler in App
  // dispatches a window event when a repo is open; we just toggle.
  useEffect(() => {
    const onOpen = () => {
      setPickerInitialMode(null);
      setPickerOpen((v) => !v);
    };
    // Cmd+N when a repo is selected — open the picker straight into
    // create mode so the user can type the new branch name without an
    // extra click. Always opens (no toggle): pressing Cmd+N twice
    // shouldn't dismiss the form you just summoned.
    const onCreate = () => {
      setPickerInitialMode('create');
      setPickerOpen(true);
    };
    window.addEventListener('overgit:openBranchPicker', onOpen);
    window.addEventListener('overgit:newRepoBranch', onCreate);
    return () => {
      window.removeEventListener('overgit:openBranchPicker', onOpen);
      window.removeEventListener('overgit:newRepoBranch', onCreate);
    };
  }, []);

  // ⌘F / ⌘P shortcuts. The global handler in App dispatches these
  // window events when a repo is open; the actions live here because
  // they need access to `busy`, the repoId, and the per-action store
  // calls. Guard each so a misfire while a fetch is in flight doesn't
  // pile a second one on top.
  useEffect(() => {
    const onFetch = () => {
      if (busy) return;
      void onAction(() => fetchRepo(repoId))();
    };
    const onPush = () => {
      if (busy || !status?.branch) return;
      void onAction(() => pushRepo(repoId))();
    };
    window.addEventListener('overgit:repoFetch', onFetch);
    window.addEventListener('overgit:repoPush', onPush);
    return () => {
      window.removeEventListener('overgit:repoFetch', onFetch);
      window.removeEventListener('overgit:repoPush', onPush);
    };
    // onAction is fresh per render but stable for the duration of a
    // mount; intentionally omitted to keep the listener attach/detach
    // tied to data deps that actually matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, repoId, status?.branch, fetchRepo, pushRepo]);

  const setSheet = useStore((s) => s.setSheet);

  const onAction = (fn: () => Promise<{ ok: boolean; error?: string }>) => async () => {
    setBusy(true);
    try {
      const res = await fn();
      if (!res.ok) pushToast({ kind: 'error', message: res.error ?? 'Action failed' });
    } finally {
      setBusy(false);
    }
  };

  /// Pull is special — its failure mode is often "local changes would
  /// be overwritten" and our store-side `pullRepo` reports the
  /// conflicts. Route those into the PullConflictSheet so the user has
  /// real recovery options instead of just an alert.
  const onPull = async () => {
    setBusy(true);
    try {
      const res = await pullRepo(repoId);
      if (res.ok) return;
      if (res.conflicts && res.conflicts.length > 0) {
        setSheet({
          kind: 'pullConflict',
          repoId,
          conflicts: res.conflicts,
          rawError: res.error ?? '',
        });
        return;
      }
      pushToast({ kind: 'error', message: res.error ?? 'Pull failed' });
    } finally {
      setBusy(false);
    }
  };

  const branchLabel = status?.branch ?? '(detached)';

  return (
    <header className="px-6 py-3 border-b border-card flex items-center gap-4">
      <div className="min-w-0">
        <div className="text-sm font-semibold truncate">{repo.name}</div>
        <div className="text-[11px] text-ink-faint truncate font-mono">{repo.path}</div>
      </div>

      <div className="flex items-center gap-2 ml-auto">
        <button
          ref={triggerRef}
          disabled={busy}
          onClick={() => setPickerOpen((v) => !v)}
          className={`text-xs px-2.5 py-1 rounded border flex items-center gap-1.5 disabled:opacity-50 ${
            pickerOpen ? 'border-accent bg-accent/10' : 'border-card hover:bg-card'
          }`}
          title="Switch branch, create one, or cherry-pick"
        >
          <BranchGlyph />
          <span className="font-mono truncate max-w-[180px]">{branchLabel}</span>
          <span className="text-[9px] text-ink-faint">▾</span>
        </button>

        {status && <WorktreeDeltaPill status={status} />}
        {status && <TrunkDistancePill status={status} />}

        <div className="w-px h-5 bg-card mx-1" />

        <button
          disabled={busy}
          onClick={onAction(() => fetchRepo(repoId))}
          title="Fetch (⌘F)"
          className="text-xs px-2.5 py-1 rounded border border-card hover:bg-card disabled:opacity-50 flex items-center gap-1.5"
        >
          <span>Fetch</span>
          <kbd className="text-[11px] text-ink-faint font-mono">⌘F</kbd>
        </button>
        <button
          disabled={busy || !status?.branch}
          onClick={onPull}
          className="text-xs px-2.5 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
        >
          Pull{status?.behind ? ` ↓${status.behind}` : ''}
        </button>
        <button
          disabled={busy || !status?.branch}
          onClick={onAction(() => pushRepo(repoId))}
          title="Push (⌘P)"
          className="text-xs px-2.5 py-1 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50 flex items-center gap-1.5"
        >
          <span>Push{status?.ahead ? ` ↑${status.ahead}` : ''}</span>
          <kbd className="text-[11px] text-white/85 font-mono">⌘P</kbd>
        </button>
        <RepoExtrasBadges repoId={repoId} />
        <button
          onClick={() => setSheet({ kind: 'manageRepo', repoId, tab: 'tags' })}
          className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card"
          title="Tags, remotes, submodules"
        >
          ⋯
        </button>
      </div>

      {pickerOpen && (
        <BranchPicker
          repoId={repoId}
          anchorRef={triggerRef}
          initialMode={pickerInitialMode}
          onClose={() => {
            setPickerOpen(false);
            setPickerInitialMode(null);
          }}
        />
      )}
    </header>
  );
}

/// Small "this repo has submodules / uses LFS" badges in the header.
/// Kept passive — clicking opens the Manage sheet to the appropriate
/// tab. Hidden when neither applies, which is the common case.
function RepoExtrasBadges({ repoId }: { repoId: UUID }): JSX.Element | null {
  const setSheet = useStore((s) => s.setSheet);
  const [submoduleCount, setSubmoduleCount] = useState<number | null>(null);
  const [lfsEnabled, setLfsEnabled] = useState<boolean>(false);
  // One-shot probe per repo. The data is cheap and rarely changes
  // mid-session; a stale badge if the user runs `git submodule add`
  // outside overgit is acceptable for v1.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.overgit.invoke('repo:listSubmodules', repoId),
      window.overgit.invoke('repo:lfsStatus', repoId),
    ]).then(([sm, lfs]) => {
      if (cancelled) return;
      setSubmoduleCount(sm.length);
      setLfsEnabled(lfs.enabled);
    });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  if (submoduleCount === null) return null;
  if (submoduleCount === 0 && !lfsEnabled) return null;

  return (
    <div className="flex items-center gap-1">
      {submoduleCount > 0 && (
        <button
          onClick={() => setSheet({ kind: 'manageRepo', repoId, tab: 'submodules' })}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-card hover:bg-card text-ink-muted"
          title={`${submoduleCount} submodule${submoduleCount === 1 ? '' : 's'}`}
        >
          ⊕ {submoduleCount}
        </button>
      )}
      {lfsEnabled && (
        <button
          onClick={() => setSheet({ kind: 'manageRepo', repoId, tab: 'submodules' })}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-accent/40 text-accent"
          title="Repository uses git-lfs"
        >
          LFS
        </button>
      )}
    </div>
  );
}

/// Compact "how far am I from trunk" pill rendered next to the branch
/// button. Hidden when comparison isn't meaningful (HEAD is the
/// default, no default configured, or the comparison ref couldn't be
/// resolved). Tone scales with severity: subtle when in-sync or only
/// ahead, amber when behind, red+amber when both diverged.
/// Compact "+47 −12" pill for the working tree's total delta against
/// HEAD. Hidden when the tree is clean OR when shortstat hasn't
/// reported anything yet (fresh-clone repos with no commits). The
/// dirty-files count gets a tooltip so users can see "5 files" without
/// us claiming a third slot in the header.
function WorktreeDeltaPill({ status }: { status: RepoStatus }): JSX.Element | null {
  const adds = status.worktreeAdds;
  const dels = status.worktreeDels;
  if (adds === null || dels === null) return null;
  if (adds === 0 && dels === 0 && status.dirtyCount === 0) return null;
  const fileWord = status.dirtyCount === 1 ? 'file' : 'files';
  return (
    <span
      className="text-[10px] px-2 h-7 rounded border border-card bg-card/40 inline-flex items-center gap-1.5 leading-none whitespace-nowrap"
      title={`${status.dirtyCount} ${fileWord} changed · ${adds} insertion${
        adds === 1 ? '' : 's'
      }, ${dels} deletion${dels === 1 ? '' : 's'} vs HEAD`}
    >
      {adds > 0 && <span className="font-mono text-emerald-400">+{adds}</span>}
      {dels > 0 && <span className="font-mono text-red-400">−{dels}</span>}
      {adds === 0 && dels === 0 && (
        <span className="text-ink-faint">untracked only</span>
      )}
      <span className="text-ink-faint">
        {status.dirtyCount} {fileWord}
      </span>
    </span>
  );
}

function TrunkDistancePill({ status }: { status: RepoStatus }): JSX.Element | null {
  const { aheadDefault, behindDefault, defaultRef } = status;
  if (
    aheadDefault === null ||
    behindDefault === null ||
    defaultRef === null
  ) {
    return null;
  }
  const inSync = aheadDefault === 0 && behindDefault === 0;
  const onlyBehind = behindDefault > 0 && aheadDefault === 0;
  const diverged = behindDefault > 0 && aheadDefault > 0;

  const tone = inSync
    ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/5'
    : onlyBehind || diverged
      ? 'border-amber-500/40 text-amber-300 bg-amber-500/10'
      : 'border-card text-ink-muted bg-card/40';

  // Drop the path prefix on the trunk ref for the visible label (the
  // pill stays narrow) while keeping the full ref in the tooltip.
  // "origin/main" → "main"; "main" → "main".
  const shortRef = defaultRef.replace(/^[^/]+\//, '');

  // English-first labels. The earlier "↓5 ↑3 vs origin/main" form
  // crammed three concepts and a preposition into a few characters
  // and read like glyph soup. New form uses words: "5 behind / 3
  // ahead of main", or "Up to date with main", with the title carrying
  // the full ref for users who care which remote they're comparing.
  const title = inSync
    ? `Up to date with ${defaultRef}`
    : `${behindDefault} commit${behindDefault === 1 ? '' : 's'} behind, ${aheadDefault} ahead of ${defaultRef}`;

  return (
    <span
      className={`text-[10px] px-2 h-7 rounded border inline-flex items-center gap-1.5 leading-none whitespace-nowrap ${tone}`}
      title={title}
    >
      {inSync ? (
        <>
          <span>✓</span>
          <span>
            Up to date with <span className="font-mono">{shortRef}</span>
          </span>
        </>
      ) : (
        <>
          {behindDefault > 0 && (
            <span>
              <span className="font-mono">{behindDefault}</span> behind
            </span>
          )}
          {behindDefault > 0 && aheadDefault > 0 && (
            <span className="text-ink-faint">·</span>
          )}
          {aheadDefault > 0 && (
            <span className={behindDefault > 0 ? '' : 'text-emerald-400'}>
              <span className="font-mono">{aheadDefault}</span> ahead
            </span>
          )}
          <span className={behindDefault > 0 ? 'text-amber-300/80' : 'text-ink-muted'}>
            of <span className="font-mono">{shortRef}</span>
          </span>
        </>
      )}
    </span>
  );
}

function BranchGlyph(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <path
        d="M5 3v6m0 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0-6a2 2 0 1 1 0-2 2 2 0 0 1 0 2Zm6 0v3a3 3 0 0 1-3 3H6m5-6a2 2 0 1 0 0-2 2 2 0 0 0 0 2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }): JSX.Element {
  const labels: Record<Tab, string> = {
    changes: 'Changes',
    history: 'History',
    files: 'Files',
    stash: 'Stash',
    branches: 'Branches',
  };
  return (
    <nav className="px-6 border-b border-card flex gap-2">
      {(['changes', 'history', 'files', 'stash', 'branches'] as const).map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`px-3 py-2 text-xs border-b-2 -mb-px ${
            tab === t
              ? 'border-accent text-ink'
              : 'border-transparent text-ink-muted hover:text-ink'
          }`}
        >
          {labels[t]}
        </button>
      ))}
    </nav>
  );
}

function ChangesTab({ repoId }: { repoId: UUID }): JSX.Element {
  const ch = useStore((s) => s.repoChanges[repoId]);
  const repoStatus = useStore((s) => s.repoStatus[repoId]);
  const repoPath = useStore((s) => s.repos.find((r) => r.id === repoId)?.path);
  const stagingMode = useStore((s) => s.settings.stagingMode ?? 'simple');
  const stage = useStore((s) => s.stageFiles);
  const unstage = useStore((s) => s.unstageFiles);
  const discard = useStore((s) => s.discardFiles);
  const commit = useStore((s) => s.commitRepo);
  const amend = useStore((s) => s.amendCommit);
  const loadDiff = useStore((s) => s.loadRepoFileDiff);
  const diffEntry = useStore((s) => s.repoDiff[repoId]);
  const cli = useStore((s) => s.cliPresence);
  const setSheet = useStore((s) => s.setSheet);
  const openRepoFile = useStore((s) => s.openRepoFile);
  const stashFilesAction = useStore((s) => s.stashFiles);
  const pushToast = useStore((s) => s.pushToast);
  const requestConfirm = useStore((s) => s.requestConfirm);
  // Last commit — pulled from the graph (already cached for History)
  // so this doesn't trigger an extra IPC call.
  const lastCommit = useStore((s) => s.repoGraph[repoId]?.[0]);
  const refreshGraph = useStore((s) => s.refreshRepoGraph);
  // Make sure the graph is loaded so the Amend toggle has a target
  // commit to show. Cheap to call when already cached.
  useEffect(() => {
    if (!lastCommit) refreshGraph(repoId);
  }, [lastCommit, refreshGraph, repoId]);

  // Stashing prompts inline via the FileGroup bar (Electron renderers
  // refuse window.prompt). The message is optional — empty string ⇒
  // git uses its default "WIP on <branch>" subject.
  const onStash = async (paths: string[], message?: string) => {
    if (paths.length === 0) return;
    const res = await stashFilesAction(repoId, paths, message);
    if (!res.ok) pushToast({ kind: 'error', message: res.error ?? 'Stash failed' });
  };

  // "View" handler shared by both groups: switch to the Files tab and
  // open the absolute path. ChangedFile.path is repo-relative, so we
  // join it onto the repo's working tree root before opening.
  const onView = (f: ChangedFile) => {
    if (!repoPath) return;
    window.dispatchEvent(
      new CustomEvent('overgit:setRepoTab', { detail: 'files' }),
    );
    void openRepoFile(repoId, joinRepoPath(repoPath, f.path));
  };

  // After a stage/unstage/discard, paths leave their group. Drop them
  // from the checked set so the next render's bulk-action toolbar
  // doesn't claim a stale count.
  const pruneChecked = (cur: Set<string>, present: ChangedFile[]) => {
    const next = new Set<string>();
    for (const f of present) if (cur.has(f.path)) next.add(f.path);
    return next;
  };
  useEffect(() => {
    setStagedChecked((cur) => pruneChecked(cur, ch?.staged ?? []));
    setUnstagedChecked((cur) => pruneChecked(cur, ch?.unstaged ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch?.staged, ch?.unstaged]);

  // Simple-mode dedupe: if a file is in both staged + unstaged (partial
  // staging from a prior session, or a separate tool), surface it once.
  // We prefer the unstaged entry's metadata so the worktree status is
  // visible in the badge.
  const combined: ChangedFile[] = useMemo(() => {
    const staged = ch?.staged ?? [];
    const unstaged = ch?.unstaged ?? [];
    const map = new Map<string, ChangedFile>();
    for (const f of staged) map.set(f.path, f);
    for (const f of unstaged) map.set(f.path, f);
    return Array.from(map.values());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch?.staged, ch?.unstaged]);

  // Simple-mode "include in commit" set. Default behavior: a newly
  // appearing path is auto-checked (matches GitHub Desktop — show up,
  // get committed). Once a user explicitly unchecks something it
  // stays unchecked across refreshes for as long as the path is still
  // present.
  const [simpleChecked, setSimpleChecked] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSimpleChecked((cur) => {
      const next = new Set<string>();
      const presentPaths = new Set(combined.map((f) => f.path));
      // Carry forward existing checked entries that still exist.
      for (const p of cur) if (presentPaths.has(p)) next.add(p);
      // Auto-check newly appeared paths (i.e. not in cur but present now).
      // We treat "first-time-seen" by checking against cur — anything
      // new gets included by default.
      for (const f of combined) {
        if (!cur.has(f.path) && !next.has(f.path)) {
          // Was it previously known and unchecked? `cur` lost it on a
          // prior prune only if the file disappeared — but this useEffect
          // also runs on initial mount when cur is empty, so we can't
          // distinguish "first-time" from "explicitly unchecked" here.
          // We err on the side of including: a new render auto-includes.
          next.add(f.path);
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combined]);

  const toggleSimple = (p: string) => {
    setSimpleChecked((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  // Auto-advance the diff preview after a hunk-action drains the
  // current file. If the selected path is no longer present in its
  // side (because the user staged / discarded the only remaining
  // hunk), pick the next file in that side so the user keeps moving
  // without having to manually click. Falls through to clearing the
  // selection when the side is empty.
  useEffect(() => {
    if (!selected) return;
    const list =
      selected.side === 'staged'
        ? ch?.staged ?? []
        : selected.side === 'combined'
          ? combined
          : ch?.unstaged ?? [];
    if (list.some((f) => f.path === selected.path)) return;
    if (list.length === 0) {
      // Try the other side before giving up — common case after a
      // successful "Stage hunk" empties the unstaged list for that
      // file but the staged side now has it. (Combined mode only
      // ever uses one side, so it short-circuits.)
      if (selected.side === 'combined') {
        setSelected(null);
        return;
      }
      const other = selected.side === 'staged' ? ch?.unstaged ?? [] : ch?.staged ?? [];
      if (other.length === 0) {
        setSelected(null);
        return;
      }
      const fallback = other[0];
      setSelected({ path: fallback.path, side: selected.side === 'staged' ? 'unstaged' : 'staged' });
      loadDiff(repoId, fallback.path, selected.side === 'staged' ? 'unstaged' : 'staged');
      return;
    }
    const next = list[0];
    setSelected({ path: next.path, side: selected.side });
    loadDiff(repoId, next.path, selected.side);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch?.staged, ch?.unstaged]);

  const toggleStaged = (p: string) => {
    setStagedChecked((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };
  const toggleUnstaged = (p: string) => {
    setUnstagedChecked((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const [selected, setSelected] = useState<
    { path: string; side: 'staged' | 'unstaged' | 'combined' } | null
  >(null);
  // Per-side selection sets for the bulk-action toolbar (advanced mode).
  // We keep two sets — one per group — so checking a file in the staged
  // list and one in the unstaged list is independent (their bulk
  // actions are different too: unstage vs. stage / discard).
  const [stagedChecked, setStagedChecked] = useState<Set<string>>(new Set());
  const [unstagedChecked, setUnstagedChecked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [amendMode, setAmendMode] = useState(false);
  // Toggling amend on prefills the message box with the last commit's
  // subject + body. Toggling off doesn't restore the prior text — we'd
  // need to stash it; the simpler behavior is honest enough.
  useEffect(() => {
    if (amendMode && lastCommit && !message.trim()) {
      setMessage(
        lastCommit.body ? `${lastCommit.subject}\n\n${lastCommit.body}` : lastCommit.subject,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amendMode]);

  const staged = ch?.staged ?? [];
  const unstaged = ch?.unstaged ?? [];
  const anyLlm = !!(cli?.claude || cli?.codex || cli?.gemini);

  const onSelect = (file: ChangedFile, side: 'staged' | 'unstaged' | 'combined') => {
    setSelected({ path: file.path, side });
    loadDiff(repoId, file.path, side);
  };

  const simpleCheckedCount = combined.reduce(
    (n, f) => (simpleChecked.has(f.path) ? n + 1 : n),
    0,
  );

  const onCommit = async () => {
    if (!message.trim()) return;
    setBusy(true);
    try {
      if (stagingMode === 'simple') {
        // Sync the index to exactly the checked set, then commit (or
        // amend). Anything unchecked that's currently staged gets
        // pulled back out so the commit only contains what the user
        // ticked. Idempotent — a no-op for unchanged paths.
        if (!amendMode && combined.length === 0) return;
        if (!amendMode && simpleCheckedCount === 0) {
          pushToast({
            kind: 'error',
            message: 'Check at least one file to commit.',
          });
          return;
        }
        const checkedPaths: string[] = [];
        const uncheckedPaths: string[] = [];
        for (const f of combined) {
          if (simpleChecked.has(f.path)) checkedPaths.push(f.path);
          else uncheckedPaths.push(f.path);
        }
        if (uncheckedPaths.length > 0) {
          await unstage(repoId, uncheckedPaths);
        }
        if (checkedPaths.length > 0) {
          await stage(repoId, checkedPaths);
        }
        const res = amendMode
          ? await amend(repoId, message.trim())
          : await commit(repoId, message.trim());
        if (!res.ok) {
          pushToast({
            kind: 'error',
            message: res.error ?? (amendMode ? 'Amend failed' : 'Commit failed'),
          });
          return;
        }
        setMessage('');
        setSelected(null);
        setAmendMode(false);
        return;
      }

      // Advanced mode:
      //   amend       → rewrites HEAD's message (+ staged set, if any).
      //                 Allowed even when nothing is staged.
      //   commit-all  → no staged set, but unstaged exist: stage every
      //                 unstaged path first, then commit. The button
      //                 label spells this out as "Commit all (N)" so
      //                 there's no invisible auto-staging.
      //   commit      → commit the explicit staged set.
      if (!amendMode && staged.length === 0 && unstaged.length === 0) return;
      if (!amendMode && staged.length === 0 && unstaged.length > 0) {
        const stageRes = await stage(
          repoId,
          unstaged.map((f) => f.path),
        );
        // `stageFiles` returns void in the store; if it threw, the
        // store would surface it. Move on to the commit either way —
        // git commit will fail loudly if nothing landed in the index.
        void stageRes;
      }
      const res = amendMode
        ? await amend(repoId, message.trim())
        : await commit(repoId, message.trim());
      if (!res.ok) {
        pushToast({
          kind: 'error',
          message: res.error ?? (amendMode ? 'Amend failed' : 'Commit failed'),
        });
        return;
      }
      setMessage('');
      setSelected(null);
      setAmendMode(false);
    } finally {
      setBusy(false);
    }
  };

  // ⌘↩ shortcut. Routed via window event from the global handler so the
  // keystroke fires regardless of whether focus is in the commit
  // textarea, the diff pane, or the file list. We re-evaluate the same
  // disabled-condition the button uses so the shortcut is a no-op in
  // states where pressing the button would be too.
  useEffect(() => {
    const onShortcut = () => {
      if (busy || !message.trim()) return;
      const blockedSimple =
        stagingMode === 'simple' && !amendMode && simpleCheckedCount === 0;
      const blockedAdvanced =
        stagingMode !== 'simple' &&
        !amendMode &&
        staged.length === 0 &&
        unstaged.length === 0;
      if (blockedSimple || blockedAdvanced) return;
      void onCommit();
    };
    window.addEventListener('overgit:repoCommit', onShortcut);
    return () => window.removeEventListener('overgit:repoCommit', onShortcut);
  }, [
    busy,
    message,
    stagingMode,
    amendMode,
    simpleCheckedCount,
    staged.length,
    unstaged.length,
    onCommit,
  ]);

  const onDiscard = async (file: ChangedFile) => {
    const ok = await requestConfirm({
      title: 'Discard changes?',
      body: `Discard changes to ${file.path}? This cannot be undone.`,
      confirmLabel: 'Discard',
      destructive: true,
    });
    if (!ok) return;
    await discard(repoId, [file.path]);
    if (selected?.path === file.path) setSelected(null);
  };

  return (
    <div className="grid grid-cols-[360px_1fr] grid-rows-[auto_1fr] overflow-hidden">
      {repoStatus?.inProgress && (
        <div className="col-span-2 row-start-1">
          <ConflictBanner repoId={repoId} status={repoStatus} />
        </div>
      )}
      <aside className="border-r border-card overflow-y-auto flex flex-col col-start-1 row-start-2">
        <div className="flex items-center gap-1 px-3 py-2 border-b border-card flex-wrap">
          {stagingMode === 'advanced' ? (
            <>
              <button
                disabled={unstaged.length === 0}
                onClick={() => stage(repoId, unstaged.map((f) => f.path))}
                className="text-xs px-2.5 py-1 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
                title="Stage every changed file"
              >
                Stage all{unstaged.length ? ` (${unstaged.length})` : ''}
              </button>
              <button
                disabled={staged.length === 0}
                onClick={() => unstage(repoId, staged.map((f) => f.path))}
                className="text-xs px-2.5 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
                title="Unstage every staged file"
              >
                Unstage all{staged.length ? ` (${staged.length})` : ''}
              </button>
            </>
          ) : null}
          <div className="flex-1" />
          <button
            disabled={!anyLlm || (staged.length === 0 && unstaged.length === 0)}
            onClick={() =>
              setSheet({
                kind: 'reviewChanges',
                repoId,
                scope: staged.length > 0 ? 'staged' : 'working',
              })
            }
            className="text-xs px-2.5 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
            title={
              anyLlm
                ? 'Send the diff to an installed LLM CLI for review'
                : 'Install claude, codex, or gemini to review with AI'
            }
          >
            Review with AI
          </button>
        </div>

        {stagingMode === 'simple' ? (
          <FileGroup
            title="Changes"
            files={combined}
            activePath={selected?.side === 'combined' ? selected.path : null}
            actionLabel="Discard"
            onAction={onDiscard}
            onSelect={(f) => onSelect(f, 'combined')}
            onView={onView}
            checked={simpleChecked}
            onToggleChecked={toggleSimple}
            onSetAllChecked={(all) =>
              setSimpleChecked(all ? new Set(combined.map((f) => f.path)) : new Set())
            }
            bulkActions={[
              {
                label: 'Discard',
                glyph: ICON_DISCARD,
                tone: 'danger',
                onAction: async (paths) => {
                  const ok = await requestConfirm({
                    title: 'Discard changes?',
                    body: `Discard changes in ${paths.length} ${
                      paths.length === 1 ? 'file' : 'files'
                    }? This cannot be undone.`,
                    confirmLabel: 'Discard',
                    destructive: true,
                  });
                  if (!ok) return;
                  void discard(repoId, paths);
                },
              },
              {
                label: 'Stash',
                glyph: ICON_STASH,
                kind: 'with-message',
                messagePlaceholder: 'Stash message (optional)…',
                onAction: (paths, message) => onStash(paths, message),
              },
            ]}
          />
        ) : (
          <>
            <FileGroup
              title="Staged"
              files={staged}
              activePath={selected?.side === 'staged' ? selected.path : null}
              actionLabel="Unstage"
              onAction={(f) => unstage(repoId, [f.path])}
              onSelect={(f) => onSelect(f, 'staged')}
              onView={onView}
              checked={stagedChecked}
              onToggleChecked={toggleStaged}
              onSetAllChecked={(all) =>
                setStagedChecked(all ? new Set(staged.map((f) => f.path)) : new Set())
              }
              bulkActions={[
                {
                  label: 'Unstage',
                  glyph: ICON_UNSTAGE,
                  tone: 'primary',
                  onAction: (paths) => unstage(repoId, paths),
                },
                {
                  label: 'Stash',
                  glyph: ICON_STASH,
                  kind: 'with-message',
                  messagePlaceholder: 'Stash message (optional)…',
                  onAction: (paths, message) => onStash(paths, message),
                },
              ]}
            />
            <FileGroup
              title="Changes"
              files={unstaged}
              activePath={selected?.side === 'unstaged' ? selected.path : null}
              actionLabel="Stage"
              onAction={(f) => stage(repoId, [f.path])}
              onSelect={(f) => onSelect(f, 'unstaged')}
              onView={onView}
              extraAction={{ label: 'Discard', onAction: onDiscard }}
              checked={unstagedChecked}
              onToggleChecked={toggleUnstaged}
              onSetAllChecked={(all) =>
                setUnstagedChecked(all ? new Set(unstaged.map((f) => f.path)) : new Set())
              }
              bulkActions={[
                {
                  label: 'Stage',
                  glyph: ICON_STAGE,
                  tone: 'primary',
                  onAction: (paths) => stage(repoId, paths),
                },
                {
                  label: 'Stash',
                  glyph: ICON_STASH,
                  kind: 'with-message',
                  messagePlaceholder: 'Stash message (optional)…',
                  onAction: (paths, message) => onStash(paths, message),
                },
                {
                  label: 'Discard',
                  glyph: ICON_DISCARD,
                  tone: 'danger',
                  onAction: async (paths) => {
                    const ok = await requestConfirm({
                      title: 'Discard changes?',
                      body: `Discard changes in ${paths.length} ${
                        paths.length === 1 ? 'file' : 'files'
                      }? This cannot be undone.`,
                      confirmLabel: 'Discard',
                      destructive: true,
                    });
                    if (!ok) return;
                    void discard(repoId, paths);
                  },
                },
              ]}
            />
          </>
        )}

        <div className="mt-auto p-3 border-t border-card flex flex-col gap-2">
          <IdentityIndicator repoId={repoId} />
          <CommitMessageSuggest
            repoId={repoId}
            stagedCount={stagingMode === 'simple' ? simpleCheckedCount : staged.length}
            // In simple mode the index doesn't reflect intent — the
            // checked set does. Pass it so the LLM diffs the right
            // bytes. In advanced mode we leave this undefined and the
            // backend falls back to `git diff --cached`.
            paths={
              stagingMode === 'simple'
                ? combined.filter((f) => simpleChecked.has(f.path)).map((f) => f.path)
                : undefined
            }
            onSuggested={(text) => setMessage(text)}
          />
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              stagingMode === 'simple'
                ? amendMode
                    ? `Amend last commit${
                        simpleCheckedCount > 0 ? ` (${simpleCheckedCount} checked)` : ''
                      }`
                    : combined.length === 0
                      ? 'No changes to commit'
                      : `Commit message (${simpleCheckedCount} of ${combined.length} checked)`
                : amendMode
                  ? `Amend last commit${
                      staged.length > 0 ? ` + ${staged.length} staged` : ''
                    }`
                  : staged.length > 0
                    ? `Commit message (${staged.length} ${
                        staged.length === 1 ? 'file' : 'files'
                      } staged)`
                    : unstaged.length > 0
                      ? `Commit message (no staged set — all ${unstaged.length} will be staged on Commit)`
                      : 'Stage files to commit'
            }
            disabled={
              stagingMode === 'simple'
                ? !amendMode && combined.length === 0
                : !amendMode && staged.length === 0 && unstaged.length === 0
            }
            className="w-full px-2 py-1.5 rounded bg-surface-elevated border border-card text-sm resize-y min-h-[64px] disabled:opacity-50"
          />

          {/* Amend toggle. Disabled when there's no last commit yet
              (fresh repo). Hint underneath shows what we're rewriting
              so the user can see the target before pressing the
              button. */}
          {lastCommit && (
            <label className="flex items-start gap-2 cursor-pointer text-[11px] text-ink-muted">
              <input
                type="checkbox"
                checked={amendMode}
                onChange={(e) => setAmendMode(e.target.checked)}
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <div>Amend last commit</div>
                <div
                  className="text-[10px] text-ink-faint truncate"
                  title={lastCommit.subject}
                >
                  {lastCommit.shortSha} · {lastCommit.subject || '(no subject)'}
                </div>
              </div>
            </label>
          )}

          <button
            disabled={
              busy ||
              !message.trim() ||
              (stagingMode === 'simple'
                ? !amendMode && simpleCheckedCount === 0
                : !amendMode && staged.length === 0 && unstaged.length === 0)
            }
            onClick={onCommit}
            className={`text-sm px-3 py-1.5 rounded text-white disabled:opacity-50 flex items-center justify-center gap-2 ${
              amendMode
                ? 'bg-amber-500 hover:bg-amber-600'
                : 'bg-accent hover:bg-accent-strong'
            }`}
            title={
              amendMode
                ? "Rewrites the previous commit. Only safe if you haven't pushed it. (⌘↩)"
                : stagingMode === 'simple'
                  ? `Commits the ${simpleCheckedCount} checked file${
                      simpleCheckedCount === 1 ? '' : 's'
                    }. (⌘↩)`
                  : !amendMode && staged.length === 0 && unstaged.length > 0
                    ? `Stages every changed file, then commits. ${unstaged.length} file${
                        unstaged.length === 1 ? '' : 's'
                      } will be staged. (⌘↩)`
                    : 'Commit (⌘↩)'
            }
          >
            <span>
              {amendMode
                ? stagingMode === 'simple'
                  ? `Amend${simpleCheckedCount > 0 ? ` (${simpleCheckedCount})` : ''}`
                  : `Amend${staged.length > 0 ? ` + ${staged.length}` : ''}`
                : stagingMode === 'simple'
                  ? simpleCheckedCount > 0
                    ? `Commit ${simpleCheckedCount}`
                    : 'Commit'
                  : staged.length > 0
                    ? `Commit ${staged.length}`
                    : unstaged.length > 0
                      ? `Commit all (${unstaged.length})`
                      : 'Commit'}
            </span>
            <kbd className="text-[13px] text-white/85 font-mono">⌘↩</kbd>
          </button>
        </div>
      </aside>

      <section className="overflow-y-auto col-start-2 row-start-2">
        {selected ? (
          <ChangesDiffPane
            repoId={repoId}
            files={diffEntry?.files ?? []}
            side={selected.side}
          />
        ) : (
          <div className="p-4 text-sm text-ink-faint">
            Pick a file on the left to see its diff.
          </div>
        )}
      </section>
    </div>
  );
}

/// Inline "✨ Suggest" affordance above the commit message box. Picks
/// the first available LLM CLI by default (claude > codex > gemini),
/// runs `cli:suggestCommitMessage` on the staged diff, and drops the
/// result into the commit input on success.
function IdentityIndicator({ repoId }: { repoId: UUID }): JSX.Element | null {
  const setSheet = useStore((s) => s.setSheet);
  const [resolved, setResolved] = useState<ResolvedIdentity | null>(null);

  // Re-resolve when the repo changes or after a commit lands (other
  // commits may have changed local config). The store doesn't have a
  // commit-finished pubsub yet, but refreshing on every status tick is
  // overkill — keep it on mount + repoId. The user can also reopen the
  // pane to refresh.
  useEffect(() => {
    let cancelled = false;
    void window.overgit.invoke('repo:resolveIdentity', repoId).then((r) => {
      if (!cancelled) setResolved(r);
    });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  if (!resolved) return null;

  // Tone — the wrong-user bug almost always lives in `system` (we
  // silently inherit the global ~/.gitconfig). Surface that in amber so
  // it's visible even when the user wasn't looking for it. `unset` is
  // outright red — commits will fail.
  const tone =
    resolved.source === 'unset'
      ? 'border-red-500/40 bg-red-500/10 text-red-200'
      : resolved.source === 'system'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
        : 'border-card bg-card/40 text-ink-muted';

  const sourceLabel: Record<ResolvedIdentity['source'], string> = {
    override: 'per-repo override',
    'repo-config': "repo's git config",
    'global-default': 'overgit default',
    system: 'system git config',
    unset: 'NOT SET',
  };

  return (
    <button
      onClick={() => setSheet({ kind: 'manageRepo', repoId, tab: 'identity' })}
      className={`text-left text-[10px] px-2 py-1.5 rounded border ${tone} hover:opacity-90 transition-opacity`}
      title="Click to change the per-repo identity override"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="uppercase tracking-wide opacity-70">Committing as</span>
        <span className="opacity-70 truncate">{sourceLabel[resolved.source]}</span>
      </div>
      <div className="mt-0.5 truncate">
        <span className="font-medium">
          {resolved.name || <span className="opacity-60">(no name)</span>}
        </span>{' '}
        <span className="font-mono opacity-70">
          &lt;{resolved.email || '(no email)'}&gt;
        </span>
      </div>
    </button>
  );
}

function CommitMessageSuggest({
  repoId,
  stagedCount,
  paths,
  onSuggested,
}: {
  repoId: UUID;
  stagedCount: number;
  /// Optional path list for select-vs-stage mode. When set, the LLM
  /// diffs these paths vs HEAD instead of the (often empty) git index.
  paths?: string[];
  onSuggested: (text: string) => void;
}): JSX.Element {
  const cli = useStore((s) => s.cliPresence);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'drafting'; tool: LlmTool }
    | { kind: 'ok'; tool: LlmTool }
    | { kind: 'err'; message: string }
  >({ kind: 'idle' });

  const tool: LlmTool | null = useMemo(() => {
    if (cli?.claude) return 'claude';
    if (cli?.codex) return 'codex';
    if (cli?.gemini) return 'gemini';
    return null;
  }, [cli]);

  // Auto-clear the success badge after a couple seconds so the row
  // settles back to "Commit message" and the user can re-suggest
  // without the stale ✓ confusing them.
  useEffect(() => {
    if (status.kind !== 'ok') return;
    const t = setTimeout(() => setStatus({ kind: 'idle' }), 2500);
    return () => clearTimeout(t);
  }, [status]);

  // Wrap in useCallback so the suggestor closure tracks all the props
  // and store values it actually depends on. The earlier inline arrow
  // version was declared *below* the event-listener effect, so the
  // listener captured a stale function and `eslint-disable` hid it —
  // the safer pattern is one canonical useCallback that the effect
  // depends on directly.
  const runSuggest = useCallback(async () => {
    if (!tool) return;
    if (stagedCount === 0) {
      setStatus({ kind: 'err', message: 'Stage some changes first.' });
      return;
    }
    setBusy(true);
    setStatus({ kind: 'drafting', tool });
    try {
      const res = await window.overgit.invoke('cli:suggestCommitMessage', {
        repoId,
        tool,
        paths,
      });
      if (!res.ok) {
        setStatus({ kind: 'err', message: res.error ?? 'Suggest failed' });
        return;
      }
      onSuggested(res.message);
      setStatus({ kind: 'ok', tool: res.tool });
    } finally {
      setBusy(false);
    }
  }, [tool, stagedCount, repoId, paths, onSuggested]);

  // Listen for Cmd+K → "Stage all & suggest commit message" which
  // dispatches `overgit:suggestCommitMessage` after navigating here.
  // The listener depends directly on `runSuggest` so it always sees the
  // current closure — no stale-callback risk.
  useEffect(() => {
    const fire = () => {
      if (busy) return;
      void runSuggest();
    };
    window.addEventListener('overgit:suggestCommitMessage', fire);
    return () => window.removeEventListener('overgit:suggestCommitMessage', fire);
  }, [runSuggest, busy]);

  const onClick = runSuggest;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-ink-faint">Commit message</span>
        <StatusPill status={status} />
      </div>
      {tool ? (
        // The StatusPill above carries the in-flight state ("Drafting
        // with claude…") so the button label stays stable here.
        // Earlier we duplicated that string into the button which made
        // the row read like the action was happening twice. Keep the
        // button consistent — just disable it while busy.
        <button
          onClick={onClick}
          disabled={busy || stagedCount === 0}
          className="self-end text-[11px] px-2 py-1 rounded border border-card hover:bg-card disabled:opacity-50 flex items-center gap-1"
          title={
            stagedCount === 0
              ? 'Stage changes first'
              : `Draft a commit message with ${tool}`
          }
        >
          <span>✨</span>
          <span>Suggest with {tool}</span>
        </button>
      ) : (
        <span
          className="self-end text-[10px] text-ink-faint"
          title="Install claude, codex, or gemini to enable suggestions"
        >
          Install an LLM CLI to enable Suggest
        </span>
      )}
    </div>
  );
}

function StatusPill({
  status,
}: {
  status:
    | { kind: 'idle' }
    | { kind: 'drafting'; tool: LlmTool }
    | { kind: 'ok'; tool: LlmTool }
    | { kind: 'err'; message: string };
}): JSX.Element | null {
  if (status.kind === 'idle') return null;
  if (status.kind === 'drafting') {
    return (
      <span className="text-[10px] text-ink-muted flex items-center gap-1">
        <Spinner />
        Drafting with {status.tool}…
      </span>
    );
  }
  if (status.kind === 'ok') {
    return (
      <span className="text-[10px] text-emerald-400">
        ✓ Suggested by {status.tool} — review &amp; edit before committing
      </span>
    );
  }
  return (
    <span className="text-[10px] text-red-400 truncate max-w-[280px]" title={status.message}>
      {status.message}
    </span>
  );
}

function Spinner(): JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      className="animate-spin"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        opacity="0.25"
      />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface BulkAction {
  /// Short label, used in the visible button.
  label: string;
  /// Optional inline svg glyph; renders left of the label so the bar
  /// reads at a glance even when collapsed to icon-only on tight widths.
  glyph?: React.ReactNode;
  tone?: 'primary' | 'neutral' | 'danger';
  /// "with-message": clicking the button opens an inline message
  /// input on the bulk bar instead of running immediately. Used by
  /// Stash so the user can label the entry. Default is "fire on click."
  kind?: 'fire' | 'with-message';
  /// Placeholder shown in the inline message input. Ignored unless
  /// `kind: 'with-message'`.
  messagePlaceholder?: string;
  onAction: (paths: string[], message?: string) => void;
}

/// Banner that appears at the top of the Changes tab whenever git
/// reports an in-progress merge / rebase / cherry-pick. The user gets
/// a path forward (continue / abort) without having to drop to a
/// terminal, plus a one-click "mark all resolved" when every conflict
/// is squared away.
function ConflictBanner({
  repoId,
  status,
}: {
  repoId: UUID;
  status: RepoStatus;
}): JSX.Element {
  const op = status.inProgress!;
  const conflicts = status.conflicts;
  const repos = useStore((s) => s.repos);
  const repoPath = repos.find((r) => r.id === repoId)?.path;
  const stage = useStore((s) => s.stageFiles);
  const abortMerge = useStore((s) => s.abortMerge);
  const abortRebase = useStore((s) => s.abortRebase);
  const continueRebase = useStore((s) => s.continueRebase);
  const abortCherryPick = useStore((s) => s.abortCherryPick);
  const continueCherryPick = useStore((s) => s.continueCherryPick);
  const markResolved = useStore((s) => s.markResolved);
  const openRepoFile = useStore((s) => s.openRepoFile);
  const requestConfirm = useStore((s) => s.requestConfirm);
  const refreshStatus = useStore((s) => s.refreshRepoStatus);
  const refreshChanges = useStore((s) => s.refreshRepoChanges);

  const onOpen = (relPath: string) => {
    if (!repoPath) return;
    window.dispatchEvent(new CustomEvent('overgit:setRepoTab', { detail: 'files' }));
    void openRepoFile(repoId, joinRepoPath(repoPath, relPath));
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remaining = conflicts.length;
  const allResolved = remaining === 0;

  const onAbort = async () => {
    const ok = await requestConfirm({
      title: `Abort ${op}?`,
      body: `Abort the in-progress ${op}? This rolls the working tree back to before it started.`,
      confirmLabel: 'Abort',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const fn =
        op === 'merge' ? abortMerge : op === 'rebase' ? abortRebase : abortCherryPick;
      const res = await fn(repoId);
      if (!res.ok) setError(res.error ?? 'Abort failed');
    } finally {
      setBusy(false);
    }
  };

  const onContinue = async () => {
    setBusy(true);
    setError(null);
    try {
      // Merge has no `--continue`: once conflicts are resolved, the
      // user makes a regular commit which finalizes the merge. We
      // surface that by linking to the commit form.
      if (op === 'merge') {
        setError(
          'Merge: stage the resolved files (or use "Mark all resolved"), then commit from the message box below to finalize.',
        );
        return;
      }
      const fn = op === 'rebase' ? continueRebase : continueCherryPick;
      const res = await fn(repoId);
      if (!res.ok) setError(res.error ?? 'Continue failed');
    } finally {
      setBusy(false);
    }
  };

  const onMarkAll = async () => {
    if (conflicts.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await markResolved(repoId, conflicts);
      if (!res.ok) setError(res.error ?? 'Mark resolved failed');
    } finally {
      setBusy(false);
    }
  };

  const onMarkOne = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await markResolved(repoId, [path]);
      if (!res.ok) setError(res.error ?? 'Mark resolved failed');
    } finally {
      setBusy(false);
    }
  };

  const opLabel =
    op === 'merge' ? 'Merge in progress' : op === 'rebase' ? 'Rebase in progress' : 'Cherry-pick in progress';

  return (
    <div
      className={`px-4 py-3 border-b ${
        allResolved
          ? 'bg-emerald-500/10 border-emerald-500/30'
          : 'bg-amber-500/10 border-amber-500/30'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold flex items-center gap-2">
            <span
              className={
                allResolved ? 'text-emerald-300' : 'text-amber-300'
              }
            >
              {opLabel}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-ink-faint">
              {allResolved
                ? 'all conflicts resolved · ready to continue'
                : `${remaining} ${remaining === 1 ? 'file' : 'files'} unresolved`}
            </span>
          </div>
          {!allResolved && (
            <div className="text-[11px] text-ink-muted mt-0.5">
              Open each file in your editor, fix the {'<<<<<<<'} / {'>>>>>>>'} markers, then mark resolved.
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {!allResolved && conflicts.length > 0 && (
            <button
              disabled={busy}
              onClick={onMarkAll}
              className="text-[11px] h-7 px-2.5 rounded border border-card hover:bg-card disabled:opacity-50"
              title="git add — marks every conflicted file as resolved"
            >
              Mark all resolved
            </button>
          )}
          {allResolved && op !== 'merge' && (
            <button
              disabled={busy}
              onClick={onContinue}
              className="text-[11px] h-7 px-2.5 rounded bg-accent text-white hover:bg-accent-strong border border-accent disabled:opacity-50"
            >
              Continue
            </button>
          )}
          <button
            disabled={busy}
            onClick={onAbort}
            className="text-[11px] h-7 px-2.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
          >
            Abort
          </button>
          <button
            onClick={() => {
              void refreshStatus(repoId);
              void refreshChanges(repoId);
            }}
            className="text-[11px] h-7 px-2 rounded text-ink-faint hover:text-ink hover:bg-card"
            title="Re-check git status"
          >
            ↻
          </button>
        </div>
      </div>

      {!allResolved && conflicts.length > 0 && (
        <ul className="mt-3 flex flex-col gap-0.5 max-h-[160px] overflow-y-auto">
          {conflicts.map((p) => (
            <li
              key={p}
              className="flex items-center gap-2 text-[11px] py-0.5 hover:bg-amber-500/10 rounded px-1"
            >
              <span className="font-mono truncate flex-1" title={p}>
                {p}
              </span>
              <button
                onClick={() => onOpen(p)}
                className="text-[10px] uppercase tracking-wide text-ink-faint hover:text-ink px-1.5"
                title="Open in editor — fix the <<<<<<< / >>>>>>> markers"
              >
                Open
              </button>
              <button
                disabled={busy}
                onClick={() => onMarkOne(p)}
                className="text-[10px] uppercase tracking-wide text-amber-300 hover:text-emerald-300 px-1.5"
                title="git add this path"
              >
                Resolve
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className="mt-2 text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5 flex items-start gap-2">
          <span className="flex-1 whitespace-pre-wrap">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-ink-faint hover:text-ink"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

function FileGroup({
  title,
  files,
  activePath,
  actionLabel,
  onAction,
  onSelect,
  onView,
  extraAction,
  checked,
  onToggleChecked,
  onSetAllChecked,
  bulkActions,
}: {
  title: string;
  files: ChangedFile[];
  activePath: string | null;
  actionLabel: string;
  onAction: (file: ChangedFile) => void;
  onSelect: (file: ChangedFile) => void;
  onView?: (file: ChangedFile) => void;
  extraAction?: { label: string; onAction: (file: ChangedFile) => void };
  checked: Set<string>;
  onToggleChecked: (path: string) => void;
  onSetAllChecked: (all: boolean) => void;
  /// Bulk actions shown in the slide-down toolbar that appears when at
  /// least one file is selected. Order matters — first one is rendered
  /// in primary color so the most-likely action sits on the left.
  bulkActions: BulkAction[];
}): JSX.Element {
  const checkedCount = files.reduce((n, f) => (checked.has(f.path) ? n + 1 : n), 0);
  const allChecked = files.length > 0 && checkedCount === files.length;
  const someChecked = checkedCount > 0;
  const checkedPaths = files.filter((f) => checked.has(f.path)).map((f) => f.path);

  // Inline-message mode for actions that ask for one (Stash). When
  // non-null, the bulk bar transforms into a single-line input + Save
  // / Cancel pair instead of the action buttons.
  const [pending, setPending] = useState<BulkAction | null>(null);
  const [pendingMsg, setPendingMsg] = useState('');
  // Selection changes (e.g. apply/stage drained the group) should
  // dismiss the pending input — otherwise the bar shows an input for
  // an action whose target paths just disappeared.
  useEffect(() => {
    if (!someChecked && pending) {
      setPending(null);
      setPendingMsg('');
    }
  }, [someChecked, pending]);

  return (
    <div className="border-b border-card">
      {/* Static title row — uncluttered, keeps the visual hierarchy
          stable as the selection toggles. The select-all checkbox
          stays here because it's the entry point into multi-select. */}
      <div className="flex items-center gap-2 px-3 py-2 bg-card">
        <input
          type="checkbox"
          checked={allChecked}
          ref={(el) => {
            // `indeterminate` isn't a React-prop; set it via ref so the
            // tri-state on the header matches the user's selection.
            if (el) el.indeterminate = someChecked && !allChecked;
          }}
          onChange={(e) => onSetAllChecked(e.target.checked)}
          disabled={files.length === 0}
          className="cursor-pointer"
          aria-label={`Select all ${title.toLowerCase()}`}
        />
        <div className="text-[10px] uppercase tracking-wide text-ink-faint">
          {title} <span className="text-ink-faint">({files.length})</span>
        </div>
      </div>

      {/* Bulk-action bar — separate row that only renders when there's
          a selection. Single-purpose row means the buttons can size
          themselves without competing with the title for width.
          `flex-nowrap` + `min-w-0` on each region keep the row on one
          line; the pill carries the count so per-button counts are
          dropped below to prevent the cramped two-line wrap. */}
      {someChecked && (
        <div className="flex flex-nowrap items-center gap-2 px-3 py-1.5 bg-accent/10">
          {pending ? (
            <>
              <span className="text-[11px] font-medium text-accent whitespace-nowrap inline-flex items-center gap-1 flex-shrink-0">
                <span className="font-mono">{checkedCount}</span>
                <span>·</span>
                <span>{pending.label}</span>
              </span>
              <input
                autoFocus
                value={pendingMsg}
                onChange={(e) => setPendingMsg(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    pending.onAction(checkedPaths, pendingMsg.trim() || undefined);
                    setPending(null);
                    setPendingMsg('');
                  } else if (e.key === 'Escape') {
                    setPending(null);
                    setPendingMsg('');
                  }
                }}
                placeholder={pending.messagePlaceholder ?? 'Optional message…'}
                className="field flex-1 min-w-0 px-2 py-1 text-[11px]"
              />
              <button
                onClick={() => {
                  pending.onAction(checkedPaths, pendingMsg.trim() || undefined);
                  setPending(null);
                  setPendingMsg('');
                }}
                className="text-[11px] h-7 px-2.5 rounded-md bg-accent text-white hover:bg-accent-strong border border-accent flex-shrink-0"
              >
                {pending.label}
              </button>
              <button
                onClick={() => {
                  setPending(null);
                  setPendingMsg('');
                }}
                className="text-[11px] w-7 h-7 rounded text-ink-muted hover:bg-card hover:text-ink flex items-center justify-center flex-shrink-0"
                title="Cancel"
                aria-label="Cancel"
              >
                ✕
              </button>
            </>
          ) : (
            <>
              <span className="text-[11px] font-medium text-accent whitespace-nowrap min-w-0 inline-flex items-center gap-1">
                <span className="font-mono">{checkedCount}</span>
                <span>selected</span>
              </span>
              <div className="flex flex-nowrap items-center gap-1 ml-auto">
                {bulkActions.map((a, i) => (
                  <BulkActionButton
                    key={a.label}
                    action={a}
                    paths={checkedPaths}
                    emphasis={a.tone ?? (i === 0 ? 'primary' : 'neutral')}
                    onClick={() => {
                      if (a.kind === 'with-message') {
                        setPending(a);
                        setPendingMsg('');
                      } else {
                        a.onAction(checkedPaths);
                      }
                    }}
                  />
                ))}
                <button
                  onClick={() => onSetAllChecked(false)}
                  className="text-[11px] w-7 h-7 rounded text-ink-muted hover:bg-card hover:text-ink flex items-center justify-center flex-shrink-0"
                  title="Clear selection"
                  aria-label="Clear selection"
                >
                  ✕
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {files.length === 0 ? (
        <div className="px-3 py-2 text-xs text-ink-faint">No files.</div>
      ) : (
        <ul>
          {files.map((f) => {
            const active = activePath === f.path;
            return (
              <li
                key={`${title}:${f.path}`}
                className={`group flex items-center gap-2 px-3 py-1 border-b border-card last:border-0 ${
                  active ? 'bg-accent text-white' : 'hover:bg-card'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked.has(f.path)}
                  onChange={() => onToggleChecked(f.path)}
                  onClick={(e) => e.stopPropagation()}
                  className="cursor-pointer flex-shrink-0"
                  aria-label={`Select ${f.path}`}
                />
                <ChangeStatusBadge file={f} />
                <button
                  onClick={() => onSelect(f)}
                  className="min-w-0 flex-1 text-left flex items-baseline gap-2 truncate"
                  title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
                >
                  <PathLabel path={f.path} origPath={f.origPath} active={active} />
                </button>
                <div
                  className={`flex gap-1 transition-opacity ${
                    active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
                  }`}
                >
                  {onView && f.indexStatus !== 'D' && f.worktreeStatus !== 'D' && (
                    <button
                      onClick={() => onView(f)}
                      className={`text-[11px] px-1.5 py-0.5 rounded ${
                        active
                          ? 'hover:bg-accent-strong text-white'
                          : 'text-ink-muted hover:bg-surface-elevated hover:text-ink'
                      }`}
                      title="Open in Files tab"
                    >
                      View
                    </button>
                  )}
                  <button
                    onClick={() => onAction(f)}
                    className={`text-[11px] px-1.5 py-0.5 rounded ${
                      active
                        ? 'hover:bg-accent-strong text-white'
                        : 'text-ink-muted hover:bg-surface-elevated hover:text-ink'
                    }`}
                  >
                    {actionLabel}
                  </button>
                  {extraAction && (
                    <button
                      onClick={() => extraAction.onAction(f)}
                      className={`text-[11px] px-1.5 py-0.5 rounded ${
                        active
                          ? 'hover:bg-accent-strong text-white'
                          : 'text-ink-muted hover:bg-surface-elevated hover:text-red-300'
                      }`}
                      title={extraAction.label}
                    >
                      {extraAction.label}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/// File-name + dim parent-path label. We render the leaf filename in
/// the row's normal ink color and the directory portion at a lower
/// emphasis (smaller, faint), which is the GitHub Desktop / VS Code
/// convention. Renames show the original→new in the same shape on the
/// title attribute already; the body just shows the new filename.
/// Tone-aware bulk-action button used inside the FileGroup's
/// slide-down bar. Three tones: `primary` (accent fill, used for the
/// most likely action), `neutral` (subtle border, used for siblings
/// like Stash), `danger` (red border for Discard). All three share the
/// same height so the bar stays a clean horizontal line on any width.
function BulkActionButton({
  action,
  paths,
  emphasis,
  onClick,
}: {
  action: BulkAction;
  paths: string[];
  emphasis: 'primary' | 'neutral' | 'danger';
  /// Caller owns dispatch — it may swap the bar into a message-input
  /// mode for `kind: 'with-message'` actions instead of firing onAction
  /// straight away. Defaults to `action.onAction(paths)` when omitted.
  onClick?: () => void;
}): JSX.Element {
  const cls =
    emphasis === 'primary'
      ? 'bg-accent text-white hover:bg-accent-strong border border-accent'
      : emphasis === 'danger'
        ? 'border border-red-500/40 text-red-300 hover:bg-red-500/10'
        : 'border border-card text-ink hover:bg-card';
  return (
    <button
      onClick={() => (onClick ? onClick() : action.onAction(paths))}
      className={`text-[11px] h-7 px-2 rounded-md inline-flex items-center gap-1 whitespace-nowrap flex-shrink-0 ${cls}`}
      title={`${action.label} ${paths.length}`}
    >
      {action.glyph}
      <span>{action.label}</span>
    </button>
  );
}

const ICON_STAGE = (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M8 3v10M3 8h10"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);
const ICON_UNSTAGE = (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
const ICON_STASH = (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="2.5" y="6" width="11" height="6" rx="1" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5 4h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
const ICON_DISCARD = (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M5 5l6 6M11 5l-6 6"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

function PathLabel({
  path,
  origPath,
  active,
}: {
  path: string;
  origPath?: string;
  active: boolean;
}): JSX.Element {
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  return (
    <>
      <span className={`font-mono text-[12px] truncate ${active ? '' : ''}`}>{name}</span>
      {(dir || origPath) && (
        <span
          className={`font-mono text-[10px] truncate ${
            active ? 'text-white/60' : 'text-ink-faint'
          }`}
        >
          {dir}
          {origPath && <span className="ml-1 italic">← {origPath}</span>}
        </span>
      )}
    </>
  );
}

function ChangeStatusBadge({ file }: { file: ChangedFile }): JSX.Element {
  // Prefer the worktree side for unstaged, the index side for staged —
  // that's what the user's eyes track. We collapse to a single letter so
  // it sits next to the path without competing for attention.
  const ch = file.indexStatus !== ' ' && file.indexStatus !== '?' ? file.indexStatus : file.worktreeStatus;
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

/// List of stash entries on the left, the selected stash's diff on
/// the right. Apply / Pop / Drop act on the entry by its `stash@{N}`
/// index. Drop confirms first since it's destructive.
function StashTab({ repoId }: { repoId: UUID }): JSX.Element {
  const stashes = useStore((s) => s.repoStashes[repoId]);
  const refreshStashes = useStore((s) => s.refreshRepoStashes);
  const applyStash = useStore((s) => s.applyStash);
  const applyStashForce = useStore((s) => s.applyStashForce);
  const dropStash = useStore((s) => s.dropStash);
  const requestConfirm = useStore((s) => s.requestConfirm);
  // Note: no `openFile` here on purpose. A stash diff shows the
  // stashed content, which usually doesn't match what's on disk —
  // clicking Open would either silently load the wrong version
  // (working tree) or fail (file deleted). Apply / Pop the stash
  // first to surface the file in the working tree, then open it.

  const [selected, setSelected] = useState<number | null>(null);
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Surface git's apply errors inline (instead of alert) so the user
  // can see exactly what's blocking and act on it. `conflicts` is
  // populated when git reports "<path> already exists, no checkout";
  // we render it as a force-overwrite affordance.
  const [error, setError] = useState<{
    message: string;
    conflicts?: string[];
    pop: boolean;
  } | null>(null);

  useEffect(() => {
    refreshStashes(repoId);
  }, [refreshStashes, repoId]);

  // Load the diff for the currently-selected stash. Re-fires when the
  // list refreshes (e.g. after pop) so the right pane stays consistent.
  useEffect(() => {
    if (selected == null) {
      setFiles(null);
      return;
    }
    let cancelled = false;
    window.overgit
      .invoke('repo:stashDiff', { repoId, index: selected })
      .then((res) => {
        if (!cancelled) setFiles(res);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, selected, stashes]);

  // After apply/pop the stash list mutates: pop removes the entry, so
  // selection should clear; apply keeps it. Settle on the first entry
  // after a refresh if the previous selection went away.
  useEffect(() => {
    if (!stashes) return;
    if (selected == null) return;
    if (!stashes.some((s) => s.index === selected)) {
      setSelected(stashes[0]?.index ?? null);
    }
  }, [stashes, selected]);

  const onApply = async (index: number, pop: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await applyStash(repoId, index, pop);
      if (!res.ok) {
        setError({ message: res.error ?? 'Apply failed', conflicts: res.conflicts, pop });
      }
    } finally {
      setBusy(false);
    }
  };

  const onForceApply = async () => {
    if (selected == null || !error) return;
    const ok = await requestConfirm({
      title: 'Force overwrite?',
      body: `Force overwrite ${error.conflicts?.length ?? 0} working-tree ${
        error.conflicts?.length === 1 ? 'file' : 'files'
      } and ${error.pop ? 'pop' : 'apply'} the stash? The local copies are deleted before the stash content is restored.`,
      confirmLabel: 'Force overwrite',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await applyStashForce(repoId, selected, error.pop);
      if (!res.ok) {
        setError({ message: res.error ?? 'Force apply failed', pop: error.pop });
      } else {
        setError(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const onDrop = async (index: number) => {
    const ok = await requestConfirm({
      title: `Drop stash@{${index}}?`,
      body: `Drop stash@{${index}}? This is irreversible — the contents are lost.`,
      confirmLabel: 'Drop',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await dropStash(repoId, index);
      if (!res.ok) setError({ message: res.error ?? 'Drop failed', pop: false });
    } finally {
      setBusy(false);
    }
  };

  // Switching selected stash should reset the per-row error so we
  // don't keep showing a stale "X already exists" message on a
  // different entry.
  useEffect(() => {
    setError(null);
  }, [selected]);

  const selectedStash = stashes?.find((s) => s.index === selected) ?? null;

  return (
    <main className="flex-1 grid grid-cols-[340px_1fr] grid-rows-[auto_1fr] overflow-hidden">
      <header className="col-span-2 px-6 py-3 border-b border-card flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Stashes</h2>
          <p className="text-[11px] text-ink-faint">
            {stashes == null
              ? 'Loading…'
              : stashes.length === 0
                ? 'No stashes — `git stash push` from your terminal or use Stash & retry on a workspace checkout.'
                : `${stashes.length} ${stashes.length === 1 ? 'entry' : 'entries'}`}
          </p>
        </div>
        <button
          onClick={() => refreshStashes(repoId)}
          className="text-xs px-3 py-1 rounded border border-card hover:bg-card"
        >
          Refresh
        </button>
      </header>

      <aside className="overflow-y-auto border-r border-card">
        {stashes && stashes.length > 0 ? (
          <ul>
            {stashes.map((s) => {
              const active = selected === s.index;
              return (
                <li key={s.ref}>
                  <button
                    onClick={() => setSelected(s.index)}
                    style={{ height: ROW_HEIGHT }}
                    className={`w-full text-left flex items-center gap-2 px-3 text-xs border-b border-card ${
                      active ? 'bg-accent text-white' : 'hover:bg-card'
                    }`}
                  >
                    {/* Single-line row, mirrors the History tab so the
                        two views feel cut from the same cloth. Layout:
                        index pill → branch tag → subject (flex) →
                        sha → relative time. */}
                    <span
                      className={`text-[9px] font-mono uppercase tracking-wide px-1 py-0.5 rounded leading-none flex-shrink-0 ${
                        active
                          ? 'bg-white/20 text-white'
                          : 'bg-card text-ink-muted border border-card'
                      }`}
                    >
                      {`{${s.index}}`}
                    </span>
                    {s.branch && (
                      <span
                        className={`text-[10px] font-mono flex-shrink-0 ${
                          active ? 'text-white/80' : 'text-sky-300/80'
                        }`}
                      >
                        on {s.branch}
                      </span>
                    )}
                    <span
                      className={`truncate flex-1 min-w-0 ${active ? 'font-medium' : ''}`}
                      title={s.subject}
                    >
                      {s.subject || (
                        <span className={active ? 'text-white/70' : 'text-ink-faint'}>
                          (no message)
                        </span>
                      )}
                    </span>
                    <span
                      className={`font-mono w-14 truncate text-right flex-shrink-0 ${
                        active ? 'text-white/70' : 'text-ink-faint'
                      }`}
                    >
                      {s.shortSha}
                    </span>
                    <span
                      className={`whitespace-nowrap text-right tabular-nums w-12 flex-shrink-0 ${
                        active ? 'text-white/70' : 'text-ink-faint'
                      }`}
                    >
                      {relativeOrAbsolute(s.date)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </aside>

      <section className="flex flex-col min-h-0 overflow-hidden">
        {selectedStash ? (
          <>
            {/* Detail header — subject + meta on the left, action
                cluster on the right. Keeps the list rows uncluttered
                and gives the actions consistent sizing + tone. */}
            <div className="flex items-start gap-3 px-4 py-3 border-b border-card">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate" title={selectedStash.subject}>
                  {selectedStash.subject || '(no message)'}
                </div>
                <div className="mt-0.5 text-[11px] text-ink-faint font-mono flex flex-wrap gap-x-2 gap-y-0.5">
                  <span>
                    stash@{'{'}
                    {selectedStash.index}
                    {'}'}
                  </span>
                  <span>{selectedStash.shortSha}</span>
                  {selectedStash.branch && <span>on {selectedStash.branch}</span>}
                  <span>{relativeAgo(selectedStash.date)}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  disabled={busy}
                  onClick={() => onApply(selectedStash.index, false)}
                  className="text-[11px] h-7 px-2.5 rounded-md border border-card text-ink hover:bg-card disabled:opacity-50"
                  title="git stash apply — keeps the stash"
                >
                  Apply
                </button>
                <button
                  disabled={busy}
                  onClick={() => onApply(selectedStash.index, true)}
                  className="text-[11px] h-7 px-2.5 rounded-md bg-accent text-white hover:bg-accent-strong border border-accent disabled:opacity-50"
                  title="git stash pop — applies and drops the stash"
                >
                  Pop
                </button>
                <button
                  disabled={busy}
                  onClick={() => onDrop(selectedStash.index)}
                  className="text-[11px] h-7 px-2.5 rounded-md border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                  title="git stash drop — irreversible"
                >
                  Drop
                </button>
              </div>
            </div>
            {error && (
              <div className="px-4 py-3 border-b border-red-500/30 bg-red-500/10">
                <div className="text-[11px] font-semibold text-red-300">
                  Git refused to {error.pop ? 'pop' : 'apply'} this stash.
                </div>
                <pre className="mt-1 text-[11px] text-ink-muted whitespace-pre-wrap font-mono leading-snug">
                  {error.message}
                </pre>
                {error.conflicts && error.conflicts.length > 0 && (
                  <>
                    <div className="mt-3 text-[10px] uppercase tracking-wide text-ink-faint">
                      Conflicting working-tree files
                    </div>
                    <ul className="mt-1 text-[11px] font-mono text-ink-muted">
                      {error.conflicts.map((c) => (
                        <li key={c} className="truncate" title={c}>
                          · {c}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-3 flex gap-2">
                      <button
                        disabled={busy}
                        onClick={onForceApply}
                        className="text-[11px] h-7 px-2.5 rounded-md bg-red-500/30 text-red-100 hover:bg-red-500/40 border border-red-500/50 disabled:opacity-50"
                        title="Delete the working-tree copies and re-run apply"
                      >
                        {busy ? 'Working…' : 'Overwrite & retry'}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => setError(null)}
                        className="text-[11px] h-7 px-2.5 rounded-md border border-card text-ink hover:bg-card disabled:opacity-50"
                      >
                        Dismiss
                      </button>
                    </div>
                  </>
                )}
                {!error.conflicts?.length && (
                  <div className="mt-2 flex justify-end">
                    <button
                      onClick={() => setError(null)}
                      className="text-[11px] h-7 px-2.5 rounded-md border border-card text-ink hover:bg-card"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              <DiffView files={files ?? []} />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-ink-faint">
            Pick a stash on the left to preview it.
          </div>
        )}
      </section>
    </main>
  );
}

/// Branches tab. Two sections so the local branch landscape and the
/// on-disk landscape don't visually blur together:
///
///   1. Local branches — every refs/heads ref, annotated with the
///      worktree that has it checked out (if any). Clicking a row
///      switches the main repo when the branch isn't owned by some
///      other worktree; if it IS owned, the row links to the owning
///      path so the user can either jump to it on disk or adopt it
///      back into the main checkout via the linked worktree's
///      "Switch main repo here" affordance.
///
///   2. Linked worktrees — siblings of the main checkout (`!isMain`).
///      The main repo itself is omitted because it's the directory the
///      user is already looking at; rendering it here just adds noise.
function BranchesTab({ repoId }: { repoId: UUID }): JSX.Element {
  const wts = useStore((s) => s.workspaceWorktrees[repoId]);
  const repoPath = useStore((s) => s.repos.find((r) => r.id === repoId)?.path);
  const branches = useStore((s) => s.repoBranchSummaries[repoId]);
  const refreshWorktrees = useStore((s) => s.refreshRepoWorktrees);
  const refreshBranches = useStore((s) => s.refreshRepoBranchSummaries);
  const checkoutRepo = useStore((s) => s.checkoutRepo);
  const pruneWorktrees = useStore((s) => s.pruneWorktrees);
  const pushToast = useStore((s) => s.pushToast);
  const requestConfirm = useStore((s) => s.requestConfirm);
  const [busy, setBusy] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void refreshWorktrees(repoId);
    void refreshBranches(repoId);
    setFilter('');
  }, [refreshWorktrees, refreshBranches, repoId]);

  const onRefresh = async () => {
    setBusy(true);
    try {
      await Promise.all([refreshWorktrees(repoId), refreshBranches(repoId)]);
    } finally {
      setBusy(false);
    }
  };

  const linked = useMemo(() => (wts ?? []).filter((w) => !w.isMain), [wts]);
  // branchName → worktree path that owns it. Used to annotate branch
  // rows and decide whether a click should switch or just navigate.
  const ownership = useMemo(() => {
    const m = new Map<string, Worktree>();
    for (const w of wts ?? []) if (w.branch) m.set(w.branch, w);
    return m;
  }, [wts]);

  const localBranches = useMemo(
    () => (branches ?? []).filter((b) => b.kind === 'local'),
    [branches],
  );

  const q = filter.trim().toLowerCase();
  const filteredLocal = useMemo(() => {
    if (!q) return localBranches;
    return localBranches.filter(
      (b) =>
        b.shortName.toLowerCase().includes(q) ||
        b.subject.toLowerCase().includes(q) ||
        b.shortSha.toLowerCase().includes(q),
    );
  }, [localBranches, q]);
  const filteredLinked = useMemo(() => {
    if (!q) return linked;
    return linked.filter(
      (w) =>
        (w.branch ?? '').toLowerCase().includes(q) ||
        w.path.toLowerCase().includes(q),
    );
  }, [linked, q]);

  const hasPrunable = useMemo(() => (wts ?? []).some((w) => w.prunable), [wts]);

  const onSwitchBranch = async (name: string) => {
    setSwitching(name);
    try {
      const out = await checkoutRepo(repoId, name, false);
      if (out.result === 'dirty') {
        pushToast({
          kind: 'warn',
          message: `Can't switch to ${name}: working tree is dirty. Stash or commit first.`,
        });
      } else if (out.result === 'error' || out.result === 'missing-branch') {
        pushToast({ kind: 'error', message: out.message ?? 'Checkout failed' });
      }
    } finally {
      setSwitching(null);
    }
  };

  const onPrune = async () => {
    const ok = await requestConfirm({
      title: 'Prune worktrees?',
      body: 'Run `git worktree prune`? Removes administrative records for worktrees whose directories were deleted manually. Safe — it never touches files on disk.',
      confirmLabel: 'Prune',
    });
    if (!ok) return;
    setPruning(true);
    try {
      const res = await pruneWorktrees(repoId);
      if (!res.ok) {
        pushToast({ kind: 'error', message: res.error ?? 'Prune failed' });
      } else if (res.output) {
        pushToast({ kind: 'success', message: `Pruned:\n${res.output}` });
      } else {
        pushToast({ kind: 'success', message: 'Worktrees pruned.' });
      }
    } finally {
      setPruning(false);
    }
  };

  return (
    <main className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-sm font-semibold">Branches</h2>
          <p className="text-[11px] text-ink-faint">
            Local branches you can switch to, plus any linked worktrees that have a branch
            checked out elsewhere on disk.
          </p>
        </div>
        <button
          onClick={onRefresh}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-50"
        >
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <div className="flex items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter branches by name, subject, sha, path…"
          className="field flex-1 px-2 py-1 text-[11px]"
        />
        {filter && (
          <button
            onClick={() => setFilter('')}
            className="text-[10px] text-ink-muted hover:text-ink px-1.5 py-1 rounded hover:bg-card"
            title="Clear filter"
          >
            ✕
          </button>
        )}
      </div>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[10px] uppercase tracking-wide text-ink-faint">
            Local branches ({filteredLocal.length}
            {q && filteredLocal.length !== localBranches.length
              ? ` of ${localBranches.length}`
              : ''}
            )
          </h3>
          <span className="text-[10px] text-ink-faint">click to switch · ⎇ marks current</span>
        </div>
        {branches === undefined ? (
          <div className="text-xs text-ink-faint">Loading…</div>
        ) : localBranches.length === 0 ? (
          <div className="text-xs text-ink-faint p-3 rounded border border-card bg-card">
            No local branches.
          </div>
        ) : filteredLocal.length === 0 ? (
          <div className="text-xs text-ink-faint p-3 rounded border border-card bg-card">
            No branches match “{filter}”.
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {filteredLocal.map((b) => (
              <BranchSwitchRow
                key={b.name}
                name={b.shortName}
                isCurrent={b.isCurrent}
                subject={b.subject}
                shortSha={b.shortSha}
                ownedBy={ownership.get(b.shortName)}
                isMainCheckout={
                  ownership.get(b.shortName)?.isMain ?? false
                }
                disabled={switching !== null}
                pending={switching === b.shortName}
                onSwitch={() => onSwitchBranch(b.shortName)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[10px] uppercase tracking-wide text-ink-faint">
            Linked worktrees ({filteredLinked.length}
            {q && filteredLinked.length !== linked.length ? ` of ${linked.length}` : ''}
            )
          </h3>
          <div className="flex items-center gap-2">
            {hasPrunable && (
              <span className="text-[10px] text-red-400">stale entries detected</span>
            )}
            <button
              onClick={onPrune}
              disabled={pruning}
              title="Clean up administrative records for worktrees whose directories were deleted on disk"
              className="text-[11px] px-2 py-0.5 rounded border border-card hover:bg-surface-elevated disabled:opacity-50"
            >
              {pruning ? 'Pruning…' : 'Prune missing'}
            </button>
          </div>
        </div>
        {wts === undefined ? (
          <div className="text-xs text-ink-faint">Loading…</div>
        ) : linked.length === 0 ? (
          <div className="text-xs text-ink-faint p-3 rounded border border-card bg-card">
            No linked worktrees. Add one from the terminal:{' '}
            <code className="px-1 rounded bg-surface-elevated font-mono">
              git worktree add ../{'<dir>'} {'<branch>'}
            </code>
          </div>
        ) : filteredLinked.length === 0 ? (
          <div className="text-xs text-ink-faint p-3 rounded border border-card bg-card">
            No worktrees match “{filter}”.
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {filteredLinked.map((w) => (
              <WorktreeRow key={w.path} repoId={repoId} repoPath={repoPath} worktree={w} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function BranchSwitchRow({
  name,
  isCurrent,
  subject,
  shortSha,
  ownedBy,
  isMainCheckout,
  disabled,
  pending,
  onSwitch,
}: {
  name: string;
  isCurrent: boolean;
  subject: string;
  shortSha: string;
  ownedBy: Worktree | undefined;
  isMainCheckout: boolean;
  disabled: boolean;
  pending: boolean;
  onSwitch: () => void;
}): JSX.Element {
  // A branch is switchable from this row only if no *linked* worktree
  // owns it. If the main repo owns it, that's the current branch (or a
  // branch the main repo just had — git allows main to switch off then
  // back). If a linked worktree owns it, the user has to use the
  // worktree row's "Switch main repo here" affordance instead, since
  // git refuses to check out a branch that's already in use.
  const ownedByLinked = ownedBy !== undefined && !isMainCheckout;
  return (
    <li
      className={`flex items-center gap-3 px-3 py-1.5 rounded border ${
        isCurrent ? 'border-accent/40 bg-accent/[0.04]' : 'border-card bg-card'
      }`}
    >
      <span
        className={`font-mono text-[11px] w-3 ${isCurrent ? 'text-accent' : 'text-ink-faint'}`}
        title={isCurrent ? 'Current branch in main checkout' : ''}
      >
        {isCurrent ? '⎇' : ''}
      </span>
      <span className="font-mono text-sm truncate flex-1" title={name}>
        {name}
      </span>
      <span className="text-[11px] text-ink-faint truncate max-w-[40%]" title={subject}>
        {subject}
      </span>
      <span className="text-[11px] text-ink-faint font-mono">{shortSha}</span>
      {ownedByLinked ? (
        <span
          className="text-[11px] text-amber-400 font-mono truncate max-w-[40%]"
          title={`This branch is checked out at ${ownedBy!.path}. Use that row's "Switch main repo here" to bring it back.`}
        >
          owned by {ownedBy!.path}
        </span>
      ) : isCurrent ? (
        <span className="text-[11px] text-ink-faint">on this checkout</span>
      ) : (
        <button
          onClick={onSwitch}
          disabled={disabled}
          className="text-[11px] px-2 py-0.5 rounded border border-card hover:bg-surface-elevated disabled:opacity-50"
        >
          {pending ? 'Switching…' : 'Switch'}
        </button>
      )}
    </li>
  );
}

function WorktreeRow({
  repoId,
  repoPath,
  worktree: w,
}: {
  repoId: UUID;
  repoPath: string | undefined;
  worktree: Worktree;
}): JSX.Element {
  const adopt = useStore((s) => s.adoptWorktreeBranch);
  const removeWt = useStore((s) => s.removeWorktree);
  type Mode = null | 'adopt' | 'remove';
  // Three ways to handle a potentially-dirty worktree on adopt. `clean`
  // assumes nothing's there to deal with; `commit` keeps the work as a
  // commit on the worktree's branch; `discard` drops it.
  type DirtyMode = 'clean' | 'commit' | 'discard';
  const [mode, setMode] = useState<Mode>(null);
  const [dirtyMode, setDirtyMode] = useState<DirtyMode>('commit');
  const [commitMessage, setCommitMessage] = useState('');
  // Used only by the standalone Remove panel; the adopt panel routes
  // discard through `dirtyMode === 'discard'` instead.
  const [forceRemove, setForceRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ step: string; message: string } | null>(null);

  const canAdopt = !w.isMain && w.branch !== null;

  const reset = () => {
    setMode(null);
    setDirtyMode('commit');
    setCommitMessage('');
    setForceRemove(false);
    setError(null);
  };

  const onAdopt = async () => {
    if (dirtyMode === 'commit' && !commitMessage.trim()) {
      setError({ step: 'precheck', message: 'Commit message required' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await adopt(
        repoId,
        w.path,
        w.branch!,
        dirtyMode === 'discard',
        dirtyMode === 'commit' ? commitMessage.trim() : undefined,
      );
      if (!res.ok) {
        setError({ step: res.step, message: res.error });
        return;
      }
      // Success: the row this lives on is about to disappear since the
      // worktree no longer exists. The parent's refresh-on-action will
      // re-render without it.
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await removeWt(repoId, w.path, forceRemove);
      if (!res.ok) {
        setError({ step: 'remove', message: res.error ?? 'Remove failed' });
        return;
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-1 px-3 py-2 rounded border border-card bg-card">
      <div className="flex items-center gap-2">
        <span className="text-sm font-mono truncate flex-1" title={w.path}>
          {w.path}
        </span>
        {w.isMain && (
          <span
            className="text-[10px] uppercase tracking-wide text-accent"
            title="The original clone — owns the .git directory"
          >
            main
          </span>
        )}
        {w.locked && (
          <span
            className="text-[10px] uppercase tracking-wide text-amber-400"
            title="git worktree lock — protected from prune"
          >
            locked
          </span>
        )}
        {w.prunable && (
          <span
            className="text-[10px] uppercase tracking-wide text-red-400"
            title="missing on disk — run `git worktree prune` to clean up"
          >
            prunable
          </span>
        )}
        <button
          onClick={() => void navigator.clipboard.writeText(w.path)}
          title="Copy path"
          className="text-[11px] text-ink-faint hover:text-ink px-2 py-0.5 rounded hover:bg-surface-elevated"
        >
          copy
        </button>
        {canAdopt && mode === null && (
          <button
            onClick={() => {
              setMode('adopt');
              setForceRemove(false);
              setError(null);
            }}
            title={`Remove the linked worktree at ${w.path} and check out ${w.branch} in the main repo`}
            className="text-[11px] px-2 py-0.5 rounded border border-card hover:bg-surface-elevated"
          >
            Switch main repo here
          </button>
        )}
        {!w.isMain && mode === null && (
          <button
            onClick={() => {
              setMode('remove');
              setForceRemove(false);
              setError(null);
            }}
            title={`git worktree remove ${w.path}`}
            className="text-[11px] px-2 py-0.5 rounded border border-card text-red-400 hover:bg-red-500/10"
          >
            Remove
          </button>
        )}
      </div>
      <div className="flex items-center gap-3 text-[11px] text-ink-faint font-mono">
        <span className={w.branch ? 'text-ink-muted' : 'text-amber-400'}>
          {w.branch ?? '(detached)'}
        </span>
        {w.head && <span>{w.head.slice(0, 10)}</span>}
        {repoPath && w.path !== repoPath && (
          <span className="text-ink-faint">linked from {repoPath}</span>
        )}
      </div>
      {mode === 'adopt' && canAdopt && (
        <div className="mt-1 p-3 rounded border border-amber-700/40 bg-amber-500/[0.04] flex flex-col gap-2 text-[11px]">
          <div>
            <span className="font-medium text-ink">Switch main repo to {w.branch}?</span> This will
            remove the linked checkout at <code className="font-mono">{w.path}</code> and then{' '}
            <code className="font-mono px-1 rounded bg-card">git switch {w.branch}</code> in the
            main repo. The main repo must be clean.
          </div>
          <fieldset className="flex flex-col gap-1.5 mt-1">
            <legend className="text-[10px] uppercase tracking-wide text-ink-faint">
              If the worktree has uncommitted changes
            </legend>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name={`dirty-${w.path}`}
                checked={dirtyMode === 'commit'}
                onChange={() => setDirtyMode('commit')}
                disabled={busy}
                className="mt-0.5"
              />
              <div className="flex-1">
                <div>Commit them on {w.branch} first, then switch</div>
                <div className="text-[10px] text-ink-faint">
                  `git add -A` + commit inside the worktree before remove. No-op if it's clean.
                </div>
              </div>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name={`dirty-${w.path}`}
                checked={dirtyMode === 'discard'}
                onChange={() => setDirtyMode('discard')}
                disabled={busy}
                className="mt-0.5"
              />
              <div className="flex-1">
                <div>Discard them (force remove)</div>
                <div className="text-[10px] text-ink-faint">
                  `git worktree remove --force` — uncommitted edits in the worktree are lost.
                </div>
              </div>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name={`dirty-${w.path}`}
                checked={dirtyMode === 'clean'}
                onChange={() => setDirtyMode('clean')}
                disabled={busy}
                className="mt-0.5"
              />
              <div className="flex-1">
                <div>Assume it's clean</div>
                <div className="text-[10px] text-ink-faint">
                  Plain `git worktree remove` — fails loudly if anything's dirty.
                </div>
              </div>
            </label>
          </fieldset>
          {dirtyMode === 'commit' && (
            <input
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              disabled={busy}
              placeholder={`Commit message (only used if ${w.path} is dirty)`}
              className="field px-2 py-1.5 text-xs"
            />
          )}
          {error && (
            <div className="text-red-400">
              {error.step === 'precheck'
                ? 'Cannot start: '
                : error.step === 'commit'
                  ? 'Commit in worktree failed: '
                  : error.step === 'remove'
                    ? 'Worktree remove failed: '
                    : 'Branch switch failed: '}
              {error.message}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              onClick={reset}
              disabled={busy}
              className="px-3 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onAdopt}
              disabled={busy}
              className="px-3 py-1 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
            >
              {busy
                ? 'Switching…'
                : dirtyMode === 'commit'
                  ? `Commit & switch to ${w.branch}`
                  : `Switch to ${w.branch}`}
            </button>
          </div>
        </div>
      )}
      {mode === 'remove' && (
        <div className="mt-1 p-3 rounded border border-red-700/40 bg-red-500/[0.04] flex flex-col gap-2 text-[11px]">
          <div>
            <span className="font-medium text-ink">Remove this worktree?</span>{' '}
            <code className="font-mono px-1 rounded bg-card">git worktree remove {w.path}</code>{' '}
            unregisters the checkout and deletes the directory. The branch{' '}
            {w.branch ? (
              <>
                <code className="font-mono">{w.branch}</code> stays available; you can re-add the
                worktree later.
              </>
            ) : (
              <>(detached HEAD) is unaffected, but anything not committed is lost.</>
            )}
          </div>
          <label className="flex items-center gap-2 cursor-pointer text-ink-muted">
            <input
              type="checkbox"
              checked={forceRemove}
              onChange={(e) => setForceRemove(e.target.checked)}
              disabled={busy}
            />
            <span>
              Force (discard uncommitted changes in <code className="font-mono">{w.path}</code>)
            </span>
          </label>
          {error && <div className="text-red-400">{error.message}</div>}
          <div className="flex gap-2 justify-end">
            <button
              onClick={reset}
              disabled={busy}
              className="px-3 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onRemove}
              disabled={busy}
              className="px-3 py-1 rounded bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
            >
              {busy ? 'Removing…' : 'Remove worktree'}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function relativeAgo(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const diff = Date.now() - d.getTime();
    const m = Math.round(diff / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.round(h / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.round(months / 12)}y ago`;
  } catch {
    return iso;
  }
}

// Lane palette shared with what BranchGraph used. Keeps the combined
// view visually consistent with the prior standalone graph tab.
const LANE_COLORS = [
  '#8a78ff',
  '#5eead4',
  '#fbbf24',
  '#f472b6',
  '#60a5fa',
  '#a3e635',
  '#fb923c',
  '#22d3ee',
];
// Tighter than the previous combined view (44px). Single-line rows
// match what the old standalone Graph tab used and let the user see
// many more commits at once.
const ROW_HEIGHT = 28;
const LANE_WIDTH = 14;
const NODE_RADIUS = 4;
const PADDING_X = 10;

const EMPTY_GRAPH: GraphCommit[] = [];

/// Combined graph + history view. The left rail draws each commit's
/// lane and parent lines; commits then render to the right with refs,
/// subject, author, and date. Selecting a commit loads its detail in
/// the right pane (subject + body + per-file +/- list + diff). The
/// "Working tree" entry is preserved at the top of the list so the
/// user can still see uncommitted changes here.
// Width of the rail column (where the lane SVG paints). Keeps row
// padding stable regardless of how many lanes the visible window has;
// past this we let the SVG overflow and the row's pl-[railWidth]
// holds the layout.
const RAIL_BASE_WIDTH = 56;

function HistoryTab({ repoId }: { repoId: UUID }): JSX.Element {
  const commits = useStore((s) => s.repoGraph[repoId] ?? EMPTY_GRAPH);
  const refreshGraph = useStore((s) => s.refreshRepoGraph);
  const refreshDiff = useStore((s) => s.refreshRepoDiff);
  const diffEntry = useStore((s) => s.repoDiff[repoId]);
  const asideWidth = useStore((s) => s.settings.historyAsideWidth);
  const setAsideWidth = useStore((s) => s.setHistoryAsideWidth);
  const createBranch = useStore((s) => s.createRepoBranch);
  const repoPath = useStore((s) => s.repos.find((r) => r.id === repoId)?.path);
  const openRepoFile = useStore((s) => s.openRepoFile);
  const pushToast = useStore((s) => s.pushToast);
  const requestConfirm = useStore((s) => s.requestConfirm);

  // Shared "Open in editor" handler for every diff rendered in this
  // tab. Working-tree diff and per-commit detail use the same path —
  // the file's working-tree state is what the user wants to inspect
  // even when looking at a historical commit.
  const openFile = (f: FileDiff) => {
    if (!repoPath) return;
    window.dispatchEvent(new CustomEvent('overgit:setRepoTab', { detail: 'files' }));
    void openRepoFile(repoId, joinRepoPath(repoPath, f.path));
  };

  const [selected, setSelected] = useState<string | 'working'>('working');
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ sha: string; x: number; y: number } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    refreshGraph(repoId);
    refreshDiff(repoId, undefined);
    setSelected('working');
    setFilter('');
  }, [refreshGraph, refreshDiff, repoId]);

  const filteredCommits = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return commits;
    return commits.filter(
      (c) =>
        c.sha.startsWith(q) ||
        c.subject.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.refs.some((r) => r.toLowerCase().includes(q)),
    );
  }, [commits, filter]);

  // Lane geometry is computed from the FULL commit set (not filtered)
  // so the rail still draws meaningful connectors even when the user
  // narrows by filter. The rail is wide enough for the visible lanes.
  const indexBySha = useMemo(() => {
    const m = new Map<string, number>();
    filteredCommits.forEach((c, i) => m.set(c.sha, i));
    return m;
  }, [filteredCommits]);

  const maxLane = useMemo(
    () => filteredCommits.reduce((m, c) => Math.max(m, c.lane, ...c.parentLanes), 0),
    [filteredCommits],
  );
  const railWidth = Math.max(RAIL_BASE_WIDTH, PADDING_X * 2 + (maxLane + 1) * LANE_WIDTH);

  const headSha = useMemo(() => {
    const head = commits.find((c) => c.refs.some((r) => r.startsWith('HEAD')));
    return head?.sha ?? null;
  }, [commits]);

  const onPickCommit = (sha: string) => {
    setSelected(sha);
    refreshDiff(repoId, sha);
  };
  const onPickWorking = () => {
    setSelected('working');
    refreshDiff(repoId, undefined);
  };

  // Keyboard navigation. The list owns focus once the user clicks
  // anywhere on it; ↑/↓ move selection between rows including the
  // working-tree entry at the top.
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const all: ('working' | string)[] = ['working', ...filteredCommits.map((c) => c.sha)];
    const idx = all.indexOf(selected);
    const next =
      e.key === 'ArrowDown'
        ? Math.min(all.length - 1, idx + 1)
        : Math.max(0, idx - 1);
    const target = all[next];
    if (target === 'working') onPickWorking();
    else onPickCommit(target);
  };

  // Drag handle for the aside.
  const onAsideDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = asideWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(
        HISTORY_ASIDE_MIN_WIDTH,
        Math.min(HISTORY_ASIDE_MAX_WIDTH, startW + (ev.clientX - startX)),
      );
      void setAsideWidth(next);
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

  // Right-click on a row → context menu, anchored to the click.
  const openContextMenu = (e: React.MouseEvent, sha: string) => {
    e.preventDefault();
    setSelected(sha);
    refreshDiff(repoId, sha);
    setMenu({ sha, x: e.clientX, y: e.clientY });
  };

  // Per-row vertical offset accounts for the working-tree row at index 0.
  // SVG draws lines/circles for filtered commits at rows 1..N.
  const totalHeight = (filteredCommits.length + 1) * ROW_HEIGHT;

  const selectedCommit =
    selected === 'working' ? null : commits.find((c) => c.sha === selected) ?? null;

  return (
    <div className="flex overflow-hidden">
      <aside
        className="border-r border-card flex-shrink-0 flex flex-col min-h-0"
        style={{ width: asideWidth }}
      >
        {/* Sticky filter at the top of the aside. The clear button
            appears only when there's something typed. */}
        <div className="px-3 py-2 border-b border-card flex items-center gap-2 flex-shrink-0">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by subject, sha, author, ref…"
            className="field flex-1 px-2 py-1 text-[11px]"
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              className="text-[10px] text-ink-muted hover:text-ink px-1.5 py-1 rounded hover:bg-card"
              title="Clear filter"
            >
              ✕
            </button>
          )}
        </div>

        {/* Scroll container. Rows + overlay SVG share this so the
            graph scrolls with the list. */}
        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={onListKey}
          className="flex-1 min-h-0 overflow-y-auto outline-none"
        >
          <div
            className="relative"
            style={{ minHeight: ROW_HEIGHT * (filteredCommits.length + 1) }}
          >
            {/* Rows render full-width with their own bg. The SVG
                overlay paints lines + circles on top of the rail
                strip; pointer-events none so clicks fall through. */}
            <button
              onClick={onPickWorking}
              className={`w-full text-left flex items-center gap-2 text-xs border-b border-card relative z-10 ${
                selected === 'working' ? 'bg-accent text-white' : 'hover:bg-card'
              }`}
              style={{ height: ROW_HEIGHT, paddingLeft: railWidth, paddingRight: 12 }}
            >
              <span className="font-medium truncate">Working tree</span>
              <span
                className={`text-[10px] truncate ${
                  selected === 'working' ? 'text-white/70' : 'text-ink-faint'
                }`}
              >
                staged + unstaged vs HEAD
              </span>
            </button>

            {filteredCommits.map((c) => {
              const active = selected === c.sha;
              const isHead = c.sha === headSha;
              return (
                <button
                  key={c.sha}
                  onClick={() => onPickCommit(c.sha)}
                  onContextMenu={(e) => openContextMenu(e, c.sha)}
                  style={{
                    height: ROW_HEIGHT,
                    paddingLeft: railWidth,
                    paddingRight: 12,
                  }}
                  className={`w-full text-left flex items-center gap-2 text-xs border-b border-card relative z-10 ${
                    active ? 'bg-accent text-white' : 'hover:bg-card'
                  }`}
                >
                  <CommitGraphRow commit={c} active={active} isHead={isHead} />
                </button>
              );
            })}
            {filteredCommits.length === 0 && commits.length > 0 && (
              <div
                className="px-3 py-3 text-[11px] text-ink-faint absolute"
                style={{ top: ROW_HEIGHT, left: railWidth }}
              >
                No commits match.
              </div>
            )}
            {commits.length === 0 && (
              <div className="px-3 py-3 text-[11px] text-ink-faint">No commits yet.</div>
            )}

            <svg
              width={railWidth}
              height={totalHeight}
              className="absolute left-0 top-0 pointer-events-none"
            >
              {filteredCommits.map((c, i) => (
                <g key={c.sha}>
                  {c.parentLanes.map((pLane, idx) => {
                    const parentIdx = indexBySha.get(c.parents[idx]);
                    if (parentIdx == null) return null;
                    const x1 = PADDING_X + c.lane * LANE_WIDTH + LANE_WIDTH / 2;
                    const y1 = (i + 1) * ROW_HEIGHT + ROW_HEIGHT / 2;
                    const x2 = PADDING_X + pLane * LANE_WIDTH + LANE_WIDTH / 2;
                    const y2 = (parentIdx + 1) * ROW_HEIGHT + ROW_HEIGHT / 2;
                    const cy = y1 + ROW_HEIGHT * 0.6;
                    const d =
                      x1 === x2
                        ? `M${x1},${y1} L${x2},${y2}`
                        : `M${x1},${y1} Q${x1},${cy} ${(x1 + x2) / 2},${cy} T${x2},${y2}`;
                    return (
                      <path
                        key={`${c.sha}:${idx}`}
                        d={d}
                        stroke={laneColor(pLane)}
                        strokeWidth="1.5"
                        fill="none"
                        opacity="0.85"
                      />
                    );
                  })}
                  {c.sha === headSha && (
                    // HEAD halo — a wider ring behind the node circle
                    // so the active commit pops without changing the
                    // base node size and disturbing the row rhythm.
                    <circle
                      cx={PADDING_X + c.lane * LANE_WIDTH + LANE_WIDTH / 2}
                      cy={(i + 1) * ROW_HEIGHT + ROW_HEIGHT / 2}
                      r={NODE_RADIUS + 4}
                      fill="none"
                      stroke="var(--c-accent)"
                      strokeWidth="1.5"
                      opacity="0.85"
                    />
                  )}
                  <circle
                    cx={PADDING_X + c.lane * LANE_WIDTH + LANE_WIDTH / 2}
                    cy={(i + 1) * ROW_HEIGHT + ROW_HEIGHT / 2}
                    r={NODE_RADIUS}
                    fill={laneColor(c.lane)}
                  />
                </g>
              ))}
            </svg>
          </div>
        </div>
      </aside>

      {/* Drag handle */}
      <div
        role="separator"
        aria-label="Resize history list"
        aria-valuenow={asideWidth}
        aria-valuemin={HISTORY_ASIDE_MIN_WIDTH}
        aria-valuemax={HISTORY_ASIDE_MAX_WIDTH}
        onMouseDown={onAsideDragStart}
        onDoubleClick={() => void setAsideWidth(480)}
        title="Drag to resize · Double-click to reset"
        className="w-1 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors flex-shrink-0"
      />

      <section className="flex-1 min-w-0 overflow-hidden">
        {selected === 'working' ? (
          <div className="h-full overflow-y-auto p-4">
            <div className="mb-3 px-1 text-[11px] uppercase tracking-wide text-ink-faint">
              Working tree · staged + unstaged vs HEAD
            </div>
            <DiffView files={diffEntry?.files ?? []} onOpenFile={openFile} />
          </div>
        ) : selectedCommit ? (
          <CommitDetail
            commit={selectedCommit}
            files={diffEntry?.files ?? null}
            onOpenFile={openFile}
          />
        ) : (
          <div className="p-4 text-xs text-ink-faint">Loading…</div>
        )}
      </section>

      {menu && (
        <CommitContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onCopySha={() => void navigator.clipboard.writeText(menu.sha)}
          onCopyShortSha={() => {
            const c = commits.find((cc) => cc.sha === menu.sha);
            if (c) void navigator.clipboard.writeText(c.shortSha);
          }}
          onCopyMessage={() => {
            const c = commits.find((cc) => cc.sha === menu.sha);
            if (!c) return;
            const text = c.body ? `${c.subject}\n\n${c.body}` : c.subject;
            void navigator.clipboard.writeText(text);
          }}
          onBranchFromHere={async (name) => {
            const res = await createBranch(repoId, name.trim(), true, menu.sha);
            if (!res.ok) pushToast({ kind: 'error', message: res.error ?? 'Create failed' });
          }}
          onCheckout={async () => {
            const ok = await requestConfirm({
              title: 'Detach HEAD?',
              body: 'Check out this commit? You will be on a detached HEAD — create a branch first if you plan to make changes.',
              confirmLabel: 'Detach and check out',
            });
            if (!ok) return;
            const res = await window.overgit.invoke('repo:checkoutCommit', {
              repoId,
              sha: menu.sha,
            });
            if (!res.ok) {
              pushToast({ kind: 'error', message: res.error ?? 'Checkout failed' });
            } else {
              await useStore.getState().refreshRepoStatus(repoId);
            }
          }}
        />
      )}
    </div>
  );
}

function CommitContextMenu({
  x,
  y,
  onClose,
  onCopySha,
  onCopyShortSha,
  onCopyMessage,
  onBranchFromHere,
  onCheckout,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onCopySha: () => void;
  onCopyShortSha: () => void;
  onCopyMessage: () => void;
  onBranchFromHere: (name: string) => void | Promise<void>;
  onCheckout: () => void;
}): JSX.Element {
  // Two modes: 'list' shows the menu, 'branch' shows an inline branch-
  // name input. We don't drop into window.prompt because Electron
  // sandboxed renderers refuse it.
  const [mode, setMode] = useState<'list' | 'branch'>('list');
  const [branchName, setBranchName] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (mode === 'branch') inputRef.current?.focus();
  }, [mode]);

  // Click anywhere outside or hit Esc → dismiss. Mouse-down (not click)
  // so a quick mousedown-then-click on a menu item still fires before
  // the dismiss handler tears the menu down.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-context-menu]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 280);
  const top = Math.min(y, window.innerHeight - 240);

  return (
    <div
      data-context-menu
      className="fixed z-50 bg-surface-elevated border border-card rounded-md shadow-2xl py-1 min-w-[240px] text-xs"
      style={{ left, top }}
    >
      {mode === 'list' ? (
        <>
          <CtxItem
            label="Copy commit SHA"
            onClick={() => {
              onCopySha();
              onClose();
            }}
          />
          <CtxItem
            label="Copy short SHA"
            onClick={() => {
              onCopyShortSha();
              onClose();
            }}
          />
          <CtxItem
            label="Copy commit message"
            onClick={() => {
              onCopyMessage();
              onClose();
            }}
          />
          <div className="my-1 border-t border-card" />
          <CtxItem
            label="Create branch from here…"
            onClick={() => setMode('branch')}
          />
          <CtxItem
            label="Checkout this commit (detached)"
            onClick={() => {
              onCheckout();
              onClose();
            }}
            tone="warn"
          />
        </>
      ) : (
        <div className="px-3 py-2 flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-wide text-ink-faint">
            New branch from this commit
          </div>
          <input
            ref={inputRef}
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && branchName.trim()) {
                void onBranchFromHere(branchName.trim());
                onClose();
              } else if (e.key === 'Escape') {
                setMode('list');
              }
            }}
            placeholder="feature/your-branch"
            className="field px-2 py-1 text-xs"
          />
          <div className="flex justify-end gap-1">
            <button
              onClick={() => setMode('list')}
              className="text-[11px] px-2 py-1 rounded text-ink-muted hover:bg-card hover:text-ink"
            >
              Back
            </button>
            <button
              disabled={!branchName.trim()}
              onClick={() => {
                void onBranchFromHere(branchName.trim());
                onClose();
              }}
              className="text-[11px] px-2.5 py-1 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
            >
              Create &amp; switch
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CtxItem({
  label,
  onClick,
  tone = 'normal',
}: {
  label: string;
  onClick: () => void;
  tone?: 'normal' | 'warn';
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 hover:bg-accent hover:text-white ${
        tone === 'warn' ? 'text-amber-300' : 'text-ink'
      }`}
    >
      {label}
    </button>
  );
}

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

/// Single-line commit row. Read order: HEAD pill → ref badges →
/// subject (flex) → author (hidden on narrow widths) → relative time.
/// Short sha is dropped from the row body since the rail node already
/// carries lane identity and the user can copy the full sha from the
/// right-click menu — the row reads cleaner without it.
function CommitGraphRow({
  commit,
  active,
  isHead,
}: {
  commit: GraphCommit;
  active: boolean;
  isHead: boolean;
}): JSX.Element {
  const ago = useMemo(() => relativeOrAbsolute(commit.date), [commit.date]);
  // Refs minus the bare "HEAD" / "HEAD -> X" entries — those are
  // represented by the HEAD pill so we don't double-up.
  const branchRefs = useMemo(
    () => commit.refs.filter((r) => !r.startsWith('HEAD')),
    [commit.refs],
  );
  return (
    <>
      {isHead && (
        <span
          className={`text-[9px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded leading-none flex-shrink-0 ${
            active
              ? 'bg-white/20 text-white'
              : 'bg-accent/25 text-accent border border-accent/40'
          }`}
        >
          HEAD
        </span>
      )}
      {branchRefs.length > 0 && (
        <RefBadges refs={branchRefs} laneColor={laneColor(commit.lane)} active={active} />
      )}
      <span
        className={`truncate flex-1 min-w-0 ${active ? 'font-medium' : ''}`}
        title={commit.subject}
      >
        {commit.subject || (
          <span className={active ? 'text-white/70' : 'text-ink-faint'}>(no subject)</span>
        )}
      </span>
      <span
        className={`truncate hidden md:inline max-w-[110px] flex-shrink-0 ${
          active ? 'text-white/70' : 'text-ink-faint'
        }`}
      >
        {commit.author}
      </span>
      <span
        className={`whitespace-nowrap text-right tabular-nums w-12 flex-shrink-0 ${
          active ? 'text-white/70' : 'text-ink-faint'
        }`}
      >
        {ago}
      </span>
    </>
  );
}

/// Compact human-readable time. Recent → "now/2m/3h/4d"; older →
/// "Mar 5" or "Mar 5 '24". Always 4–5 chars wide so the column stays
/// neat across rows.
function relativeOrAbsolute(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const diff = Date.now() - d.getTime();
    const m = Math.round(diff / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h`;
    const days = Math.round(h / 24);
    if (days < 14) return `${days}d`;
    const today = new Date();
    const sameYear = d.getFullYear() === today.getFullYear();
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: sameYear ? undefined : '2-digit',
    });
  } catch {
    return iso;
  }
}

function RefBadges({
  refs,
  laneColor,
  active,
}: {
  refs: string[];
  laneColor: string;
  active: boolean;
}): JSX.Element {
  return (
    <div className="flex gap-1 flex-shrink-0">
      {refs.slice(0, 3).map((r) => {
        const clean = r.replace(/^HEAD -> /, '');
        const isHead = r.startsWith('HEAD');
        return (
          <span
            key={r}
            className="px-1.5 py-0.5 rounded text-[9px] font-mono leading-none"
            style={{
              background: active
                ? 'rgba(255,255,255,0.18)'
                : `color-mix(in srgb, ${laneColor} 22%, transparent)`,
              border: `1px solid color-mix(in srgb, ${laneColor} 50%, transparent)`,
              color: active ? '#fff' : isHead ? laneColor : 'var(--c-ink-muted)',
              fontWeight: isHead ? 600 : 400,
            }}
            title={r}
          >
            {clean}
          </span>
        );
      })}
    </div>
  );
}

/// Right-pane commit detail: smaller subject, full body, meta line,
/// per-file change list with +/- counts, then the unified diff. Counts
/// are derived client-side from the FileDiff body so we don't need a
/// follow-up `git show --numstat` round-trip.
function CommitDetail({
  commit,
  files,
  onOpenFile,
}: {
  commit: GraphCommit;
  files: FileDiff[] | null;
  /// Forwarded to DiffView so each per-file block can render an
  /// "Open" affordance that lands the file in the Files tab.
  onOpenFile?: (file: FileDiff) => void;
}): JSX.Element {
  const stats = useMemo(() => {
    if (!files) return null;
    let totalAdds = 0;
    let totalDels = 0;
    const perFile = files.map((f) => {
      let adds = 0;
      let dels = 0;
      for (const line of f.body.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) adds += 1;
        else if (line.startsWith('-') && !line.startsWith('---')) dels += 1;
      }
      totalAdds += adds;
      totalDels += dels;
      return { file: f, adds, dels };
    });
    return { totalAdds, totalDels, perFile };
  }, [files]);

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Sticky detail header — stays pinned while the diff body
          scrolls so the user keeps the commit context in view. */}
      <header className="flex-shrink-0 px-5 py-4 border-b border-card bg-surface-elevated">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          {commit.refs.length > 0 && (
            <RefBadges refs={commit.refs} laneColor={laneColor(commit.lane)} active={false} />
          )}
        </div>
        <h2 className="text-sm font-semibold leading-snug">
          {commit.subject || '(no subject)'}
        </h2>
        {commit.body && (
          <pre className="mt-2 text-[12px] leading-relaxed text-ink-muted whitespace-pre-wrap font-sans max-w-prose">
            {commit.body}
          </pre>
        )}
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-faint font-mono">
          <span>{commit.shortSha}</span>
          <span>{commit.author}</span>
          {commit.authorEmail && <span>&lt;{commit.authorEmail}&gt;</span>}
          <span>{formatDate(commit.date)}</span>
          {commit.parents.length > 1 && (
            <span title="Merge commit">merge of {commit.parents.length}</span>
          )}
          <button
            onClick={() => navigator.clipboard.writeText(commit.sha)}
            className="ml-auto text-[10px] text-ink-faint hover:text-ink underline-offset-2 hover:underline"
            title="Copy full SHA"
          >
            Copy SHA
          </button>
        </div>
      </header>

      {stats && (
        <div className="flex-shrink-0 px-5 py-3 border-b border-card bg-card/30">
          <div className="flex items-baseline gap-3 mb-2">
            <span className="text-[11px] uppercase tracking-wide text-ink-faint">
              {stats.perFile.length}{' '}
              {stats.perFile.length === 1 ? 'file changed' : 'files changed'}
            </span>
            {stats.totalAdds > 0 && (
              <span className="text-[11px] font-mono text-emerald-400">
                +{stats.totalAdds}
              </span>
            )}
            {stats.totalDels > 0 && (
              <span className="text-[11px] font-mono text-red-400">
                −{stats.totalDels}
              </span>
            )}
          </div>
          <ul className="flex flex-col gap-0.5 max-h-[180px] overflow-y-auto">
            {stats.perFile.map(({ file, adds, dels }) => (
              <li
                key={`${file.status}:${file.path}`}
                className="flex items-center gap-2 text-[11px] py-0.5 hover:bg-card rounded px-1"
              >
                <FileDiffStatusBadge status={file.status} />
                <button
                  onClick={() => {
                    document
                      .getElementById(`diff-file-${file.path}`)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  className="font-mono truncate flex-1 text-left text-ink hover:underline"
                  title={file.path}
                >
                  {file.path}
                </button>
                <span className="font-mono text-emerald-400">+{adds}</span>
                <span className="font-mono text-red-400">−{dels}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Only this region scrolls so the header above stays sticky. */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <DiffView files={files ?? []} onOpenFile={onOpenFile} />
      </div>
    </div>
  );
}

function FileDiffStatusBadge({ status }: { status: FileDiff['status'] }): JSX.Element {
  const map: Record<FileDiff['status'], string> = {
    A: 'bg-emerald-500/20 text-emerald-300',
    M: 'bg-amber-500/20 text-amber-300',
    D: 'bg-red-500/20 text-red-300',
    R: 'bg-sky-500/20 text-sky-300',
    C: 'bg-sky-500/20 text-sky-300',
    '?': 'bg-card text-ink-muted',
  };
  return (
    <span
      className={`inline-block px-1 rounded text-[9px] font-mono ${map[status]}`}
    >
      {status}
    </span>
  );
}

/// Changes-tab diff pane. Differs from the read-only `DiffView` in that
/// each hunk gets its own "Stage / Discard" (or "Unstage") action so
/// the user can commit a clean subset of a messy file. Patch is built
/// from the file header + selected hunks and piped to `git apply`.
function ChangesDiffPane({
  repoId,
  files,
  side,
}: {
  repoId: UUID;
  files: FileDiff[];
  /// 'combined' is simple-staging mode: hunks expose Discard only — no
  /// Stage / Unstage, since the simple model hides the index entirely.
  side: 'staged' | 'unstaged' | 'combined';
}): JSX.Element {
  const applyPatch = useStore((s) => s.applyPatch);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (files.length === 0) {
    return <div className="p-4 text-sm text-ink-faint">No changes.</div>;
  }

  const onHunk = async (
    file: FileDiff,
    hunk: ParsedHunk,
    action: 'stage' | 'unstage' | 'discard',
  ) => {
    const key = `${file.path}@${hunk.startLine}:${action}`;
    setBusyKey(key);
    setError(null);
    try {
      const patch = buildHunkPatch(file, [hunk]);
      const res = await applyPatch(repoId, patch, action);
      if (!res.ok) setError(res.error ?? 'Apply failed');
    } finally {
      setBusyKey(null);
    }
  };

  const onFileAction = async (
    file: FileDiff,
    action: 'stage' | 'unstage' | 'discard',
  ) => {
    const hunks = parseHunks(file);
    if (hunks.length === 0) return;
    const key = `${file.path}@all:${action}`;
    setBusyKey(key);
    setError(null);
    try {
      const patch = buildHunkPatch(file, hunks);
      const res = await applyPatch(repoId, patch, action);
      if (!res.ok) setError(res.error ?? 'Apply failed');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      {error && (
        <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2 flex items-start gap-2">
          <span className="font-mono whitespace-pre-wrap flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-ink-faint hover:text-ink"
          >
            ✕
          </button>
        </div>
      )}
      {files.map((f) => (
        <ChangesFileBlock
          key={`${f.status}:${f.path}`}
          file={f}
          side={side}
          busyKey={busyKey}
          onHunk={onHunk}
          onFileAction={onFileAction}
        />
      ))}
    </div>
  );
}

function ChangesFileBlock({
  file,
  side,
  busyKey,
  onHunk,
  onFileAction,
}: {
  file: FileDiff;
  side: 'staged' | 'unstaged' | 'combined';
  busyKey: string | null;
  onHunk: (
    file: FileDiff,
    hunk: ParsedHunk,
    action: 'stage' | 'unstage' | 'discard',
  ) => void;
  onFileAction: (file: FileDiff, action: 'stage' | 'unstage' | 'discard') => void;
}): JSX.Element {
  const hunks = useMemo(() => parseHunks(file), [file]);
  const requestConfirm = useStore((s) => s.requestConfirm);

  // Whole-file actions sit in the file header so the user can stage or
  // discard everything in one click without scrolling. Hunk-level
  // actions are still available below.
  const wholeFileActions =
    side === 'staged'
      ? (['unstage'] as const)
      : side === 'combined'
        ? (['discard'] as const)
        : (['stage', 'discard'] as const);

  return (
    <div
      id={`diff-file-${file.path}`}
      className="rounded border border-card overflow-hidden scroll-mt-4"
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-card text-xs border-b border-card">
        <FileStatusBadge status={file.status} />
        <span className="font-mono truncate flex-1" title={file.path}>
          {file.path}
        </span>
        <div className="flex gap-1">
          {wholeFileActions.map((a) => {
            const k = `${file.path}@all:${a}`;
            const busy = busyKey === k;
            const tone =
              a === 'stage'
                ? 'bg-accent text-white hover:bg-accent-strong border-accent'
                : a === 'unstage'
                  ? 'bg-accent text-white hover:bg-accent-strong border-accent'
                  : 'border-red-500/40 text-red-300 hover:bg-red-500/10';
            return (
              <button
                key={a}
                disabled={busy}
                onClick={async () => {
                  if (a === 'discard') {
                    const ok = await requestConfirm({
                      title: 'Discard file changes?',
                      body: `Discard all changes in ${file.path}?`,
                      confirmLabel: 'Discard',
                      destructive: true,
                    });
                    if (!ok) return;
                  }
                  onFileAction(file, a);
                }}
                className={`text-[10px] uppercase tracking-wide font-mono h-6 px-2 rounded border ${tone} disabled:opacity-50`}
              >
                {busy ? '…' : a}
              </button>
            );
          })}
        </div>
      </div>

      {hunks.length === 0 ? (
        // Pure binary / rename / mode-change with no hunk body — the
        // raw diff still has useful header info; render it plainly.
        <pre className="text-xs leading-snug overflow-x-auto px-3 py-2 font-mono whitespace-pre">
          {file.body.split('\n').map((line, i) => (
            <DiffLine key={i} line={line} />
          ))}
        </pre>
      ) : (
        hunks.map((h) => (
          <HunkBlock
            key={`${file.path}@${h.startLine}`}
            file={file}
            hunk={h}
            side={side}
            busyKey={busyKey}
            onHunk={onHunk}
          />
        ))
      )}
    </div>
  );
}

function HunkBlock({
  file,
  hunk,
  side,
  busyKey,
  onHunk,
}: {
  file: FileDiff;
  hunk: ParsedHunk;
  side: 'staged' | 'unstaged' | 'combined';
  busyKey: string | null;
  onHunk: (
    file: FileDiff,
    hunk: ParsedHunk,
    action: 'stage' | 'unstage' | 'discard',
  ) => void;
}): JSX.Element {
  const requestConfirm = useStore((s) => s.requestConfirm);
  const actions =
    side === 'staged'
      ? (['unstage'] as const)
      : side === 'combined'
        ? (['discard'] as const)
        : (['stage', 'discard'] as const);
  const adds = hunk.lines.filter((l) => l.startsWith('+')).length;
  const dels = hunk.lines.filter((l) => l.startsWith('-')).length;
  return (
    <div className="group">
      <div className="flex items-center gap-2 px-3 py-1 bg-card/50 border-b border-card text-[11px] font-mono">
        <span className="text-ink-faint truncate flex-1" title={hunk.header}>
          {hunk.header.replace(/\s+@@.*$/, ' @@')}
        </span>
        {adds > 0 && <span className="text-emerald-400">+{adds}</span>}
        {dels > 0 && <span className="text-red-400">−{dels}</span>}
        <div className="flex gap-1 transition-opacity opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          {actions.map((a) => {
            const k = `${file.path}@${hunk.startLine}:${a}`;
            const busy = busyKey === k;
            const tone =
              a === 'stage' || a === 'unstage'
                ? 'bg-accent text-white hover:bg-accent-strong border-accent'
                : 'border-red-500/40 text-red-300 hover:bg-red-500/10';
            const label = a === 'stage' ? 'Stage hunk' : a === 'unstage' ? 'Unstage hunk' : 'Discard hunk';
            return (
              <button
                key={a}
                disabled={busy}
                onClick={async () => {
                  if (a === 'discard') {
                    const ok = await requestConfirm({
                      title: 'Discard hunk?',
                      body: 'Discard this hunk? This cannot be undone.',
                      confirmLabel: 'Discard',
                      destructive: true,
                    });
                    if (!ok) return;
                  }
                  onHunk(file, hunk, a);
                }}
                className={`text-[10px] uppercase tracking-wide font-mono h-6 px-2 rounded border ${tone} disabled:opacity-50`}
              >
                {busy ? '…' : label}
              </button>
            );
          })}
        </div>
      </div>
      <pre className="text-xs leading-snug overflow-x-auto px-3 py-2 font-mono whitespace-pre">
        <DiffLine line={hunk.header} />
        {hunk.lines.map((line, i) => (
          <DiffLine key={i} line={line} />
        ))}
      </pre>
    </div>
  );
}

interface ParsedHunk {
  /// The raw `@@ -x,y +a,b @@ ...` header line.
  header: string;
  /// All the lines after the header that belong to this hunk
  /// (' '/'+'/'-'/'\' for "no newline at end of file"). Excludes the
  /// header itself.
  lines: string[];
  /// Index into the file body's line array where this hunk's `@@`
  /// header lives — used as a stable identity for a hunk within a
  /// file, since a single file can have several hunks at the same
  /// line number after edits.
  startLine: number;
}

/// Parse a `FileDiff.body` (full diff including the `diff --git`
/// preamble) into discrete hunks. The preamble before the first `@@`
/// is the file header and is reused for every constructed sub-patch.
function parseHunks(file: FileDiff): ParsedHunk[] {
  const lines = file.body.split('\n');
  const out: ParsedHunk[] = [];
  let cur: ParsedHunk | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      if (cur) out.push(cur);
      cur = { header: line, lines: [], startLine: i };
      continue;
    }
    // Anything before the first `@@` is the file header — skip when
    // we don't have a hunk yet. After the first `@@`, capture content
    // until the next `@@`.
    if (cur) cur.lines.push(line);
  }
  if (cur) out.push(cur);
  return out;
}

/// Re-build a syntactically-valid unified-diff patch with the file's
/// existing header followed by the chosen hunks. We reuse `file.body`'s
/// preamble verbatim so `index <oldsha>..<newsha>` and the path lines
/// match what git would expect.
function buildHunkPatch(file: FileDiff, hunks: ParsedHunk[]): string {
  const lines = file.body.split('\n');
  // Find the first `@@` — everything before it is the file header.
  let firstHunkAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('@@')) {
      firstHunkAt = i;
      break;
    }
  }
  const header = (firstHunkAt === -1 ? lines : lines.slice(0, firstHunkAt)).join('\n');
  const body = hunks
    .map((h) => [h.header, ...h.lines].join('\n'))
    .join('\n');
  return `${header}\n${body}\n`;
}

function DiffView({
  files,
  onOpenFile,
}: {
  files: FileDiff[];
  /// Optional "open in editor" callback. When provided, each file
  /// gets an Open button in its header that hands the path off to the
  /// caller (typically: navigate to the Files tab and load it). Hidden
  /// for files git considers deleted — there's nothing on disk.
  onOpenFile?: (file: FileDiff) => void;
}): JSX.Element {
  if (files.length === 0) {
    return (
      <div className="text-sm text-ink-faint px-2 py-4">
        No changes.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {files.map((f) => (
        <FileDiffBlock key={`${f.status}:${f.path}`} file={f} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

function FileDiffBlock({
  file,
  onOpenFile,
}: {
  file: FileDiff;
  onOpenFile?: (file: FileDiff) => void;
}): JSX.Element {
  const canOpen = !!onOpenFile && file.status !== 'D';
  return (
    <div
      id={`diff-file-${file.path}`}
      className="rounded border border-card overflow-hidden scroll-mt-4 group"
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-card text-xs border-b border-card">
        <FileStatusBadge status={file.status} />
        <span className="font-mono truncate flex-1" title={file.path}>
          {file.path}
        </span>
        {canOpen && (
          <button
            onClick={() => onOpenFile?.(file)}
            title="Open in Files tab"
            className="text-[10px] uppercase tracking-wide font-mono px-2 h-6 rounded text-ink-muted hover:text-ink hover:bg-surface-elevated transition-opacity opacity-0 group-hover:opacity-100 focus:opacity-100"
          >
            Open
          </button>
        )}
      </div>
      <pre className="text-xs leading-snug overflow-x-auto px-3 py-2 font-mono whitespace-pre">
        {file.body.split('\n').map((line, i) => (
          <DiffLine key={i} line={line} />
        ))}
      </pre>
    </div>
  );
}

function DiffLine({ line }: { line: string }): JSX.Element {
  let cls = '';
  if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400';
  else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400';
  else if (line.startsWith('@@')) cls = 'text-ink-faint';
  else if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
  )
    cls = 'text-ink-faint';
  return <span className={cls}>{line + '\n'}</span>;
}

function FileStatusBadge({ status }: { status: FileDiff['status'] }): JSX.Element {
  const map: Record<FileDiff['status'], string> = {
    A: 'bg-emerald-500/20 text-emerald-300',
    M: 'bg-amber-500/20 text-amber-300',
    D: 'bg-red-500/20 text-red-300',
    R: 'bg-sky-500/20 text-sky-300',
    C: 'bg-sky-500/20 text-sky-300',
    '?': 'bg-card text-ink-muted',
  };
  return (
    <span
      className={`inline-block px-1.5 rounded text-[10px] font-mono ${map[status]}`}
    >
      {status}
    </span>
  );
}

function formatDate(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const today = new Date();
    const sameYear = d.getFullYear() === today.getFullYear();
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: sameYear ? undefined : 'numeric',
    });
  } catch {
    return iso;
  }
}

// Re-export RepoStatus type usage so callers importing from this module
// can keep getting just the component without pulling in shared types.
export type { RepoStatus };
