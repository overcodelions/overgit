import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { RepoDetail } from './RepoDetail';
import type {
  CheckoutOutcome,
  CliPresence,
  PullRequest,
  RepoPRs,
  RepoStatus,
  UUID,
} from '@shared/types';

export function App(): JSX.Element {
  const { loaded, hydrate } = useStore();
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  if (!loaded) {
    return <div className="p-6 text-ink-muted">Loading…</div>;
  }

  return (
    <div className="flex h-full">
      <Sidebar />
      <Main />
    </div>
  );
}

function Sidebar(): JSX.Element {
  const repos = useStore((s) => s.repos);
  const workspaces = useStore((s) => s.workspaces);
  const selectedWs = useStore((s) => s.selectedWorkspaceId);
  const selectedRepo = useStore((s) => s.selectedRepoId);
  const selectWs = useStore((s) => s.selectWorkspace);
  const selectRepo = useStore((s) => s.selectRepo);
  const pickAndAddRepo = useStore((s) => s.pickAndAddRepo);
  const createWorkspace = useStore((s) => s.createWorkspace);

  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<UUID>>(new Set());

  return (
    <aside className="w-72 shrink-0 border-r border-card bg-surface-muted p-4 flex flex-col gap-6 overflow-y-auto">
      <header>
        <div className="text-xs uppercase tracking-wide text-ink-faint">Overgit</div>
        <div className="text-base font-semibold">Workspaces over your repos</div>
      </header>

      <section>
        <h2 className="text-xs uppercase tracking-wide text-ink-faint mb-2">Workspaces</h2>
        {workspaces.length === 0 ? (
          <div className="text-sm text-ink-faint">No workspaces yet.</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {workspaces.map((w) => (
              <li key={w.id}>
                <button
                  onClick={() => selectWs(w.id)}
                  className={`w-full text-left px-2 py-1.5 rounded-md text-sm ${
                    selectedWs === w.id && !selectedRepo
                      ? 'bg-accent text-white'
                      : 'hover:bg-card'
                  }`}
                >
                  <div className="font-medium">{w.name}</div>
                  <div
                    className={`text-xs ${
                      selectedWs === w.id && !selectedRepo ? 'text-white/70' : 'text-ink-faint'
                    }`}
                  >
                    {w.repoIds.length} {w.repoIds.length === 1 ? 'repo' : 'repos'}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs uppercase tracking-wide text-ink-faint">Repos</h2>
          <button
            onClick={pickAndAddRepo}
            className="text-xs px-2 py-0.5 rounded bg-accent text-white hover:bg-accent-strong"
          >
            Add
          </button>
        </div>
        {repos.length === 0 ? (
          <div className="text-sm text-ink-faint">
            Add a local git repo to get started.
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {repos.map((r) => {
              const isPicked = picked.has(r.id);
              const isOpen = selectedRepo === r.id;
              return (
                <li
                  key={r.id}
                  className={`flex items-center gap-2 px-2 py-1 rounded text-sm ${
                    isOpen ? 'bg-accent text-white' : 'hover:bg-card'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isPicked}
                    onChange={() => {
                      const next = new Set(picked);
                      if (next.has(r.id)) next.delete(r.id);
                      else next.add(r.id);
                      setPicked(next);
                    }}
                  />
                  <button
                    onClick={() => selectRepo(r.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="font-medium truncate">{r.name}</div>
                    <div
                      className={`text-xs truncate ${
                        isOpen ? 'text-white/70' : 'text-ink-faint'
                      }`}
                    >
                      {r.path}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {picked.size > 0 && (
        <section className="border-t border-card pt-4">
          <h2 className="text-xs uppercase tracking-wide text-ink-faint mb-2">
            New workspace
          </h2>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
            className="w-full px-2 py-1 rounded bg-surface-elevated border border-card text-sm mb-2"
          />
          <button
            disabled={!name.trim()}
            onClick={async () => {
              await createWorkspace(name.trim(), [...picked]);
              setName('');
              setPicked(new Set());
            }}
            className="w-full text-sm px-2 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Create from {picked.size} {picked.size === 1 ? 'repo' : 'repos'}
          </button>
        </section>
      )}
    </aside>
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

  // The repo detail pane wins when a repo is open — workspaces remain
  // selected in the sidebar so the user can pop back without re-picking.
  if (selectedRepo) return <RepoDetail repoId={selectedRepo} />;

  if (!ws) {
    return (
      <main className="flex-1 flex items-center justify-center text-ink-muted">
        <div className="text-center max-w-sm">
          <div className="text-lg font-medium mb-1">Pick a workspace or open a repo</div>
          <p className="text-sm text-ink-faint">
            A workspace is just a named group of repos — overgit coordinates
            branches, status, and PRs across them without changing anything
            inside the repos themselves.
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
  const statuses = useStore((s) => s.workspaceStatuses[workspaceId] ?? []);
  const prs = useStore((s) => s.workspacePRs[workspaceId] ?? []);
  const lastCheckout = useStore((s) => s.lastCheckout);
  const cli = useStore((s) => s.cliPresence);
  const refresh = useStore((s) => s.refreshWorkspaceStatus);
  const refreshPRs = useStore((s) => s.refreshWorkspacePRs);
  const fetchWs = useStore((s) => s.fetchWorkspace);
  const checkout = useStore((s) => s.checkoutWorkspaceBranch);
  const selectRepo = useStore((s) => s.selectRepo);

  const [branch, setBranch] = useState('');
  const [createIfMissing, setCreateIfMissing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    refresh(workspaceId);
    refreshPRs(workspaceId);
  }, [refresh, refreshPRs, workspaceId]);

  if (!ws) return <main className="flex-1" />;

  const reposById = new Map(repos.map((r) => [r.id, r]));

  return (
    <main className="flex-1 overflow-y-auto p-6">
      <header className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">{ws.name}</h1>
          <p className="text-xs text-ink-faint">
            {ws.repoIds.length} {ws.repoIds.length === 1 ? 'repo' : 'repos'} ·
            CLIs: {cliSummary(cli)}
          </p>
        </div>
        <div className="flex gap-2">
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
            className="text-sm px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-50"
          >
            Fetch all
          </button>
          <button
            disabled={busy}
            onClick={() => {
              refresh(workspaceId);
              refreshPRs(workspaceId);
            }}
            className="text-sm px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </header>

      <section className="mb-6 p-3 rounded-lg bg-card border border-card">
        <div className="text-xs uppercase tracking-wide text-ink-faint mb-2">
          Bring workspace to a branch
        </div>
        <div className="flex gap-2 items-center">
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="branch name"
            className="flex-1 px-2 py-1.5 rounded bg-surface-elevated border border-card text-sm"
          />
          <label className="flex items-center gap-1 text-xs text-ink-muted">
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
            className="text-sm px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
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

      {prs.length > 0 && (
        <PRSection prs={prs} reposById={reposById} cli={cli} />
      )}

      <section>
        <h2 className="text-xs uppercase tracking-wide text-ink-faint mb-2">Status</h2>
        <ul className="flex flex-col gap-1">
          {ws.repoIds.map((id) => {
            const repo = reposById.get(id);
            const st = statuses.find((s) => s.repoId === id);
            return (
              <li
                key={id}
                className="flex items-center gap-3 px-3 py-2 rounded border border-card bg-card"
              >
                <button
                  onClick={() => selectRepo(id)}
                  className="min-w-0 flex-1 text-left hover:underline"
                  title="Open repo detail"
                >
                  <div className="font-medium truncate">{repo?.name ?? id}</div>
                  <div className="text-xs text-ink-faint truncate">{repo?.path}</div>
                </button>
                <StatusCell status={st} />
              </li>
            );
          })}
        </ul>
      </section>
    </main>
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

  const [showCommit, setShowCommit] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const onStash = async () => {
    setBusy(true);
    try {
      const res = await stash(outcome.repoId);
      if (!res.ok) {
        alert(res.error ?? 'Stash failed');
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
        alert(res.error ?? 'Commit failed');
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
    <li className="text-xs flex flex-col gap-1">
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
            className="flex-1 px-2 py-1 rounded bg-surface-elevated border border-card text-xs"
          />
          <button
            disabled={busy || !message.trim()}
            onClick={onCommit}
            className="px-2 py-1 rounded bg-accent text-white text-xs hover:bg-accent-strong disabled:opacity-50"
          >
            Commit
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setShowCommit(false);
              setMessage('');
            }}
            className="px-2 py-1 rounded border border-card text-xs hover:bg-card disabled:opacity-50"
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
  // Sort across repos by most recently updated; that matches what GitHub
  // itself shows by default and is the most useful first scan order.
  flat.sort((a, b) => (a.pr.updatedAt < b.pr.updatedAt ? 1 : -1));

  // Repos that errored — show a thin note so the user knows gh didn't
  // silently skip them. Suppressed entirely if gh isn't installed at all
  // (then the whole section is just informational).
  const errored = prs.filter((p) => p.error && p.prs === null);

  return (
    <section className="mb-6">
      <h2 className="text-xs uppercase tracking-wide text-ink-faint mb-2">
        Open pull requests
      </h2>
      {!cli?.gh ? (
        <div className="text-xs text-ink-faint p-3 rounded border border-card bg-card">
          Install <span className="font-mono">gh</span> to surface PRs across the workspace.
        </div>
      ) : flat.length === 0 ? (
        <div className="text-xs text-ink-faint p-3 rounded border border-card bg-card">
          No open PRs in this workspace.
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {flat.map(({ repoId, repoName, pr }) => (
            <li
              key={`${repoId}:${pr.number}`}
              className="flex items-center gap-3 px-3 py-2 rounded border border-card bg-card text-sm"
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
              <span className="text-xs text-ink-faint font-mono">
                {pr.headBranch} → {pr.baseBranch}
              </span>
              <span className="text-xs text-ink-faint">{pr.author}</span>
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

function StatusCell({ status }: { status?: RepoStatus }): JSX.Element {
  if (!status) return <span className="text-xs text-ink-faint">…</span>;
  if (status.error) {
    return <span className="text-xs text-red-400">{status.error}</span>;
  }
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="font-mono">{status.branch ?? '(detached)'}</span>
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
