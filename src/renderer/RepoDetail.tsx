import React, { useEffect, useMemo, useRef, useState } from 'react';
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

type Tab = 'changes' | 'history' | 'files' | 'graph';

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
  };
  return (
    <nav className="px-6 border-b border-card flex gap-2">
      {(['changes', 'history', 'files', 'graph'] as const).map((t) => (
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
  const stage = useStore((s) => s.stageFiles);
  const unstage = useStore((s) => s.unstageFiles);
  const discard = useStore((s) => s.discardFiles);
  const commit = useStore((s) => s.commitRepo);
  const loadDiff = useStore((s) => s.loadRepoFileDiff);
  const diffEntry = useStore((s) => s.repoDiff[repoId]);
  const cli = useStore((s) => s.cliPresence);
  const setSheet = useStore((s) => s.setSheet);

  const [selected, setSelected] = useState<{ path: string; side: 'staged' | 'unstaged' } | null>(
    null,
  );
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
        />
        <FileGroup
          title="Changes"
          files={unstaged}
          activePath={selected?.side === 'unstaged' ? selected.path : null}
          actionLabel="Stage"
          onAction={(f) => stage(repoId, [f.path])}
          onSelect={(f) => onSelect(f, 'unstaged')}
          extraAction={{ label: 'Discard', onAction: onDiscard }}
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

  const onClick = async () => {
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
  };

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

function FileGroup({
  title,
  files,
  activePath,
  actionLabel,
  onAction,
  onSelect,
  extraAction,
}: {
  title: string;
  files: ChangedFile[];
  activePath: string | null;
  actionLabel: string;
  onAction: (file: ChangedFile) => void;
  onSelect: (file: ChangedFile) => void;
  extraAction?: { label: string; onAction: (file: ChangedFile) => void };
}): JSX.Element {
  return (
    <div className="border-b border-card">
      <div className="flex items-center justify-between px-3 py-2 bg-card">
        <div className="text-[10px] uppercase tracking-wide text-ink-faint">
          {title} <span className="text-ink-faint">({files.length})</span>
        </div>
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
