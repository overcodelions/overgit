import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import type { BranchSummary, Commit, UUID } from '@shared/types';
import { sanitizeBranchName } from '@shared/branch-name';
import { Explain } from './Explain';

interface Props {
  repoId: UUID;
  /// Position the popover under the trigger element. We use the bounding
  /// rect rather than a portal so the picker tracks the trigger if the
  /// header reflows.
  anchorRef: React.RefObject<HTMLElement>;
  /// Mount the picker directly into a sub-mode instead of the branch
  /// list. Currently only `create` is wired — used by the Cmd+N shortcut
  /// so the user lands on the "name your new branch" form immediately.
  initialMode?: 'create' | null;
  onClose: () => void;
}

type Mode =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'cherryPickFrom'; branch: BranchSummary }
  | { kind: 'rename'; branch: BranchSummary };

/// Searchable branch picker popover. GitHub-Desktop-style: type to
/// filter, arrow keys to move, Enter to switch. Branches are grouped
/// (default, current, local, remote) and each row shows the tip's
/// subject/age so the user knows what they're switching into.
///
/// Two side-quests are reachable from the same popover:
///   - Create branch (inline form, switches on submit)
///   - Cherry-pick from a branch (opens a commit picker, applies on Enter)
/// Both close the popover on success and surface errors via window.alert.
export function BranchPicker({ repoId, anchorRef, initialMode, onClose }: Props): JSX.Element | null {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId));
  const status = useStore((s) => s.repoStatus[repoId]);
  const summaries = useStore((s) => s.repoBranchSummaries[repoId] ?? null);
  const refresh = useStore((s) => s.refreshRepoBranchSummaries);
  const checkout = useStore((s) => s.checkoutRepo);
  const create = useStore((s) => s.createRepoBranch);
  const pushToast = useStore((s) => s.pushToast);
  const requestConfirm = useStore((s) => s.requestConfirm);

  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<Mode>(
    initialMode === 'create' ? { kind: 'create' } : { kind: 'list' },
  );
  const [busy, setBusy] = useState(false);
  /// Branch name the user just clicked to switch into. Drives the
  /// "Switching to <branch>…" overlay so the picker doesn't look frozen
  /// while git churns through the checkout (can take a beat on big
  /// repos). Cleared once the IPC resolves.
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const anchorRect = useAnchorRect(anchorRef);

  // Re-fetch summaries every time the picker mounts — the cache can
  // be stale right after a checkout (other UI may have advanced HEAD
  // without updating summaries) and we want the "ON" badge to track
  // the actual current branch. Cheap call; one IPC per picker open.
  useEffect(() => {
    refresh(repoId);
  }, [refresh, repoId]);

  // Outside-click + Esc dismiss. We special-case the trigger element so
  // clicking it again closes (the parent-button toggle), not a re-open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mode.kind !== 'list') setMode({ kind: 'list' });
        else onClose();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (containerRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [onClose, mode, anchorRef]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  const grouped = useMemo(() => groupBranches(summaries ?? [], status?.branch ?? null, search), [
    summaries,
    status?.branch,
    search,
  ]);
  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);
  const [activeIdx, setActiveIdx] = useState(0);

  // Keep the keyboard cursor inside the visible list as it shrinks/grows
  // in response to the search filter.
  useEffect(() => {
    if (activeIdx >= flat.length) setActiveIdx(Math.max(0, flat.length - 1));
  }, [flat.length, activeIdx]);

  const onSwitch = async (b: BranchSummary) => {
    if (b.isCurrent) {
      onClose();
      return;
    }
    const target = b.kind === 'remote' ? b.shortName : b.name;
    setBusy(true);
    setSwitchingTo(b.shortName);
    try {
      const outcome = await checkout(repoId, target, false);
      if (outcome.result === 'error') {
        pushToast({ kind: 'error', message: outcome.message ?? 'Checkout failed' });
      } else if (outcome.result === 'dirty') {
        pushToast({
          kind: 'warn',
          message: `Can't switch to ${target}: working tree has uncommitted changes. Stash, commit, or discard first.`,
        });
      } else if (outcome.result === 'missing-branch') {
        pushToast({
          kind: 'warn',
          message: `Branch ${target} doesn't exist locally or on origin.`,
        });
      } else if (outcome.result === 'worktree-conflict') {
        pushToast({
          kind: 'warn',
          message: outcome.worktreePath
            ? `${target} is checked out at ${outcome.worktreePath}. Adopt or remove that worktree first (Worktrees panel).`
            : `${target} is checked out in a linked worktree.`,
        });
      }
      onClose();
    } finally {
      setBusy(false);
      setSwitchingTo(null);
    }
  };

  const pullRepo = useStore((s) => s.pullRepo);
  const mergeBranchAction = useStore((s) => s.mergeBranch);
  const rebaseOntoAction = useStore((s) => s.rebaseOnto);
  const renameBranchAction = useStore((s) => s.renameRepoBranch);

  const dismissToast = useStore((s) => s.dismissToast);
  const onMerge = async (b: BranchSummary) => {
    // Prefer the upstream tracking ref when a local branch has one. The
    // trunk-distance pill compares against `origin/<branch>`, so merging
    // local `master` (which the user hasn't pulled) silently no-ops while
    // the pill still says "14 behind master". Merging the upstream
    // matches what the user is reading on screen.
    const target =
      b.kind === 'remote' ? b.name : b.upstream ?? b.shortName;
    const targetLabel =
      b.kind === 'local' && b.upstream && b.upstream !== b.shortName
        ? `${b.shortName} (via ${b.upstream})`
        : target;
    const into = status?.branch ?? 'current branch';
    // Default to a regular merge (creates a merge commit). FF-only
    // and squash can be added as a sub-menu in a future pass — most
    // common case is just "merge X in", and conflicts get caught by
    // the in-progress banner in the Changes tab.
    const ok = await requestConfirm({
      title: `Merge ${b.shortName}?`,
      body: `Merge ${targetLabel} into ${into}?\n\nIf there are conflicts you'll see a banner in the Changes tab with Resolve / Abort options.`,
      confirmLabel: 'Merge',
    });
    if (!ok) return;
    setBusy(true);
    // Sticky "in progress" toast — bridges the gap between dialog close
    // and the success/error toast so the user can see the merge is
    // running. Dismissed before we push the final outcome.
    const pendingId = pushToast({
      kind: 'info',
      message: `Merging ${target} into ${into}…`,
      sticky: true,
    });
    try {
      const res = await mergeBranchAction(repoId, target, 'merge');
      dismissToast(pendingId);
      if (!res.ok) {
        pushToast({ kind: 'error', message: res.error ?? 'Merge failed' });
      } else if (res.alreadyUpToDate) {
        pushToast({
          kind: 'info',
          message: `Already up to date — ${into} already contains every commit on ${target}.`,
        });
      } else {
        pushToast({ kind: 'success', message: `Merged ${target} into ${into}.` });
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const onRename = async (b: BranchSummary, next: string) => {
    setBusy(true);
    try {
      // Branch picker only ever renames local branches (the rename
      // affordance is hidden on remote rows). For the *current* branch
      // we pass `null` so git renames HEAD's branch directly — equivalent
      // but avoids an explicit `<from>` arg.
      const from = b.isCurrent ? null : b.shortName;
      const res = await renameBranchAction(repoId, from, next, false);
      if (!res.ok) {
        pushToast({ kind: 'error', message: res.error ?? 'Rename failed' });
        return false;
      }
      await refresh(repoId);
      return true;
    } finally {
      setBusy(false);
    }
  };

  const onRebase = async (b: BranchSummary) => {
    const target = b.kind === 'remote' ? b.name : b.shortName;
    const ok = await requestConfirm({
      title: `Rebase onto ${target}?`,
      body: `Rebase current branch onto ${target}? Your commits will be replayed on top of ${target}.`,
      confirmLabel: 'Rebase',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await rebaseOntoAction(repoId, target);
      if (!res.ok) {
        pushToast({
          kind: 'error',
          message:
            (res.error ?? 'Rebase failed') +
            '\n\nIf there are conflicts, resolve them in the Changes tab — the conflict banner will guide you through Continue / Abort.',
          sticky: true,
        });
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async (
    name: string,
    opts: { syncDefault: boolean; pull: boolean },
  ) => {
    setBusy(true);
    try {
      // Optional sync to default branch first. We skip silently if no
      // default is configured — the create still runs from current HEAD,
      // which matches the workset-wide flow's "no-default-branch"
      // behavior.
      if (opts.syncDefault && repo?.defaultBranch) {
        const switchRes = await checkout(repoId, repo.defaultBranch, false);
        if (switchRes.result === 'dirty') {
          pushToast({
            kind: 'warn',
            message: `Can't sync to ${repo.defaultBranch}: working tree is dirty. Stash or commit first.`,
          });
          return;
        }
        if (switchRes.result === 'error' || switchRes.result === 'missing-branch') {
          pushToast({
            kind: 'error',
            message: switchRes.message ?? `Could not switch to ${repo.defaultBranch}`,
          });
          return;
        }
      }
      if (opts.pull) {
        const pullRes = await pullRepo(repoId);
        if (!pullRes.ok) {
          pushToast({ kind: 'error', message: pullRes.error ?? 'Pull failed' });
          return;
        }
      }
      const res = await create(repoId, name, true);
      if (!res.ok) {
        pushToast({ kind: 'error', message: res.error ?? 'Create failed' });
        return;
      }
      await refresh(repoId);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  if (!anchorRect) return null;

  // Anchored under the trigger; clamp to the right edge of the window so
  // the picker doesn't slip off-screen on narrow layouts.
  const popWidth = 460;
  const popLeft = Math.min(
    Math.max(8, anchorRect.left),
    window.innerWidth - popWidth - 8,
  );
  const popTop = anchorRect.bottom + 4;

  return (
    <div
      ref={containerRef}
      className="fixed z-40 bg-surface-elevated border border-card rounded-lg shadow-2xl overflow-hidden flex flex-col"
      style={{ width: popWidth, left: popLeft, top: popTop, maxHeight: '60vh' }}
    >
      {mode.kind === 'list' && (
        <ListMode
          inputRef={inputRef}
          search={search}
          setSearch={setSearch}
          grouped={grouped}
          flat={flat}
          activeIdx={activeIdx}
          setActiveIdx={setActiveIdx}
          busy={busy}
          onSwitch={onSwitch}
          onStartCreate={() => {
            setSearch('');
            setMode({ kind: 'create' });
          }}
          onCherryPickFrom={(b) => setMode({ kind: 'cherryPickFrom', branch: b })}
          onRenameBranch={(b) => setMode({ kind: 'rename', branch: b })}
          onMerge={onMerge}
          onRebase={onRebase}
          currentBranchLabel={status?.branch ?? null}
        />
      )}
      {mode.kind === 'create' && (
        <CreateMode
          inputRef={inputRef}
          busy={busy}
          defaultBranch={repo?.defaultBranch ?? null}
          onCancel={() => setMode({ kind: 'list' })}
          onSubmit={(name, opts) => onCreate(name, opts)}
        />
      )}
      {mode.kind === 'cherryPickFrom' && (
        <CherryPickMode
          repoId={repoId}
          branch={mode.branch}
          onCancel={() => setMode({ kind: 'list' })}
          onClose={onClose}
        />
      )}
      {mode.kind === 'rename' && (
        <RenameMode
          inputRef={inputRef}
          busy={busy}
          branch={mode.branch}
          onCancel={() => setMode({ kind: 'list' })}
          onSubmit={async (next) => {
            const ok = await onRename(mode.branch, next);
            if (ok) setMode({ kind: 'list' });
          }}
        />
      )}
      {switchingTo && (
        <div className="absolute inset-0 bg-surface-elevated/85 backdrop-blur-sm flex items-center justify-center text-xs text-ink z-10">
          <div className="flex items-center gap-2">
            <span
              className="inline-block w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin"
              aria-hidden
            />
            <span>
              Switching to <span className="font-mono">{switchingTo}</span>…
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function ListMode({
  inputRef,
  search,
  setSearch,
  grouped,
  flat,
  activeIdx,
  setActiveIdx,
  busy,
  onSwitch,
  onStartCreate,
  onCherryPickFrom,
  onRenameBranch,
  onMerge,
  onRebase,
  currentBranchLabel,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  search: string;
  setSearch: (s: string) => void;
  grouped: BranchGroup[];
  flat: BranchSummary[];
  activeIdx: number;
  setActiveIdx: (n: number) => void;
  busy: boolean;
  onSwitch: (b: BranchSummary) => void;
  onStartCreate: () => void;
  onCherryPickFrom: (b: BranchSummary) => void;
  onRenameBranch: (b: BranchSummary) => void;
  onMerge: (b: BranchSummary) => void;
  onRebase: (b: BranchSummary) => void;
  currentBranchLabel: string | null;
}): JSX.Element {
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(Math.min(flat.length - 1, activeIdx + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(Math.max(0, activeIdx - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = flat[activeIdx];
      if (target) onSwitch(target);
    }
  };

  return (
    <>
      <div className="p-2 border-b border-card">
        <input
          ref={inputRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onKey}
          placeholder={`Search branches…${currentBranchLabel ? `  (on ${currentBranchLabel})` : ''}`}
          className="field w-full px-2 py-1.5 text-xs"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {flat.length === 0 ? (
          <div className="px-3 py-3 text-xs text-ink-faint">No branches match.</div>
        ) : (
          grouped.map((g) => (
            <div key={g.label}>
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-ink-faint">
                {g.label}
              </div>
              {g.items.map((b) => {
                const idx = flat.indexOf(b);
                return (
                  <BranchRow
                    key={`${b.kind}:${b.name}`}
                    branch={b}
                    active={idx === activeIdx}
                    busy={busy}
                    onSelect={() => onSwitch(b)}
                    onHover={() => setActiveIdx(idx)}
                    onCherryPickFrom={() => onCherryPickFrom(b)}
                    onRenameBranch={() => onRenameBranch(b)}
                    onMerge={() => onMerge(b)}
                    onRebase={() => onRebase(b)}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className="border-t border-card p-2 flex items-center justify-between gap-2 text-[11px]">
        <Explain
          command="git checkout -b <new-branch>"
          plain="Create a new branch starting from your current commit and switch to it."
        >
          <button
            onClick={onStartCreate}
            className="text-ink-muted hover:text-ink rounded px-2 py-1 hover:bg-card"
          >
            + Create branch
          </button>
        </Explain>
        <span className="text-ink-faint">
          ↑↓ to move · Enter to switch · Esc to close
        </span>
      </div>
    </>
  );
}

function BranchRow({
  branch,
  active,
  busy,
  onSelect,
  onHover,
  onCherryPickFrom,
  onRenameBranch,
  onMerge,
  onRebase,
}: {
  branch: BranchSummary;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onHover: () => void;
  onCherryPickFrom: () => void;
  onRenameBranch: () => void;
  onMerge: () => void;
  onRebase: () => void;
}): JSX.Element {
  // Merge / Rebase only make sense when the row is NOT the current
  // branch — git refuses to merge a branch into itself, and rebase-onto
  // self is always a no-op. We hide both actions for the current row
  // so the affordance stays meaningful.
  const showMergeRebase = !branch.isCurrent;
  // Rename only applies to local branches — `git branch -m` doesn't
  // rename remote-tracking refs, that requires renaming server-side.
  const showRename = branch.kind === 'local';
  return (
    <div
      onMouseEnter={onHover}
      className={`group relative flex items-center gap-2 px-3 py-2 text-xs ${
        active ? 'bg-accent/15' : ''
      }`}
    >
      <Explain
        command={
          branch.kind === 'remote'
            ? `git checkout ${branch.shortName}`
            : `git checkout ${branch.shortName}`
        }
        plain={
          branch.isCurrent
            ? `You are already on ${branch.shortName}.`
            : branch.kind === 'remote'
              ? `Switch to ${branch.shortName} — creates a local branch tracking this remote.`
              : `Switch HEAD to ${branch.shortName}. Your working tree updates to match.`
        }
      >
      <button
        disabled={busy}
        onClick={onSelect}
        className="flex-1 min-w-0 text-left flex flex-col gap-0.5"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {branch.isCurrent && (
            <span className="text-[9px] uppercase font-mono text-emerald-400">on</span>
          )}
          <span
            className={`font-mono truncate ${branch.isCurrent ? 'text-ink font-medium' : 'text-ink'}`}
          >
            {branch.kind === 'remote' ? branch.name : branch.shortName}
          </span>
          {branch.kind === 'remote' && (
            <span className="text-[9px] uppercase font-mono text-sky-300/80">remote</span>
          )}
          {branch.upstream &&
            branch.kind === 'local' &&
            branch.upstream !== `origin/${branch.shortName}` && (
              <span
                className="text-[10px] text-ink-faint truncate shrink-0"
                title={`tracks ${branch.upstream}`}
              >
                ↔ {branch.upstream}
              </span>
            )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-ink-faint min-w-0">
          <span className="font-mono">{branch.shortSha}</span>
          <span className="truncate">{branch.subject || '(no subject)'}</span>
          <span className="ml-auto whitespace-nowrap">{relativeTime(branch.date)}</span>
        </div>
      </button>
      </Explain>
      <div
        className={`absolute right-2 top-1/2 -translate-y-1/2 flex gap-1 rounded-md bg-surface-elevated/95 backdrop-blur-sm shadow-md p-0.5 transition-opacity ${
          active ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'
        }`}
      >
        {showMergeRebase && (
          <>
            <Explain
              command={`git merge ${branch.shortName}`}
              plain={`Bring commits from ${branch.shortName} into your current branch as a merge commit.`}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onMerge();
                }}
                className="text-[10px] px-1.5 py-1 rounded border border-card hover:bg-card"
                title={`Merge ${branch.shortName} into current branch`}
              >
                Merge
              </button>
            </Explain>
            <Explain
              command={`git rebase ${branch.shortName}`}
              plain={`Replay your current branch's commits on top of ${branch.shortName}. Rewrites history.`}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRebase();
                }}
                className="text-[10px] px-1.5 py-1 rounded border border-card hover:bg-card"
                title={`Rebase current branch onto ${branch.shortName}`}
              >
                Rebase
              </button>
            </Explain>
          </>
        )}
        {showRename && (
          <Explain
            command={`git branch -m ${branch.shortName} <new-name>`}
            plain={`Rename ${branch.shortName} in place. The branch keeps its history.`}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRenameBranch();
              }}
              className="text-[10px] px-1.5 py-1 rounded border border-card hover:bg-card"
              title={`Rename ${branch.shortName}`}
            >
              Rename
            </button>
          </Explain>
        )}
        <Explain
          command={`git cherry-pick <commit>`}
          plain={`Pick individual commits from ${branch.shortName} to copy onto your current branch.`}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCherryPickFrom();
            }}
            className="text-[10px] px-1.5 py-1 rounded border border-card hover:bg-card"
            title={`Cherry-pick commits from ${branch.shortName}`}
          >
            ⋯
          </button>
        </Explain>
      </div>
    </div>
  );
}

function CreateMode({
  inputRef,
  busy,
  defaultBranch,
  onCancel,
  onSubmit,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  busy: boolean;
  defaultBranch: string | null;
  onCancel: () => void;
  onSubmit: (name: string, opts: { syncDefault: boolean; pull: boolean }) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  // Default-on when a default branch exists. If the repo has no
  // configured default, syncing is meaningless so we lock both off and
  // tell the user where to set one.
  const [syncDefault, setSyncDefault] = useState(!!defaultBranch);
  const [pull, setPull] = useState(!!defaultBranch);

  const sanitized = useMemo(() => sanitizeBranchName(name), [name]);

  const submit = () => {
    if (!sanitized.value || sanitized.error) return;
    onSubmit(sanitized.value, { syncDefault, pull });
  };

  return (
    <div className="p-3 flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-faint">
        New branch
      </div>
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          else if (e.key === 'Escape') onCancel();
        }}
        placeholder="feature/your-branch"
        className="field px-2 py-1.5 text-xs"
      />
      {/* Live sanitization preview / error. Non-blocking when we just
          rewrote the input (spaces → hyphens etc.), blocking when the
          name has nothing salvageable. Avoids a round-trip through git
          to learn `feature/foo bar` is invalid. */}
      {name.trim() && sanitized.error ? (
        <div className="text-[11px] text-red-400">{sanitized.error}</div>
      ) : (
        sanitized.changed && (
          <div className="text-[11px] text-amber-300">
            Will create as <span className="font-mono">{sanitized.value}</span>
          </div>
        )
      )}
      {defaultBranch ? (
        <div className="flex flex-col gap-1 text-[11px] text-ink-muted">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={syncDefault}
              disabled={busy}
              onChange={(e) => setSyncDefault(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Switch to{' '}
              <span className="font-mono text-ink">{defaultBranch}</span> first
            </span>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={pull}
              disabled={busy}
              onChange={(e) => setPull(e.target.checked)}
              className="mt-0.5"
            />
            <span>Pull latest before branching</span>
          </label>
        </div>
      ) : (
        <div className="text-[10px] text-ink-faint">
          No default branch configured — branch will be created from current HEAD.
          Set one in Settings → Default branches.
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button
          onClick={onCancel}
          disabled={busy}
          className="text-xs px-2.5 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
        >
          Back
        </button>
        <button
          disabled={busy || !sanitized.value || !!sanitized.error}
          onClick={submit}
          className="text-xs px-2.5 py-1 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Create & switch'}
        </button>
      </div>
    </div>
  );
}

function RenameMode({
  inputRef,
  busy,
  branch,
  onCancel,
  onSubmit,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  busy: boolean;
  branch: BranchSummary;
  onCancel: () => void;
  onSubmit: (next: string) => void;
}): JSX.Element {
  const [name, setName] = useState(branch.shortName);
  const sanitized = useMemo(() => sanitizeBranchName(name), [name]);
  const unchanged = sanitized.value === branch.shortName;
  const submit = () => {
    if (!sanitized.value || sanitized.error || unchanged) return;
    onSubmit(sanitized.value);
  };
  return (
    <div className="p-3 flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-faint">
        Rename branch
      </div>
      <div className="text-[11px] text-ink-muted">
        From <span className="font-mono text-ink">{branch.shortName}</span>
      </div>
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          else if (e.key === 'Escape') onCancel();
        }}
        placeholder="new-branch-name"
        className="field px-2 py-1.5 text-xs"
      />
      {name.trim() && sanitized.error ? (
        <div className="text-[11px] text-red-400">{sanitized.error}</div>
      ) : (
        sanitized.changed && !unchanged && (
          <div className="text-[11px] text-amber-300">
            Will rename to <span className="font-mono">{sanitized.value}</span>
          </div>
        )
      )}
      <div className="text-[10px] text-ink-faint">
        Local rename only — if this branch tracks a remote, the upstream
        ref keeps its old name until you push and reset the upstream.
      </div>
      <div className="flex gap-2 justify-end">
        <button
          onClick={onCancel}
          disabled={busy}
          className="text-xs px-2.5 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
        >
          Back
        </button>
        <button
          disabled={busy || !sanitized.value || !!sanitized.error || unchanged}
          onClick={submit}
          className="text-xs px-2.5 py-1 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
        >
          {busy ? 'Renaming…' : 'Rename'}
        </button>
      </div>
    </div>
  );
}

function CherryPickMode({
  repoId,
  branch,
  onCancel,
  onClose,
}: {
  repoId: UUID;
  branch: BranchSummary;
  onCancel: () => void;
  onClose: () => void;
}): JSX.Element {
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ref = branch.kind === 'remote' ? branch.name : branch.shortName;
    window.overgit
      .invoke('repo:branchCommits', { repoId, ref, limit: 100 })
      .then((c) => {
        if (!cancelled) setCommits(c);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, branch]);

  const toggle = (sha: string) => {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  };

  const onApply = async () => {
    if (picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Apply in oldest-to-newest order so the resulting history reads
      // chronologically and conflicts arise in the same order they would
      // if you'd written the commits in sequence.
      const all = commits ?? [];
      const ordered = [...all]
        .reverse()
        .filter((c) => picked.has(c.sha))
        .map((c) => c.sha);
      const res = await window.overgit.invoke('repo:cherryPick', {
        repoId,
        shas: ordered,
      });
      if (!res.ok) {
        setError(
          (res.error ?? 'cherry-pick failed') +
            '\n\nGit left the repo paused — open a terminal to resolve conflicts and run `git cherry-pick --continue`.',
        );
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="px-3 py-2 border-b border-card flex items-center gap-2 text-xs">
        <button
          onClick={onCancel}
          className="text-ink-muted hover:text-ink rounded p-1 hover:bg-card"
          title="Back to branch list"
          aria-label="Back"
        >
          ←
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-ink-faint">
            Cherry-pick from
          </div>
          <div className="font-mono truncate">{branch.shortName}</div>
        </div>
        <span className="text-[10px] text-ink-faint">{picked.size} picked</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {commits == null ? (
          <div className="px-3 py-3 text-xs text-ink-faint">Loading commits…</div>
        ) : commits.length === 0 ? (
          <div className="px-3 py-3 text-xs text-ink-faint">No commits.</div>
        ) : (
          commits.map((c) => (
            <label
              key={c.sha}
              className="flex items-start gap-2 px-3 py-1.5 text-[11px] hover:bg-card cursor-pointer"
            >
              <input
                type="checkbox"
                checked={picked.has(c.sha)}
                onChange={() => toggle(c.sha)}
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate">{c.subject || '(no subject)'}</div>
                <div className="flex gap-2 text-ink-faint">
                  <span className="font-mono">{c.shortSha}</span>
                  <span className="truncate">{c.author}</span>
                  <span className="ml-auto">{relativeTime(c.date)}</span>
                </div>
              </div>
            </label>
          ))
        )}
      </div>
      {error && (
        <pre className="text-[11px] text-red-300 bg-red-500/10 px-3 py-2 whitespace-pre-wrap border-t border-red-500/20">
          {error}
        </pre>
      )}
      <div className="border-t border-card p-2 flex justify-end gap-2 text-[11px]">
        <button
          onClick={onCancel}
          className="px-2.5 py-1 rounded border border-card hover:bg-card"
        >
          Cancel
        </button>
        <button
          disabled={busy || picked.size === 0}
          onClick={onApply}
          className="px-2.5 py-1 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
        >
          {busy
            ? 'Applying…'
            : `Cherry-pick ${picked.size || ''}`.trim()}
        </button>
      </div>
    </>
  );
}

interface BranchGroup {
  label: string;
  items: BranchSummary[];
}

/// Group branches the way GitHub Desktop does: current first, then a
/// "Default" entry pinned to the trunk for fast access, then everything
/// else local, then remotes. The search filter is applied per-row before
/// grouping so an empty group is just dropped.
function groupBranches(
  branches: BranchSummary[],
  currentName: string | null,
  search: string,
): BranchGroup[] {
  const q = search.trim().toLowerCase();
  const matches = (b: BranchSummary) =>
    !q ||
    b.name.toLowerCase().includes(q) ||
    b.shortName.toLowerCase().includes(q) ||
    b.subject.toLowerCase().includes(q);

  // Sort newest-first by tip commit date so the rows the user is most
  // likely to want are at the top. `for-each-ref` already returns them
  // in committerdate-desc order, but we re-sort here to guarantee the
  // contract regardless of where `branches` came from.
  const byDateDesc = (a: BranchSummary, b: BranchSummary) => {
    const ad = a.date ?? '';
    const bd = b.date ?? '';
    if (ad === bd) return 0;
    return bd.localeCompare(ad);
  };
  const filtered = branches.filter(matches);
  const current = filtered.filter((b) => b.isCurrent);
  const locals = filtered
    .filter((b) => b.kind === 'local' && !b.isCurrent)
    .sort(byDateDesc);
  const remotes = filtered.filter((b) => b.kind === 'remote').sort(byDateDesc);

  const groups: BranchGroup[] = [];
  if (current.length) groups.push({ label: 'Current', items: current });
  if (locals.length) groups.push({ label: 'Local', items: locals });
  if (remotes.length) groups.push({ label: 'Remote', items: remotes });
  return groups;
}

function useAnchorRect(ref: React.RefObject<HTMLElement>) {
  // Re-measure on every paint while the picker is mounted — cheap and
  // handles the trigger moving (sidebar toggle, window resize) without
  // wiring up a ResizeObserver.
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const next = ref.current?.getBoundingClientRect() ?? null;
      setRect((prev) => {
        if (!next) return null;
        if (
          prev &&
          prev.top === next.top &&
          prev.left === next.left &&
          prev.width === next.width &&
          prev.height === next.height
        ) {
          return prev;
        }
        return next;
      });
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [ref]);
  return rect;
}

function relativeTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const diff = Date.now() - d.getTime();
    const minutes = Math.round(diff / 60000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months}mo`;
    const years = Math.round(months / 12);
    return `${years}y`;
  } catch {
    return iso;
  }
}
