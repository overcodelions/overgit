import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import type { ChangedFile, Commit, FileDiff, RepoStatus, UUID } from '@shared/types';

type Tab = 'changes' | 'history';

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

  return (
    <main className="flex-1 grid grid-rows-[auto_auto_1fr] overflow-hidden">
      <RepoHeader repoId={repoId} />
      <Tabs tab={tab} onChange={setTab} />
      {tab === 'changes' ? <ChangesTab repoId={repoId} /> : <HistoryTab repoId={repoId} />}
    </main>
  );
}

function RepoHeader({ repoId }: { repoId: UUID }): JSX.Element {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId))!;
  const status = useStore((s) => s.repoStatus[repoId]);
  const branches = useStore((s) => s.repoBranches[repoId]);
  const fetchRepo = useStore((s) => s.fetchRepo);
  const pullRepo = useStore((s) => s.pullRepo);
  const pushRepo = useStore((s) => s.pushRepo);
  const checkoutRepo = useStore((s) => s.checkoutRepo);
  const createBranch = useStore((s) => s.createRepoBranch);

  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newBranch, setNewBranch] = useState('');

  const localBranches = branches?.local ?? [];

  const onPickBranch = async (target: string) => {
    if (!target || target === status?.branch) return;
    setBusy(true);
    try {
      const outcome = await checkoutRepo(repoId, target, false);
      if (outcome.result === 'dirty') {
        alert(
          `Can't switch to ${target}: working tree has uncommitted changes. Stash, commit, or discard first.`,
        );
      } else if (outcome.result === 'missing-branch') {
        alert(`Branch ${target} doesn't exist.`);
      } else if (outcome.result === 'error') {
        alert(outcome.message ?? 'Checkout failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async () => {
    if (!newBranch.trim()) return;
    setBusy(true);
    try {
      const res = await createBranch(repoId, newBranch.trim(), true);
      if (!res.ok) {
        alert(res.error ?? 'Create branch failed');
        return;
      }
      setNewBranch('');
      setShowCreate(false);
    } finally {
      setBusy(false);
    }
  };

  const onAction = (fn: () => Promise<{ ok: boolean; error?: string }>) => async () => {
    setBusy(true);
    try {
      const res = await fn();
      if (!res.ok) alert(res.error ?? 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="px-6 py-3 border-b border-card flex items-center gap-4">
      <div className="min-w-0">
        <div className="text-base font-semibold truncate">{repo.name}</div>
        <div className="text-xs text-ink-faint truncate">{repo.path}</div>
      </div>

      <div className="flex items-center gap-2 ml-auto">
        <select
          disabled={busy}
          value={status?.branch ?? ''}
          onChange={(e) => onPickBranch(e.target.value)}
          className="text-sm px-2 py-1 rounded bg-surface-elevated border border-card disabled:opacity-50"
          title="Switch branch"
        >
          {!status?.branch && <option value="">(detached)</option>}
          {localBranches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>

        <button
          disabled={busy}
          onClick={() => setShowCreate((s) => !s)}
          className="text-sm px-2 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
          title="Create branch"
        >
          + Branch
        </button>

        <div className="w-px h-6 bg-card mx-1" />

        <button
          disabled={busy}
          onClick={onAction(() => fetchRepo(repoId))}
          className="text-sm px-3 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
        >
          Fetch
        </button>
        <button
          disabled={busy || !status?.branch}
          onClick={onAction(() => pullRepo(repoId))}
          className="text-sm px-3 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
        >
          Pull{status?.behind ? ` ↓${status.behind}` : ''}
        </button>
        <button
          disabled={busy || !status?.branch}
          onClick={onAction(() => pushRepo(repoId))}
          className="text-sm px-3 py-1 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
        >
          Push{status?.ahead ? ` ↑${status.ahead}` : ''}
        </button>
      </div>

      {showCreate && (
        <div className="absolute right-6 top-16 z-10 p-3 rounded-lg bg-surface-elevated border border-card shadow-lg flex gap-2">
          <input
            autoFocus
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            placeholder="new-branch-name"
            className="px-2 py-1 rounded bg-surface-elevated border border-card text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCreate();
              if (e.key === 'Escape') {
                setShowCreate(false);
                setNewBranch('');
              }
            }}
          />
          <button
            disabled={busy || !newBranch.trim()}
            onClick={onCreate}
            className="text-sm px-3 py-1 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
          >
            Create & switch
          </button>
        </div>
      )}
    </header>
  );
}

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }): JSX.Element {
  return (
    <nav className="px-6 border-b border-card flex gap-2">
      {(['changes', 'history'] as const).map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`px-3 py-2 text-sm border-b-2 -mb-px ${
            tab === t
              ? 'border-accent text-ink'
              : 'border-transparent text-ink-muted hover:text-ink'
          }`}
        >
          {t === 'changes' ? 'Changes' : 'History'}
        </button>
      ))}
    </nav>
  );
}

function ChangesTab({ repoId }: { repoId: UUID }): JSX.Element {
  const ch = useStore((s) => s.repoChanges[repoId]);
  const stage = useStore((s) => s.stageFiles);
  const unstage = useStore((s) => s.unstageFiles);
  const discard = useStore((s) => s.discardFiles);
  const commit = useStore((s) => s.commitRepo);
  const loadDiff = useStore((s) => s.loadRepoFileDiff);
  const diffEntry = useStore((s) => s.repoDiff[repoId]);

  const [selected, setSelected] = useState<{ path: string; side: 'staged' | 'unstaged' } | null>(
    null,
  );
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const staged = ch?.staged ?? [];
  const unstaged = ch?.unstaged ?? [];

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
        <FileGroup
          title="Staged"
          files={staged}
          activePath={selected?.side === 'staged' ? selected.path : null}
          actionLabel="Unstage"
          onAction={(f) => unstage(repoId, [f.path])}
          onActionAll={
            staged.length > 0
              ? () => unstage(repoId, staged.map((f) => f.path))
              : undefined
          }
          onSelect={(f) => onSelect(f, 'staged')}
        />
        <FileGroup
          title="Changes"
          files={unstaged}
          activePath={selected?.side === 'unstaged' ? selected.path : null}
          actionLabel="Stage"
          onAction={(f) => stage(repoId, [f.path])}
          onActionAll={
            unstaged.length > 0
              ? () => stage(repoId, unstaged.map((f) => f.path))
              : undefined
          }
          onSelect={(f) => onSelect(f, 'unstaged')}
          extraAction={{ label: 'Discard', onAction: onDiscard }}
        />

        <div className="mt-auto p-3 border-t border-card flex flex-col gap-2">
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

function FileGroup({
  title,
  files,
  activePath,
  actionLabel,
  onAction,
  onActionAll,
  onSelect,
  extraAction,
}: {
  title: string;
  files: ChangedFile[];
  activePath: string | null;
  actionLabel: string;
  onAction: (file: ChangedFile) => void;
  onActionAll?: () => void;
  onSelect: (file: ChangedFile) => void;
  extraAction?: { label: string; onAction: (file: ChangedFile) => void };
}): JSX.Element {
  return (
    <div className="border-b border-card">
      <div className="flex items-center justify-between px-3 py-2 bg-card">
        <div className="text-xs uppercase tracking-wide text-ink-faint">
          {title} <span className="text-ink-faint">({files.length})</span>
        </div>
        {onActionAll && (
          <button
            onClick={onActionAll}
            className="text-xs px-2 py-0.5 rounded border border-card hover:bg-surface-elevated"
          >
            {actionLabel} all
          </button>
        )}
      </div>
      {files.length === 0 ? (
        <div className="px-3 py-2 text-xs text-ink-faint">No files.</div>
      ) : (
        <ul>
          {files.map((f) => {
            const active = activePath === f.path;
            return (
              <li
                key={`${title}:${f.path}`}
                className={`flex items-center gap-2 px-3 py-1.5 text-sm border-b border-card last:border-0 ${
                  active ? 'bg-accent text-white' : 'hover:bg-card'
                }`}
              >
                <ChangeStatusBadge file={f} />
                <button
                  onClick={() => onSelect(f)}
                  className="min-w-0 flex-1 text-left truncate font-mono text-xs"
                  title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
                >
                  {f.origPath ? `${f.origPath} → ${f.path}` : f.path}
                </button>
                <button
                  onClick={() => onAction(f)}
                  className={`text-xs px-2 py-0.5 rounded border border-card ${
                    active ? 'hover:bg-accent-strong' : 'hover:bg-surface-elevated'
                  }`}
                >
                  {actionLabel}
                </button>
                {extraAction && (
                  <button
                    onClick={() => extraAction.onAction(f)}
                    className={`text-xs px-2 py-0.5 rounded border border-card ${
                      active ? 'hover:bg-accent-strong' : 'hover:bg-surface-elevated'
                    }`}
                    title={extraAction.label}
                  >
                    {extraAction.label}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
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

function HistoryTab({ repoId }: { repoId: UUID }): JSX.Element {
  const commits = useStore((s) => s.repoLog[repoId] ?? []);
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
