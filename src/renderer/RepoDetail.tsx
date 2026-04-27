import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { FileEditor } from './FileEditor';
import { BranchGraph } from './BranchGraph';
import { BranchPicker } from './BranchPicker';
import type {
  ChangedFile,
  Commit,
  FileDiff,
  LlmTool,
  RepoStatus,
  UUID,
} from '@shared/types';

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

type Tab = 'changes' | 'history' | 'files' | 'graph' | 'stash';

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
        detail === 'graph'
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
      {tab === 'graph' && <BranchGraph repoId={repoId} />}
      {tab === 'stash' && <StashTab repoId={repoId} />}
    </main>
  );
}

function RepoHeader({ repoId }: { repoId: UUID }): JSX.Element {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId))!;
  const status = useStore((s) => s.repoStatus[repoId]);
  const fetchRepo = useStore((s) => s.fetchRepo);
  const pullRepo = useStore((s) => s.pullRepo);
  const pushRepo = useStore((s) => s.pushRepo);

  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Cmd+B shortcut → toggle the picker. The global handler in App
  // dispatches a window event when a repo is open; we just toggle.
  useEffect(() => {
    const onOpen = () => setPickerOpen((v) => !v);
    window.addEventListener('overgit:openBranchPicker', onOpen);
    return () => window.removeEventListener('overgit:openBranchPicker', onOpen);
  }, []);

  const onAction = (fn: () => Promise<{ ok: boolean; error?: string }>) => async () => {
    setBusy(true);
    try {
      const res = await fn();
      if (!res.ok) alert(res.error ?? 'Action failed');
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

        <div className="w-px h-5 bg-card mx-1" />

        <button
          disabled={busy}
          onClick={onAction(() => fetchRepo(repoId))}
          className="text-xs px-2.5 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
        >
          Fetch
        </button>
        <button
          disabled={busy || !status?.branch}
          onClick={onAction(() => pullRepo(repoId))}
          className="text-xs px-2.5 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
        >
          Pull{status?.behind ? ` ↓${status.behind}` : ''}
        </button>
        <button
          disabled={busy || !status?.branch}
          onClick={onAction(() => pushRepo(repoId))}
          className="text-xs px-2.5 py-1 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
        >
          Push{status?.ahead ? ` ↑${status.ahead}` : ''}
        </button>
      </div>

      {pickerOpen && (
        <BranchPicker
          repoId={repoId}
          anchorRef={triggerRef}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </header>
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
    graph: 'Graph',
    stash: 'Stash',
  };
  return (
    <nav className="px-6 border-b border-card flex gap-2">
      {(['changes', 'history', 'files', 'graph', 'stash'] as const).map((t) => (
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
  const repoPath = useStore((s) => s.repos.find((r) => r.id === repoId)?.path);
  const stage = useStore((s) => s.stageFiles);
  const unstage = useStore((s) => s.unstageFiles);
  const discard = useStore((s) => s.discardFiles);
  const commit = useStore((s) => s.commitRepo);
  const loadDiff = useStore((s) => s.loadRepoFileDiff);
  const diffEntry = useStore((s) => s.repoDiff[repoId]);
  const cli = useStore((s) => s.cliPresence);
  const setSheet = useStore((s) => s.setSheet);
  const openRepoFile = useStore((s) => s.openRepoFile);
  const stashFilesAction = useStore((s) => s.stashFiles);

  // Stashing prompts inline via the FileGroup bar (Electron renderers
  // refuse window.prompt). The message is optional — empty string ⇒
  // git uses its default "WIP on <branch>" subject.
  const onStash = async (paths: string[], message?: string) => {
    if (paths.length === 0) return;
    const res = await stashFilesAction(repoId, paths, message);
    if (!res.ok) alert(res.error ?? 'Stash failed');
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

  const [selected, setSelected] = useState<{ path: string; side: 'staged' | 'unstaged' } | null>(
    null,
  );
  // Per-side selection sets for the bulk-action toolbar. We keep two
  // sets — one per group — so checking a file in the staged list and
  // one in the unstaged list is independent (their bulk actions are
  // different too: unstage vs. stage / discard).
  const [stagedChecked, setStagedChecked] = useState<Set<string>>(new Set());
  const [unstagedChecked, setUnstagedChecked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const staged = ch?.staged ?? [];
  const unstaged = ch?.unstaged ?? [];
  const anyLlm = !!(cli?.claude || cli?.codex || cli?.gemini);

  const onSelect = (file: ChangedFile, side: 'staged' | 'unstaged') => {
    setSelected({ path: file.path, side });
    loadDiff(repoId, file.path, side);
  };

  const onCommit = async () => {
    if (!message.trim() || staged.length === 0) return;
    setBusy(true);
    try {
      const res = await commit(repoId, message.trim());
      if (!res.ok) {
        alert(res.error ?? 'Commit failed');
        return;
      }
      setMessage('');
      setSelected(null);
    } finally {
      setBusy(false);
    }
  };

  const onDiscard = async (file: ChangedFile) => {
    const ok = window.confirm(
      `Discard changes to ${file.path}? This cannot be undone.`,
    );
    if (!ok) return;
    await discard(repoId, [file.path]);
    if (selected?.path === file.path) setSelected(null);
  };

  return (
    <div className="grid grid-cols-[360px_1fr] overflow-hidden">
      <aside className="border-r border-card overflow-y-auto flex flex-col">
        <div className="flex items-center gap-1 px-3 py-2 border-b border-card flex-wrap">
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
              onAction: (paths) => {
                if (
                  !window.confirm(
                    `Discard changes in ${paths.length} ${
                      paths.length === 1 ? 'file' : 'files'
                    }? This cannot be undone.`,
                  )
                )
                  return;
                void discard(repoId, paths);
              },
            },
          ]}
        />

        <div className="mt-auto p-3 border-t border-card flex flex-col gap-2">
          <CommitMessageSuggest
            repoId={repoId}
            stagedCount={staged.length}
            onSuggested={(text) => setMessage(text)}
          />
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              staged.length === 0
                ? 'Stage files to commit'
                : `Commit message (${staged.length} ${
                    staged.length === 1 ? 'file' : 'files'
                  } staged)`
            }
            disabled={staged.length === 0}
            className="w-full px-2 py-1.5 rounded bg-surface-elevated border border-card text-sm resize-y min-h-[64px] disabled:opacity-50"
          />
          <button
            disabled={busy || staged.length === 0 || !message.trim()}
            onClick={onCommit}
            className="text-sm px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
          >
            Commit{staged.length > 0 ? ` ${staged.length}` : ''}
          </button>
        </div>
      </aside>

      <section className="overflow-y-auto p-4">
        {selected ? (
          <DiffView files={diffEntry?.files ?? []} />
        ) : (
          <div className="text-sm text-ink-faint">
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
function CommitMessageSuggest({
  repoId,
  stagedCount,
  onSuggested,
}: {
  repoId: UUID;
  stagedCount: number;
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
  }, [tool, stagedCount, repoId, onSuggested]);

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
          <span>{busy ? `Drafting with ${tool}…` : `Suggest with ${tool}`}</span>
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
        <div className="flex flex-nowrap items-center gap-2 px-3 py-1.5 bg-accent/10 border-b border-accent/20">
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
    if (
      !window.confirm(
        `Force overwrite ${error.conflicts?.length ?? 0} working-tree ${
          error.conflicts?.length === 1 ? 'file' : 'files'
        } and ${error.pop ? 'pop' : 'apply'} the stash? The local copies are deleted before the stash content is restored.`,
      )
    )
      return;
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
    if (
      !window.confirm(
        `Drop stash@{${index}}? This is irreversible — the contents are lost.`,
      )
    )
      return;
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
            {stashes.map((s) => (
              <li key={s.ref}>
                <button
                  onClick={() => setSelected(s.index)}
                  className={`w-full text-left px-4 py-2.5 border-b border-card ${
                    selected === s.index ? 'bg-accent text-white' : 'hover:bg-card'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`text-[10px] font-mono ${
                        selected === s.index ? 'text-white/80' : 'text-ink-faint'
                      }`}
                    >
                      stash@{'{'}
                      {s.index}
                      {'}'}
                    </span>
                    {s.branch && (
                      <span
                        className={`text-[10px] font-mono ${
                          selected === s.index ? 'text-white/80' : 'text-sky-300/80'
                        }`}
                      >
                        on {s.branch}
                      </span>
                    )}
                    <span
                      className={`text-[10px] ml-auto font-mono ${
                        selected === s.index ? 'text-white/70' : 'text-ink-faint'
                      }`}
                    >
                      {relativeAgo(s.date)}
                    </span>
                  </div>
                  <div className="text-xs mt-0.5 truncate" title={s.subject}>
                    {s.subject || '(no message)'}
                  </div>
                  <div
                    className={`text-[10px] mt-0.5 font-mono ${
                      selected === s.index ? 'text-white/60' : 'text-ink-faint'
                    }`}
                  >
                    {s.shortSha}
                  </div>
                </button>
              </li>
            ))}
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

function HistoryTab({ repoId }: { repoId: UUID }): JSX.Element {
  const commits = useStore((s) => s.repoLog[repoId] ?? EMPTY_COMMITS);
  const refreshDiff = useStore((s) => s.refreshRepoDiff);
  const diffEntry = useStore((s) => s.repoDiff[repoId]);

  const [selected, setSelected] = useState<string | 'working'>('working');

  useEffect(() => {
    refreshDiff(repoId, undefined);
    setSelected('working');
  }, [refreshDiff, repoId]);

  const onPickCommit = (sha: string) => {
    setSelected(sha);
    refreshDiff(repoId, sha);
  };

  const onPickWorking = () => {
    setSelected('working');
    refreshDiff(repoId, undefined);
  };

  return (
    <div className="grid grid-cols-[280px_1fr] overflow-hidden">
      <aside className="overflow-y-auto border-r border-card">
        <button
          onClick={onPickWorking}
          className={`w-full text-left px-4 py-2 text-sm border-b border-card ${
            selected === 'working' ? 'bg-accent text-white' : 'hover:bg-card'
          }`}
        >
          <div className="font-medium">Working tree</div>
          <div className={`text-xs ${selected === 'working' ? 'text-white/70' : 'text-ink-faint'}`}>
            staged + unstaged vs HEAD
          </div>
        </button>
        <ul>
          {commits.map((c) => (
            <li key={c.sha}>
              <button
                onClick={() => onPickCommit(c.sha)}
                className={`w-full text-left px-4 py-2 text-sm border-b border-card ${
                  selected === c.sha ? 'bg-accent text-white' : 'hover:bg-card'
                }`}
              >
                <CommitRow commit={c} active={selected === c.sha} />
              </button>
            </li>
          ))}
          {commits.length === 0 && (
            <li className="px-4 py-3 text-xs text-ink-faint">No commits.</li>
          )}
        </ul>
      </aside>

      <section className="overflow-y-auto p-4">
        <DiffView files={diffEntry?.files ?? []} />
      </section>
    </div>
  );
}

function CommitRow({ commit, active }: { commit: Commit; active: boolean }): JSX.Element {
  const date = useMemo(() => formatDate(commit.date), [commit.date]);
  return (
    <>
      <div className="font-medium truncate">{commit.subject || '(no subject)'}</div>
      <div className={`text-xs flex gap-2 ${active ? 'text-white/70' : 'text-ink-faint'}`}>
        <span className="font-mono">{commit.shortSha}</span>
        <span className="truncate">{commit.author}</span>
        <span className="ml-auto">{date}</span>
      </div>
    </>
  );
}

function DiffView({ files }: { files: FileDiff[] }): JSX.Element {
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
        <FileDiffBlock key={`${f.status}:${f.path}`} file={f} />
      ))}
    </div>
  );
}

function FileDiffBlock({ file }: { file: FileDiff }): JSX.Element {
  return (
    <div className="rounded border border-card overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-card text-xs border-b border-card">
        <FileStatusBadge status={file.status} />
        <span className="font-mono truncate">{file.path}</span>
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
