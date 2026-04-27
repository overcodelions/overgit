import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import type {
  LlmTool,
  Repo,
  ReviewResult,
  SyncAndBranchOutcome,
  UUID,
} from '@shared/types';

/// Top-level sheet host. Picks which sheet (modal) to render based on
/// `store.sheet` and provides the common backdrop + escape-to-close.
export function SheetHost(): JSX.Element | null {
  const sheet = useStore((s) => s.sheet);
  const setSheet = useStore((s) => s.setSheet);

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheet(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet, setSheet]);

  if (!sheet) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setSheet(null);
      }}
    >
      <div
        className={`bg-surface-elevated border border-card rounded-lg shadow-2xl overflow-hidden flex flex-col ${
          sheet.kind === 'reviewChanges'
            ? 'w-[760px] max-w-[92vw] max-h-[85vh]'
            : 'w-[640px] max-w-[90vw] max-h-[80vh]'
        }`}
      >
        {sheet.kind === 'settings' && <SettingsSheet />}
        {sheet.kind === 'about' && <AboutSheet />}
        {sheet.kind === 'newWorkspace' && <WorkspaceSheet />}
        {sheet.kind === 'editWorkspace' && (
          <WorkspaceSheet workspaceId={sheet.workspaceId} />
        )}
        {sheet.kind === 'reviewChanges' && (
          <ReviewSheet repoId={sheet.repoId} initialScope={sheet.scope} />
        )}
        {sheet.kind === 'newBranchInWorkspace' && (
          <WorkspaceBranchSheet workspaceId={sheet.workspaceId} />
        )}
      </div>
    </div>
  );
}

function SheetHeader({ title, onClose }: { title: string; onClose: () => void }): JSX.Element {
  return (
    <div className="flex items-center justify-between px-5 py-3 border-b border-card">
      <h2 className="text-sm font-semibold">{title}</h2>
      <button
        onClick={onClose}
        className="text-ink-faint hover:text-ink rounded p-1 hover:bg-card"
        aria-label="Close"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

function SettingsSheet(): JSX.Element {
  const settings = useStore((s) => s.settings);
  const cli = useStore((s) => s.cliPresence);
  const repos = useStore((s) => s.repos);
  const workspaces = useStore((s) => s.workspaces);
  const setSheet = useStore((s) => s.setSheet);

  const updateTheme = async (theme: 'light' | 'dark' | 'system') => {
    const next = { ...settings, theme };
    useStore.setState({ settings: next });
    await window.overgit.invoke('store:saveSettings', next);
    applyTheme(theme);
  };

  return (
    <>
      <SheetHeader title="Settings" onClose={() => setSheet(null)} />
      <div className="overflow-y-auto p-5 flex flex-col gap-6 text-sm">
        <ProcessExplainer />

        <Section
          title="LLM CLIs (Review with AI)"
          subtitle="Overgit pipes a diff into one of these CLIs in non-interactive mode and shows the response. Nothing leaves your machine via overgit — the CLI handles all auth and transport."
        >
          <ul className="text-xs flex flex-col gap-1.5">
            <CliRow
              name="claude"
              present={cli?.claude}
              purpose="Claude Code CLI · `claude -p -` reads prompt from stdin"
            />
            <CliRow
              name="codex"
              present={cli?.codex}
              purpose="OpenAI Codex CLI · `codex exec --skip-git-repo-check -`"
            />
            <CliRow
              name="gemini"
              present={cli?.gemini}
              purpose="Google Gemini CLI · `gemini -p -`"
            />
          </ul>
        </Section>

        <Section
          title="Forge CLIs"
          subtitle="Used for PR / MR data and comments. Missing CLIs just hide their UI — they don't block anything else."
        >
          <ul className="text-xs flex flex-col gap-1.5">
            <CliRow name="gh" present={cli?.gh} purpose="GitHub · PR list, comments, reviews" />
            <CliRow name="glab" present={cli?.glab} purpose="GitLab MR list (planned)" />
            <CliRow name="jj" present={cli?.jj} purpose="Jujutsu integration (planned)" />
          </ul>
        </Section>

        {repos.length > 0 && (
          <Section
            title="Default branches"
            subtitle="Each repo's trunk — the branch overgit treats as the base for compare/PR-base flows. Auto-detected from origin/HEAD when you add a repo; override here if your trunk differs."
          >
            <ul className="text-xs flex flex-col gap-1">
              {repos.map((r) => (
                <DefaultBranchRow key={r.id} repoId={r.id} />
              ))}
            </ul>
          </Section>
        )}

        <Section title="Keyboard shortcuts">
          <ul className="text-xs flex flex-col gap-1 font-mono">
            <ShortcutRow keys="⌘ ," what="Open settings" />
            <ShortcutRow keys="⌘ \\" what="Toggle sidebar" />
            <ShortcutRow keys="⌘ R" what="Refresh current pane" />
            <ShortcutRow keys="⌘ B" what="Open branch picker (in a repo)" />
            <ShortcutRow keys="⌘ N" what="New branch (in a workspace)" />
            <ShortcutRow keys="⌘ 1 / 2 / 3 / 4" what="Repo tabs: Changes / History / Files / Graph" />
            <ShortcutRow keys="↑ ↓ Enter" what="Navigate the branch picker" />
            <ShortcutRow keys="⌘ S" what="Save the open file (in Files tab)" />
          </ul>
        </Section>

        <Section title="Theme" subtitle="System follows your OS dark/light setting.">
          <div className="flex gap-2">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button
                key={t}
                onClick={() => updateTheme(t)}
                className={`px-3 py-1.5 rounded border text-xs ${
                  settings.theme === t
                    ? 'bg-accent text-white border-accent'
                    : 'border-card hover:bg-card'
                }`}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Library" subtitle="Where overgit's overlay state lives.">
          <ul className="text-xs flex flex-col gap-1">
            <li>
              <span className="text-ink-faint">Repos: </span>
              <span className="font-mono">{repos.length}</span>
            </li>
            <li>
              <span className="text-ink-faint">Workspaces: </span>
              <span className="font-mono">{workspaces.length}</span>
            </li>
          </ul>
        </Section>
      </div>
    </>
  );
}

function ShortcutRow({ keys, what }: { keys: string; what: string }): JSX.Element {
  return (
    <li className="flex justify-between items-baseline gap-3">
      <span className="text-ink-muted">{keys}</span>
      <span className="text-ink-faint flex-1 text-right font-sans">{what}</span>
    </li>
  );
}

function DefaultBranchRow({ repoId }: { repoId: UUID }): JSX.Element {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId))!;
  const summaries = useStore((s) => s.repoBranchSummaries[repoId]);
  const refresh = useStore((s) => s.refreshRepoBranchSummaries);
  const setDefault = useStore((s) => s.setRepoDefaultBranch);

  useEffect(() => {
    if (summaries == null) refresh(repoId);
  }, [summaries, refresh, repoId]);

  const localOptions = useMemo(
    () => (summaries ?? []).filter((b) => b.kind === 'local').map((b) => b.name),
    [summaries],
  );

  const onAutoDetect = async () => {
    const detected = await window.overgit.invoke('repo:detectDefaultBranch', repoId);
    if (detected) {
      await setDefault(repoId, detected);
    } else {
      alert("Couldn't detect a default branch (no origin/HEAD set). Pick one manually.");
    }
  };

  return (
    <li className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{repo.name}</div>
        <div className="text-[10px] text-ink-faint truncate font-mono">{repo.path}</div>
      </div>
      <select
        value={repo.defaultBranch ?? ''}
        onChange={(e) => setDefault(repoId, e.target.value || null)}
        className="field text-xs px-2 py-1"
      >
        <option value="">(none)</option>
        {/* Show the saved value even if not in the freshly-loaded list,
            so a default that points at a branch we haven't fetched yet
            still appears selected. */}
        {repo.defaultBranch && !localOptions.includes(repo.defaultBranch) && (
          <option value={repo.defaultBranch}>{repo.defaultBranch} (saved)</option>
        )}
        {localOptions.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
      <button
        onClick={onAutoDetect}
        className="text-[11px] px-2 py-1 rounded border border-card hover:bg-card"
        title="Detect from origin/HEAD"
      >
        Auto
      </button>
    </li>
  );
}

function ProcessExplainer(): JSX.Element {
  return (
    <section className="p-4 rounded-lg border border-accent/40 bg-accent/5">
      <h3 className="text-xs uppercase tracking-wide text-accent mb-2">How overgit works</h3>
      <ol className="text-xs text-ink-muted flex flex-col gap-2 list-decimal pl-4">
        <li>
          <strong className="text-ink">Add a repo.</strong> Overgit records the path in
          its own store. Your repo on disk is untouched — overgit never writes to
          <span className="font-mono"> .git</span> metadata.
        </li>
        <li>
          <strong className="text-ink">Group repos into a workspace.</strong> A workspace
          is just a named list of repo IDs. No symlinks, no synthetic root, no
          junctions — just a coordinator that fans operations out.
        </li>
        <li>
          <strong className="text-ink">Run actions.</strong> Every git operation
          (status, fetch, checkout, push) is the equivalent shell command run in
          the repo's existing directory. Anything you'd see in a terminal, you
          see here.
        </li>
        <li>
          <strong className="text-ink">CLIs handle reviews.</strong> Where it makes
          sense, overgit shells out to <span className="font-mono">gh</span>,
          <span className="font-mono"> glab</span>, or
          <span className="font-mono"> jj</span> instead of rebuilding API clients.
          The features show up only when the CLI is installed.
        </li>
      </ol>
      <p className="text-[11px] text-ink-faint mt-3">
        This means you can stop using overgit at any time and your repos behave
        exactly the same in any other tool.
      </p>
    </section>
  );
}

function CliRow({
  name,
  present,
  purpose,
}: {
  name: string;
  present: boolean | undefined;
  purpose: string;
}): JSX.Element {
  return (
    <li className="flex items-center gap-3">
      <span className="font-mono w-12">{name}</span>
      {present === undefined ? (
        <span className="text-ink-faint text-[10px] uppercase">probing…</span>
      ) : present ? (
        <span className="text-emerald-400 text-[10px] uppercase">installed</span>
      ) : (
        <span className="text-ink-faint text-[10px] uppercase">missing</span>
      )}
      <span className="text-ink-faint">{purpose}</span>
    </li>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-ink-faint mb-1">{title}</h3>
      {subtitle && <p className="text-xs text-ink-faint mb-2">{subtitle}</p>}
      {children}
    </section>
  );
}

function applyTheme(theme: 'light' | 'dark' | 'system'): void {
  // Single point of theme application: toggle the `dark` class on <body>.
  // CSS variables in styles.css read off that class. `system` follows the
  // OS via prefers-color-scheme.
  const body = document.body;
  if (theme === 'dark') {
    body.classList.add('dark');
  } else if (theme === 'light') {
    body.classList.remove('dark');
  } else {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    body.classList.toggle('dark', dark);
  }
}

function AboutSheet(): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  return (
    <>
      <SheetHeader title="About overgit" onClose={() => setSheet(null)} />
      <div className="p-6 text-sm flex flex-col gap-3">
        <div>
          <div className="text-base font-semibold">overgit</div>
          <div className="text-xs text-ink-faint">v0.1.0 · workspace-overlay git client</div>
        </div>
        <p className="text-ink-muted">
          A desktop git client that coordinates many repos at once without owning
          their state. Workspaces fan operations out to standalone repositories;
          everything you do in overgit lands as plain git commands.
        </p>
        <p className="text-xs text-ink-faint">
          Built with Electron, React, and Tailwind. Sibling project of overcli.
        </p>
      </div>
    </>
  );
}

function WorkspaceSheet({ workspaceId }: { workspaceId?: UUID } = {}): JSX.Element {
  const repos = useStore((s) => s.repos);
  const workspaces = useStore((s) => s.workspaces);
  const setSheet = useStore((s) => s.setSheet);
  const createWorkspace = useStore((s) => s.createWorkspace);
  const updateWorkspace = useStore((s) => s.updateWorkspace);

  const editing = workspaceId
    ? workspaces.find((w) => w.id === workspaceId) ?? null
    : null;

  const [name, setName] = useState(editing?.name ?? '');
  const [picked, setPicked] = useState<Set<UUID>>(
    new Set(editing?.repoIds ?? []),
  );
  const [busy, setBusy] = useState(false);

  const toggle = (id: UUID) => {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onSave = async () => {
    if (!name.trim() || picked.size === 0) return;
    setBusy(true);
    try {
      if (editing) {
        await updateWorkspace(editing.id, { name: name.trim(), repoIds: [...picked] });
      } else {
        await createWorkspace(name.trim(), [...picked]);
      }
      setSheet(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SheetHeader
        title={editing ? `Edit workspace · ${editing.name}` : 'New workspace'}
        onClose={() => setSheet(null)}
      />
      <div className="p-5 flex flex-col gap-4 text-sm overflow-y-auto">
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-ink-faint">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. service-platform, marketing-site, polyrepo-stack"
            className="field px-2 py-1.5 text-sm"
          />
        </label>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-wide text-ink-faint">Repos</span>
            <span className="text-[11px] text-ink-faint">
              {picked.size} of {repos.length} selected
            </span>
          </div>
          {repos.length === 0 ? (
            <div className="text-xs text-ink-faint p-3 rounded border border-card bg-card">
              Add a repo first — workspaces are built from repos already in
              overgit.
            </div>
          ) : (
            <ul className="border border-card rounded overflow-hidden max-h-[40vh] overflow-y-auto">
              {repos.map((r) => {
                const isPicked = picked.has(r.id);
                return (
                  <li key={r.id} className="border-b border-card last:border-0">
                    <RepoPickRow repo={r} picked={isPicked} onToggle={() => toggle(r.id)} />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <div className="px-5 py-3 border-t border-card flex justify-end gap-2">
        <button
          onClick={() => setSheet(null)}
          className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
        >
          Cancel
        </button>
        <button
          disabled={busy || !name.trim() || picked.size === 0}
          onClick={onSave}
          className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
        >
          {editing ? 'Save changes' : `Create workspace`}
        </button>
      </div>
    </>
  );
}

/// "Review with AI" sheet. Lets the user pick an installed LLM CLI and
/// a scope (working tree vs staged), then runs `cli:reviewChanges` and
/// shows the response. Also provides a one-click "use as commit message"
/// button when the user wants to apply the LLM's suggestion.
function ReviewSheet({
  repoId,
  initialScope,
}: {
  repoId: UUID;
  initialScope: 'staged' | 'working';
}): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const cli = useStore((s) => s.cliPresence);
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId));
  const changes = useStore((s) => s.repoChanges[repoId]);

  const available: LlmTool[] = useMemo(() => {
    const out: LlmTool[] = [];
    if (cli?.claude) out.push('claude');
    if (cli?.codex) out.push('codex');
    if (cli?.gemini) out.push('gemini');
    return out;
  }, [cli]);

  // "Staged only" diffs only the index; "Working tree" diffs index +
  // worktree (everything overgit shows as dirty). When one of these is
  // empty the LLM has nothing to chew on, so we expose the counts and
  // prefer the populated one as the default.
  const stagedCount = changes?.staged.length ?? 0;
  const workingCount = (changes?.staged.length ?? 0) + (changes?.unstaged.length ?? 0);
  const initialScopeAdjusted: 'staged' | 'working' =
    initialScope === 'staged' && stagedCount === 0 ? 'working' : initialScope;

  const [tool, setTool] = useState<LlmTool | null>(available[0] ?? null);
  const [scope, setScope] = useState<'staged' | 'working'>(initialScopeAdjusted);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReviewResult | null>(null);

  // If detection finishes after the sheet mounted, sync the default tool.
  useEffect(() => {
    if (!tool && available.length > 0) setTool(available[0]);
  }, [tool, available]);

  // If the user manually switches scope to one that's empty, leave it —
  // they may be about to stage something. Don't auto-flip on every change
  // tick; that would yank the toggle out from under them.

  const onRun = async () => {
    if (!tool) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await window.overgit.invoke('cli:reviewChanges', {
        repoId,
        scope,
        tool,
      });
      setResult(res);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SheetHeader
        title={`Review with AI · ${repo?.name ?? ''}`}
        onClose={() => setSheet(null)}
      />

      <div className="px-5 py-4 border-b border-card flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-ink-faint">Tool</span>
          {available.length === 0 ? (
            <span className="text-xs text-ink-faint">
              No LLM CLI installed. Install <span className="font-mono">claude</span>,{' '}
              <span className="font-mono">codex</span>, or{' '}
              <span className="font-mono">gemini</span> to enable this.
            </span>
          ) : (
            <div className="flex gap-1">
              {available.map((t) => (
                <button
                  key={t}
                  onClick={() => setTool(t)}
                  className={`text-xs font-mono px-2.5 py-1 rounded border ${
                    tool === t
                      ? 'bg-accent text-white border-accent'
                      : 'border-card hover:bg-card'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-ink-faint">Scope</span>
          <div className="flex gap-1">
            <ScopeButton
              label="Staged"
              count={stagedCount}
              active={scope === 'staged'}
              onClick={() => setScope('staged')}
            />
            <ScopeButton
              label="Working tree"
              count={workingCount}
              active={scope === 'working'}
              onClick={() => setScope('working')}
            />
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setSheet(null)}
            className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
          >
            Close
          </button>
          <button
            onClick={onRun}
            disabled={
              busy ||
              !tool ||
              (scope === 'staged' ? stagedCount === 0 : workingCount === 0)
            }
            className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
          >
            {busy ? 'Reviewing…' : result ? 'Run again' : 'Run review'}
          </button>
        </div>
      </div>

      <div className="overflow-y-auto p-5 flex-1 min-h-0">
        {busy && !result && (
          <div className="text-xs text-ink-faint">
            Sending the {scope === 'staged' ? 'staged' : 'working-tree'} diff to{' '}
            <span className="font-mono">{tool}</span>… (up to 90s)
          </div>
        )}
        {!busy && !result && (
          <div className="text-xs text-ink-faint">
            Pick a tool and scope, then click Run review. The diff is piped to the
            CLI's stdin in non-interactive mode; nothing is uploaded by overgit
            itself — the CLI handles everything.
          </div>
        )}
        {result && <ReviewBody result={result} />}
      </div>
    </>
  );
}

function ScopeButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  const empty = count === 0;
  return (
    <button
      onClick={onClick}
      title={empty ? `${label} has no changes` : undefined}
      className={`text-xs px-2.5 py-1 rounded border flex items-center gap-1 ${
        active ? 'bg-accent text-white border-accent' : 'border-card hover:bg-card'
      } ${empty ? 'opacity-60' : ''}`}
    >
      <span>{label}</span>
      <span className={`font-mono text-[10px] ${active ? 'text-white/80' : 'text-ink-faint'}`}>
        {count}
      </span>
    </button>
  );
}

function ReviewBody({ result }: { result: ReviewResult }): JSX.Element {
  if (!result.ok) {
    return (
      <div className="flex flex-col gap-3 text-xs">
        <div className="text-red-400 font-medium">
          {result.tool} returned an error
        </div>
        <pre className="font-mono text-xs whitespace-pre-wrap p-3 rounded bg-card border border-card">
          {result.error || '(no stderr captured)'}
        </pre>
        {result.output && (
          <details>
            <summary className="text-ink-faint cursor-pointer">Partial output</summary>
            <pre className="font-mono text-xs whitespace-pre-wrap p-3 rounded bg-card border border-card mt-2">
              {result.output}
            </pre>
          </details>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-faint">
        {result.tool} response
      </div>
      <pre className="font-mono text-xs whitespace-pre-wrap p-4 rounded bg-card border border-card leading-relaxed">
        {result.output || '(empty response)'}
      </pre>
      {result.output && (
        <button
          onClick={() => navigator.clipboard.writeText(result.output)}
          className="self-start text-[11px] px-2 py-0.5 rounded border border-card hover:bg-card"
        >
          Copy to clipboard
        </button>
      )}
    </div>
  );
}

/// Workspace-wide "create branch" workflow. The user names a branch and
/// picks two switches (defaults match the GitHub-Desktop "back to
/// mainline → pull → branch" pattern). On submit we run
/// `workspace:syncAndBranch`, then render per-repo outcomes inline so a
/// partial failure (one repo dirty, one repo's pull conflicted) is
/// readable and recoverable.
function WorkspaceBranchSheet({ workspaceId }: { workspaceId: UUID }): JSX.Element {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const repos = useStore((s) => s.repos);
  const refreshStatus = useStore((s) => s.refreshWorkspaceStatus);
  const setSheet = useStore((s) => s.setSheet);

  const [branch, setBranch] = useState('');
  const [syncDefault, setSyncDefault] = useState(true);
  const [pullBefore, setPullBefore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<SyncAndBranchOutcome[] | null>(null);

  const reposById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);
  const memberRepos = useMemo(
    () => (ws?.repoIds ?? []).map((id) => reposById.get(id)).filter((r): r is Repo => !!r),
    [ws?.repoIds, reposById],
  );

  const onRun = async () => {
    if (!branch.trim()) return;
    setBusy(true);
    setOutcomes(null);
    try {
      const res = await window.overgit.invoke('workspace:syncAndBranch', {
        workspaceId,
        branch: branch.trim(),
        syncDefault,
        pullBeforeBranch: pullBefore,
      });
      setOutcomes(res);
      await refreshStatus(workspaceId);
    } finally {
      setBusy(false);
    }
  };

  const allCreated =
    outcomes !== null && outcomes.every((o) => o.result === 'created');

  return (
    <>
      <SheetHeader
        title={`New branch · ${ws?.name ?? ''}`}
        onClose={() => setSheet(null)}
      />
      <div className="p-5 flex flex-col gap-4 text-sm overflow-y-auto">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-faint">
            Branch name
          </span>
          <input
            autoFocus
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            disabled={busy}
            placeholder="feature/my-thing"
            className="field px-2 py-1.5 text-sm font-mono"
          />
        </label>

        <fieldset className="flex flex-col gap-2 p-3 rounded border border-card bg-card">
          <legend className="text-[10px] uppercase tracking-wide text-ink-faint px-1">
            Workflow
          </legend>
          <Switch
            label="Sync to default branch first"
            sublabel="Switch each repo to its trunk before branching. Skipped per-repo if no default is configured."
            checked={syncDefault}
            disabled={busy}
            onChange={setSyncDefault}
          />
          <Switch
            label="Pull latest before branching"
            sublabel="Run `git pull` so the new branch starts from origin's latest. Disable if you're offline."
            checked={pullBefore}
            disabled={busy}
            onChange={setPullBefore}
          />
        </fieldset>

        <div>
          <div className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">
            Will run on {memberRepos.length}{' '}
            {memberRepos.length === 1 ? 'repo' : 'repos'}
          </div>
          <ul className="text-[11px] text-ink-faint flex flex-col gap-0.5">
            {memberRepos.map((r) => (
              <li key={r.id} className="flex justify-between gap-2">
                <span className="truncate">{r.name}</span>
                <span className="font-mono">
                  {r.defaultBranch ?? <span className="text-amber-400">no default</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {outcomes && (
          <ul className="flex flex-col gap-1 text-[11px]">
            {outcomes.map((o) => (
              <li
                key={o.repoId}
                className="flex items-center gap-2 px-2 py-1 rounded border border-card bg-card"
              >
                <span className="w-32 truncate">
                  {reposById.get(o.repoId)?.name ?? o.repoId}
                </span>
                <BranchOutcomeBadge result={o.result} />
                {o.message && (
                  <span className="text-ink-faint truncate flex-1" title={o.message}>
                    — {o.message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="px-5 py-3 border-t border-card flex justify-end gap-2">
        <button
          onClick={() => setSheet(null)}
          className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
        >
          {allCreated ? 'Done' : 'Cancel'}
        </button>
        <button
          disabled={busy || !branch.trim()}
          onClick={onRun}
          className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
        >
          {busy
            ? 'Running…'
            : outcomes
              ? `Run again`
              : `Create on ${memberRepos.length} ${
                  memberRepos.length === 1 ? 'repo' : 'repos'
                }`}
        </button>
      </div>
    </>
  );
}

function Switch({
  label,
  sublabel,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  sublabel?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div className="flex-1 min-w-0">
        <div className="text-xs">{label}</div>
        {sublabel && <div className="text-[10px] text-ink-faint">{sublabel}</div>}
      </div>
    </label>
  );
}

function BranchOutcomeBadge({
  result,
}: {
  result: SyncAndBranchOutcome['result'];
}): JSX.Element {
  const map: Record<SyncAndBranchOutcome['result'], { label: string; cls: string }> = {
    created: { label: 'created', cls: 'text-emerald-400' },
    'no-default-branch': { label: 'no default', cls: 'text-amber-400' },
    dirty: { label: 'dirty', cls: 'text-amber-400' },
    'pull-failed': { label: 'pull failed', cls: 'text-red-400' },
    'create-failed': { label: 'create failed', cls: 'text-red-400' },
    'switch-failed': { label: 'switch failed', cls: 'text-red-400' },
  };
  const { label, cls } = map[result];
  return <span className={`font-mono ${cls}`}>{label}</span>;
}

function RepoPickRow({
  repo,
  picked,
  onToggle,
}: {
  repo: Repo;
  picked: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <label
      className={`flex items-center gap-3 px-3 py-2 cursor-pointer text-sm ${
        picked ? 'bg-accent/10' : 'hover:bg-card'
      }`}
    >
      <input
        type="checkbox"
        checked={picked}
        onChange={onToggle}
        className="cursor-pointer"
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{repo.name}</div>
        <div className="text-[11px] text-ink-faint truncate font-mono">{repo.path}</div>
      </div>
    </label>
  );
}
