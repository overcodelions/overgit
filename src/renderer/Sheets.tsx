import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import type {
  AbandonLocalPreview,
  AppSettings,
  BlameLine,
  CommitAllOutcome,
  FileLogCommit,
  Identity,
  LfsStatus,
  LlmTool,
  Remote,
  Repo,
  RepoStatus,
  ResolvedIdentity,
  ReviewResult,
  Submodule,
  SyncAndBranchOutcome,
  Tag,
  UUID,
  WorksetDiffTruncation,
  WorksetOpenPROutcome,
  WorksetPushOutcome,
  WorksetResetOutcome,
} from '@shared/types';
import { sanitizeBranchName } from '@shared/branch-name';

/// Stable empty-array reference used as the fallback for selectors that
/// read `s.worksetStatuses[id]`. Returning a fresh `[]` from a zustand
/// selector fails React's `useSyncExternalStore` snapshot equality and
/// loops with "Maximum update depth exceeded".
const EMPTY_STATUSES: RepoStatus[] = [];

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
            ? 'w-[760px] max-w-[92vw] h-[85vh]'
            : sheet.kind === 'about'
              ? 'w-[720px] max-w-[92vw] max-h-[85vh]'
              : sheet.kind === 'settings'
                ? 'w-[1080px] max-w-[95vw] h-[80vh]'
                : sheet.kind === 'pullConflict'
                  ? 'w-[680px] max-w-[92vw] max-h-[80vh]'
                  : sheet.kind === 'resolveConflict'
                    ? 'w-[1100px] max-w-[96vw] h-[85vh]'
                  : sheet.kind === 'abandonLocal'
                    ? 'w-[720px] max-w-[92vw] max-h-[85vh]'
                  : sheet.kind === 'fileHistory'
                    ? 'w-[860px] max-w-[94vw] h-[82vh]'
                    : sheet.kind === 'manageRepo'
                      ? 'w-[720px] max-w-[92vw] h-[78vh]'
                      : 'w-[640px] max-w-[90vw] max-h-[80vh]'
        }`}
      >
        {sheet.kind === 'settings' && <SettingsSheet />}
        {sheet.kind === 'about' && <AboutSheet />}
        {sheet.kind === 'newWorkset' && <WorksetSheet />}
        {sheet.kind === 'editWorkset' && (
          <WorksetSheet worksetId={sheet.worksetId} />
        )}
        {sheet.kind === 'newWorkspace' && <WorkspaceSheet />}
        {sheet.kind === 'editWorkspace' && (
          <WorkspaceSheet workspaceId={sheet.workspaceId} />
        )}
        {sheet.kind === 'resetWorkspaceProgress' && (
          <ResetWorkspaceProgressSheet
            workspaceId={sheet.workspaceId}
            repoIds={sheet.repoIds}
          />
        )}
        {sheet.kind === 'fetchWorkspaceProgress' && (
          <FetchWorkspaceProgressSheet
            workspaceId={sheet.workspaceId}
            repoIds={sheet.repoIds}
          />
        )}
        {sheet.kind === 'syncBehindProgress' && (
          <SyncBehindProgressSheet
            workspaceId={sheet.workspaceId}
            repoIds={sheet.repoIds}
          />
        )}
        {sheet.kind === 'reviewChanges' && (
          <ReviewSheet repoId={sheet.repoId} initialScope={sheet.scope} />
        )}
        {sheet.kind === 'newBranchInWorkset' && (
          <WorksetBranchSheet worksetId={sheet.worksetId} />
        )}
        {sheet.kind === 'commitAllInWorkset' && (
          <WorksetCommitAllSheet worksetId={sheet.worksetId} />
        )}
        {sheet.kind === 'pushAllInWorkset' && (
          <WorksetPushAllSheet worksetId={sheet.worksetId} />
        )}
        {sheet.kind === 'openPRsInWorkset' && (
          <WorksetOpenPRsSheet worksetId={sheet.worksetId} />
        )}
        {sheet.kind === 'fileHistory' && (
          <FileHistorySheet
            repoId={sheet.repoId}
            path={sheet.path}
            initialTab={sheet.tab}
          />
        )}
        {sheet.kind === 'manageRepo' && (
          <ManageRepoSheet repoId={sheet.repoId} initialTab={sheet.tab} />
        )}
        {sheet.kind === 'pullConflict' && (
          <PullConflictSheet
            repoId={sheet.repoId}
            conflicts={sheet.conflicts}
            rawError={sheet.rawError}
          />
        )}
        {sheet.kind === 'initRepo' && (
          <InitRepoSheet path={sheet.path} reason={sheet.reason} />
        )}
        {sheet.kind === 'resolveConflict' && (
          <ResolveConflictSheet repoId={sheet.repoId} path={sheet.path} />
        )}
        {sheet.kind === 'abandonLocal' && (
          <AbandonLocalSheet repoId={sheet.repoId} />
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

function InitRepoSheet({ path, reason }: { path: string; reason: string }): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const initAndAddRepo = useStore((s) => s.initAndAddRepo);
  const [branch, setBranch] = useState('main');
  const [busy, setBusy] = useState(false);
  const folderName = useMemo(() => {
    const trimmed = path.replace(/[/\\]+$/, '');
    const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  }, [path]);

  const trimmedBranch = branch.trim();
  const branchError =
    trimmedBranch.length > 0 && /[\s~^:?*\[\\]/.test(trimmedBranch)
      ? 'Branch name contains an illegal character.'
      : null;

  const onInit = async () => {
    if (busy || branchError) return;
    setBusy(true);
    try {
      const res = await initAndAddRepo(path, trimmedBranch);
      if (res.ok) setSheet(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SheetHeader title="Initialize as git repo" onClose={() => setSheet(null)} />
      <div className="flex-1 min-h-0 p-5 flex flex-col gap-4 text-sm overflow-y-auto">
        <div className="text-ink-muted">
          <p>
            <span className="font-mono text-ink">{folderName}</span> isn't a git repo yet.
          </p>
          <p className="text-[11px] text-ink-faint mt-1">
            {reason} · Run <span className="font-mono">git init</span> here?
          </p>
          <p className="text-[11px] text-ink-faint mt-2 break-all font-mono">{path}</p>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-faint">
            Initial branch name
          </span>
          <input
            autoFocus
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            disabled={busy}
            placeholder="main"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !branchError && !busy) void onInit();
            }}
            className="field px-2 py-1.5 text-sm font-mono"
          />
          {branchError ? (
            <span className="text-[11px] text-red-400">{branchError}</span>
          ) : (
            <span className="text-[11px] text-ink-faint">
              Leave blank to use git's <span className="font-mono">init.defaultBranch</span>.
            </span>
          )}
        </label>
      </div>
      <div className="flex-shrink-0 flex items-center justify-end gap-2 border-t border-card px-5 py-3">
        <button
          onClick={() => setSheet(null)}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={onInit}
          disabled={busy || !!branchError}
          className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
        >
          {busy ? 'Initializing…' : 'Initialize and add'}
        </button>
      </div>
    </>
  );
}

type SettingsTab = 'general' | 'identity' | 'ai' | 'repos' | 'shortcuts';

const SETTINGS_TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: 'general', label: 'General', hint: 'Theme, library' },
  { id: 'identity', label: 'Identity', hint: 'Commit author' },
  { id: 'ai', label: 'AI & Forges', hint: 'CLI integrations' },
  { id: 'repos', label: 'Repos', hint: 'Default branches' },
  { id: 'shortcuts', label: 'Shortcuts', hint: 'Keyboard' },
];

function SettingsSheet(): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const [tab, setTab] = useState<SettingsTab>('general');

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-shrink-0 flex items-center justify-between border-b border-card px-6 py-3.5">
        <div>
          <h2 className="text-base font-semibold leading-none">Settings</h2>
          <p className="mt-1 text-[11px] text-ink-faint">
            How overgit works · CLIs · Defaults · Shortcuts
          </p>
        </div>
        <button
          onClick={() => setSheet(null)}
          className="text-ink-faint hover:text-ink rounded p-1.5 hover:bg-card"
          aria-label="Close"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Two-column body: tab rail on the left, scrollable content on
          the right. Both columns share the modal's flex height; the
          right side is the only one that scrolls. */}
      <div className="flex-1 min-h-0 grid grid-cols-[180px_1fr] overflow-hidden">
        <nav className="border-r border-card bg-card/30 px-2 py-3 overflow-y-auto">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full text-left px-3 py-2 rounded-md mb-0.5 ${
                tab === t.id ? 'bg-accent text-white' : 'hover:bg-card text-ink-muted hover:text-ink'
              }`}
            >
              <div className="text-[12px] font-semibold leading-tight">{t.label}</div>
              <div
                className={`text-[10px] mt-0.5 ${
                  tab === t.id ? 'text-white/70' : 'text-ink-faint'
                }`}
              >
                {t.hint}
              </div>
            </button>
          ))}
        </nav>

        <div className="overflow-y-auto px-6 py-5">
          {tab === 'general' && <SettingsGeneralPanel />}
          {tab === 'identity' && <SettingsIdentityPanel />}
          {tab === 'ai' && <SettingsCliPanel />}
          {tab === 'repos' && <SettingsReposPanel />}
          {tab === 'shortcuts' && <SettingsShortcutsPanel />}
        </div>
      </div>

      <div className="flex-shrink-0 flex items-center justify-end border-t border-card px-5 py-3">
        <button
          onClick={() => setSheet(null)}
          className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function SettingsGeneralPanel(): JSX.Element {
  const settings = useStore((s) => s.settings);
  const repos = useStore((s) => s.repos);
  const worksets = useStore((s) => s.worksets);

  const updateTheme = async (theme: 'light' | 'dark' | 'system') => {
    const next = { ...settings, theme };
    useStore.setState({ settings: next });
    await window.overgit.invoke('store:saveSettings', next);
    applyTheme(theme);
  };

  const updateStagingMode = async (stagingMode: 'simple' | 'advanced') => {
    const next = { ...settings, stagingMode };
    useStore.setState({ settings: next });
    await window.overgit.invoke('store:saveSettings', next);
  };

  const updateExplainMode = async (explainMode: boolean) => {
    const next = { ...settings, explainMode };
    useStore.setState({ settings: next });
    await window.overgit.invoke('store:saveSettings', next);
  };

  return (
    <div className="flex flex-col gap-6 text-sm">
      <ProcessExplainer />

      <SettingsGroup
        eyebrow="Display"
        title="Theme"
        subtitle="System follows your OS dark/light setting."
      >
        <div className="flex gap-2">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button
              key={t}
              onClick={() => updateTheme(t)}
              className={`px-3 py-1.5 rounded-md border text-xs ${
                settings.theme === t
                  ? 'bg-accent text-white border-accent'
                  : 'border-card hover:bg-card'
              }`}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup
        eyebrow="Learning"
        title="Explain mode"
        subtitle="Show the underlying git command and a plain-English caption next to action buttons. Useful for learning what overgit is doing under the hood."
      >
        <div className="flex gap-2">
          {([['off', false], ['on', true]] as const).map(([label, value]) => (
            <button
              key={label}
              onClick={() => updateExplainMode(value)}
              className={`px-3 py-1.5 rounded-md border text-xs ${
                Boolean(settings.explainMode) === value
                  ? 'bg-accent text-white border-accent'
                  : 'border-card hover:bg-card'
              }`}
            >
              {label[0].toUpperCase() + label.slice(1)}
            </button>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup
        eyebrow="Commit"
        title="Staging"
        subtitle="Simple: one Changes list, the checkbox decides what to commit. Advanced: separate Staged + Unstaged groups with explicit Stage/Unstage actions."
      >
        <div className="flex gap-2">
          {(['simple', 'advanced'] as const).map((m) => (
            <button
              key={m}
              onClick={() => updateStagingMode(m)}
              className={`px-3 py-1.5 rounded-md border text-xs ${
                (settings.stagingMode ?? 'simple') === m
                  ? 'bg-accent text-white border-accent'
                  : 'border-card hover:bg-card'
              }`}
            >
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup
        eyebrow="State"
        title="Library"
        subtitle="What overgit currently tracks. Nothing is written into your repos."
      >
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Repos" value={repos.length.toString()} />
          <Stat label="Worksets" value={worksets.length.toString()} />
        </div>
      </SettingsGroup>
    </div>
  );
}

function SettingsCliPanel(): JSX.Element {
  const cli = useStore((s) => s.cliPresence);
  return (
    <div className="flex flex-col gap-6 text-sm">
      <SettingsGroup
        eyebrow="AI"
        title="LLM CLIs"
        subtitle="Overgit pipes a diff into one of these in non-interactive mode and shows the response. Nothing leaves your machine via overgit — each CLI handles its own auth and transport."
      >
        <ul className="flex flex-col">
          <CliRow name="claude" present={cli?.claude} purpose="Claude Code · pipes prompt to claude -p -" />
          <CliRow name="codex" present={cli?.codex} purpose="OpenAI Codex · codex exec --skip-git-repo-check -" />
          <CliRow name="gemini" present={cli?.gemini} purpose="Google Gemini · gemini -p -" />
        </ul>
      </SettingsGroup>

      <SettingsGroup
        eyebrow="Forge"
        title="Review CLIs"
        subtitle="Used for PR / MR data and comments. Missing CLIs just hide their UI."
      >
        <ul className="flex flex-col">
          <CliRow name="gh" present={cli?.gh} purpose="GitHub · PR list, comments, reviews" />
          <CliRow name="glab" present={cli?.glab} purpose="GitLab MR list (planned)" />
          <CliRow name="jj" present={cli?.jj} purpose="Jujutsu integration (planned)" />
        </ul>
      </SettingsGroup>
    </div>
  );
}

function SettingsReposPanel(): JSX.Element {
  const repos = useStore((s) => s.repos);
  return (
    <div className="flex flex-col gap-6 text-sm">
      <SettingsGroup
        eyebrow="Repos"
        title="Default branches"
        subtitle="Each repo's trunk — the branch overgit treats as the base for compare/PR-base and as the recovery target during a workset sync-and-branch. Auto-detected from origin/HEAD on add."
      >
        {repos.length === 0 ? (
          <div className="text-[11px] text-ink-faint p-3 rounded border border-card bg-card">
            No repos yet. Add one from the sidebar to configure its default branch.
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {repos.map((r) => (
              <DefaultBranchRow key={r.id} repoId={r.id} />
            ))}
          </ul>
        )}
      </SettingsGroup>
    </div>
  );
}

function SettingsIdentityPanel(): JSX.Element {
  const settings = useStore((s) => s.settings);
  const repos = useStore((s) => s.repos);

  const current = settings.defaultIdentity;
  const [name, setName] = useState(current?.name ?? '');
  const [email, setEmail] = useState(current?.email ?? '');
  const [savingDefault, setSavingDefault] = useState(false);

  useEffect(() => {
    setName(current?.name ?? '');
    setEmail(current?.email ?? '');
  }, [current?.name, current?.email]);

  const defaultDirty = name !== (current?.name ?? '') || email !== (current?.email ?? '');

  const onSaveDefault = async () => {
    setSavingDefault(true);
    try {
      const next: AppSettings = {
        ...settings,
        defaultIdentity:
          name.trim() && email.trim()
            ? { name: name.trim(), email: email.trim() }
            : undefined,
      };
      useStore.setState({ settings: next });
      await window.overgit.invoke('store:saveSettings', next);
    } finally {
      setSavingDefault(false);
    }
  };

  const onClearDefault = async () => {
    setSavingDefault(true);
    try {
      const next: AppSettings = { ...settings, defaultIdentity: undefined };
      useStore.setState({ settings: next });
      await window.overgit.invoke('store:saveSettings', next);
      setName('');
      setEmail('');
    } finally {
      setSavingDefault(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 text-sm">
      <SettingsGroup
        eyebrow="Identity"
        title="Default commit author"
        subtitle="Used when a repo has no per-repo override and its local .git/config has no user.name/user.email."
      >
        <div className="flex flex-wrap gap-2 items-end max-w-2xl">
          <div className="flex flex-col gap-1 flex-1 min-w-[160px]">
            <label className="text-[10px] uppercase tracking-wide text-ink-faint">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Lionel Farr"
              className="field px-2 py-1.5 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
            <label className="text-[10px] uppercase tracking-wide text-ink-faint">Email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="field px-2 py-1.5 text-sm"
            />
          </div>
          <button
            onClick={onSaveDefault}
            disabled={savingDefault || !defaultDirty || (!!name.trim() !== !!email.trim())}
            className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
          >
            Save default
          </button>
          {current && (
            <button
              onClick={onClearDefault}
              disabled={savingDefault}
              className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup
        eyebrow="Per-repo"
        title="Identity per repository"
        subtitle="Edit any row inline, or check rows and bulk-apply an identity. Override columns left blank fall through to the repo's git config / global default / system git."
      >
        {repos.length === 0 ? (
          <div className="text-[11px] text-ink-faint p-3 rounded border border-card bg-card">
            No repos yet. Add one from the sidebar.
          </div>
        ) : (
          <IdentityBulkTable />
        )}
      </SettingsGroup>
    </div>
  );
}

interface RowDraft {
  /// Override draft. Empty string means "no override" — same on save
  /// (we'll send identity: null). We don't track repo-config / global
  /// fallbacks here; this draft only ever represents the per-repo
  /// override the user is editing.
  name: string;
  email: string;
}

function IdentityBulkTable(): JSX.Element {
  const repos = useStore((s) => s.repos);
  const settings = useStore((s) => s.settings);
  const pushToast = useStore((s) => s.pushToast);
  const [resolved, setResolved] = useState<Record<UUID, ResolvedIdentity>>({});
  const [drafts, setDrafts] = useState<Record<UUID, RowDraft>>({});
  const [checked, setChecked] = useState<Set<UUID>>(new Set());
  const [busy, setBusy] = useState<Set<UUID>>(new Set());
  const [filter, setFilter] = useState('');

  const refreshResolved = async () => {
    const map = await window.overgit.invoke('repo:resolveAllIdentities');
    setResolved(map);
  };

  useEffect(() => {
    void refreshResolved();
  }, [repos.length]);

  // Seed drafts from saved overrides whenever the underlying repo
  // identity list changes (e.g. after a save). Untouched rows stay in
  // sync with the store; rows the user is currently editing keep their
  // in-flight text because the spread below only fills missing keys.
  useEffect(() => {
    setDrafts((prev) => {
      const next: Record<UUID, RowDraft> = {};
      for (const r of repos) {
        next[r.id] = prev[r.id] ?? {
          name: r.identity?.name ?? '',
          email: r.identity?.email ?? '',
        };
      }
      return next;
    });
  }, [repos]);

  // The bulk-apply dropdown: global default plus every distinct
  // identity already in use across repos. Lets the user click "Apply"
  // with whatever identity they already have wired up somewhere.
  const presets = useMemo(() => {
    const list: { label: string; identity: Identity }[] = [];
    if (settings.defaultIdentity) {
      list.push({
        label: `Global default · ${settings.defaultIdentity.name} <${settings.defaultIdentity.email}>`,
        identity: settings.defaultIdentity,
      });
    }
    const seen = new Set<string>();
    if (settings.defaultIdentity) {
      seen.add(`${settings.defaultIdentity.name}|${settings.defaultIdentity.email}`);
    }
    for (const r of repos) {
      if (!r.identity) continue;
      const key = `${r.identity.name}|${r.identity.email}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        label: `${r.identity.name} <${r.identity.email}>`,
        identity: r.identity,
      });
    }
    return list;
  }, [repos, settings.defaultIdentity]);

  const [presetIndex, setPresetIndex] = useState(0);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q) ||
        (r.identity?.email ?? '').toLowerCase().includes(q),
    );
  }, [repos, filter]);

  const allChecked = filtered.length > 0 && filtered.every((r) => checked.has(r.id));
  const someChecked = filtered.some((r) => checked.has(r.id));

  const toggleAll = () => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (allChecked) {
        for (const r of filtered) next.delete(r.id);
      } else {
        for (const r of filtered) next.add(r.id);
      }
      return next;
    });
  };

  const updateDraft = (id: UUID, patch: Partial<RowDraft>) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch },
    }));
  };

  /// Save one repo's draft. Both fields blank → clear override; both
  /// filled → set override; mixed (only one filled) → reject so we
  /// never store half an identity.
  const saveRow = async (id: UUID): Promise<boolean> => {
    const d = drafts[id];
    if (!d) return false;
    const name = d.name.trim();
    const email = d.email.trim();
    if (!!name !== !!email) {
      pushToast({
        kind: 'error',
        message: 'Name and email must both be set, or both blank.',
      });
      return false;
    }
    setBusy((prev) => new Set(prev).add(id));
    try {
      const identity: Identity | null = name && email ? { name, email } : null;
      await window.overgit.invoke('repo:setIdentity', { repoId: id, identity });
      useStore.setState({
        repos: useStore.getState().repos.map((r) =>
          r.id === id ? { ...r, identity: identity ?? undefined } : r,
        ),
      });
      return true;
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const onSaveRow = async (id: UUID) => {
    const ok = await saveRow(id);
    if (ok) {
      pushToast({ kind: 'success', message: 'Identity saved.' });
      void refreshResolved();
    }
  };

  // Every row whose draft differs from the persisted override. Powers
  // "Save all" / "Revert" — without these, bulk-editing a dozen rows
  // forces a dozen Save clicks, which defeats the point of the table.
  const dirtyIds = useMemo(() => {
    const out: UUID[] = [];
    for (const r of repos) {
      const d = drafts[r.id];
      if (!d) continue;
      const savedName = r.identity?.name ?? '';
      const savedEmail = r.identity?.email ?? '';
      if (d.name !== savedName || d.email !== savedEmail) out.push(r.id);
    }
    return out;
  }, [repos, drafts]);

  const onSaveAll = async () => {
    if (dirtyIds.length === 0) return;
    setBusy((prev) => {
      const next = new Set(prev);
      for (const id of dirtyIds) next.add(id);
      return next;
    });
    try {
      const results = await Promise.all(dirtyIds.map((id) => saveRow(id)));
      const okCount = results.filter(Boolean).length;
      if (okCount > 0) {
        pushToast({
          kind: 'success',
          message: `Saved ${okCount} repo${okCount === 1 ? '' : 's'}.`,
        });
      }
      void refreshResolved();
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        for (const id of dirtyIds) next.delete(id);
        return next;
      });
    }
  };

  const onRevertAll = () => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const id of dirtyIds) {
        const r = repos.find((x) => x.id === id);
        if (!r) continue;
        next[id] = { name: r.identity?.name ?? '', email: r.identity?.email ?? '' };
      }
      return next;
    });
  };

  const onClearRow = async (id: UUID) => {
    updateDraft(id, { name: '', email: '' });
    setBusy((prev) => new Set(prev).add(id));
    try {
      await window.overgit.invoke('repo:setIdentity', { repoId: id, identity: null });
      useStore.setState({
        repos: useStore.getState().repos.map((r) =>
          r.id === id ? { ...r, identity: undefined } : r,
        ),
      });
      void refreshResolved();
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const applyPreset = async (scope: 'all' | 'selected') => {
    const preset = presets[presetIndex];
    if (!preset) return;
    const target =
      scope === 'all'
        ? filtered
        : filtered.filter((r) => checked.has(r.id));
    if (target.length === 0) {
      pushToast({
        kind: 'warn',
        message:
          scope === 'selected'
            ? 'Check at least one row first.'
            : 'No repos to apply to.',
      });
      return;
    }
    setBusy((prev) => {
      const next = new Set(prev);
      for (const r of target) next.add(r.id);
      return next;
    });
    try {
      await Promise.all(
        target.map(async (r) => {
          await window.overgit.invoke('repo:setIdentity', {
            repoId: r.id,
            identity: preset.identity,
          });
          updateDraft(r.id, {
            name: preset.identity.name,
            email: preset.identity.email,
          });
        }),
      );
      useStore.setState({
        repos: useStore.getState().repos.map((r) =>
          target.some((t) => t.id === r.id) ? { ...r, identity: preset.identity } : r,
        ),
      });
      pushToast({
        kind: 'success',
        message: `Applied to ${target.length} repo${target.length === 1 ? '' : 's'}.`,
      });
      void refreshResolved();
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        for (const r of target) next.delete(r.id);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Bulk-apply controls */}
      <div className="flex flex-wrap items-center gap-2 p-2 rounded border border-card bg-card/40">
        <span className="text-[11px] uppercase tracking-wide text-ink-faint">Bulk apply</span>
        {presets.length === 0 ? (
          <span className="text-[11px] text-ink-faint italic">
            Set a global default or a per-repo override below to enable bulk apply.
          </span>
        ) : (
          <>
            <select
              value={presetIndex}
              onChange={(e) => setPresetIndex(Number(e.target.value))}
              className="field text-xs px-2 py-1 max-w-[300px]"
            >
              {presets.map((p, i) => (
                <option key={i} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => applyPreset('selected')}
              disabled={!someChecked}
              className="text-[11px] px-2 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
              title="Apply to checked rows"
            >
              Apply to selected ({checked.size})
            </button>
            <button
              onClick={() => applyPreset('all')}
              className="text-[11px] px-2 py-1 rounded border border-card hover:bg-card"
              title="Apply to every visible row"
            >
              Apply to all ({filtered.length})
            </button>
          </>
        )}
        <div className="flex-1" />
        <button
          onClick={onSaveAll}
          disabled={dirtyIds.length === 0}
          className="text-[11px] px-2 py-1 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-40"
          title="Save every row whose name/email differs from what's stored"
        >
          Save all ({dirtyIds.length})
        </button>
        <button
          onClick={onRevertAll}
          disabled={dirtyIds.length === 0}
          className="text-[11px] px-2 py-1 rounded border border-card hover:bg-card disabled:opacity-40"
          title="Discard unsaved row edits"
        >
          Revert
        </button>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="field text-xs px-2 py-1 w-[180px]"
        />
      </div>

      {/* Header */}
      <div className="grid grid-cols-[24px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.6fr)_auto] gap-2 px-2 text-[10px] uppercase tracking-wide text-ink-faint">
        <input
          type="checkbox"
          checked={allChecked}
          ref={(el) => {
            if (el) el.indeterminate = !allChecked && someChecked;
          }}
          onChange={toggleAll}
          aria-label="Select all"
        />
        <span>Repository</span>
        <span>Override name</span>
        <span>Override email</span>
        <span>Active source</span>
        <span></span>
      </div>

      {/* Rows */}
      <ul className="flex flex-col">
        {filtered.map((r) => {
          const draft = drafts[r.id] ?? { name: '', email: '' };
          const res = resolved[r.id];
          const dirty =
            draft.name !== (r.identity?.name ?? '') ||
            draft.email !== (r.identity?.email ?? '');
          const isBusy = busy.has(r.id);
          return (
            <li
              key={r.id}
              className="grid grid-cols-[24px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.6fr)_auto] gap-2 items-center px-2 py-1.5 border-b border-card last:border-b-0"
            >
              <input
                type="checkbox"
                checked={checked.has(r.id)}
                onChange={() => {
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.id)) next.delete(r.id);
                    else next.add(r.id);
                    return next;
                  });
                }}
                aria-label={`Select ${r.name}`}
              />
              <div className="min-w-0">
                <div className="text-xs font-medium truncate">{r.name}</div>
                <div className="text-[10px] text-ink-faint truncate font-mono">{r.path}</div>
              </div>
              <input
                value={draft.name}
                onChange={(e) => updateDraft(r.id, { name: e.target.value })}
                placeholder="(no override)"
                disabled={isBusy}
                className="field text-xs px-2 py-1"
              />
              <input
                value={draft.email}
                onChange={(e) => updateDraft(r.id, { email: e.target.value })}
                placeholder="(no override)"
                disabled={isBusy}
                className="field text-xs px-2 py-1"
              />
              <div className="min-w-0 text-[11px]">
                {res ? (
                  <>
                    <IdentitySourceLabel source={res.source} />
                    <div className="text-[10px] text-ink-faint truncate font-mono">
                      {res.email || '(no email)'}
                    </div>
                  </>
                ) : (
                  <span className="text-ink-faint">…</span>
                )}
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => onSaveRow(r.id)}
                  disabled={isBusy || !dirty}
                  className="text-[11px] px-2 py-1 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-40"
                  title="Save this row"
                >
                  Save
                </button>
                {(r.identity || draft.name || draft.email) && (
                  <button
                    onClick={() => onClearRow(r.id)}
                    disabled={isBusy}
                    className="text-[11px] px-2 py-1 rounded border border-card hover:bg-card disabled:opacity-40"
                    title="Clear this repo's override"
                  >
                    Clear
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SettingsShortcutsPanel(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 text-sm">
      <SettingsGroup
        eyebrow="Input"
        title="Keyboard shortcuts"
        subtitle="Inputs and textareas are skipped for alphabetic shortcuts so typing isn't intercepted; ⌘K and number-tabs always fire."
      >
        <ul className="grid grid-cols-1 gap-y-1.5 font-mono text-[11px]">
          <ShortcutRow keys="⌘ K" what="Command palette (switch / create branch, jump to repo, file)" />
          <ShortcutRow keys="⌘ ," what="Open settings" />
          <ShortcutRow keys="⌘ \\" what="Toggle sidebar" />
          <ShortcutRow keys="⌘ R" what="Refresh current pane" />
          <ShortcutRow keys="⌘ B" what="Branch picker (in a repo)" />
          <ShortcutRow keys="⌘ N" what="New branch (in a workset)" />
          <ShortcutRow keys="⌘ 1 – 4" what="Changes / History / Files / Graph" />
          <ShortcutRow keys="⌘ S" what="Save open file" />
          <ShortcutRow keys="↑ ↓ ⏎" what="Navigate picker / palette" />
        </ul>
      </SettingsGroup>
    </div>
  );
}

function SettingsGroup({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section>
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">
        {eyebrow}
      </div>
      <div className="mt-0.5 text-[13px] font-semibold text-ink leading-tight">{title}</div>
      {subtitle && (
        <div className="mt-1 text-[11px] leading-snug text-ink-faint mb-2">{subtitle}</div>
      )}
      <div className="mt-2 min-w-0">{children}</div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-card bg-card/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="text-lg font-mono leading-tight">{value}</div>
    </div>
  );
}

function ShortcutRow({ keys, what }: { keys: string; what: string }): JSX.Element {
  return (
    <li className="flex justify-between items-baseline gap-3">
      <span className="text-ink min-w-[68px]">{keys}</span>
      <span className="text-ink-faint flex-1 font-sans">{what}</span>
    </li>
  );
}

function DefaultBranchRow({ repoId }: { repoId: UUID }): JSX.Element {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId))!;
  const summaries = useStore((s) => s.repoBranchSummaries[repoId]);
  const refresh = useStore((s) => s.refreshRepoBranchSummaries);
  const setDefault = useStore((s) => s.setRepoDefaultBranch);
  const pushToast = useStore((s) => s.pushToast);

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
      pushToast({
        kind: 'warn',
        message: "Couldn't detect a default branch (no origin/HEAD set). Pick one manually.",
      });
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
  const steps = [
    {
      title: 'Add a repo',
      body:
        'Overgit records the path in its own store. Your repo on disk is untouched — we never write inside .git.',
    },
    {
      title: 'Group into a workset',
      body:
        'A workset is the unit of in-flight work — a named list of repos you branch, commit, push, and archive together. No symlinks, no synthetic root.',
    },
    {
      title: 'Run plain git',
      body:
        'Every action (status, fetch, checkout, push) is the equivalent shell command in the repo\'s existing directory.',
    },
    {
      title: 'CLIs handle reviews',
      body:
        'gh, glab, jj for forges. claude, codex, gemini for AI review. Features appear only when the CLI is installed.',
    },
  ];
  return (
    <section className="rounded-xl border border-accent/40 bg-gradient-to-br from-accent/10 to-transparent p-4">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">
          How overgit works
        </span>
        <div className="h-px flex-1 bg-accent/20" />
      </div>
      <ol className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-2.5">
            <span className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-accent/20 text-[10px] font-mono font-semibold text-accent">
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-ink">{s.title}</div>
              <div className="text-[11px] leading-snug text-ink-muted">{s.body}</div>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[11px] text-ink-faint border-t border-accent/15 pt-2.5">
        Stop using overgit at any time and your repos behave the same in any other tool.
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
    <li className="flex items-center gap-3 py-1.5 border-b border-card last:border-0">
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${
          present === undefined
            ? 'bg-ink-faint'
            : present
              ? 'bg-emerald-400'
              : 'bg-ink-faint/40'
        }`}
        title={
          present === undefined ? 'probing…' : present ? 'installed' : 'not installed'
        }
      />
      <span className={`font-mono text-xs w-16 ${present ? 'text-ink' : 'text-ink-faint'}`}>
        {name}
      </span>
      <span className="text-[11px] text-ink-muted truncate flex-1">{purpose}</span>
      <span
        className={`text-[10px] uppercase tracking-wide font-mono ${
          present === undefined
            ? 'text-ink-faint'
            : present
              ? 'text-emerald-400'
              : 'text-ink-faint'
        }`}
      >
        {present === undefined ? '…' : present ? 'ready' : 'missing'}
      </span>
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

/// About sheet — designed as a real product page, not a "v0.1.0" stub.
/// Hero with mark + tagline, three pillars explaining the value, a
/// features grid, footer with credits and a GitHub link. Patterned on
/// overcli's About so the two siblings feel related.
const ABOUT_PILLARS = [
  {
    color: '#8a78ff',
    kicker: 'Coordinate',
    title: 'Worksets, not single repos.',
    body:
      "Group the repos that ship together — a service, its shared libs, the infra repo — into one workset. Branch, sync, commit, and push across every member in one pass. No synthetic root. No monorepo migration. Archive when the work lands; un-archive if it comes back.",
  },
  {
    color: '#5eead4',
    kicker: 'Overlay',
    title: 'Nothing inside your .git.',
    body:
      "Overgit never touches a member repo's .git directory or config. Every action runs as a plain `git` command in the existing checkout. Quit overgit any time — every repo behaves identically in any other tool you use.",
  },
  {
    color: '#fbbf24',
    kicker: 'AI in the loop',
    title: 'Review and commit faster.',
    body:
      'Pipe a diff to claude, codex, or gemini for a 30-second review. Stage changes and have an LLM CLI draft a conventional-commit message from the diff. Uses your existing CLI auth — nothing extra to wire up, nothing leaves your machine via overgit.',
  },
] as const;

const ABOUT_GROUPINGS = [
  {
    color: '#5eead4',
    kicker: 'Workspace',
    sub: 'Durable · identity',
    title: 'Your repo neighborhoods.',
    body:
      '"These repos are Platform." A workspace is a permanent group that owns the sidebar section. One click fetches every repo in it, or resets every repo to its default branch. A repo can belong to many workspaces.',
  },
  {
    color: '#8a78ff',
    kicker: 'Workset',
    sub: 'Transient · in-flight',
    title: 'The thing you\'re shipping.',
    body:
      '"Ship auth migration this week." A workset is a temporary unit of work across a handful of repos. Branch, commit, push, and open PRs together — then archive when it lands.',
  },
] as const;

const ABOUT_STEPS = [
  {
    title: 'Group the repos that ship together',
    body:
      'Sidebar → New workset. Pick from your registered repos and name it. The workset lives in overgit only — no file is written into any member.',
  },
  {
    title: 'Branch every member with one command',
    body:
      '⌘N inside the workset, name a branch. Each repo fetches origin, fast-forwards its default branch, then cuts the new branch off it. Per-repo outcomes if any step fails — partial success is honest, not hidden.',
  },
  {
    title: 'Edit, stage, commit across the set',
    body:
      'Work in your editor as usual. The workset view shows dirty state for every member; the command palette stages, commits, and pushes them together. Cherry-pick a single commit into any other branch from the branch picker.',
  },
  {
    title: 'Ship, then archive',
    body:
      'gh PRs aggregate workset-wide — open every member\'s PR from one view. When the work lands, archive the workset. Reactivate it later in one click if a follow-up lands on your plate.',
  },
] as const;

const ABOUT_FEATURES = [
  { title: 'Workspace bulk actions', body: 'Fetch all, reset all to default — one click per workspace.' },
  { title: 'Workset-wide branching', body: 'Sync to default → pull → branch, across N repos at once.' },
  { title: 'Cross-repo commit & push', body: 'Stage, commit, push every dirty member from one screen.' },
  { title: 'Branch picker (⌘B)', body: 'Local + remote, searchable, with per-branch cherry-pick.' },
  { title: 'Command palette (⌘K)', body: 'Branches, files, repos, worksets, actions — one keystroke.' },
  { title: 'AI review & suggest', body: 'claude / codex / gemini on the staged or working diff.' },
  { title: 'gh PR aggregation', body: 'Workset-wide PR list — open every member\'s PR from one view.' },
  { title: 'Per-repo deep view', body: 'Changes / History / Files / Graph / Stash with bulk actions.' },
  { title: 'Sandboxed file editor', body: 'Syntax-highlighted, scoped to your registered repos.' },
] as const;

const ABOUT_SHORTCUTS = [
  { keys: '⌘K', label: 'Command palette' },
  { keys: '⌘B', label: 'Branch picker' },
  { keys: '⌘N', label: 'New branch' },
  { keys: '⌘P', label: 'Push' },
  { keys: '⌘F', label: 'Fetch' },
  { keys: '⌘⏎', label: 'Commit' },
  { keys: '⌘1–5', label: 'Repo tabs' },
  { keys: '⌘R', label: 'Refresh' },
  { keys: '⌘,', label: 'Settings' },
  { keys: '⌘\\', label: 'Toggle sidebar' },
] as const;

function AboutSheet(): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  // Wrapper must fill the modal AND allow its children to shrink, or
  // the inner `overflow-y-auto` body has no constrained height to
  // scroll within. `h-full min-h-0 flex flex-col` is the recipe: fill,
  // don't grow, become a flex parent for header/body/footer.
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="relative overflow-hidden border-b border-card bg-gradient-to-b from-accent/18 via-accent/6 to-transparent px-7 pt-7 pb-7 flex-shrink-0">
        <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-accent/15 blur-3xl" />
        <div className="pointer-events-none absolute -left-16 -bottom-20 h-48 w-48 rounded-full bg-accent/8 blur-3xl" />

        <div className="relative flex items-start gap-5">
          <AppMark />
          <div className="min-w-0 flex-1 pt-1">
            <div className="flex items-baseline gap-3">
              <div className="text-[30px] font-bold leading-none tracking-tight text-ink">overgit</div>
              <div className="rounded-full border border-card bg-card/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
                v0.1.0
              </div>
            </div>
            <div className="mt-2.5 text-sm leading-snug text-ink-muted">
              An overlay git client built around <span className="text-ink">workspaces</span> and{' '}
              <span className="text-ink">worksets</span> — coordinate many repos at once without
              owning their state.
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-7 py-5">
        <SectionLabel>Why overgit</SectionLabel>
        <div className="mt-3 flex flex-col gap-2">
          {ABOUT_PILLARS.map((p, i) => (
            <PillarRow key={p.title} index={i + 1} {...p} />
          ))}
        </div>

        <SectionLabel className="mt-6">Workspaces & worksets</SectionLabel>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {ABOUT_GROUPINGS.map((g) => (
            <GroupingRow key={g.kicker} {...g} />
          ))}
        </div>

        <SectionLabel className="mt-6">How a workset works</SectionLabel>
        <div className="mt-3 flex flex-col gap-2">
          {ABOUT_STEPS.map((s, i) => (
            <StepRow key={s.title} index={i + 1} title={s.title} body={s.body} />
          ))}
        </div>

        <SectionLabel className="mt-6">What's in the box</SectionLabel>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {ABOUT_FEATURES.map((f) => (
            <FeatureRow key={f.title} title={f.title} body={f.body} />
          ))}
        </div>

        <SectionLabel className="mt-6">Shortcuts</SectionLabel>
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-xl border border-card bg-card/30 px-4 py-3">
          {ABOUT_SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center gap-2 text-[11px]">
              <kbd className="inline-flex min-w-[44px] justify-center rounded border border-card bg-surface/70 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink">
                {s.keys}
              </kbd>
              <span className="text-ink-muted">{s.label}</span>
            </div>
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between rounded-xl border border-card bg-card/40 px-4 py-3 text-xs">
          <div>
            <div className="font-semibold text-ink">A father–son project.</div>
            <div className="mt-0.5 text-ink-muted">
              Built by Lionel &amp; Owen Farr · sibling of{' '}
              <a
                href="https://github.com/overcodelions/overcli"
                target="_blank"
                rel="noreferrer"
                className="text-ink-muted underline decoration-card underline-offset-2 hover:text-ink hover:decoration-ink-muted"
              >
                overcli
              </a>{' '}
              · Apache-2.0.
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400/80" />
            No API keys collected
          </div>
        </div>
      </div>

      <div className="flex-shrink-0 flex items-center gap-2 border-t border-card px-5 py-3 text-[11px]">
        <span className="text-ink-faint">
          Shells out to git, gh, claude, codex, gemini — uses your existing CLIs.
        </span>
        <div className="flex-1" />
        <a
          href="https://github.com/overcodelions/overcli"
          target="_blank"
          rel="noreferrer"
          className="rounded px-2 py-1 text-ink-muted hover:bg-card hover:text-ink"
        >
          overcli
        </a>
        <a
          href="https://github.com/overcodelions/overgit"
          target="_blank"
          rel="noreferrer"
          className="rounded px-2 py-1 text-ink-muted hover:bg-card hover:text-ink"
        >
          GitHub
        </a>
        <button
          onClick={() => setSheet(null)}
          className="rounded bg-accent px-3 py-1 font-medium text-white hover:bg-accent-strong"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function AppMark(): JSX.Element {
  return (
    <div className="relative flex h-[80px] w-[80px] items-center justify-center rounded-[20px] border border-card bg-gradient-to-br from-accent/55 via-accent/20 to-accent/5 shadow-[0_12px_24px_rgba(0,0,0,0.28)] flex-shrink-0">
      <div className="absolute inset-[5px] rounded-[15px] border border-ink/5 bg-surface/30" />
      <svg width="42" height="42" viewBox="0 0 42 42" fill="none" className="relative">
        {/* Stylized branch glyph: trunk + fork. Reads as "git" without
            being literal. White-on-purple keeps it punchy in dark mode. */}
        <circle cx="13" cy="11" r="3.5" stroke="currentColor" strokeWidth="2.5" className="text-ink" />
        <circle cx="13" cy="31" r="3.5" stroke="currentColor" strokeWidth="2.5" className="text-ink" />
        <circle cx="29" cy="21" r="3.5" stroke="currentColor" strokeWidth="2.5" className="text-ink" />
        <path d="M13 14.5 V 27.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-ink" />
        <path
          d="M13 21 Q 21 21 25.5 21"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="text-ink"
        />
      </svg>
    </div>
  );
}

function SectionLabel({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
        {children}
      </div>
      <div className="h-px flex-1 bg-card" />
    </div>
  );
}

function PillarRow({
  index,
  color,
  kicker,
  title,
  body,
}: {
  index: number;
  color: string;
  kicker: string;
  title: string;
  body: string;
}): JSX.Element {
  return (
    <div
      className="relative overflow-hidden rounded-xl border border-card bg-gradient-to-br from-card to-card/30 px-4 py-3 transition-colors hover:border-card"
      style={{ boxShadow: `inset 0 1px 0 ${color}20` }}
    >
      <div
        className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full blur-3xl"
        style={{ backgroundColor: `${color}1a` }}
      />
      <div className="relative">
        <span
          className="inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold uppercase tracking-[0.14em]"
          style={{ backgroundColor: `${color}24`, color }}
        >
          {String(index).padStart(2, '0')} · {kicker}
        </span>
        <div className="mt-1.5 text-[14px] font-semibold leading-tight text-ink">{title}</div>
        <div className="mt-1 text-[12px] leading-[1.5] text-ink-muted">{body}</div>
      </div>
    </div>
  );
}

function FeatureRow({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-card bg-card/30 px-3 py-2.5">
      <div className="text-[12px] font-semibold text-ink">{title}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-ink-muted">{body}</div>
    </div>
  );
}

function GroupingRow({
  color,
  kicker,
  sub,
  title,
  body,
}: {
  color: string;
  kicker: string;
  sub: string;
  title: string;
  body: string;
}): JSX.Element {
  return (
    <div
      className="relative overflow-hidden rounded-xl border border-card bg-card/40 px-3.5 py-3"
      style={{ boxShadow: `inset 0 1px 0 ${color}20` }}
    >
      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold uppercase tracking-[0.14em]"
          style={{ backgroundColor: `${color}24`, color }}
        >
          {kicker}
        </span>
        <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">{sub}</span>
      </div>
      <div className="mt-1.5 text-[13px] font-semibold leading-tight text-ink">{title}</div>
      <div className="mt-1 text-[11px] leading-[1.5] text-ink-muted">{body}</div>
    </div>
  );
}

function StepRow({
  index,
  title,
  body,
}: {
  index: number;
  title: string;
  body: string;
}): JSX.Element {
  return (
    <div className="flex gap-3 rounded-lg border border-card bg-card/30 px-3 py-2.5">
      <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/15 text-[11px] font-semibold text-accent">
        {index}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-semibold text-ink">{title}</div>
        <div className="mt-0.5 text-[11px] leading-[1.5] text-ink-muted">{body}</div>
      </div>
    </div>
  );
}

function WorksetSheet({ worksetId }: { worksetId?: UUID } = {}): JSX.Element {
  const repos = useStore((s) => s.repos);
  const worksets = useStore((s) => s.worksets);
  const setSheet = useStore((s) => s.setSheet);
  const createWorkset = useStore((s) => s.createWorkset);
  const updateWorkset = useStore((s) => s.updateWorkset);
  const checkoutWorksetBranch = useStore((s) => s.checkoutWorksetBranch);
  const adoptWorktreeBranch = useStore((s) => s.adoptWorktreeBranch);
  const stashRepo = useStore((s) => s.stashRepo);
  const pushToast = useStore((s) => s.pushToast);
  const editingId = worksetId ?? null;
  const existingStatuses = useStore((s) =>
    editingId ? s.worksetStatuses[editingId] ?? EMPTY_STATUSES : EMPTY_STATUSES,
  );
  const refreshWorksetStatus = useStore((s) => s.refreshWorksetStatus);

  const editing = worksetId
    ? worksets.find((w) => w.id === worksetId) ?? null
    : null;

  const [name, setName] = useState(editing?.name ?? '');
  const [picked, setPicked] = useState<Set<UUID>>(
    new Set(editing?.repoIds ?? []),
  );
  const [branch, setBranch] = useState(editing?.preferredBranch ?? '');
  const [busy, setBusy] = useState(false);
  const [repoFilter, setRepoFilter] = useState('');
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);

  const visibleRepos = useMemo(() => {
    const q = repoFilter.trim().toLowerCase();
    let list = [...repos].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
    if (showSelectedOnly) list = list.filter((r) => picked.has(r.id));
    if (!q) return list;
    return list.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q),
    );
  }, [repos, repoFilter, showSelectedOnly, picked]);

  // Where the bound branch should come from for the auto-checkout step
  // on Create. Default to "from origin/<default>" — the safest base for
  // fresh work, matching the "+ New branch" sheet's default. Edit doesn't
  // expose this; Edit just saves the metadata patch and lets the user run
  // the explicit branch flows when they want to move repos.
  type BaseMode = 'origin' | 'current' | 'existing';
  const [baseMode, setBaseMode] = useState<BaseMode>('origin');

  // Progress phase for the create flow. The sheet swaps its form for a
  // spinner-and-message UI while the workset is being created and the
  // bound branch is being checked out / created across N repos. After
  // the operation finishes, partial failures are shown as a per-repo
  // outcome list so the user can act before closing the sheet.
  type Row = {
    repoId: UUID;
    ok: boolean;
    label: string;
    message?: string;
    /// Only set when the underlying CheckoutOutcome was 'worktree-conflict'.
    /// Carries the path of the linked worktree that owns the branch so the
    /// row can offer a one-click "Adopt & retry".
    branch?: string;
    worktreePath?: string;
  };
  type Phase =
    | { kind: 'form' }
    | { kind: 'busy'; message: string }
    | { kind: 'outcomes'; rows: Row[] };
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  // Per-row "adopt" busy id, so the right row's button shows the spinner
  // without freezing the others.
  const [adoptingId, setAdoptingId] = useState<UUID | null>(null);
  // Per-row "stash & retry" busy id, same idea. Separate from adoptingId
  // because the two affordances target different failure modes and may
  // appear on the same row's siblings simultaneously.
  const [stashingId, setStashingId] = useState<UUID | null>(null);

  // Slug suggestion derived from the workset name. Shown as the Branch
  // input's placeholder when the user hasn't typed one yet — accepting
  // the placeholder is one click. Pure formatting, no state writes.
  const suggestedBranch = useMemo(() => {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug ? `feature/${slug}` : '';
  }, [name]);

  // Bound branch for the workset. The Branch input wins (it's what the
  // user is about to save); falls back to `editing.preferredBranch` for
  // existing worksets without a typed override; falls back to majority-
  // inference for legacy worksets that haven't bound a branch yet. Used
  // to offer a post-save sync for any newly-added project.
  const commonBranch: string | null = useMemo(() => {
    const typed = branch.trim();
    if (typed) return typed;
    if (!editing) return null;
    if (editing.preferredBranch) return editing.preferredBranch;
    const tally = new Map<string, number>();
    for (const s of existingStatuses) {
      const b = s.branch;
      if (!b) continue;
      tally.set(b, (tally.get(b) ?? 0) + 1);
    }
    if (tally.size === 0) return null;
    const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const [topBranch, topCount] = sorted[0];
    if (topCount < 2) return null;
    if (topCount * 2 < existingStatuses.length) return null;
    return topBranch;
  }, [branch, editing, existingStatuses]);

  // Newly-added repos: in `picked` but not previously a member. These
  // are the rows we'll offer to sync to commonBranch after save.
  const newlyAdded = useMemo<UUID[]>(() => {
    const before = new Set(editing?.repoIds ?? []);
    return [...picked].filter((id) => !before.has(id));
  }, [editing, picked]);

  // After the save, the user can choose to bring each new repo up to
  // commonBranch. We track per-repo state so the same row can show
  // "syncing", an outcome badge, or a retry.
  type SyncState =
    | { kind: 'idle' }
    | { kind: 'syncing' }
    | { kind: 'done'; outcome: SyncAndBranchOutcome | { result: 'unknown-repo' } };
  const [showSync, setShowSync] = useState(false);
  const [syncState, setSyncState] = useState<Record<UUID, SyncState>>({});

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
    const trimmedBranch = branch.trim() || suggestedBranch;
    setBusy(true);
    try {
      // Edit path: just save metadata, no branch operations. Branch
      // changes on edit happen explicitly via "+ New branch" / per-row
      // Sync, so we don't move N repos as a side effect of "Save".
      if (editing) {
        await updateWorkset(editing.id, {
          name: name.trim(),
          repoIds: [...picked],
          preferredBranch: trimmedBranch || undefined,
        });
        if (newlyAdded.length > 0 && commonBranch) {
          setShowSync(true);
        } else {
          setSheet(null);
        }
        return;
      }

      // Create path: workset row + (if a branch is bound) the chosen
      // branch flow across every member. Spinner and per-repo outcomes
      // surface in the sheet body via `phase`.
      setPhase({ kind: 'busy', message: 'Creating workset…' });
      await createWorkset(name.trim(), [...picked], trimmedBranch || undefined);
      const createdId = useStore.getState().selectedWorksetId;
      if (!createdId || !trimmedBranch) {
        setSheet(null);
        return;
      }

      const repoCount = picked.size;
      const repoWord = repoCount === 1 ? 'repo' : 'repos';
      const rows: Row[] = [];

      if (baseMode === 'origin' || baseMode === 'current') {
        const syncDefault = baseMode === 'origin';
        setPhase({
          kind: 'busy',
          message:
            baseMode === 'origin'
              ? `Fetching, syncing default, and creating ${trimmedBranch} across ${repoCount} ${repoWord}…`
              : `Creating ${trimmedBranch} from current branch in ${repoCount} ${repoWord}…`,
        });
        const outcomes = await window.overgit.invoke('workset:syncAndBranch', {
          worksetId: createdId,
          branch: trimmedBranch,
          syncDefault,
          pullBeforeBranch: syncDefault,
        });
        for (const o of outcomes) {
          rows.push({
            repoId: o.repoId,
            ok: o.result === 'created',
            label: o.result,
            message: o.message,
          });
        }
      } else {
        // Existing branch — checkout without creating. Repos that don't
        // have the branch come back as 'missing-branch' and surface in
        // the outcomes list so the user can decide what to do.
        setPhase({
          kind: 'busy',
          message: `Checking out ${trimmedBranch} across ${repoCount} ${repoWord}…`,
        });
        const outcomes = await window.overgit.invoke('workset:checkoutBranch', {
          worksetId: createdId,
          branch: trimmedBranch,
          createIfMissing: false,
        });
        for (const o of outcomes) {
          const ok = o.result === 'switched' || o.result === 'already-on-branch';
          rows.push({
            repoId: o.repoId,
            ok,
            label: o.result,
            message: o.message,
            branch: o.branch,
            worktreePath: o.worktreePath,
          });
        }
      }

      await refreshWorksetStatus(createdId);
      const failures = rows.filter((r) => !r.ok);
      if (failures.length === 0) {
        pushToast({
          kind: 'success',
          message: `Workset created · ${trimmedBranch} on ${repoCount} ${repoWord}.`,
        });
        setSheet(null);
      } else {
        // Stay in the sheet and show per-repo outcomes so the user can
        // see what failed (dirty / pull-failed / missing-branch / etc).
        setPhase({ kind: 'outcomes', rows });
      }
    } finally {
      setBusy(false);
    }
  };

  const onAdoptRow = async (row: Row) => {
    if (!row.worktreePath || !row.branch) return;
    setAdoptingId(row.repoId);
    try {
      const res = await adoptWorktreeBranch(
        row.repoId,
        row.worktreePath,
        row.branch,
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
      // adoptWorktreeBranch already ran `git switch` in the main repo —
      // mark the row as switched so the user sees the green outcome.
      setPhase((p) =>
        p.kind === 'outcomes'
          ? {
              ...p,
              rows: p.rows.map((r) =>
                r.repoId === row.repoId
                  ? { ...r, ok: true, label: 'switched', message: undefined, worktreePath: undefined }
                  : r,
              ),
            }
          : p,
      );
      const wsId = useStore.getState().selectedWorksetId;
      if (wsId) await refreshWorksetStatus(wsId);
    } finally {
      setAdoptingId(null);
    }
  };

  const onStashRow = async (row: Row) => {
    const targetBranch = branch.trim() || suggestedBranch;
    if (!targetBranch) return;
    setStashingId(row.repoId);
    try {
      const stashed = await stashRepo(row.repoId);
      if (!stashed.ok) {
        pushToast({ kind: 'error', message: stashed.error ?? 'Stash failed' });
        return;
      }
      const res = await window.overgit.invoke('workset:syncMemberToBranch', {
        repoId: row.repoId,
        branch: targetBranch,
      });
      const ok = 'result' in res && res.result === 'created';
      setPhase((p) =>
        p.kind === 'outcomes'
          ? {
              ...p,
              rows: p.rows.map((r) =>
                r.repoId === row.repoId
                  ? {
                      ...r,
                      ok,
                      label: res.result,
                      message: 'message' in res ? res.message : undefined,
                      worktreePath: undefined,
                    }
                  : r,
              ),
            }
          : p,
      );
      const wsId = useStore.getState().selectedWorksetId;
      if (wsId) await refreshWorksetStatus(wsId);
    } finally {
      setStashingId(null);
    }
  };

  const runSyncFor = async (repoId: UUID) => {
    if (!commonBranch || !editingId) return;
    setSyncState((s) => ({ ...s, [repoId]: { kind: 'syncing' } }));
    const outcome = await window.overgit.invoke('workset:syncMemberToBranch', {
      repoId,
      branch: commonBranch,
    });
    setSyncState((s) => ({ ...s, [repoId]: { kind: 'done', outcome } }));
    await refreshWorksetStatus(editingId);
  };

  const runSyncAll = async () => {
    for (const id of newlyAdded) {
      const cur = syncState[id];
      if (cur && cur.kind !== 'idle') continue;
      await runSyncFor(id);
    }
  };

  const reposById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);

  return (
    <>
      <SheetHeader
        title={editing ? `Edit workset · ${editing.name}` : 'New workset'}
        onClose={() => setSheet(null)}
      />
      <div className="flex-1 min-h-0 p-5 flex flex-col gap-4 text-sm overflow-y-auto">
        {phase.kind === 'busy' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 py-12">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              className="animate-spin text-accent"
              aria-hidden
            >
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" fill="none" />
              <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
            </svg>
            <div className="text-sm text-ink text-center max-w-md leading-snug">
              {phase.message}
            </div>
            <div className="text-[11px] text-ink-faint">This can take a moment.</div>
          </div>
        )}
        {phase.kind === 'outcomes' && (
          <div className="flex flex-col gap-3">
            <div className="text-sm text-ink">
              Workset created. Some repos need attention:
            </div>
            <ul className="flex flex-col gap-1.5">
              {phase.rows.map((row) => {
                const r = reposById.get(row.repoId);
                return (
                  <li
                    key={row.repoId}
                    className={`flex items-center gap-3 px-3 py-2 rounded border ${
                      row.ok ? 'border-card bg-card' : 'border-amber-500/30 bg-amber-500/5'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">
                        {r?.name ?? row.repoId}
                      </div>
                      {r?.path && (
                        <div className="text-[11px] text-ink-faint truncate font-mono">
                          {r.path}
                        </div>
                      )}
                    </div>
                    <span
                      className={`text-[11px] font-mono max-w-[260px] truncate ${
                        row.ok ? 'text-emerald-400' : 'text-amber-400'
                      }`}
                      title={row.message ?? row.label}
                    >
                      {row.label}
                      {row.message ? ` — ${row.message}` : ''}
                    </span>
                    {!row.ok && row.worktreePath && row.branch && (
                      <button
                        disabled={adoptingId !== null}
                        onClick={() => void onAdoptRow(row)}
                        title={`Remove the worktree at ${row.worktreePath} and check out ${row.branch} here.`}
                        className="text-[11px] px-2 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
                      >
                        {adoptingId === row.repoId ? 'Adopting…' : 'Adopt & retry'}
                      </button>
                    )}
                    {!row.ok && row.label === 'dirty' && (
                      <button
                        disabled={stashingId !== null}
                        onClick={() => void onStashRow(row)}
                        title="Stash this repo's dirty changes, then retry sync + branch. Stash entry is preserved — pop it later from the Stash tab."
                        className="text-[11px] px-2 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
                      >
                        {stashingId === row.repoId ? 'Stashing…' : 'Stash & retry'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="text-[11px] text-ink-faint leading-snug">
              The workset is created and the branch is bound. Use the per-repo
              "Sync to <span className="font-mono">{branch.trim() || suggestedBranch}</span>"
              button on each row above (or "+ New branch" inside the workset)
              to bring drifted repos onto the branch.
            </div>
          </div>
        )}
        {phase.kind === 'form' && !showSync && (
          <>
            {!editing && (
              <div className="rounded border border-accent/30 bg-accent/5 px-3 py-2.5 text-[12px] text-ink-muted leading-snug">
                <div className="text-ink font-medium mb-0.5">What's a workset?</div>
                A unit of work across repos, bound to a branch. Pick the repos
                and name the branch — then branch, commit, and push them
                together. Archive when shipped.
              </div>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-ink-faint">Name</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. checkout-redesign, billing-migration, sso-rollout"
                className="field px-2 py-1.5 text-sm"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-ink-faint">Branch</span>
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder={suggestedBranch || 'e.g. feature/checkout-redesign'}
                className="field px-2 py-1.5 text-sm font-mono"
              />
              <span className="text-[11px] text-ink-faint">
                {editing
                  ? 'The branch this workset is bound to. Changes apply on save; member repos are not switched automatically — use "+ New branch" or per-row Sync.'
                  : 'On Create, every selected repo is moved to this branch using the option below.'}
                {!editing && !branch.trim() && suggestedBranch && (
                  <>
                    {' '}Empty saves as{' '}
                    <button
                      type="button"
                      onClick={() => setBranch(suggestedBranch)}
                      className="font-mono text-accent hover:underline"
                    >
                      {suggestedBranch}
                    </button>
                    .
                  </>
                )}
              </span>
            </label>

            {!editing && (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-xs uppercase tracking-wide text-ink-faint mb-1">
                  Branch from
                </legend>
                <BaseModeRadio
                  value="origin"
                  current={baseMode}
                  onPick={setBaseMode}
                  title="Latest origin/<default>"
                  subtitle="Recommended for new work — fetch, switch each repo to its default, pull, then create the branch off it."
                />
                <BaseModeRadio
                  value="current"
                  current={baseMode}
                  onPick={setBaseMode}
                  title="Each repo's current branch"
                  subtitle="Quick — create the branch from whatever each repo is on right now."
                />
                <BaseModeRadio
                  value="existing"
                  current={baseMode}
                  onPick={setBaseMode}
                  title="Existing branch (don't create)"
                  subtitle="Just check out — fail per-repo if the branch isn't there."
                />
              </fieldset>
            )}

            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs uppercase tracking-wide text-ink-faint">Repos</span>
                <span className="text-[11px] text-ink-faint">
                  {picked.size} of {repos.length} selected
                  {(repoFilter.trim() || showSelectedOnly) && (
                    <> · {visibleRepos.length} shown</>
                  )}
                </span>
              </div>
              {repos.length === 0 ? (
                <div className="text-xs text-ink-faint p-3 rounded border border-card bg-card">
                  Add a repo first — worksets are built from repos already in
                  overgit.
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <input
                      value={repoFilter}
                      onChange={(e) => setRepoFilter(e.target.value)}
                      placeholder="Filter by name or path…"
                      className="field text-xs px-2 py-1 flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSelectedOnly((v) => !v)}
                      disabled={picked.size === 0}
                      className={`text-[11px] px-2 py-1 rounded border ${
                        showSelectedOnly
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-card hover:bg-card'
                      } disabled:opacity-40`}
                      title="Show only currently-selected repos"
                    >
                      Selected ({picked.size})
                    </button>
                    {visibleRepos.length > 0 && (repoFilter.trim() || showSelectedOnly) && (
                      <button
                        type="button"
                        onClick={() => {
                          const allVisiblePicked = visibleRepos.every((r) => picked.has(r.id));
                          setPicked((cur) => {
                            const next = new Set(cur);
                            if (allVisiblePicked) {
                              for (const r of visibleRepos) next.delete(r.id);
                            } else {
                              for (const r of visibleRepos) next.add(r.id);
                            }
                            return next;
                          });
                        }}
                        className="text-[11px] px-2 py-1 rounded border border-card hover:bg-card"
                        title="Toggle every repo currently visible"
                      >
                        {visibleRepos.every((r) => picked.has(r.id)) ? 'Unselect all' : 'Select all'}
                      </button>
                    )}
                  </div>
                  {visibleRepos.length === 0 ? (
                    <div className="text-xs text-ink-faint p-3 rounded border border-card bg-card">
                      No repos match.
                    </div>
                  ) : (
                    <ul className="border border-card rounded overflow-hidden max-h-[40vh] overflow-y-auto">
                      {visibleRepos.map((r) => {
                        const isPicked = picked.has(r.id);
                        const previously = (editing?.repoIds ?? []).includes(r.id);
                        return (
                          <li key={r.id} className="border-b border-card last:border-0">
                            <RepoPickRow
                              repo={r}
                              picked={isPicked}
                              onToggle={() => toggle(r.id)}
                              tag={
                                isPicked && !previously && commonBranch
                                  ? `will sync to ${commonBranch}`
                                  : null
                              }
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
            </div>

            {editing && commonBranch && newlyAdded.length > 0 && (
              <div className="rounded border border-accent/40 bg-accent/10 px-3 py-2 text-[11px] text-ink">
                After saving, you'll be offered to sync the {newlyAdded.length}{' '}
                new {newlyAdded.length === 1 ? 'repo' : 'repos'} to{' '}
                <span className="font-mono">{commonBranch}</span> (fetch → switch
                default → pull → check out the workset branch).
              </div>
            )}
          </>
        )}
        {showSync && commonBranch && (
          <div className="flex flex-col gap-3">
            <div className="text-xs text-ink-muted">
              Workset common branch:{' '}
              <span className="font-mono text-ink">{commonBranch}</span>. Sync
              each new repo to bring it onto that branch off the latest default.
            </div>
            <ul className="flex flex-col gap-1.5">
              {newlyAdded.map((id) => {
                const r = reposById.get(id);
                const st = syncState[id] ?? { kind: 'idle' };
                return (
                  <SyncRow
                    key={id}
                    repoId={id}
                    repoName={r?.name ?? id}
                    repoPath={r?.path}
                    branch={commonBranch}
                    state={st}
                    onSync={() => runSyncFor(id)}
                  />
                );
              })}
            </ul>
          </div>
        )}
      </div>
      <div className="px-5 py-3 border-t border-card flex justify-end gap-2">
        {phase.kind === 'busy' && (
          <button
            disabled
            className="text-xs px-3 py-1.5 rounded border border-card text-ink-faint cursor-not-allowed"
          >
            Working…
          </button>
        )}
        {phase.kind === 'outcomes' && (
          <button
            onClick={() => setSheet(null)}
            className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong"
          >
            Done
          </button>
        )}
        {phase.kind === 'form' && !showSync && (
          <>
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
              {editing
                ? 'Save changes'
                : (branch.trim() || suggestedBranch)
                  ? baseMode === 'existing'
                    ? `Create & checkout ${branch.trim() || suggestedBranch}`
                    : `Create & branch ${branch.trim() || suggestedBranch}`
                  : 'Create workset'}
            </button>
          </>
        )}
        {showSync && (
          <>
            <button
              onClick={() => setSheet(null)}
              className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
            >
              Done
            </button>
            <button
              onClick={runSyncAll}
              disabled={newlyAdded.every(
                (id) => (syncState[id]?.kind ?? 'idle') !== 'idle',
              )}
              className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
            >
              Sync all
            </button>
          </>
        )}
      </div>
    </>
  );
}

/// New/Edit Workspace sheet. Much simpler than the Workset sheet —
/// a Workspace is just a durable grouping of repo IDs, no branch
/// binding, no archive lifecycle, no checkout flow on save.
function WorkspaceSheet({
  workspaceId,
}: { workspaceId?: UUID } = {}): JSX.Element {
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
  const [repoFilter, setRepoFilter] = useState('');
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);

  const visibleRepos = useMemo(() => {
    const q = repoFilter.trim().toLowerCase();
    let list = [...repos].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
    if (showSelectedOnly) list = list.filter((r) => picked.has(r.id));
    if (!q) return list;
    return list.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q),
    );
  }, [repos, repoFilter, showSelectedOnly, picked]);

  const toggle = (id: UUID) => {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || picked.size === 0 || busy) return;
    setBusy(true);
    try {
      if (editing) {
        await updateWorkspace(editing.id, {
          name: trimmed,
          repoIds: [...picked],
        });
      } else {
        await createWorkspace(trimmed, [...picked]);
      }
      setSheet(null);
    } finally {
      setBusy(false);
    }
  };

  const title = editing ? 'Edit workspace' : 'New workspace';
  const canSave = name.trim().length > 0 && picked.size > 0 && !busy;
  const hasFilter = repoFilter.trim().length > 0;
  const filteredOutSelected = hasFilter
    ? [...picked].filter((id) => !visibleRepos.some((r) => r.id === id)).length
    : 0;

  return (
    <>
      <SheetHeader title={title} onClose={() => setSheet(null)} />
      <div className="flex-1 min-h-0 p-5 flex flex-col gap-4 text-sm overflow-hidden">
        {!editing && (
          <div className="rounded border border-accent/30 bg-accent/5 px-3 py-2.5 text-[12px] text-ink-muted leading-snug">
            <div className="text-ink font-medium mb-0.5">What's a workspace?</div>
            A long-lived group of repos that belong together — an initiative,
            a client, an org. The sidebar folds them under one header so bulk
            actions like Reset all and Fetch all target the whole group.
            Repos can belong to more than one workspace.
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-faint">
            Name
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder="e.g. Platform, Acme Co., Personal"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSave) void onSave();
            }}
            className="field px-2 py-1.5 text-sm"
          />
        </label>

        <div className="flex flex-col gap-2 flex-1 min-h-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide text-ink-faint">
              Repos
            </span>
            <span className="text-[11px] text-ink-muted">
              <span className={picked.size > 0 ? 'text-accent' : ''}>
                {picked.size}
              </span>
              <span className="text-ink-faint"> / {repos.length} selected</span>
              {filteredOutSelected > 0 && (
                <span className="text-ink-faint">
                  {' '}
                  ({filteredOutSelected} hidden by filter)
                </span>
              )}
            </span>
            <input
              value={repoFilter}
              onChange={(e) => setRepoFilter(e.target.value)}
              placeholder="Filter by name or path…"
              className="field ml-auto px-2 py-1 text-xs w-56"
            />
            <button
              onClick={() => setShowSelectedOnly((v) => !v)}
              disabled={picked.size === 0 && !showSelectedOnly}
              className={`text-[10px] px-2 py-1 rounded transition-colors ${
                showSelectedOnly
                  ? 'text-accent bg-accent/10 hover:bg-accent/15'
                  : 'text-ink-faint hover:text-ink hover:bg-card disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-faint'
              }`}
            >
              Selected only
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto rounded bg-card/40">
            {visibleRepos.length === 0 ? (
              <div className="p-6 text-[11px] text-ink-faint text-center">
                {showSelectedOnly && picked.size === 0
                  ? 'No repos selected yet — click rows below to add them.'
                  : hasFilter
                    ? `No repos match “${repoFilter.trim()}”.`
                    : 'No repos available.'}
              </div>
            ) : (
              visibleRepos.map((r) => {
                const isPicked = picked.has(r.id);
                return (
                  <button
                    key={r.id}
                    onClick={() => toggle(r.id)}
                    disabled={busy}
                    title={r.path}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 text-left transition-colors relative ${
                      isPicked
                        ? 'bg-accent/[0.18] hover:bg-accent/[0.24] shadow-[inset_2px_0_0_var(--c-accent)]'
                        : 'hover:bg-card'
                    }`}
                  >
                    <input
                      type="checkbox"
                      readOnly
                      checked={isPicked}
                      className="pointer-events-none accent-accent"
                    />
                    <span
                      className={`truncate text-[12px] ${
                        isPicked ? 'text-ink font-medium' : 'text-ink-muted'
                      }`}
                    >
                      {r.name}
                    </span>
                    <span
                      className={`ml-auto truncate text-[10px] font-mono max-w-[55%] ${
                        isPicked ? 'text-ink-muted' : 'text-ink-faint'
                      }`}
                    >
                      {r.path}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div className="text-[10px] text-ink-faint">
            {picked.size === 0
              ? 'Pick at least one repo to create the workspace.'
              : `Ready: “${name.trim() || '…'}” will contain ${picked.size} repo${picked.size === 1 ? '' : 's'}.`}
          </div>
        </div>

        <div className="flex items-center gap-2 justify-end pt-1">
          <button
            onClick={() => setSheet(null)}
            disabled={busy}
            className="text-xs text-ink-muted hover:text-ink py-1.5 px-3 rounded hover:bg-card"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={!canSave}
            className="text-xs bg-accent text-white py-1.5 px-3 rounded hover:bg-accent/90 disabled:opacity-50"
          >
            {busy ? 'Saving…' : editing ? 'Save' : 'Create workspace'}
          </button>
        </div>
      </div>
    </>
  );
}

/// Live progress sheet for "Reset workspace to default". Owns the
/// per-repo loop in the renderer so each row updates as its single-
/// repo IPC settles. Concurrency-capped at 3 to match the backend's
/// batch helper — same network politeness, just visible.
function ResetWorkspaceProgressSheet({
  workspaceId,
  repoIds,
}: {
  workspaceId: UUID;
  repoIds: UUID[];
}): JSX.Element {
  const repos = useStore((s) => s.repos);
  const workspaces = useStore((s) => s.workspaces);
  const setSheet = useStore((s) => s.setSheet);
  const resetRepoToDefault = useStore((s) => s.resetRepoToDefault);
  const refreshAllRepoStatuses = useStore((s) => s.refreshAllRepoStatuses);
  const pushToast = useStore((s) => s.pushToast);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const reposById = useMemo(() => {
    const m = new Map<UUID, Repo>();
    for (const r of repos) m.set(r.id, r);
    return m;
  }, [repos]);

  type RowState =
    | { phase: 'pending' }
    | { phase: 'running' }
    | { phase: 'done'; outcome: WorksetResetOutcome };
  const [rows, setRows] = useState<Record<UUID, RowState>>(() => {
    const init: Record<UUID, RowState> = {};
    for (const id of repoIds) init[id] = { phase: 'pending' };
    return init;
  });
  const [allDone, setAllDone] = useState(false);
  /// Tracks whether the user closed the sheet mid-flight. We can't
  /// abort the in-flight IPC calls (each one is a sequence of git
  /// processes that already started), but we can stop scheduling
  /// new ones and avoid a toast for a flow the user walked away from.
  const cancelledRef = useRef(false);

  // Kick off the loop exactly once on mount. Closing the sheet flips
  // `cancelledRef` so the loop bails after the in-flight calls land.
  // NOTE: React StrictMode runs effects twice in dev (mount → cleanup
  // → mount), so we reset cancelledRef at the START of each effect
  // run. Without that, the first cleanup pinned cancelled=true and the
  // re-run's workers (or the in-flight IPCs from the first run) all
  // bailed silently — rows sat in 'running' forever.
  useEffect(() => {
    cancelledRef.current = false;
    if (repoIds.length === 0) {
      setAllDone(true);
      return;
    }
    let cursor = 0;
    const worker = async () => {
      while (true) {
        if (cancelledRef.current) return;
        const i = cursor++;
        if (i >= repoIds.length) return;
        const id = repoIds[i];
        setRows((prev) => ({ ...prev, [id]: { phase: 'running' } }));
        try {
          const outcome = await resetRepoToDefault(id);
          if (cancelledRef.current) return;
          setRows((prev) => ({
            ...prev,
            [id]: { phase: 'done', outcome },
          }));
        } catch (err) {
          if (cancelledRef.current) return;
          setRows((prev) => ({
            ...prev,
            [id]: {
              phase: 'done',
              outcome: {
                repoId: id,
                defaultBranch: null,
                result: 'pull-failed',
                message: err instanceof Error ? err.message : String(err),
              },
            },
          }));
        }
      }
    };
    const concurrency = Math.min(3, repoIds.length);
    Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
      if (cancelledRef.current) return;
      setAllDone(true);
      void refreshAllRepoStatuses();
    });
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoIds]);

  // Summary toast once the run finishes (and the user hasn't dismissed
  // the sheet yet — in that case the toast already isn't useful).
  useEffect(() => {
    if (!allDone) return;
    const wsName = workspace?.name ?? 'workspace';
    const outcomes = repoIds
      .map((id) => {
        const r = rows[id];
        return r && r.phase === 'done' ? r.outcome : null;
      })
      .filter((o): o is WorksetResetOutcome => o !== null);
    const failed = outcomes.filter((o) => o.result !== 'reset');
    if (failed.length === 0) {
      pushToast({
        kind: 'success',
        message: `All ${outcomes.length} ${outcomes.length === 1 ? 'repo is' : 'repos are'} on default in ${wsName}.`,
      });
    } else if (failed.length === outcomes.length) {
      pushToast({
        kind: 'error',
        message: `Reset failed for every repo in ${wsName}. See sheet for details.`,
      });
    } else {
      pushToast({
        kind: 'warn',
        message: `${outcomes.length - failed.length} reset, ${failed.length} skipped or failed in ${wsName}.`,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDone]);

  const counts = useMemo(() => {
    let pending = 0;
    let running = 0;
    let succeeded = 0;
    let dirty = 0;
    let failed = 0;
    for (const id of repoIds) {
      const r = rows[id];
      if (!r || r.phase === 'pending') pending++;
      else if (r.phase === 'running') running++;
      else if (r.outcome.result === 'reset') succeeded++;
      else if (
        r.outcome.result === 'dirty'
        || r.outcome.result === 'upstream-gone'
        || r.outcome.result === 'unpushed-commits'
      )
        dirty++;
      else failed++;
    }
    return { pending, running, succeeded, dirty, failed, total: repoIds.length };
  }, [rows, repoIds]);

  const onClose = () => {
    cancelledRef.current = true;
    setSheet(null);
  };

  /// Retry a single repo's reset in-place. `kind` decides what to
  /// do before the retry: stash dirty edits, re-detect the default
  /// branch from `origin/HEAD`, force past the unpushed-commits
  /// guard, or just retry as-is. The row animates through running
  /// → done like a fresh dispatch so the rendering stays uniform.
  const retryRow = async (
    id: UUID,
    kind: 'plain' | 'stash' | 'refresh-default' | 'force',
  ) => {
    setRows((prev) => ({ ...prev, [id]: { phase: 'running' } }));
    try {
      if (kind === 'stash') {
        const stashRes = await useStore.getState().stashRepo(id);
        if (!stashRes.ok) {
          setRows((prev) => ({
            ...prev,
            [id]: {
              phase: 'done',
              outcome: {
                repoId: id,
                defaultBranch: null,
                result: 'dirty',
                message: `Stash failed: ${stashRes.error ?? 'unknown error'}`,
              },
            },
          }));
          return;
        }
      } else if (kind === 'refresh-default') {
        const refresh = await useStore
          .getState()
          .refreshRepoDefaultBranch(id);
        if (!refresh.ok) {
          setRows((prev) => ({
            ...prev,
            [id]: {
              phase: 'done',
              outcome: {
                repoId: id,
                defaultBranch: null,
                result: 'upstream-gone',
                message: `Couldn't refresh origin/HEAD: ${refresh.error}`,
              },
            },
          }));
          return;
        }
      }
      const outcome = await resetRepoToDefault(id, kind === 'force');
      setRows((prev) => ({ ...prev, [id]: { phase: 'done', outcome } }));
    } catch (err) {
      setRows((prev) => ({
        ...prev,
        [id]: {
          phase: 'done',
          outcome: {
            repoId: id,
            defaultBranch: null,
            result: 'pull-failed',
            message: err instanceof Error ? err.message : String(err),
          },
        },
      }));
    }
  };

  const openRepoFromRow = (id: UUID) => {
    useStore.getState().selectRepo(id);
    setSheet(null);
  };

  return (
    <>
      <SheetHeader
        title={`Reset ${workspace?.name ?? 'workspace'} to default`}
        onClose={onClose}
      />
      <div className="flex-1 min-h-0 px-5 pt-4 pb-4 flex flex-col gap-4 text-sm overflow-hidden">
        <ProgressSummary counts={counts} allDone={allDone} />

        <div className="flex-1 min-h-0 overflow-y-auto rounded-md bg-black/10 ring-1 ring-white/[0.04]">
          {repoIds.map((id) => {
            const repo = reposById.get(id);
            const row = rows[id] ?? { phase: 'pending' as const };
            return (
              <ResetProgressRow
                key={id}
                name={repo?.name ?? id}
                path={repo?.path}
                row={row}
                onOpenRepo={() => openRepoFromRow(id)}
                onStashAndRetry={() => void retryRow(id, 'stash')}
                onRetry={() => void retryRow(id, 'plain')}
                onRefreshDefaultAndRetry={() =>
                  void retryRow(id, 'refresh-default')
                }
                onForceReset={() => void retryRow(id, 'force')}
              />
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-1">
          <div className="text-[11px] text-ink-faint">
            {allDone
              ? counts.dirty > 0
                ? `Finished. ${counts.dirty} ${counts.dirty === 1 ? 'repo needs' : 'repos need'} your attention — expand to review.`
                : 'Finished. Repos are back on their default branch where it succeeded.'
              : 'Running fetch → switch → pull on each repo. Dirty repos are skipped.'}
          </div>
          <button
            onClick={onClose}
            className={`text-xs py-1.5 px-3 rounded ${
              allDone
                ? 'bg-accent text-white hover:bg-accent/90'
                : 'text-ink-muted hover:text-ink hover:bg-white/[0.06]'
            }`}
          >
            {allDone ? 'Close' : 'Run in background'}
          </button>
        </div>
      </div>
    </>
  );
}

/// Header strip for the progress sheets — a continuous progress bar
/// on top of a compact "N of M · K running · K pending · K failed"
/// status line. Kept visual-only so both Reset and Fetch sheets share
/// the exact same affordance.
function ProgressSummary({
  counts,
  allDone,
}: {
  counts: {
    pending: number;
    running: number;
    succeeded: number;
    /// Rows that finished but need user attention before they can
    /// succeed — dirty trees, missing default branch, etc. Counted
    /// separately from `failed` so the user knows the difference
    /// between "this needs me" and "this is broken."
    dirty?: number;
    failed: number;
    total: number;
  };
  allDone: boolean;
}): JSX.Element {
  const dirty = counts.dirty ?? 0;
  const done = counts.succeeded + counts.failed + dirty;
  const pct = counts.total === 0 ? 0 : (done / counts.total) * 100;
  const barTone =
    counts.failed === 0 && dirty === 0
      ? 'bg-emerald-400/80'
      : counts.failed > 0 && counts.succeeded === 0 && dirty === 0
        ? 'bg-red-400/80'
        : 'bg-amber-400/80';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <span className="font-semibold text-ink tabular-nums text-[15px]">
          {done}
          <span className="text-ink-faint font-normal"> / {counts.total}</span>
        </span>
        <span className="text-[10px] uppercase tracking-wider text-ink-faint">
          {allDone ? 'Done' : 'In progress'}
        </span>
        <div className="ml-auto flex items-center gap-3 text-[11px] tabular-nums">
          {counts.running > 0 && (
            <span className="text-accent">{counts.running} running</span>
          )}
          {counts.pending > 0 && (
            <span className="text-ink-faint">{counts.pending} pending</span>
          )}
          {counts.succeeded > 0 && (
            <span className="text-emerald-700 dark:text-emerald-300/80">{counts.succeeded} ok</span>
          )}
          {dirty > 0 && (
            <span className="text-amber-700 dark:text-amber-300/90">{dirty} needs attention</span>
          )}
          {counts.failed > 0 && (
            <span className="text-red-700 dark:text-red-300/90">{counts.failed} failed</span>
          )}
        </div>
      </div>
      <div className="h-[3px] w-full rounded-full overflow-hidden bg-white/[0.06]">
        <div
          className={`h-full ${barTone} transition-[width] duration-300 ease-out`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/// Vertical color strip at the leading edge of a progress row.
/// Lets the user scan a 22-row list and instantly see which are
/// pending (muted), running (pulsing accent), succeeded (emerald),
/// or failed (red) without reading the status text on the right.
function StatusStrip({
  tone,
}: {
  tone: 'pending' | 'running' | 'success' | 'dirty' | 'fail';
}): JSX.Element {
  const cls =
    tone === 'pending'
      ? 'bg-white/[0.06]'
      : tone === 'running'
        ? 'bg-accent animate-pulse'
        : tone === 'success'
          ? 'bg-emerald-400/80'
          : tone === 'dirty'
            ? 'bg-amber-400/80'
            : 'bg-red-400/80';
  return <span className={`shrink-0 w-[3px] self-stretch rounded-sm ${cls}`} />;
}

function RowSpinner(): JSX.Element {
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
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function ResetProgressRow({
  name,
  path,
  row,
  onOpenRepo,
  onStashAndRetry,
  onRetry,
  onRefreshDefaultAndRetry,
  onForceReset,
}:
  {
    name: string;
    path?: string;
    row:
      | { phase: 'pending' }
      | { phase: 'running' }
      | { phase: 'done'; outcome: WorksetResetOutcome };
    onOpenRepo: () => void;
    onStashAndRetry: () => void;
    onRetry: () => void;
    onRefreshDefaultAndRetry: () => void;
    onForceReset: () => void;
  }): JSX.Element {
  const outcome =
    row.phase === 'done' ? row.outcome : null;
  const result = outcome?.result;
  const isDirty = result === 'dirty';
  const isUpstreamGone = result === 'upstream-gone';
  const isUnpushed = result === 'unpushed-commits';
  const isOtherFailure =
    result !== undefined
    && result !== 'reset'
    && !isDirty
    && !isUpstreamGone
    && !isUnpushed;
  const tone =
    row.phase === 'pending'
      ? 'pending'
      : row.phase === 'running'
        ? 'running'
        : result === 'reset'
          ? 'success'
          : isDirty || isUpstreamGone || isUnpushed
            ? 'dirty'
            : 'fail';
  const failedMessage = isOtherFailure ? outcome!.message?.trim() || null : null;
  const dirtyMessage = isDirty ? outcome!.message?.trim() || null : null;
  const dirtyPaths = isDirty ? outcome!.dirtyPaths ?? [] : [];
  const upstreamMessage = isUpstreamGone
    ? outcome!.message?.trim() || null
    : null;
  const staleRef = isUpstreamGone ? outcome!.staleRef : undefined;
  const unpushedMessage = isUnpushed
    ? outcome!.message?.trim() || null
    : null;
  const unpushedCount = isUnpushed ? outcome!.unpushedCount ?? 0 : 0;
  // Click-to-expand reveals: the git stderr for plain failures, the
  // dirty file list + actions for dirty, the stale ref + heal action
  // for upstream-gone, the unpushed-commit count + force action for
  // unpushed-commits.
  const [expanded, setExpanded] = useState(false);
  const canExpand =
    isDirty || isUpstreamGone || isUnpushed || failedMessage !== null;
  const stopRowClick = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div
      className={`flex items-stretch gap-2.5 pl-0 pr-3 py-1.5 transition-colors text-[12px] ${
        canExpand ? 'cursor-pointer hover:bg-white/[0.03]' : 'hover:bg-white/[0.02]'
      }`}
      onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
    >
      <StatusStrip tone={tone} />
      <div className="flex-1 min-w-0 flex flex-col gap-1.5 py-0.5">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="truncate text-ink leading-tight">{name}</div>
            {path && (
              <div className="truncate text-[10px] text-ink-faint/80 font-mono leading-tight mt-0.5">
                {path}
              </div>
            )}
          </div>
          <ResetRowStatus row={row} expanded={expanded} canExpand={canExpand} />
        </div>
        {expanded && isDirty && (
          <div className="flex flex-col gap-2 text-[11px] bg-amber-950/20 border border-amber-900/30 rounded px-2.5 py-2">
            {dirtyMessage && (
              <div className="text-amber-200/90">{dirtyMessage}</div>
            )}
            {dirtyPaths.length > 0 && (
              <div className="flex flex-col gap-0.5 max-h-32 overflow-y-auto font-mono text-[10.5px] text-ink-muted">
                {dirtyPaths.map((p) => (
                  <div key={p} className="truncate">{p}</div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1.5" onClick={stopRowClick}>
              <button
                onClick={onOpenRepo}
                className="text-[11px] px-2 py-1 rounded border border-card text-ink-muted hover:text-ink hover:bg-white/[0.06]"
              >
                Open repo
              </button>
              <button
                onClick={onStashAndRetry}
                className="text-[11px] px-2 py-1 rounded bg-accent/80 text-white hover:bg-accent"
              >
                Stash &amp; retry
              </button>
              <button
                onClick={onRetry}
                className="text-[11px] px-2 py-1 rounded border border-card text-ink-muted hover:text-ink hover:bg-white/[0.06]"
              >
                Retry
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(false);
                }}
                className="ml-auto text-[11px] px-2 py-1 rounded text-ink-faint hover:text-ink hover:bg-white/[0.06]"
              >
                Skip
              </button>
            </div>
          </div>
        )}
        {expanded && isUpstreamGone && (
          <div className="flex flex-col gap-2 text-[11px] bg-amber-950/20 border border-amber-900/30 rounded px-2.5 py-2">
            <div className="text-amber-200/90">
              {upstreamMessage ?? 'The branch is tracking a remote ref that no longer exists.'}
            </div>
            {staleRef && (
              <div className="font-mono text-[10.5px] text-ink-muted truncate">
                {staleRef}
              </div>
            )}
            <div className="text-[10.5px] text-ink-faint leading-snug">
              Re-detect runs <span className="font-mono">git remote set-head origin --auto</span>
              {' '}and saves the new default to overgit, then retries the reset.
            </div>
            <div className="flex items-center gap-1.5" onClick={stopRowClick}>
              <button
                onClick={onOpenRepo}
                className="text-[11px] px-2 py-1 rounded border border-card text-ink-muted hover:text-ink hover:bg-white/[0.06]"
              >
                Open repo
              </button>
              <button
                onClick={onRefreshDefaultAndRetry}
                className="text-[11px] px-2 py-1 rounded bg-accent/80 text-white hover:bg-accent"
              >
                Re-detect default &amp; retry
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(false);
                }}
                className="ml-auto text-[11px] px-2 py-1 rounded text-ink-faint hover:text-ink hover:bg-white/[0.06]"
              >
                Skip
              </button>
            </div>
          </div>
        )}
        {expanded && isUnpushed && (
          <div className="flex flex-col gap-2 text-[11px] bg-amber-950/20 border border-amber-900/30 rounded px-2.5 py-2">
            <div className="text-amber-200/90">
              {unpushedMessage ?? `${unpushedCount} unpushed commits on the default branch.`}
            </div>
            <div className="text-[10.5px] text-ink-faint leading-snug">
              Force reset hard-resets the local default to{' '}
              <span className="font-mono">origin/&lt;default&gt;</span> —
              those {unpushedCount === 1 ? 'commit' : 'commits'} will become
              unreachable (still recoverable via reflog for ~90 days).
            </div>
            <div className="flex items-center gap-1.5" onClick={stopRowClick}>
              <button
                onClick={onOpenRepo}
                className="text-[11px] px-2 py-1 rounded border border-card text-ink-muted hover:text-ink hover:bg-white/[0.06]"
              >
                Open repo
              </button>
              <button
                onClick={onForceReset}
                className="text-[11px] px-2 py-1 rounded bg-red-500/80 text-white hover:bg-red-500"
              >
                Force reset (lose {unpushedCount})
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(false);
                }}
                className="ml-auto text-[11px] px-2 py-1 rounded text-ink-faint hover:text-ink hover:bg-white/[0.06]"
              >
                Skip
              </button>
            </div>
          </div>
        )}
        {expanded && !isDirty && !isUpstreamGone && !isUnpushed && failedMessage && (
          <pre className="whitespace-pre-wrap break-words text-[11px] text-red-200/90 bg-red-950/30 border border-red-900/40 rounded px-2 py-1.5 font-mono leading-snug max-h-48 overflow-y-auto select-text">
            {failedMessage}
          </pre>
        )}
      </div>
    </div>
  );
}

function ResetRowStatus({
  row,
  expanded,
  canExpand,
}: {
  row:
    | { phase: 'pending' }
    | { phase: 'running' }
    | { phase: 'done'; outcome: WorksetResetOutcome };
  expanded?: boolean;
  canExpand?: boolean;
}): JSX.Element {
  if (row.phase === 'pending') {
    return (
      <span className="text-[11px] text-ink-faint/70 tabular-nums">Pending</span>
    );
  }
  if (row.phase === 'running') {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-accent">
        <RowSpinner />
        <RunningElapsed verb="Resetting" />
      </span>
    );
  }
  const o = row.outcome;
  if (o.result === 'reset') {
    return (
      <span className="text-[11px] text-emerald-700 dark:text-emerald-300/90">
        on <span className="font-mono">{o.defaultBranch ?? 'default'}</span>
      </span>
    );
  }
  if (o.result === 'dirty') {
    const count = o.dirtyPaths?.length ?? 0;
    const label =
      count > 0
        ? `Dirty — ${count} ${count === 1 ? 'file' : 'files'}`
        : 'Dirty';
    return (
      <span className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300/90 max-w-[280px]">
        <span className="truncate">{label}</span>
        {canExpand && (
          <span
            className="text-ink-faint/70 font-mono shrink-0"
            aria-hidden="true"
          >
            {expanded ? '▾' : '▸'}
          </span>
        )}
      </span>
    );
  }
  if (o.result === 'upstream-gone') {
    return (
      <span className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300/90 max-w-[280px]">
        <span className="truncate">Upstream gone</span>
        {canExpand && (
          <span
            className="text-ink-faint/70 font-mono shrink-0"
            aria-hidden="true"
          >
            {expanded ? '▾' : '▸'}
          </span>
        )}
      </span>
    );
  }
  if (o.result === 'unpushed-commits') {
    const n = o.unpushedCount ?? 0;
    return (
      <span className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300/90 max-w-[280px]">
        <span className="truncate">
          {n} unpushed {n === 1 ? 'commit' : 'commits'}
        </span>
        {canExpand && (
          <span
            className="text-ink-faint/70 font-mono shrink-0"
            aria-hidden="true"
          >
            {expanded ? '▾' : '▸'}
          </span>
        )}
      </span>
    );
  }
  const label =
    o.result === 'no-default-branch'
      ? 'No default branch'
      : o.result === 'fetch-failed'
        ? 'Fetch failed'
        : o.result === 'switch-failed'
          ? 'Switch failed'
          : o.result === 'pull-failed'
            ? 'Pull failed'
            : o.result;
  return (
    <span className="flex items-center gap-1 text-[11px] text-red-700 dark:text-red-300/90 max-w-[280px]">
      <span className="truncate">{label}</span>
      {canExpand && (
        <span
          className="text-ink-faint/70 font-mono shrink-0"
          aria-hidden="true"
        >
          {expanded ? '▾' : '▸'}
        </span>
      )}
    </span>
  );
}

/// Live elapsed counter for a running row. Stays hidden under 2s
/// (clutter for short fetches) and ticks every second afterwards so
/// the user knows the row is still working when a remote is slow.
function RunningElapsed({ verb }: { verb: string }): JSX.Element {
  const start = useRef(Date.now());
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const seconds = Math.floor((Date.now() - start.current) / 1000);
  return (
    <span>
      {verb}…
      {seconds >= 2 && (
        <span className="text-ink-faint/80 ml-1 tabular-nums">({seconds}s)</span>
      )}
    </span>
  );
}

/// Live progress sheet for "Fetch all in workspace". Same shape as
/// the Reset sheet — renderer drives one `repo:fetch` per row,
/// concurrency-capped at 3.
function FetchWorkspaceProgressSheet({
  workspaceId,
  repoIds,
}: {
  workspaceId: UUID;
  repoIds: UUID[];
}): JSX.Element {
  const repos = useStore((s) => s.repos);
  const workspaces = useStore((s) => s.workspaces);
  const setSheet = useStore((s) => s.setSheet);
  const fetchRepo = useStore((s) => s.fetchRepo);
  const refreshAllRepoStatuses = useStore((s) => s.refreshAllRepoStatuses);
  const pushToast = useStore((s) => s.pushToast);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const reposById = useMemo(() => {
    const m = new Map<UUID, Repo>();
    for (const r of repos) m.set(r.id, r);
    return m;
  }, [repos]);

  type FetchOutcome = { ok: boolean; error?: string };
  type RowState =
    | { phase: 'pending' }
    | { phase: 'running' }
    | { phase: 'done'; outcome: FetchOutcome };
  const [rows, setRows] = useState<Record<UUID, RowState>>(() => {
    const init: Record<UUID, RowState> = {};
    for (const id of repoIds) init[id] = { phase: 'pending' };
    return init;
  });
  const [allDone, setAllDone] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    // See the Reset sheet for the StrictMode story — same fix:
    // reset cancelled at the start of every effect run so the
    // dev-mode cleanup doesn't permanently mute the workers.
    cancelledRef.current = false;
    if (repoIds.length === 0) {
      setAllDone(true);
      return;
    }
    let cursor = 0;
    const worker = async () => {
      while (true) {
        if (cancelledRef.current) return;
        const i = cursor++;
        if (i >= repoIds.length) return;
        const id = repoIds[i];
        setRows((prev) => ({ ...prev, [id]: { phase: 'running' } }));
        try {
          const res = await fetchRepo(id);
          if (cancelledRef.current) return;
          setRows((prev) => ({
            ...prev,
            [id]: { phase: 'done', outcome: { ok: res.ok, error: res.error } },
          }));
        } catch (err) {
          if (cancelledRef.current) return;
          setRows((prev) => ({
            ...prev,
            [id]: {
              phase: 'done',
              outcome: {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
            },
          }));
        }
      }
    };
    // Fetch is read-only on the local working tree, so we can push
    // concurrency higher than reset (which serializes per-repo
    // fetch → switch → pull). Six in flight cuts wall-clock for a
    // 22-repo workspace from ~7 batches to ~4 without putting too
    // much pressure on credential helpers or remote rate limits.
    const concurrency = Math.min(6, repoIds.length);
    Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
      if (cancelledRef.current) return;
      setAllDone(true);
      void refreshAllRepoStatuses();
    });
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoIds]);

  useEffect(() => {
    if (!allDone) return;
    const wsName = workspace?.name ?? 'workspace';
    const outcomes = repoIds
      .map((id) => (rows[id]?.phase === 'done' ? rows[id] : null))
      .filter((r): r is { phase: 'done'; outcome: FetchOutcome } => r !== null)
      .map((r) => r.outcome);
    const failed = outcomes.filter((o) => !o.ok);
    if (failed.length === 0) {
      pushToast({
        kind: 'success',
        message: `Fetched ${outcomes.length} ${outcomes.length === 1 ? 'repo' : 'repos'} in ${wsName}.`,
      });
    } else if (failed.length === outcomes.length) {
      pushToast({
        kind: 'error',
        message: `Fetch failed for every repo in ${wsName}. See sheet for details.`,
      });
    } else {
      pushToast({
        kind: 'warn',
        message: `${outcomes.length - failed.length} fetched, ${failed.length} failed in ${wsName}.`,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDone]);

  const counts = useMemo(() => {
    let pending = 0;
    let running = 0;
    let succeeded = 0;
    let failed = 0;
    for (const id of repoIds) {
      const r = rows[id];
      if (!r || r.phase === 'pending') pending++;
      else if (r.phase === 'running') running++;
      else if (r.outcome.ok) succeeded++;
      else failed++;
    }
    return { pending, running, succeeded, failed, total: repoIds.length };
  }, [rows, repoIds]);

  const onClose = () => {
    cancelledRef.current = true;
    setSheet(null);
  };

  return (
    <>
      <SheetHeader
        title={`Fetch ${workspace?.name ?? 'workspace'}`}
        onClose={onClose}
      />
      <div className="flex-1 min-h-0 px-5 pt-4 pb-4 flex flex-col gap-4 text-sm overflow-hidden">
        <ProgressSummary counts={counts} allDone={allDone} />

        <div className="flex-1 min-h-0 overflow-y-auto rounded-md bg-black/10 ring-1 ring-white/[0.04]">
          {repoIds.map((id) => {
            const repo = reposById.get(id);
            const row = rows[id] ?? { phase: 'pending' as const };
            return (
              <FetchProgressRow
                key={id}
                name={repo?.name ?? id}
                path={repo?.path}
                row={row}
              />
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-1">
          <div className="text-[11px] text-ink-faint">
            {allDone
              ? 'Finished. Sidebar ahead/behind dots now reflect the latest remote refs.'
              : 'Running git fetch on each repo. Six in flight at a time.'}
          </div>
          <button
            onClick={onClose}
            className={`text-xs py-1.5 px-3 rounded ${
              allDone
                ? 'bg-accent text-white hover:bg-accent/90'
                : 'text-ink-muted hover:text-ink hover:bg-white/[0.06]'
            }`}
          >
            {allDone ? 'Close' : 'Run in background'}
          </button>
        </div>
      </div>
    </>
  );
}

function FetchProgressRow({
  name,
  path,
  row,
}:
  {
    name: string;
    path?: string;
    row:
      | { phase: 'pending' }
      | { phase: 'running' }
      | { phase: 'done'; outcome: { ok: boolean; error?: string } };
  }): JSX.Element {
  const tone =
    row.phase === 'pending'
      ? 'pending'
      : row.phase === 'running'
        ? 'running'
        : row.outcome.ok
          ? 'success'
          : 'fail';
  const failedMessage =
    row.phase === 'done' && !row.outcome.ok
      ? row.outcome.error?.trim() || 'Fetch failed'
      : null;
  const [expanded, setExpanded] = useState(false);
  const canExpand = failedMessage !== null;
  let status: JSX.Element;
  if (row.phase === 'pending') {
    status = (
      <span className="text-[11px] text-ink-faint/70 tabular-nums">Pending</span>
    );
  } else if (row.phase === 'running') {
    status = (
      <span className="flex items-center gap-1.5 text-[11px] text-accent">
        <RowSpinner />
        <RunningElapsed verb="Fetching" />
      </span>
    );
  } else if (row.outcome.ok) {
    status = <span className="text-[11px] text-emerald-700 dark:text-emerald-300/90">Fetched</span>;
  } else {
    status = (
      <span className="flex items-center gap-1 text-[11px] text-red-700 dark:text-red-300/90 max-w-[280px]">
        <span className="truncate">Fetch failed</span>
        <span className="text-ink-faint/70 font-mono shrink-0" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </span>
    );
  }
  return (
    <div
      className={`flex items-stretch gap-2.5 pl-0 pr-3 py-1.5 transition-colors text-[12px] ${
        canExpand ? 'cursor-pointer hover:bg-white/[0.03]' : 'hover:bg-white/[0.02]'
      }`}
      onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
    >
      <StatusStrip tone={tone} />
      <div className="flex-1 min-w-0 flex flex-col gap-1.5 py-0.5">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="truncate text-ink leading-tight">{name}</div>
            {path && (
              <div className="truncate text-[10px] text-ink-faint/80 font-mono leading-tight mt-0.5">
                {path}
              </div>
            )}
          </div>
          <div className="shrink-0 flex items-center gap-2">{status}</div>
        </div>
        {expanded && failedMessage && (
          <pre className="whitespace-pre-wrap break-words text-[11px] text-red-200/90 bg-red-950/30 border border-red-900/40 rounded px-2 py-1.5 font-mono leading-snug max-h-48 overflow-y-auto select-text">
            {failedMessage}
          </pre>
        )}
      </div>
    </div>
  );
}

/// Live progress sheet for "Sync N behind" on the workspace detail
/// page. Drives a per-row `repo:fastForward` loop and surfaces three
/// outcomes: synced (fast-forwarded), up-to-date (nothing to do —
/// behind count was stale), or diverged/failed (needs attention).
function SyncBehindProgressSheet({
  workspaceId,
  repoIds,
}: {
  workspaceId: UUID;
  repoIds: UUID[];
}): JSX.Element {
  const repos = useStore((s) => s.repos);
  const workspaces = useStore((s) => s.workspaces);
  const setSheet = useStore((s) => s.setSheet);
  const fastForwardRepo = useStore((s) => s.fastForwardRepo);
  const refreshAllRepoStatuses = useStore((s) => s.refreshAllRepoStatuses);
  const pushToast = useStore((s) => s.pushToast);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const reposById = useMemo(() => {
    const m = new Map<UUID, Repo>();
    for (const r of repos) m.set(r.id, r);
    return m;
  }, [repos]);

  type SyncOutcome = {
    ok: boolean;
    error?: string;
    alreadyUpToDate?: boolean;
    diverged?: boolean;
  };
  type RowState =
    | { phase: 'pending' }
    | { phase: 'running' }
    | { phase: 'done'; outcome: SyncOutcome };
  const [rows, setRows] = useState<Record<UUID, RowState>>(() => {
    const init: Record<UUID, RowState> = {};
    for (const id of repoIds) init[id] = { phase: 'pending' };
    return init;
  });
  const [allDone, setAllDone] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    // See the Reset sheet for the StrictMode story — reset cancelled
    // at the start of every effect run so the dev-mode cleanup
    // doesn't permanently mute the workers.
    cancelledRef.current = false;
    if (repoIds.length === 0) {
      setAllDone(true);
      return;
    }
    let cursor = 0;
    const worker = async () => {
      while (true) {
        if (cancelledRef.current) return;
        const i = cursor++;
        if (i >= repoIds.length) return;
        const id = repoIds[i];
        setRows((prev) => ({ ...prev, [id]: { phase: 'running' } }));
        try {
          const res = await fastForwardRepo(id);
          if (cancelledRef.current) return;
          setRows((prev) => ({
            ...prev,
            [id]: { phase: 'done', outcome: res },
          }));
        } catch (err) {
          if (cancelledRef.current) return;
          setRows((prev) => ({
            ...prev,
            [id]: {
              phase: 'done',
              outcome: {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
            },
          }));
        }
      }
    };
    const concurrency = Math.min(4, repoIds.length);
    Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
      if (cancelledRef.current) return;
      setAllDone(true);
      void refreshAllRepoStatuses();
    });
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoIds]);

  useEffect(() => {
    if (!allDone) return;
    const wsName = workspace?.name ?? 'workspace';
    const outcomes = repoIds
      .map((id) => (rows[id]?.phase === 'done' ? rows[id] : null))
      .filter((r): r is { phase: 'done'; outcome: SyncOutcome } => r !== null)
      .map((r) => r.outcome);
    const failed = outcomes.filter((o) => !o.ok);
    if (failed.length === 0) {
      pushToast({
        kind: 'success',
        message: `Synced ${outcomes.length} ${outcomes.length === 1 ? 'repo' : 'repos'} in ${wsName}.`,
      });
    } else if (failed.length === outcomes.length) {
      pushToast({
        kind: 'error',
        message: `Sync failed for every repo in ${wsName}. See sheet for details.`,
      });
    } else {
      pushToast({
        kind: 'warn',
        message: `${outcomes.length - failed.length} synced, ${failed.length} need attention in ${wsName}.`,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDone]);

  const counts = useMemo(() => {
    let pending = 0;
    let running = 0;
    let succeeded = 0;
    let dirty = 0;
    let failed = 0;
    for (const id of repoIds) {
      const r = rows[id];
      if (!r || r.phase === 'pending') pending++;
      else if (r.phase === 'running') running++;
      else if (r.outcome.ok) succeeded++;
      else if (r.outcome.diverged) dirty++;
      else failed++;
    }
    return { pending, running, succeeded, dirty, failed, total: repoIds.length };
  }, [rows, repoIds]);

  const onClose = () => {
    cancelledRef.current = true;
    setSheet(null);
  };

  return (
    <>
      <SheetHeader
        title={`Sync ${workspace?.name ?? 'workspace'}`}
        onClose={onClose}
      />
      <div className="flex-1 min-h-0 px-5 pt-4 pb-4 flex flex-col gap-4 text-sm overflow-hidden">
        <ProgressSummary counts={counts} allDone={allDone} />

        <div className="flex-1 min-h-0 overflow-y-auto rounded-md bg-black/10 ring-1 ring-white/[0.04]">
          {repoIds.map((id) => {
            const repo = reposById.get(id);
            const row = rows[id] ?? { phase: 'pending' as const };
            return (
              <SyncProgressRow
                key={id}
                name={repo?.name ?? id}
                path={repo?.path}
                row={row}
              />
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-1">
          <div className="text-[11px] text-ink-faint">
            {allDone
              ? 'Finished. Repos with diverged or dirty trees were skipped — expand to see why.'
              : 'Running git pull --ff-only on each behind repo. Diverged branches refuse the sync.'}
          </div>
          <button
            onClick={onClose}
            className={`text-xs py-1.5 px-3 rounded ${
              allDone
                ? 'bg-accent text-white hover:bg-accent/90'
                : 'text-ink-muted hover:text-ink hover:bg-white/[0.06]'
            }`}
          >
            {allDone ? 'Close' : 'Run in background'}
          </button>
        </div>
      </div>
    </>
  );
}

function SyncProgressRow({
  name,
  path,
  row,
}: {
  name: string;
  path?: string;
  row:
    | { phase: 'pending' }
    | { phase: 'running' }
    | {
        phase: 'done';
        outcome: {
          ok: boolean;
          error?: string;
          alreadyUpToDate?: boolean;
          diverged?: boolean;
        };
      };
}): JSX.Element {
  const tone =
    row.phase === 'pending'
      ? 'pending'
      : row.phase === 'running'
        ? 'running'
        : row.outcome.ok
          ? 'success'
          : row.outcome.diverged
            ? 'dirty'
            : 'fail';
  const failedMessage =
    row.phase === 'done' && !row.outcome.ok
      ? row.outcome.error?.trim() || 'Sync failed'
      : null;
  const [expanded, setExpanded] = useState(false);
  const canExpand = failedMessage !== null;
  let status: JSX.Element;
  if (row.phase === 'pending') {
    status = (
      <span className="text-[11px] text-ink-faint/70 tabular-nums">Pending</span>
    );
  } else if (row.phase === 'running') {
    status = (
      <span className="flex items-center gap-1.5 text-[11px] text-accent">
        <RowSpinner />
        <RunningElapsed verb="Syncing" />
      </span>
    );
  } else if (row.outcome.ok) {
    status = (
      <span className="text-[11px] text-emerald-300/90">
        {row.outcome.alreadyUpToDate ? 'Up to date' : 'Synced'}
      </span>
    );
  } else if (row.outcome.diverged) {
    status = (
      <span className="flex items-center gap-1 text-[11px] text-amber-300/90 max-w-[280px]">
        <span className="truncate">Diverged</span>
        {canExpand && (
          <span className="text-ink-faint/70 font-mono shrink-0" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        )}
      </span>
    );
  } else {
    status = (
      <span className="flex items-center gap-1 text-[11px] text-red-300/90 max-w-[280px]">
        <span className="truncate">Sync failed</span>
        <span className="text-ink-faint/70 font-mono shrink-0" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </span>
    );
  }
  return (
    <div
      className={`flex items-stretch gap-2.5 pl-0 pr-3 py-1.5 transition-colors text-[12px] ${
        canExpand ? 'cursor-pointer hover:bg-white/[0.03]' : 'hover:bg-white/[0.02]'
      }`}
      onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
    >
      <StatusStrip tone={tone} />
      <div className="flex-1 min-w-0 flex flex-col gap-1.5 py-0.5">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="truncate text-ink leading-tight">{name}</div>
            {path && (
              <div className="truncate text-[10px] text-ink-faint/80 font-mono leading-tight mt-0.5">
                {path}
              </div>
            )}
          </div>
          <div className="shrink-0 flex items-center gap-2">{status}</div>
        </div>
        {expanded && failedMessage && (
          <pre className="whitespace-pre-wrap break-words text-[11px] text-red-200/90 bg-red-950/30 border border-red-900/40 rounded px-2 py-1.5 font-mono leading-snug max-h-48 overflow-y-auto select-text">
            {failedMessage}
          </pre>
        )}
      </div>
    </div>
  );
}

function BaseModeRadio<V extends string>({
  value,
  current,
  onPick,
  title,
  subtitle,
}: {
  value: V;
  current: V;
  onPick: (v: V) => void;
  title: string;
  subtitle: string;
}): JSX.Element {
  const selected = current === value;
  return (
    <button
      type="button"
      onClick={() => onPick(value)}
      className={`text-left rounded border px-3 py-2 transition-colors ${
        selected
          ? 'border-accent/60 bg-accent/10'
          : 'border-card bg-card hover:border-accent/30'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`flex items-center justify-center w-4 h-4 rounded-full border-2 shrink-0 ${
            selected ? 'border-accent' : 'border-ink-faint'
          }`}
        >
          {selected && <span className="w-2 h-2 rounded-full bg-accent" />}
        </span>
        <span className={`text-xs font-medium ${selected ? 'text-ink' : 'text-ink-muted'}`}>
          {title}
        </span>
      </div>
      <div className="mt-0.5 ml-6 text-[11px] text-ink-faint leading-snug">
        {subtitle}
      </div>
    </button>
  );
}

/// One row of the post-edit sync panel. When the sync result is `dirty`,
/// surfaces Stash & retry / Commit & retry inline so the user can resolve
/// the offending working tree without leaving the sheet — same pattern
/// as `CheckoutOutcomeRow` for the Resume flow. Owns its own commit
/// composer / busy state so a slow stash on one repo doesn't lock up the
/// rest of the panel.
type SyncRowState =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'done'; outcome: SyncAndBranchOutcome | { result: 'unknown-repo' } };

function SyncRow({
  repoId,
  repoName,
  repoPath,
  branch,
  state,
  onSync,
}: {
  repoId: UUID;
  repoName: string;
  repoPath: string | undefined;
  branch: string;
  state: SyncRowState;
  onSync: () => Promise<void> | void;
}): JSX.Element {
  const stash = useStore((s) => s.stashRepo);
  const commitAll = useStore((s) => s.commitAllRepo);
  const pushToast = useStore((s) => s.pushToast);

  const [showCommit, setShowCommit] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const isDirty =
    state.kind === 'done' &&
    'result' in state.outcome &&
    state.outcome.result === 'dirty';

  const onStash = async () => {
    setBusy(true);
    try {
      const res = await stash(repoId);
      if (!res.ok) {
        pushToast({ kind: 'error', message: res.error ?? 'Stash failed' });
        return;
      }
      await onSync();
    } finally {
      setBusy(false);
    }
  };

  const onCommit = async () => {
    if (!message.trim()) return;
    setBusy(true);
    try {
      const res = await commitAll(repoId, message.trim());
      if (!res.ok) {
        pushToast({ kind: 'error', message: res.error ?? 'Commit failed' });
        return;
      }
      setShowCommit(false);
      setMessage('');
      await onSync();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-1.5 px-3 py-2 rounded border border-card bg-card">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{repoName}</div>
          {repoPath && (
            <div className="text-[11px] text-ink-faint truncate font-mono">{repoPath}</div>
          )}
        </div>
        {state.kind === 'idle' && (
          <button
            onClick={() => void onSync()}
            className="text-[11px] px-2 py-1 rounded border border-card hover:bg-card"
          >
            Sync to {branch}
          </button>
        )}
        {state.kind === 'syncing' && (
          <span className="text-[11px] text-ink-faint">syncing…</span>
        )}
        {state.kind === 'done' && <SyncOutcomeBadge outcome={state.outcome} />}
      </div>
      {isDirty && !showCommit && (
        <div className="flex gap-1 ml-1 text-[11px]">
          <button
            disabled={busy}
            onClick={onStash}
            className="px-2 py-0.5 rounded border border-card hover:bg-card disabled:opacity-50"
          >
            {busy ? 'Stashing…' : 'Stash & retry'}
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
      {isDirty && showCommit && (
        <div className="flex gap-1 ml-1">
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
            {busy ? 'Committing…' : 'Commit'}
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

function SyncOutcomeBadge({
  outcome,
}: {
  outcome: SyncAndBranchOutcome | { result: 'unknown-repo' };
}): JSX.Element {
  const result = outcome.result;
  const tone =
    result === 'created'
      ? 'text-emerald-400'
      : result === 'no-default-branch'
        ? 'text-amber-400'
        : 'text-red-400';
  const message = 'message' in outcome ? outcome.message : undefined;
  return (
    <span
      className={`text-[11px] font-mono ${tone} max-w-[260px] truncate`}
      title={message ?? result}
    >
      {result}
      {message ? ` — ${message}` : ''}
    </span>
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

export function ReviewBody({ result }: { result: ReviewResult }): JSX.Element {
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

/// Surfaces a blocked-pull error with a clear path forward instead of
/// dumping git's wall of stderr into an alert. Two recovery options:
///   Stash & retry    → save the listed paths to a named stash, then
///                      pull. The stash stays around for later pop.
///   Discard & retry  → reset the listed paths to HEAD, then pull.
///                      Destructive (local changes are lost), so the
///                      button is red and confirms the file count.
/// Last-resort recovery sheet. The user committed (or has dirty work)
/// on a branch they can't push to and just wants to "go back to what's
/// on the server." We model that as a fetch + hard-reset to upstream,
/// with two safety nets:
///   1. Always offer to spin a `backup/…` branch off HEAD *before* the
///      reset, so the abandoned commits stay reachable as a normal
///      branch rather than relying on the reflog.
///   2. If an LLM CLI is installed, expose a "Suggest with AI" button
///      that proposes a meaningful backup-branch name (and one-line
///      summary) from the unpushed log + dirty tree.
/// The Reset button is gated behind an explicit destructive confirm —
/// this is the most dangerous action overgit ships, so it gets the
/// most signal before we actually run it.
function AbandonLocalSheet({ repoId }: { repoId: UUID }): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId));
  const status = useStore((s) => s.repoStatus[repoId]);
  const cli = useStore((s) => s.cliPresence);
  const pushToast = useStore((s) => s.pushToast);
  const requestConfirm = useStore((s) => s.requestConfirm);
  const refreshRepoStatus = useStore((s) => s.refreshRepoStatus);
  const refreshRepoLog = useStore((s) => s.refreshRepoLog);
  const refreshRepoChanges = useStore((s) => s.refreshRepoChanges);
  const refreshRepoBranches = useStore((s) => s.refreshRepoBranches);
  const refreshRepoBranchSummaries = useStore((s) => s.refreshRepoBranchSummaries);
  const refreshWorksetStatus = useStore((s) => s.refreshWorksetStatus);
  const worksets = useStore((s) => s.worksets);

  const [preview, setPreview] = useState<AbandonLocalPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [makeBackup, setMakeBackup] = useState(true);
  const [cleanUntracked, setCleanUntracked] = useState(false);
  const [busy, setBusy] = useState<'reset' | 'suggest' | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);

  const today = useMemo(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }, []);
  const fallbackBackupName = useMemo(() => {
    const branch = status?.branch ?? 'work';
    const slug = branch.replace(/[^A-Za-z0-9._-]+/g, '-');
    return `backup/${slug}-${today}`;
  }, [status?.branch, today]);

  const [backupName, setBackupName] = useState(fallbackBackupName);
  // Keep the name in sync with the fallback until the user has typed
  // (or accepted an AI suggestion). Once they touch it we stop
  // re-defaulting so the field isn't yanked out from under them.
  const [backupNameDirty, setBackupNameDirty] = useState(false);
  useEffect(() => {
    if (!backupNameDirty) setBackupName(fallbackBackupName);
  }, [fallbackBackupName, backupNameDirty]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await window.overgit.invoke('repo:abandonLocalPreview', repoId);
        if (!alive) return;
        setPreview(res);
      } catch (err) {
        if (!alive) return;
        setPreviewError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [repoId]);

  const sanitized = useMemo(
    () => (makeBackup ? sanitizeBranchName(backupName) : null),
    [makeBackup, backupName],
  );

  const tools: LlmTool[] = useMemo(() => {
    if (!cli) return [];
    const out: LlmTool[] = [];
    if (cli.claude) out.push('claude');
    if (cli.codex) out.push('codex');
    if (cli.gemini) out.push('gemini');
    return out;
  }, [cli]);
  const firstTool = tools[0] ?? null;

  const onSuggest = async () => {
    if (!firstTool) return;
    setBusy('suggest');
    setAiSummary(null);
    try {
      const res = await window.overgit.invoke(
        'repo:suggestBackupBranchName',
        { repoId, tool: firstTool },
      );
      if (!res.ok) {
        pushToast({ kind: 'error', message: res.error ?? 'AI suggestion failed' });
        return;
      }
      setBackupName(res.name);
      setBackupNameDirty(true);
      setAiSummary(res.summary || null);
    } finally {
      setBusy(null);
    }
  };

  const onReset = async () => {
    if (!preview?.upstream) return;
    if (makeBackup && sanitized?.error) {
      pushToast({ kind: 'error', message: sanitized.error });
      return;
    }
    const lossLines: string[] = [];
    if (preview.unpushed.length) {
      lossLines.push(
        `${preview.unpushed.length} unpushed commit${preview.unpushed.length === 1 ? '' : 's'}`,
      );
    }
    if (preview.dirtyFiles.length) {
      lossLines.push(
        `${preview.dirtyFiles.length} dirty file${preview.dirtyFiles.length === 1 ? '' : 's'}`,
      );
    }
    const lossSummary = lossLines.length ? lossLines.join(' + ') : 'nothing material';
    const confirmBody = makeBackup
      ? `Reset to ${preview.upstream}. ${lossSummary} will be preserved on a new branch "${sanitized?.value}" you can return to.`
      : `Reset to ${preview.upstream}. ${lossSummary} will be DESTROYED. There is no backup. Reflog may help recover, but don't count on it.`;
    const ok = await requestConfirm({
      title: makeBackup ? 'Reset to upstream?' : 'Reset and discard everything?',
      body: confirmBody,
      confirmLabel: makeBackup ? 'Move to backup & reset' : 'Discard everything',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;

    setBusy('reset');
    try {
      const res = await window.overgit.invoke('repo:resetToUpstream', {
        repoId,
        upstreamRef: preview.upstream,
        backupBranch: makeBackup ? sanitized?.value : undefined,
        cleanUntracked,
      });
      if (!res.ok) {
        const stepLabel = res.step ? ` (${res.step})` : '';
        pushToast({
          kind: 'error',
          message: `Reset failed${stepLabel}: ${res.error ?? 'unknown error'}`,
        });
        return;
      }
      pushToast({
        kind: 'success',
        message: res.backupBranch
          ? `Reset to ${preview.upstream}. Backup saved on ${res.backupBranch}.`
          : `Reset to ${preview.upstream}.`,
      });
      // Refresh per-repo caches (header reads `repoStatus`) AND every
      // workset that contains this repo (workset-detail view reads
      // `worksetStatuses`, not `repoStatus` — without this, the
      // workset page keeps showing the pre-reset ahead/behind counts
      // and the Push/Merge affordances stay live).
      const memberOf = worksets
        .filter((w) => w.repoIds.includes(repoId))
        .map((w) => w.id);
      await Promise.all([
        refreshRepoStatus(repoId),
        refreshRepoLog(repoId),
        refreshRepoChanges(repoId),
        refreshRepoBranches(repoId),
        refreshRepoBranchSummaries(repoId),
        ...memberOf.map((id) => refreshWorksetStatus(id)),
      ]);
      setSheet(null);
    } finally {
      setBusy(null);
    }
  };

  const hasWork =
    (preview?.unpushed?.length ?? 0) > 0 ||
    (preview?.dirtyFiles?.length ?? 0) > 0;
  const canReset =
    !!preview?.upstream &&
    busy === null &&
    (!makeBackup || (sanitized?.error == null && (sanitized?.value?.length ?? 0) > 0));

  return (
    <>
      <SheetHeader
        title={`Abandon local commits${repo ? ` · ${repo.name}` : ''}`}
        onClose={() => setSheet(null)}
      />
      <div className="flex-1 min-h-0 p-5 flex flex-col gap-4 text-sm overflow-y-auto">
        <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2.5 text-[12px] text-ink-muted leading-snug">
          <div className="text-ink font-medium mb-0.5">Destructive recovery</div>
          Fetch the remote, then hard-reset this branch to its upstream. Local
          commits and dirty files go away. Leave the backup branch on (default)
          so the discarded work is still reachable later.
        </div>

        {previewError && (
          <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
            Could not load preview: {previewError}
          </div>
        )}

        {preview && !preview.upstream && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
            No upstream is configured for this branch. Abandon-to-upstream
            needs an upstream to snap to — set one with{' '}
            <span className="font-mono">git push -u origin {status?.branch}</span>{' '}
            or pick a different branch.
          </div>
        )}

        {preview?.upstream && (
          <div className="text-[11px] text-ink-muted">
            Will reset{' '}
            <span className="font-mono text-ink">{status?.branch ?? '(detached)'}</span>{' '}
            to{' '}
            <span className="font-mono text-ink">{preview.upstream}</span>.
          </div>
        )}

        {preview && preview.unpushed.length > 0 && (
          <section>
            <div className="text-[10px] uppercase tracking-wide text-ink-faint mb-1.5">
              Unpushed commits ({preview.unpushed.length})
            </div>
            <ul className="border border-card rounded overflow-hidden max-h-[180px] overflow-y-auto">
              {preview.unpushed.map((c) => (
                <li
                  key={c.sha}
                  className="px-3 py-1.5 border-b border-card last:border-0 text-[11px] flex gap-2 items-baseline"
                >
                  <span className="font-mono text-ink-faint shrink-0">{c.shortSha}</span>
                  <span className="truncate flex-1 text-ink">{c.subject}</span>
                  <span className="text-ink-faint shrink-0">{c.author}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {preview && preview.dirtyFiles.length > 0 && (
          <section>
            <div className="text-[10px] uppercase tracking-wide text-ink-faint mb-1.5">
              Dirty files ({preview.dirtyFiles.length})
            </div>
            <ul className="border border-card rounded overflow-hidden max-h-[140px] overflow-y-auto">
              {preview.dirtyFiles.map((f) => (
                <li
                  key={f.path}
                  className="px-3 py-1 border-b border-card last:border-0 text-[11px] font-mono flex gap-2"
                >
                  <span className="text-amber-400 w-6 shrink-0">
                    {f.indexStatus}
                    {f.worktreeStatus}
                  </span>
                  <span className="truncate text-ink">{f.path}</span>
                </li>
              ))}
            </ul>
            {preview.diffStat.trim() && (
              <pre className="mt-2 text-[10px] text-ink-faint whitespace-pre-wrap leading-snug max-h-[120px] overflow-y-auto">
                {preview.diffStat.trim()}
              </pre>
            )}
          </section>
        )}

        {preview && !hasWork && (
          <div className="text-[11px] text-ink-faint">
            Nothing local to lose — branch matches upstream already.
          </div>
        )}

        <fieldset className="flex flex-col gap-2 rounded border border-card bg-card/40 px-3 py-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={makeBackup}
              onChange={(e) => setMakeBackup(e.target.checked)}
              className="accent-accent mt-0.5"
            />
            <div className="flex flex-col gap-1 min-w-0 flex-1">
              <span className="text-xs text-ink font-medium">
                Save abandoned work as a backup branch
              </span>
              <span className="text-[11px] text-ink-faint">
                Creates a branch off the current HEAD before the reset, so the
                commits and dirty work stay reachable as{' '}
                <span className="font-mono">{sanitized?.value || fallbackBackupName}</span>.
                Strongly recommended.
              </span>
              {makeBackup && (
                <div className="flex flex-col gap-1 mt-1">
                  <div className="flex items-center gap-2">
                    <input
                      value={backupName}
                      onChange={(e) => {
                        setBackupNameDirty(true);
                        setBackupName(e.target.value);
                      }}
                      placeholder={fallbackBackupName}
                      className="field flex-1 px-2 py-1 text-[12px] font-mono"
                    />
                    {firstTool && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void onSuggest()}
                        title={`Ask ${firstTool} to summarize the abandoned work and name the backup branch.`}
                        className="text-[11px] px-2 py-1 rounded border border-card hover:bg-card disabled:opacity-50 whitespace-nowrap"
                      >
                        {busy === 'suggest' ? `Asking ${firstTool}…` : `Suggest with ${firstTool}`}
                      </button>
                    )}
                  </div>
                  {sanitized?.changed && sanitized.value && !sanitized.error && (
                    <span className="text-[11px] text-ink-faint">
                      Will be created as{' '}
                      <span className="font-mono">{sanitized.value}</span>.
                    </span>
                  )}
                  {sanitized?.error && (
                    <span className="text-[11px] text-red-400">{sanitized.error}</span>
                  )}
                  {aiSummary && (
                    <span className="text-[11px] text-ink-muted italic">
                      {aiSummary}
                    </span>
                  )}
                </div>
              )}
            </div>
          </label>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={cleanUntracked}
              onChange={(e) => setCleanUntracked(e.target.checked)}
              className="accent-accent mt-0.5"
            />
            <div className="flex flex-col min-w-0">
              <span className="text-xs text-ink font-medium">
                Also delete untracked files (<span className="font-mono">git clean -fd</span>)
              </span>
              <span className="text-[11px] text-ink-faint">
                Off by default. Untracked files aren't preserved by the backup
                branch — turning this on means they're gone for good.
              </span>
            </div>
          </label>
        </fieldset>
      </div>
      <div className="px-5 py-3 border-t border-card flex items-center justify-between gap-2">
        <span className="text-[11px] text-ink-faint">
          {firstTool
            ? `AI assist available (${tools.join(', ')})`
            : 'No LLM CLI detected — install claude/codex/gemini for naming help.'}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => setSheet(null)}
            className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
          >
            Cancel
          </button>
          <button
            disabled={!canReset}
            onClick={() => void onReset()}
            className="text-xs px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {busy === 'reset' && (
              <svg width="11" height="11" viewBox="0 0 24 24" className="animate-spin" aria-hidden>
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" fill="none" />
                <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
              </svg>
            )}
            <span>
              {busy === 'reset'
                ? 'Resetting…'
                : makeBackup
                  ? 'Back up & reset'
                  : 'Discard & reset'}
            </span>
          </button>
        </div>
      </div>
    </>
  );
}

function PullConflictSheet({
  repoId,
  conflicts,
  rawError,
}: {
  repoId: UUID;
  conflicts: string[];
  rawError: string;
}): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const pullForce = useStore((s) => s.pullForce);
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId));
  const requestConfirm = useStore((s) => s.requestConfirm);
  const [busy, setBusy] = useState<'stash' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ stashed: boolean } | null>(null);

  const fileWord = conflicts.length === 1 ? 'file' : 'files';

  const onRetry = async (strategy: 'stash' | 'discard') => {
    if (strategy === 'discard') {
      const ok = await requestConfirm({
        title: 'Discard local changes?',
        body: `Discard local changes in ${conflicts.length} ${fileWord}? This cannot be undone — the working-tree copies will be replaced with HEAD.`,
        confirmLabel: 'Discard',
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(strategy);
    setError(null);
    try {
      const res = await pullForce(repoId, conflicts, strategy);
      if (!res.ok) {
        setError(res.error ?? 'Pull failed');
        return;
      }
      setDone({ stashed: !!res.stashed });
    } finally {
      setBusy(null);
    }
  };

  // Success state — flash a confirmation and close on user dismiss
  // (rather than auto-closing) so the user sees what happened.
  if (done) {
    return (
      <div className="flex flex-col">
        <div className="flex items-center justify-between border-b border-card px-5 py-3">
          <h2 className="text-sm font-semibold text-emerald-300">Pull complete</h2>
          <button
            onClick={() => setSheet(null)}
            className="text-ink-faint hover:text-ink rounded p-1 hover:bg-card"
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="p-5 text-sm flex flex-col gap-3">
          <p className="text-ink">
            Pulled successfully after recovering from the conflict.
          </p>
          {done.stashed && (
            <p className="text-[12px] text-ink-muted">
              Your local changes were saved as <span className="font-mono">stash@{'{0}'}</span> with
              the message <span className="font-mono">"auto: pull"</span>. Pop it from the
              Stash tab when you're ready to bring those edits back.
            </p>
          )}
        </div>
        <div className="px-5 py-3 border-t border-card flex justify-end">
          <button
            onClick={() => setSheet(null)}
            className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-start justify-between border-b border-card px-5 py-3 flex-shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <span className="text-amber-300">Pull blocked</span>
            <span className="text-[10px] uppercase tracking-wide text-ink-faint font-mono">
              {repo?.name}
            </span>
          </h2>
          <p className="mt-1 text-[11px] text-ink-faint">
            Git refused to merge — your local changes to {conflicts.length}{' '}
            {fileWord} would be overwritten by the incoming commits.
          </p>
        </div>
        <button
          onClick={() => setSheet(null)}
          className="text-ink-faint hover:text-ink rounded p-1 hover:bg-card flex-shrink-0"
          aria-label="Close"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-4 text-sm">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-ink-faint mb-1.5">
            Files with local changes
          </div>
          <ul className="rounded border border-card bg-card/40 max-h-[220px] overflow-y-auto">
            {conflicts.map((p) => (
              <li
                key={p}
                className="flex items-center gap-2 px-3 py-1 text-[12px] font-mono border-b border-card last:border-0"
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-300/70 flex-shrink-0" />
                <span className="truncate" title={p}>
                  {p}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wide text-ink-faint mb-1.5">
            Recovery
          </div>
          <div className="flex flex-col gap-2">
            <ActionCard
              tone="primary"
              title="Stash & retry"
              subtitle="Save these files to a stash, pull, and leave the stash around so you can pop it later from the Stash tab."
              cmd="git stash push -- <files> && git pull"
              busy={busy === 'stash'}
              disabled={busy !== null}
              onClick={() => onRetry('stash')}
            />
            <ActionCard
              tone="danger"
              title="Discard & retry"
              subtitle="Reset these files to the version on HEAD, then pull. Your local changes are lost."
              cmd="git checkout HEAD -- <files> && git pull"
              busy={busy === 'discard'}
              disabled={busy !== null}
              onClick={() => onRetry('discard')}
            />
          </div>
        </div>

        {error && (
          <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
            <div className="font-semibold mb-1">Recovery failed</div>
            <pre className="whitespace-pre-wrap font-mono">{error}</pre>
          </div>
        )}

        <details className="text-[10px] text-ink-faint">
          <summary className="cursor-pointer hover:text-ink-muted">
            Show full git output
          </summary>
          <pre className="mt-2 px-3 py-2 rounded bg-card border border-card font-mono whitespace-pre-wrap leading-relaxed">
            {rawError}
          </pre>
        </details>
      </div>

      <div className="flex-shrink-0 flex justify-end gap-2 border-t border-card px-5 py-3">
        <button
          onClick={() => setSheet(null)}
          className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ActionCard({
  tone,
  title,
  subtitle,
  cmd,
  busy,
  disabled,
  onClick,
}: {
  tone: 'primary' | 'danger';
  title: string;
  subtitle: string;
  cmd: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}): JSX.Element {
  const cls =
    tone === 'primary'
      ? 'border-accent/40 hover:bg-accent/10'
      : 'border-red-500/40 hover:bg-red-500/10';
  const titleCls = tone === 'primary' ? 'text-ink' : 'text-red-300';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`text-left rounded border ${cls} px-4 py-3 disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
    >
      <div className="flex items-baseline gap-2">
        <span className={`text-[13px] font-semibold ${titleCls}`}>{title}</span>
        {busy && <span className="text-[11px] text-ink-faint">running…</span>}
      </div>
      <div className="mt-1 text-[11px] text-ink-muted">{subtitle}</div>
      <div className="mt-1.5 text-[10px] font-mono text-ink-faint">{cmd}</div>
    </button>
  );
}

/// Workset-wide "create branch" workflow. The user names a branch and
/// picks two switches (defaults match the GitHub-Desktop "back to
/// mainline → pull → branch" pattern). On submit we run
/// `workset:syncAndBranch`, then render per-repo outcomes inline so a
/// partial failure (one repo dirty, one repo's pull conflicted) is
/// readable and recoverable.
type DirtyResolution = 'stash' | 'commit' | 'skip';

function WorksetBranchSheet({ worksetId }: { worksetId: UUID }): JSX.Element {
  const ws = useStore((s) => s.worksets.find((w) => w.id === worksetId));
  const repos = useStore((s) => s.repos);
  const statuses = useStore((s) => s.worksetStatuses[worksetId] ?? EMPTY_STATUSES);
  const refreshStatus = useStore((s) => s.refreshWorksetStatus);
  const stashRepo = useStore((s) => s.stashRepo);
  const commitAllWorkset = useStore((s) => s.commitAllWorkset);
  const setSheet = useStore((s) => s.setSheet);

  const [branch, setBranch] = useState('');
  const [syncDefault, setSyncDefault] = useState(true);
  const [pullBefore, setPullBefore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<SyncAndBranchOutcome[] | null>(null);
  // Dirty-resolution preflight. Default to stash because it's the
  // safest reversible option — any work survives even if the branch
  // creation fails halfway through.
  const [dirtyAction, setDirtyAction] = useState<DirtyResolution>('stash');
  const [commitMessage, setCommitMessage] = useState('');
  const [preflightError, setPreflightError] = useState<string | null>(null);

  const reposById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);
  const memberRepos = useMemo(
    () => (ws?.repoIds ?? []).map((id) => reposById.get(id)).filter((r): r is Repo => !!r),
    [ws?.repoIds, reposById],
  );

  // Pull a fresh status when the sheet mounts so the dirty list isn't
  // stale from before the user opened the sheet.
  useEffect(() => {
    void refreshStatus(worksetId);
  }, [refreshStatus, worksetId]);

  const dirtyRepos = useMemo(
    () => statuses.filter((s) => s.dirtyCount > 0),
    [statuses],
  );

  const sanitizedBranch = useMemo(() => sanitizeBranchName(branch), [branch]);

  const onRun = async () => {
    if (!sanitizedBranch.value || sanitizedBranch.error) return;
    setBusy(true);
    setOutcomes(null);
    setPreflightError(null);
    try {
      // Preflight: if any repos are dirty, resolve them first per the
      // user's choice. We do this BEFORE syncAndBranch so a "stash" or
      // "commit" doesn't have to be undone if the branch creation
      // succeeds — and so a "dirty" outcome from syncAndBranch becomes
      // exceptional, not the common case it is today.
      if (dirtyRepos.length > 0) {
        if (dirtyAction === 'commit') {
          if (!commitMessage.trim()) {
            setPreflightError('Commit message required');
            return;
          }
          setBusyLabel('Committing dirty repos…');
          const commitOutcomes = await commitAllWorkset(worksetId, commitMessage.trim());
          const failed = commitOutcomes.filter((o) => o.result === 'commit-failed');
          if (failed.length > 0) {
            setPreflightError(
              `Commit failed in ${failed.length} repo${failed.length === 1 ? '' : 's'}: ${failed
                .map((f) => reposById.get(f.repoId)?.name ?? f.repoId)
                .join(', ')}`,
            );
            return;
          }
        } else if (dirtyAction === 'stash') {
          setBusyLabel('Stashing dirty repos…');
          const stashFails: string[] = [];
          for (const st of dirtyRepos) {
            const res = await stashRepo(st.repoId);
            if (!res.ok) stashFails.push(reposById.get(st.repoId)?.name ?? st.repoId);
          }
          if (stashFails.length > 0) {
            setPreflightError(`Stash failed in: ${stashFails.join(', ')}`);
            return;
          }
        }
        // 'skip' → fall through and let syncAndBranch's per-repo
        // 'dirty' outcome surface, which is the legacy behavior.
      }
      setBusyLabel('Creating branch…');
      const res = await window.overgit.invoke('workset:syncAndBranch', {
        worksetId,
        branch: sanitizedBranch.value,
        syncDefault,
        pullBeforeBranch: pullBefore,
      });
      setOutcomes(res);
      await refreshStatus(worksetId);
    } finally {
      setBusy(false);
      setBusyLabel(null);
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
      <div className="flex-1 min-h-0 p-5 flex flex-col gap-4 text-sm overflow-y-auto">
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
          {branch.trim() && sanitizedBranch.error ? (
            <span className="text-[11px] text-red-400">{sanitizedBranch.error}</span>
          ) : (
            sanitizedBranch.changed && (
              <span className="text-[11px] text-amber-300">
                Will create as{' '}
                <span className="font-mono">{sanitizedBranch.value}</span>
              </span>
            )
          )}
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

        {dirtyRepos.length > 0 && (
          <fieldset className="flex flex-col gap-2 p-3 rounded border border-amber-700/40 bg-amber-500/[0.04]">
            <legend className="text-[10px] uppercase tracking-wide text-amber-300 px-1">
              {dirtyRepos.length} {dirtyRepos.length === 1 ? 'repo has' : 'repos have'} uncommitted
              changes
            </legend>
            <ul className="text-[11px] text-ink-faint mb-1 max-h-24 overflow-y-auto">
              {dirtyRepos.map((s) => (
                <li key={s.repoId} className="flex justify-between gap-2">
                  <span className="truncate">
                    {reposById.get(s.repoId)?.name ?? s.repoId}
                  </span>
                  <span className="font-mono">
                    {s.dirtyCount} {s.dirtyCount === 1 ? 'file' : 'files'}
                  </span>
                </li>
              ))}
            </ul>
            <DirtyChoice
              value={dirtyAction}
              onChange={setDirtyAction}
              disabled={busy}
            />
            {dirtyAction === 'commit' && (
              <input
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                disabled={busy}
                placeholder="Commit message for all dirty repos"
                className="field px-2 py-1.5 text-xs"
              />
            )}
          </fieldset>
        )}

        {preflightError && (
          <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
            {preflightError}
          </div>
        )}

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
          disabled={busy || !sanitizedBranch.value || !!sanitizedBranch.error}
          onClick={onRun}
          className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
        >
          {busy
            ? busyLabel ?? 'Running…'
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

function DirtyChoice({
  value,
  onChange,
  disabled,
}: {
  value: DirtyResolution;
  onChange: (v: DirtyResolution) => void;
  disabled?: boolean;
}): JSX.Element {
  // Three radio rows. We use plain <label> wrappers rather than a
  // fancy radio-card component because this only ever shows up
  // contextually, in two places, and one row of clickable text matches
  // the surrounding sheet density.
  const opts: { value: DirtyResolution; label: string; sub: string }[] = [
    {
      value: 'stash',
      label: 'Stash before continuing',
      sub: 'Reversible — pop the stash later from the Stash tab.',
    },
    {
      value: 'commit',
      label: 'Commit all with shared message',
      sub: 'Stages everything (incl. untracked) and commits in each dirty repo.',
    },
    {
      value: 'skip',
      label: 'Continue anyway',
      sub: 'Dirty repos will fail the switch and need manual cleanup.',
    },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      {opts.map((o) => (
        <label
          key={o.value}
          className={`flex items-start gap-2 cursor-pointer ${
            disabled ? 'opacity-60 cursor-not-allowed' : ''
          }`}
        >
          <input
            type="radio"
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
            className="mt-0.5"
          />
          <div className="flex-1 min-w-0">
            <div className="text-xs">{o.label}</div>
            <div className="text-[10px] text-ink-faint">{o.sub}</div>
          </div>
        </label>
      ))}
    </div>
  );
}

/// Workset-wide commit-all. Stages everything in every dirty repo and
/// commits with a shared message, skipping detached-HEAD repos. Mirrors
/// WorksetBranchSheet's per-repo outcome list so success and failure
/// share a layout.
function WorksetCommitAllSheet({ worksetId }: { worksetId: UUID }): JSX.Element {
  const ws = useStore((s) => s.worksets.find((w) => w.id === worksetId));
  const repos = useStore((s) => s.repos);
  const statuses = useStore((s) => s.worksetStatuses[worksetId] ?? EMPTY_STATUSES);
  const refreshStatus = useStore((s) => s.refreshWorksetStatus);
  const commitAllWorkset = useStore((s) => s.commitAllWorkset);
  const cli = useStore((s) => s.cliPresence);
  const setSheet = useStore((s) => s.setSheet);

  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<CommitAllOutcome[] | null>(null);

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

  const reposById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);

  useEffect(() => {
    void refreshStatus(worksetId);
  }, [refreshStatus, worksetId]);

  const dirtyOnBranch = useMemo(
    () => statuses.filter((s) => s.dirtyCount > 0 && s.branch !== null),
    [statuses],
  );
  const dirtyDetached = useMemo(
    () => statuses.filter((s) => s.dirtyCount > 0 && s.branch === null),
    [statuses],
  );

  const cliBusy =
    cliStatus.kind === 'drafting' || cliStatus.kind === 'reviewing';

  const onDraft = async () => {
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
      setMessage(res.message);
      setCliStatus({ kind: 'drafted', tool: res.tool });
    } catch (err: unknown) {
      setCliStatus({ kind: 'err', message: String(err) });
    }
  };

  const onReview = async () => {
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

  // Auto-clear "drafted" pill after a couple of seconds so the row
  // settles and the user can re-draft without a stale ✓.
  useEffect(() => {
    if (cliStatus.kind !== 'drafted') return;
    const t = setTimeout(() => setCliStatus({ kind: 'idle' }), 2500);
    return () => clearTimeout(t);
  }, [cliStatus]);

  const onRun = async () => {
    if (!message.trim() || dirtyOnBranch.length === 0) return;
    setBusy(true);
    setOutcomes(null);
    try {
      const res = await commitAllWorkset(worksetId, message.trim());
      setOutcomes(res);
    } finally {
      setBusy(false);
    }
  };

  const allDone =
    outcomes !== null &&
    outcomes.every((o) => o.result === 'committed' || o.result === 'clean' || o.result === 'detached');

  return (
    <>
      <SheetHeader
        title={`Commit all · ${ws?.name ?? ''}`}
        onClose={() => setSheet(null)}
      />
      <div className="flex-1 min-h-0 p-5 flex flex-col gap-4 text-sm overflow-y-auto">
        <label className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="uppercase tracking-wide text-ink-faint">
              Commit message
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
            autoFocus
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={busy}
            placeholder="Shared commit message — applied to every dirty repo on a branch"
            rows={3}
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
                      : 'border-card hover:bg-card'
                  } disabled:opacity-50`}
                >
                  {t}
                </button>
              ))}
            </div>
            <button
              onClick={onDraft}
              disabled={cliBusy || !tool || dirtyOnBranch.length === 0}
              className="text-[11px] px-2 py-0.5 rounded border border-card hover:bg-card disabled:opacity-50"
              title="Draft a shared commit message from the aggregated workset diff"
            >
              ✨ Draft message
            </button>
            <button
              onClick={onReview}
              disabled={cliBusy || !tool || dirtyOnBranch.length === 0}
              className="text-[11px] px-2 py-0.5 rounded border border-card hover:bg-card disabled:opacity-50"
              title="Pipe the aggregated workset diff to the CLI for review"
            >
              Review changes
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

        {review && (
          <div className="border border-card rounded p-3 bg-card/40">
            <ReviewBody result={review} />
          </div>
        )}

        <div>
          <div className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">
            Will commit on {dirtyOnBranch.length}{' '}
            {dirtyOnBranch.length === 1 ? 'repo' : 'repos'}
          </div>
          {dirtyOnBranch.length === 0 ? (
            <div className="text-[11px] text-ink-faint">
              Nothing to commit — every repo in this workset is either clean or in
              detached HEAD.
            </div>
          ) : (
            <ul className="text-[11px] text-ink-faint flex flex-col gap-0.5">
              {dirtyOnBranch.map((s) => (
                <li key={s.repoId} className="flex justify-between gap-2">
                  <span className="truncate">
                    {reposById.get(s.repoId)?.name ?? s.repoId}
                  </span>
                  <span className="font-mono">
                    {s.branch} · {s.dirtyCount}{' '}
                    {s.dirtyCount === 1 ? 'file' : 'files'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {dirtyDetached.length > 0 && (
          <div className="text-[11px] text-amber-400 bg-amber-500/[0.06] border border-amber-700/40 rounded px-3 py-2">
            Skipping {dirtyDetached.length} detached-HEAD{' '}
            {dirtyDetached.length === 1 ? 'repo' : 'repos'} —{' '}
            {dirtyDetached
              .map((s) => reposById.get(s.repoId)?.name ?? s.repoId)
              .join(', ')}
            . Committing onto detached HEAD orphans the commit; resolve manually.
          </div>
        )}

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
                <CommitAllOutcomeBadge result={o.result} />
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
          {allDone ? 'Done' : 'Cancel'}
        </button>
        <button
          disabled={busy || !message.trim() || dirtyOnBranch.length === 0}
          onClick={onRun}
          className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
        >
          {busy
            ? 'Committing…'
            : outcomes
              ? 'Run again'
              : `Commit on ${dirtyOnBranch.length} ${
                  dirtyOnBranch.length === 1 ? 'repo' : 'repos'
                }`}
        </button>
      </div>
    </>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CommitAllOutcomeBadge({
  result,
}: {
  result: CommitAllOutcome['result'];
}): JSX.Element {
  const map: Record<CommitAllOutcome['result'], { label: string; cls: string }> = {
    committed: { label: 'committed', cls: 'text-emerald-400' },
    clean: { label: 'clean', cls: 'text-ink-faint' },
    detached: { label: 'detached', cls: 'text-amber-400' },
    'commit-failed': { label: 'failed', cls: 'text-red-400' },
  };
  const { label, cls } = map[result];
  return <span className={`font-mono ${cls}`}>{label}</span>;
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

/// Workset-wide push. Preflights with `worksetStatuses` so the user
/// can see exactly which repos will push (and how many commits each
/// has) before committing the action. Repos with no upstream still
/// participate — we wire upstream on the first push, same as the
/// single-repo Push button.
function WorksetPushAllSheet({ worksetId }: { worksetId: UUID }): JSX.Element {
  const ws = useStore((s) => s.worksets.find((w) => w.id === worksetId));
  const repos = useStore((s) => s.repos);
  const statuses = useStore((s) => s.worksetStatuses[worksetId] ?? EMPTY_STATUSES);
  const refreshStatus = useStore((s) => s.refreshWorksetStatus);
  const pushAllWorkset = useStore((s) => s.pushAllWorkset);
  const setSheet = useStore((s) => s.setSheet);

  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<WorksetPushOutcome[] | null>(null);

  const reposById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);

  useEffect(() => {
    void refreshStatus(worksetId);
  }, [refreshStatus, worksetId]);

  // For each on-branch repo, how many commits would actually move on
  // push. When `ahead` is known we use that; when there's no upstream
  // we fall back to `aheadDefault` (commits on this branch beyond the
  // repo's default branch — what `git push -u` would publish on a
  // freshly-created feature branch).
  const commitsToPush = (s: RepoStatus): number =>
    s.ahead ?? s.aheadDefault ?? 0;

  // Eligible = on a branch. Up-to-date repos still go through the call
  // so the result table is symmetric ("up-to-date" is a result, not a
  // skip), but we tell the user how many will actually push.
  const onBranch = useMemo(() => statuses.filter((s) => s.branch !== null), [statuses]);
  const willPush = useMemo(
    () => onBranch.filter((s) => commitsToPush(s) > 0),
    [onBranch],
  );
  const upToDate = useMemo(
    () => onBranch.filter((s) => commitsToPush(s) === 0),
    [onBranch],
  );
  const detached = useMemo(() => statuses.filter((s) => s.branch === null), [statuses]);

  const onRun = async () => {
    setBusy(true);
    setOutcomes(null);
    try {
      const res = await pushAllWorkset(worksetId);
      setOutcomes(res);
    } finally {
      setBusy(false);
    }
  };

  const ranSuccessfully =
    outcomes !== null && outcomes.every((o) => o.result !== 'push-failed');

  return (
    <>
      <SheetHeader title={`Push all · ${ws?.name ?? ''}`} onClose={() => setSheet(null)} />
      <div className="flex-1 min-h-0 p-5 flex flex-col gap-4 text-sm overflow-y-auto">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">
            Will push {willPush.length} {willPush.length === 1 ? 'repo' : 'repos'}
            {upToDate.length > 0 &&
              ` · ${upToDate.length} already up to date`}
          </div>
          {willPush.length === 0 ? (
            <div className="text-[11px] text-ink-faint">
              {onBranch.length === 0
                ? 'No repos on a branch — nothing to push.'
                : 'Every repo is already in sync with its upstream.'}
            </div>
          ) : (
            <ul className="text-[11px] text-ink-faint flex flex-col gap-0.5">
              {willPush.map((s) => (
                <li key={s.repoId} className="flex justify-between gap-2">
                  <span className="truncate">
                    {reposById.get(s.repoId)?.name ?? s.repoId}
                  </span>
                  <span className="font-mono">
                    {s.branch} · ↑{commitsToPush(s)}
                    {!s.hasUpstream && ' · no upstream'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {detached.length > 0 && (
          <div className="text-[11px] text-amber-400 bg-amber-500/[0.06] border border-amber-700/40 rounded px-3 py-2">
            Skipping {detached.length} detached-HEAD{' '}
            {detached.length === 1 ? 'repo' : 'repos'} —{' '}
            {detached.map((s) => reposById.get(s.repoId)?.name ?? s.repoId).join(', ')}.
          </div>
        )}

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
                <PushOutcomeBadge result={o.result} />
                <span className="font-mono text-ink-faint">
                  {o.branch ?? '—'}
                  {typeof o.ahead === 'number' && o.ahead > 0 ? ` · ↑${o.ahead}` : ''}
                </span>
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
          {ranSuccessfully ? 'Done' : 'Cancel'}
        </button>
        <button
          disabled={busy || willPush.length === 0}
          onClick={onRun}
          className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
        >
          {busy
            ? 'Pushing…'
            : outcomes
              ? 'Run again'
              : `Push ${willPush.length} ${willPush.length === 1 ? 'repo' : 'repos'}`}
        </button>
      </div>
    </>
  );
}

function PushOutcomeBadge({ result }: { result: WorksetPushOutcome['result'] }): JSX.Element {
  const map: Record<WorksetPushOutcome['result'], { label: string; cls: string }> = {
    pushed: { label: 'pushed', cls: 'text-emerald-400' },
    'pushed-new-upstream': { label: 'pushed +tracking', cls: 'text-emerald-400' },
    'up-to-date': { label: 'up-to-date', cls: 'text-ink-faint' },
    detached: { label: 'detached', cls: 'text-amber-400' },
    'push-failed': { label: 'failed', cls: 'text-red-400' },
  };
  const { label, cls } = map[result];
  return <span className={`font-mono ${cls}`}>{label}</span>;
}

/// Workset-wide "Open PRs". Lets the user enter one shared title and
/// body; we run `gh pr create` per repo against each repo's default
/// branch. Already-open PRs come back as `already-open` (with the
/// existing URL) so re-running is idempotent.
function WorksetOpenPRsSheet({ worksetId }: { worksetId: UUID }): JSX.Element {
  const ws = useStore((s) => s.worksets.find((w) => w.id === worksetId));
  const repos = useStore((s) => s.repos);
  const statuses = useStore((s) => s.worksetStatuses[worksetId] ?? EMPTY_STATUSES);
  const cli = useStore((s) => s.cliPresence);
  const refreshStatus = useStore((s) => s.refreshWorksetStatus);
  const openPRsWorkset = useStore((s) => s.openPRsWorkset);
  const setSheet = useStore((s) => s.setSheet);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  // Track whether the user has edited the title, so the auto-prefill
  // from the workset name doesn't clobber what they typed. Body is
  // intentionally left blank — auto-prefilling from a commit message
  // tends to surface stale history (old merge commits in the log)
  // rather than the user's actual coordinated change, so we let them
  // write the description themselves.
  const [titleEdited, setTitleEdited] = useState(false);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<WorksetOpenPROutcome[] | null>(null);

  const reposById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);

  useEffect(() => {
    void refreshStatus(worksetId);
  }, [refreshStatus, worksetId]);

  // The set of repos we'd actually try to PR. We exclude detached HEAD
  // and repos sitting on the default branch (nothing to PR). We can't
  // know without calling gh whether a PR is already open or whether
  // the branch is unpushed — those show up in the outcomes list.
  const candidates = useMemo(() => {
    return statuses.filter((s) => {
      if (s.branch === null) return false;
      const repo = reposById.get(s.repoId);
      if (!repo) return false;
      const def = repo.defaultBranch;
      return !def || s.branch !== def;
    });
  }, [statuses, reposById]);

  // Default title = workset name. Reflects intent ("a coordinated
  // change called RED-6148") rather than a single commit subject from
  // one of the member repos — which often turned out to be an old merge
  // commit from another developer's history rather than the user's
  // actual work.
  useEffect(() => {
    if (titleEdited) return;
    if (ws?.name && !title) setTitle(ws.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.name]);

  const onRun = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setOutcomes(null);
    try {
      const res = await openPRsWorkset(worksetId, {
        title: title.trim(),
        body: body.trim(),
        draft,
      });
      setOutcomes(res);
      // Bitbucket (and other no-CLI providers) come back with
      // 'opened-in-browser' + a pre-filled web URL. Fire those off
      // immediately — Electron's setWindowOpenHandler routes window.open
      // to the system browser, so each becomes a tab in Safari/Chrome.
      for (const o of res) {
        if (o.result === 'opened-in-browser' && o.url) window.open(o.url);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SheetHeader title={`Open PRs · ${ws?.name ?? ''}`} onClose={() => setSheet(null)} />
      <div className="flex-1 min-h-0 p-5 flex flex-col gap-4 text-sm overflow-y-auto">
        {!cli?.gh && (
          <div className="text-[12px] text-amber-400 bg-amber-500/[0.06] border border-amber-700/40 rounded px-3 py-2">
            <span className="font-mono">gh</span> not installed — GitHub repos
            will report <span className="font-mono">no-gh</span>. Bitbucket repos
            still work via the browser.
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-faint">Title</span>
          <input
            autoFocus
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleEdited(true);
            }}
            placeholder="Shared PR title"
            disabled={busy}
            className="field px-2 py-1.5 text-sm"
          />
          {ws?.name && !titleEdited && title === ws.name && (
            <span className="text-[10px] text-ink-faint">
              Pre-filled from workset name · type to override
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-faint">Body</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Shared PR body — markdown allowed"
            disabled={busy}
            rows={5}
            className="field px-2 py-1.5 text-sm resize-none"
          />
        </label>
        <label className="flex items-center gap-2 text-[12px] text-ink-muted">
          <input
            type="checkbox"
            checked={draft}
            onChange={(e) => setDraft(e.target.checked)}
            disabled={busy}
          />
          Open as draft
        </label>

        <div>
          <div className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">
            Will attempt on {candidates.length}{' '}
            {candidates.length === 1 ? 'repo' : 'repos'}
          </div>
          {candidates.length === 0 ? (
            <div className="text-[11px] text-ink-faint">
              Every repo is on its default branch (or detached). Switch to a feature
              branch to open PRs across the workset.
            </div>
          ) : (
            <ul className="text-[11px] text-ink-faint flex flex-col gap-0.5">
              {candidates.map((s) => {
                const repo = reposById.get(s.repoId);
                const baseBranch = repo?.defaultBranch ?? '(default)';
                return (
                  <li key={s.repoId} className="flex justify-between gap-2">
                    <span className="truncate">{repo?.name ?? s.repoId}</span>
                    <span className="font-mono">
                      {s.branch} → {baseBranch}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
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
                <OpenPROutcomeBadge result={o.result} />
                {o.url && o.number ? (
                  <a
                    href={o.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-accent hover:underline"
                  >
                    #{o.number}
                  </a>
                ) : (
                  <span className="font-mono text-ink-faint">
                    {o.branch ?? '—'}
                    {o.baseBranch ? ` → ${o.baseBranch}` : ''}
                  </span>
                )}
                {o.message && !o.url && (
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
          {outcomes ? 'Done' : 'Cancel'}
        </button>
        <button
          disabled={busy || !title.trim() || candidates.length === 0}
          onClick={onRun}
          className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
        >
          {busy
            ? 'Opening PRs…'
            : outcomes
              ? 'Run again'
              : `Open ${candidates.length} ${candidates.length === 1 ? 'PR' : 'PRs'}`}
        </button>
      </div>
    </>
  );
}

function OpenPROutcomeBadge({
  result,
}: {
  result: WorksetOpenPROutcome['result'];
}): JSX.Element {
  const map: Record<WorksetOpenPROutcome['result'], { label: string; cls: string }> = {
    created: { label: 'created', cls: 'text-emerald-400' },
    'already-open': { label: 'already open', cls: 'text-sky-400' },
    'opened-in-browser': { label: 'opened in browser', cls: 'text-emerald-400' },
    detached: { label: 'detached', cls: 'text-amber-400' },
    'on-default-branch': { label: 'default branch', cls: 'text-ink-faint' },
    unpushed: { label: 'unpushed', cls: 'text-amber-400' },
    'no-gh': { label: 'no gh', cls: 'text-amber-400' },
    'no-remote': { label: 'no remote', cls: 'text-amber-400' },
    'create-failed': { label: 'failed', cls: 'text-red-400' },
  };
  const { label, cls } = map[result];
  return <span className={`font-mono ${cls}`}>{label}</span>;
}

/// Per-file history + blame. Two tabs because the same `path` plus
/// the same opened sheet covers the two related questions a developer
/// usually has when poking at a file: "how did this file get to look
/// like this?" (history) and "who wrote this line?" (blame). Sharing a
/// sheet keeps the "switch view" cost low.
function FileHistorySheet({
  repoId,
  path,
  initialTab,
}: {
  repoId: UUID;
  path: string;
  initialTab: 'history' | 'blame';
}): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const [tab, setTab] = useState<'history' | 'blame'>(initialTab);
  const [log, setLog] = useState<FileLogCommit[] | null>(null);
  const [blame, setBlame] = useState<BlameLine[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Lazy-load each tab's data the first time it's viewed. Re-fetching
  // when the user toggles back is wasteful — file history doesn't
  // change unless they ran a git operation, which already invalidates
  // it elsewhere via store refreshes.
  useEffect(() => {
    let cancelled = false;
    if (tab === 'history' && log === null) {
      setLoading(true);
      window.overgit
        .invoke('repo:fileLog', { repoId, path, limit: 200 })
        .then((rows) => {
          if (!cancelled) setLog(rows);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    } else if (tab === 'blame' && blame === null) {
      setLoading(true);
      window.overgit
        .invoke('repo:fileBlame', { repoId, path })
        .then((rows) => {
          if (!cancelled) setBlame(rows);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [tab, log, blame, repoId, path]);

  return (
    <>
      <SheetHeader title={`File history · ${path}`} onClose={() => setSheet(null)} />
      <div className="flex-shrink-0 px-5 border-b border-card flex gap-2">
        <FileHistoryTab label="History" active={tab === 'history'} onClick={() => setTab('history')} />
        <FileHistoryTab label="Blame" active={tab === 'blame'} onClick={() => setTab('blame')} />
      </div>
      <div className="flex-1 min-h-0 overflow-hidden flex">
        {tab === 'history' ? (
          <FileHistoryList commits={log} loading={loading} />
        ) : (
          <FileBlameList lines={blame} loading={loading} />
        )}
      </div>
    </>
  );
}

function FileHistoryTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-3 py-2 border-b-2 -mb-px transition-colors ${
        active
          ? 'border-accent text-ink'
          : 'border-transparent text-ink-faint hover:text-ink'
      }`}
    >
      {label}
    </button>
  );
}

function FileHistoryList({
  commits,
  loading,
}: {
  commits: FileLogCommit[] | null;
  loading: boolean;
}): JSX.Element {
  if (loading && commits === null) {
    return (
      <div className="flex-1 p-6 text-xs text-ink-faint">Loading history…</div>
    );
  }
  if (!commits || commits.length === 0) {
    return (
      <div className="flex-1 p-6 text-xs text-ink-faint">
        No commits found for this file.
      </div>
    );
  }
  return (
    <ul className="flex-1 overflow-y-auto p-3 flex flex-col gap-1">
      {commits.map((c) => (
        <li
          key={c.sha}
          className="px-3 py-2 rounded border border-card bg-card hover:bg-card/70"
        >
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] text-ink-faint shrink-0">
              {c.shortSha}
            </span>
            <span className="text-sm font-medium truncate flex-1" title={c.subject}>
              {c.subject}
            </span>
            <span className="text-[10px] text-ink-faint shrink-0">
              {formatDateShort(c.authorDate)}
            </span>
          </div>
          <div className="text-[11px] text-ink-faint mt-0.5 flex items-baseline gap-2">
            <span className="truncate">{c.author}</span>
            <span className="font-mono text-[10px]" title={c.pathAtCommit}>
              · {c.pathAtCommit}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function FileBlameList({
  lines,
  loading,
}: {
  lines: BlameLine[] | null;
  loading: boolean;
}): JSX.Element {
  if (loading && lines === null) {
    return (
      <div className="flex-1 p-6 text-xs text-ink-faint">Running blame…</div>
    );
  }
  if (!lines || lines.length === 0) {
    return (
      <div className="flex-1 p-6 text-xs text-ink-faint">
        No blame data — the file may be untracked or empty.
      </div>
    );
  }
  // Group consecutive lines that share a sha so the gutter only
  // displays the metadata once per group. Greatly improves scanability
  // — without grouping the gutter dominates the view.
  type Group = { sha: string; shortSha: string; author: string; date: string; lines: BlameLine[] };
  const groups: Group[] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last && last.sha === line.sha) {
      last.lines.push(line);
    } else {
      groups.push({
        sha: line.sha,
        shortSha: line.shortSha,
        author: line.author,
        date: formatDateShort(line.authorDate),
        lines: [line],
      });
    }
  }
  return (
    <div className="flex-1 overflow-auto font-mono text-[12px] leading-snug">
      <div className="grid" style={{ gridTemplateColumns: 'auto 1fr' }}>
        {groups.map((g) => (
          <FileBlameGroup key={`${g.sha}:${g.lines[0].lineNumber}`} group={g} />
        ))}
      </div>
    </div>
  );
}

function FileBlameGroup({
  group,
}: {
  group: {
    sha: string;
    shortSha: string;
    author: string;
    date: string;
    lines: BlameLine[];
  };
}): JSX.Element {
  return (
    <>
      <div
        className="border-r border-card px-2 py-1 bg-surface-muted text-[11px] text-ink-faint sticky top-0 self-start"
        title={`${group.sha}\n${group.author}\n${group.date}`}
      >
        <div className="flex items-baseline gap-1.5">
          <span className="text-ink">{group.shortSha}</span>
          <span className="truncate max-w-[110px]" title={group.author}>
            {group.author}
          </span>
        </div>
        <div className="text-[10px]">{group.date}</div>
      </div>
      <pre className="px-2 py-1 m-0 whitespace-pre">
        {group.lines.map((l) => (
          <div key={l.lineNumber} className="flex gap-3">
            <span className="text-ink-faint select-none w-8 text-right shrink-0">
              {l.lineNumber}
            </span>
            <span className="flex-1">{l.content}</span>
          </div>
        ))}
      </pre>
    </>
  );
}

function formatDateShort(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

/// Repo-scoped management surface — three loosely-related domains
/// (tags, remotes, submodules) consolidated in one sheet because each
/// one alone is too small to justify its own entry point. LFS status
/// shows up as a footer badge inside the Submodules tab; LFS doesn't
/// have any per-LFS-pattern operations worth a dedicated tab in v1.
function ManageRepoSheet({
  repoId,
  initialTab,
}: {
  repoId: UUID;
  initialTab: 'tags' | 'remotes' | 'submodules' | 'identity';
}): JSX.Element {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId));
  const setSheet = useStore((s) => s.setSheet);
  const [tab, setTab] = useState(initialTab);

  return (
    <>
      <SheetHeader
        title={`Manage · ${repo?.name ?? ''}`}
        onClose={() => setSheet(null)}
      />
      <div className="flex-shrink-0 px-5 border-b border-card flex gap-2">
        <FileHistoryTab label="Tags" active={tab === 'tags'} onClick={() => setTab('tags')} />
        <FileHistoryTab
          label="Remotes"
          active={tab === 'remotes'}
          onClick={() => setTab('remotes')}
        />
        <FileHistoryTab
          label="Submodules"
          active={tab === 'submodules'}
          onClick={() => setTab('submodules')}
        />
        <FileHistoryTab
          label="Identity"
          active={tab === 'identity'}
          onClick={() => setTab('identity')}
        />
      </div>
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {tab === 'tags' && <TagsPane repoId={repoId} />}
        {tab === 'remotes' && <RemotesPane repoId={repoId} />}
        {tab === 'submodules' && <SubmodulesPane repoId={repoId} />}
        {tab === 'identity' && <IdentityPane repoId={repoId} />}
      </div>
    </>
  );
}

function IdentityPane({ repoId }: { repoId: UUID }): JSX.Element {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId))!;
  const pushToast = useStore((s) => s.pushToast);
  const [resolved, setResolved] = useState<ResolvedIdentity | null>(null);
  const [name, setName] = useState(repo.identity?.name ?? '');
  const [email, setEmail] = useState(repo.identity?.email ?? '');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const r = await window.overgit.invoke('repo:resolveIdentity', repoId);
    setResolved(r);
  };

  useEffect(() => {
    void refresh();
  }, [repoId]);

  // Re-sync the form when the underlying repo.identity changes (e.g.
  // we just saved or cleared).
  useEffect(() => {
    setName(repo.identity?.name ?? '');
    setEmail(repo.identity?.email ?? '');
  }, [repo.identity?.name, repo.identity?.email]);

  const onSave = async () => {
    if (!name.trim() || !email.trim()) return;
    setBusy(true);
    try {
      const identity: Identity = { name: name.trim(), email: email.trim() };
      await window.overgit.invoke('repo:setIdentity', { repoId, identity });
      // Update the renderer-side Repo so other panels see the change
      // without a hydrate round-trip.
      useStore.setState({
        repos: useStore.getState().repos.map((r) =>
          r.id === repoId ? { ...r, identity } : r,
        ),
      });
      pushToast({ kind: 'success', message: 'Per-repo identity saved.' });
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    setBusy(true);
    try {
      await window.overgit.invoke('repo:setIdentity', { repoId, identity: null });
      useStore.setState({
        repos: useStore.getState().repos.map((r) =>
          r.id === repoId ? { ...r, identity: undefined } : r,
        ),
      });
      setName('');
      setEmail('');
      pushToast({ kind: 'success', message: 'Override cleared.' });
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5 text-sm">
      <section className="rounded-lg border border-card bg-card/40 px-4 py-3">
        <div className="text-[10px] uppercase tracking-wide text-ink-faint">
          Resolved identity
        </div>
        {resolved ? (
          <>
            <div className="mt-1 text-sm font-medium">
              {resolved.name || <span className="text-amber-400">(no name)</span>}{' '}
              <span className="text-ink-faint font-mono text-[11px]">
                &lt;{resolved.email || '(no email)'}&gt;
              </span>
            </div>
            <div className="mt-1 text-[11px] text-ink-faint">
              Source: <IdentitySourceLabel source={resolved.source} />
            </div>
          </>
        ) : (
          <div className="mt-1 text-[11px] text-ink-faint">Resolving…</div>
        )}
      </section>

      <section>
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">
          Override
        </div>
        <div className="mt-0.5 text-[13px] font-semibold text-ink leading-tight">
          Per-repo author / committer
        </div>
        <div className="mt-1 text-[11px] leading-snug text-ink-faint">
          Pins every commit overgit makes in this repo to the values below — wins over the
          repo's local git config and the global default. Leave blank to fall back through
          the precedence chain (repo's .git/config → global default → system git).
        </div>

        <div className="mt-3 flex flex-col gap-2 max-w-md">
          <label className="text-[11px] uppercase tracking-wide text-ink-faint">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Author name"
            className="field px-2 py-1.5 text-sm"
          />
          <label className="text-[11px] uppercase tracking-wide text-ink-faint mt-2">Email</label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="field px-2 py-1.5 text-sm"
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={onSave}
              disabled={busy || !name.trim() || !email.trim()}
              className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
            >
              Save override
            </button>
            {repo.identity && (
              <button
                onClick={onClear}
                disabled={busy}
                className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card disabled:opacity-50"
              >
                Clear override
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function IdentitySourceLabel({
  source,
}: {
  source: ResolvedIdentity['source'];
}): JSX.Element {
  const map: Record<ResolvedIdentity['source'], { label: string; tone: string }> = {
    override: { label: 'per-repo override', tone: 'text-emerald-400' },
    'repo-config': { label: "repo's .git/config", tone: 'text-ink' },
    'global-default': { label: 'overgit global default', tone: 'text-accent' },
    system: { label: 'system git config', tone: 'text-amber-400' },
    unset: { label: 'NOT SET — commits will fail', tone: 'text-red-400' },
  };
  const v = map[source];
  return <span className={`font-mono ${v.tone}`}>{v.label}</span>;
}

function TagsPane({ repoId }: { repoId: UUID }): JSX.Element {
  const pushToast = useStore((s) => s.pushToast);
  const requestConfirm = useStore((s) => s.requestConfirm);
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const rows = await window.overgit.invoke('repo:listTags', repoId);
    setTags(rows);
  };

  useEffect(() => {
    void refresh();
  }, [repoId]);

  const onCreate = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await window.overgit.invoke('repo:createTag', {
        repoId,
        name: name.trim(),
        ref: null,
        message: message.trim() ? message : null,
      });
      if (!res.ok) {
        pushToast({ kind: 'error', message: res.error ?? 'Tag failed' });
        return;
      }
      setName('');
      setMessage('');
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (tag: Tag) => {
    const ok = await requestConfirm({
      title: `Delete tag ${tag.name}?`,
      body: `Delete the local tag "${tag.name}"? Remote copies are not affected.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    const res = await window.overgit.invoke('repo:deleteTag', { repoId, name: tag.name });
    if (!res.ok) {
      pushToast({ kind: 'error', message: res.error ?? 'Delete failed' });
      return;
    }
    void refresh();
  };

  const onPush = async (tag: Tag) => {
    const res = await window.overgit.invoke('repo:pushTag', {
      repoId,
      name: tag.name,
      remote: 'origin',
    });
    if (!res.ok) {
      pushToast({ kind: 'error', message: res.error ?? 'Push failed' });
    } else {
      pushToast({ kind: 'success', message: `Pushed ${tag.name} to origin.` });
    }
  };

  return (
    <>
      <div className="px-5 py-4 border-b border-card flex flex-col gap-2">
        <div className="text-[10px] uppercase tracking-wide text-ink-faint">
          New tag at HEAD
        </div>
        <div className="flex gap-2 items-center">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="tag name (e.g. v1.2.0)"
            disabled={busy}
            className="field flex-1 px-2 py-1.5 text-xs"
          />
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="annotation (optional → annotated tag)"
            disabled={busy}
            className="field flex-1 px-2 py-1.5 text-xs"
          />
          <button
            onClick={onCreate}
            disabled={busy || !name.trim()}
            className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {tags === null ? (
          <div className="text-xs text-ink-faint p-3">Loading tags…</div>
        ) : tags.length === 0 ? (
          <div className="text-xs text-ink-faint p-3">No tags yet.</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {tags.map((t) => (
              <li
                key={t.name}
                className="flex items-center gap-2 px-3 py-1.5 rounded border border-card bg-card text-xs group"
              >
                <span
                  className={
                    t.kind === 'annotated' ? 'text-accent' : 'text-ink-faint'
                  }
                  title={t.kind}
                >
                  {t.kind === 'annotated' ? '⚑' : '◇'}
                </span>
                <span className="font-mono w-44 truncate" title={t.name}>
                  {t.name}
                </span>
                <span className="font-mono text-[10px] text-ink-faint shrink-0">
                  {t.shortSha}
                </span>
                <span
                  className="truncate flex-1 text-ink-faint"
                  title={t.subject}
                >
                  {t.subject}
                </span>
                <span className="text-[10px] text-ink-faint shrink-0">
                  {t.date.slice(0, 10)}
                </span>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => onPush(t)}
                    className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-card hover:bg-card text-ink-muted hover:text-ink"
                    title="git push origin <tag>"
                  >
                    Push
                  </button>
                  <button
                    onClick={() => onDelete(t)}
                    className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/10"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function RemotesPane({ repoId }: { repoId: UUID }): JSX.Element {
  const pushToast = useStore((s) => s.pushToast);
  const requestConfirm = useStore((s) => s.requestConfirm);
  const [remotes, setRemotes] = useState<Remote[] | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const rows = await window.overgit.invoke('repo:listRemotes', repoId);
    setRemotes(rows);
  };
  useEffect(() => {
    void refresh();
  }, [repoId]);

  const onAdd = async () => {
    if (!name.trim() || !url.trim()) return;
    setBusy(true);
    try {
      const res = await window.overgit.invoke('repo:addRemote', {
        repoId,
        name: name.trim(),
        url: url.trim(),
      });
      if (!res.ok) {
        pushToast({ kind: 'error', message: res.error ?? 'Add failed' });
        return;
      }
      setName('');
      setUrl('');
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (r: Remote) => {
    const ok = await requestConfirm({
      title: `Remove remote ${r.name}?`,
      body: `Delete the remote "${r.name}"? Branches that track it will lose their upstream.`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    const res = await window.overgit.invoke('repo:removeRemote', {
      repoId,
      name: r.name,
    });
    if (!res.ok) {
      pushToast({ kind: 'error', message: res.error ?? 'Remove failed' });
      return;
    }
    void refresh();
  };

  return (
    <>
      <div className="px-5 py-4 border-b border-card flex flex-col gap-2">
        <div className="text-[10px] uppercase tracking-wide text-ink-faint">
          Add remote
        </div>
        <div className="flex gap-2 items-center">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name (e.g. origin)"
            disabled={busy}
            className="field flex-1 px-2 py-1.5 text-xs"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="git@github.com:user/repo.git"
            disabled={busy}
            className="field flex-[2] px-2 py-1.5 text-xs font-mono"
          />
          <button
            onClick={onAdd}
            disabled={busy || !name.trim() || !url.trim()}
            className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {remotes === null ? (
          <div className="text-xs text-ink-faint p-3">Loading remotes…</div>
        ) : remotes.length === 0 ? (
          <div className="text-xs text-ink-faint p-3">No remotes configured.</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {remotes.map((r) => (
              <li
                key={r.name}
                className="flex flex-col gap-1 px-3 py-2 rounded border border-card bg-card text-xs group"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono w-24 truncate">{r.name}</span>
                  <span className="text-[10px] uppercase tracking-wide text-ink-faint">
                    fetch
                  </span>
                  <RemoteUrlInput
                    repoId={repoId}
                    name={r.name}
                    initial={r.fetchUrl}
                    kind="fetch"
                    onSaved={refresh}
                  />
                  <button
                    onClick={() => onRemove(r)}
                    className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/10 ml-auto opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    Remove
                  </button>
                </div>
                {r.pushUrl !== r.fetchUrl && (
                  <div className="flex items-center gap-2 pl-[7.25rem]">
                    <span className="text-[10px] uppercase tracking-wide text-ink-faint">
                      push
                    </span>
                    <RemoteUrlInput
                      repoId={repoId}
                      name={r.name}
                      initial={r.pushUrl}
                      kind="push"
                      onSaved={refresh}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function RemoteUrlInput({
  repoId,
  name,
  initial,
  kind,
  onSaved,
}: {
  repoId: UUID;
  name: string;
  initial: string;
  kind: 'fetch' | 'push';
  onSaved: () => void;
}): JSX.Element {
  const pushToast = useStore((s) => s.pushToast);
  const [url, setUrl] = useState(initial);
  const [busy, setBusy] = useState(false);
  // Reset local state when the prop URL changes (e.g. after refresh).
  useEffect(() => {
    setUrl(initial);
  }, [initial]);

  const onSave = async () => {
    if (url.trim() === initial) return;
    setBusy(true);
    try {
      const res = await window.overgit.invoke('repo:setRemoteUrl', {
        repoId,
        name,
        url: url.trim(),
        kind,
      });
      if (!res.ok) {
        pushToast({ kind: 'error', message: res.error ?? 'Update failed' });
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <input
      value={url}
      onChange={(e) => setUrl(e.target.value)}
      onBlur={onSave}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      disabled={busy}
      className="field flex-1 px-2 py-1 text-xs font-mono"
    />
  );
}

function SubmodulesPane({ repoId }: { repoId: UUID }): JSX.Element {
  const [submodules, setSubmodules] = useState<Submodule[] | null>(null);
  const [lfs, setLfs] = useState<LfsStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.overgit.invoke('repo:listSubmodules', repoId),
      window.overgit.invoke('repo:lfsStatus', repoId),
    ]).then(([sm, l]) => {
      if (!cancelled) {
        setSubmodules(sm);
        setLfs(l);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  return (
    <>
      <div className="flex-1 overflow-y-auto p-3">
        {submodules === null ? (
          <div className="text-xs text-ink-faint p-3">Loading…</div>
        ) : submodules.length === 0 ? (
          <div className="text-xs text-ink-faint p-3">
            No submodules. Initialize one with{' '}
            <span className="font-mono">git submodule add</span> in a terminal.
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {submodules.map((sm) => (
              <li
                key={sm.path}
                className="flex items-center gap-2 px-3 py-1.5 rounded border border-card bg-card text-xs"
              >
                <SubmoduleStateBadge state={sm.state} />
                <span className="font-mono truncate flex-1" title={sm.path}>
                  {sm.path}
                </span>
                <span className="font-mono text-[10px] text-ink-faint">
                  {sm.shortSha}
                </span>
                {sm.describe && (
                  <span className="text-[10px] text-ink-faint">{sm.describe}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {lfs && (
        <div className="px-5 py-3 border-t border-card text-[11px] text-ink-faint flex items-center gap-2">
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
              lfs.enabled
                ? 'border-accent/50 text-accent'
                : 'border-card text-ink-faint'
            }`}
          >
            LFS {lfs.enabled ? 'enabled' : 'off'}
          </span>
          {lfs.enabled
            ? `${lfs.patternCount} ${lfs.patternCount === 1 ? 'pattern' : 'patterns'} routed through filter=lfs in .gitattributes.`
            : 'No filter=lfs entries in .gitattributes.'}
        </div>
      )}
    </>
  );
}

function SubmoduleStateBadge({
  state,
}: {
  state: Submodule['state'];
}): JSX.Element {
  const map: Record<Submodule['state'], { label: string; cls: string }> = {
    'up-to-date': { label: '✓', cls: 'text-emerald-400' },
    modified: { label: '+', cls: 'text-amber-400' },
    uninitialized: { label: '−', cls: 'text-ink-faint' },
    conflict: { label: 'U', cls: 'text-red-400' },
  };
  const { label, cls } = map[state];
  return <span className={`font-mono w-3 ${cls}`} title={state}>{label}</span>;
}

function RepoPickRow({
  repo,
  picked,
  onToggle,
  tag,
}: {
  repo: Repo;
  picked: boolean;
  onToggle: () => void;
  tag?: string | null;
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
      {tag && (
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/20 text-accent shrink-0">
          {tag}
        </span>
      )}
    </label>
  );
}

/// Hunk-level 3-way conflict resolver.
///
/// Reads the conflicted file from disk, parses its `<<<<<<<` /
/// `=======` / `>>>>>>>` regions into hunks, and lets the user pick
/// "Ours", "Theirs", or "Both" for each region — or edit the result
/// inline. The non-conflicted slices around each hunk render plainly so
/// the user can see context. On Save we serialize the resolution back
/// to the file and `git add` it so the conflict banner ticks down.
///
/// Diff3 markers (`|||||||` for the merge base) are preserved in the
/// "ours" half so they don't leak into the saved output but still let
/// us recover the base text if we want to render it later.
interface ConflictHunk {
  ours: string;
  theirs: string;
  base: string | null;
  /// Header text after the conflict marker (e.g. branch name git wrote).
  oursLabel: string;
  theirsLabel: string;
  /// User's choice. 'edit' means `editText` overrides everything.
  choice: 'ours' | 'theirs' | 'both' | 'edit' | null;
  /// When `choice === 'both'`, which side comes first in the merged
  /// output. Default 'ours' so the "ours then theirs" reading order
  /// matches how `<<<<<<<` and `>>>>>>>` typically frame the conflict.
  bothOrder: 'ours' | 'theirs';
  editText: string;
}

interface ParsedConflict {
  /// Alternating literal-string + hunk slices. Index even = string,
  /// odd = hunk. Lets us render in document order without an extra
  /// position field.
  segments: Array<string | ConflictHunk>;
  /// Indexes into `segments` of every hunk for fast iteration.
  hunkIndexes: number[];
}

function parseConflicts(text: string): ParsedConflict {
  const segments: Array<string | ConflictHunk> = [];
  const hunkIndexes: number[] = [];
  const lines = text.split('\n');
  let buf: string[] = [];
  let i = 0;
  const flushString = () => {
    segments.push(buf.join('\n'));
    buf = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('<<<<<<<')) {
      flushString();
      const oursLabel = line.slice(7).trim();
      const oursLines: string[] = [];
      const baseLines: string[] = [];
      const theirsLines: string[] = [];
      let theirsLabel = '';
      let phase: 'ours' | 'base' | 'theirs' = 'ours';
      i += 1;
      while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
        const l = lines[i];
        if (l.startsWith('|||||||')) {
          phase = 'base';
        } else if (l.startsWith('=======')) {
          phase = 'theirs';
        } else if (phase === 'ours') {
          oursLines.push(l);
        } else if (phase === 'base') {
          baseLines.push(l);
        } else {
          theirsLines.push(l);
        }
        i += 1;
      }
      if (i < lines.length) {
        theirsLabel = lines[i].slice(7).trim();
        i += 1;
      }
      const hunk: ConflictHunk = {
        ours: oursLines.join('\n'),
        theirs: theirsLines.join('\n'),
        base: phase === 'base' || baseLines.length > 0 ? baseLines.join('\n') : null,
        oursLabel,
        theirsLabel,
        choice: null,
        bothOrder: 'ours',
        editText: '',
      };
      hunkIndexes.push(segments.length);
      segments.push(hunk);
    } else {
      buf.push(line);
      i += 1;
    }
  }
  flushString();
  return { segments, hunkIndexes };
}

function serializeResolution(parsed: ParsedConflict): {
  text: string;
  unresolved: number;
} {
  const out: string[] = [];
  let unresolved = 0;
  for (const seg of parsed.segments) {
    if (typeof seg === 'string') {
      out.push(seg);
      continue;
    }
    if (seg.choice === 'ours') out.push(seg.ours);
    else if (seg.choice === 'theirs') out.push(seg.theirs);
    else if (seg.choice === 'both') {
      const first = seg.bothOrder === 'ours' ? seg.ours : seg.theirs;
      const second = seg.bothOrder === 'ours' ? seg.theirs : seg.ours;
      out.push(`${first}\n${second}`);
    } else if (seg.choice === 'edit') out.push(seg.editText);
    else {
      unresolved += 1;
      // Re-emit the conflict markers so the file remains a valid
      // conflict file if the user saves with unresolved hunks (we
      // disable Save in that case, but be safe).
      out.push(`<<<<<<< ${seg.oursLabel}`);
      out.push(seg.ours);
      if (seg.base !== null) {
        out.push(`||||||| base`);
        out.push(seg.base);
      }
      out.push(`=======`);
      out.push(seg.theirs);
      out.push(`>>>>>>> ${seg.theirsLabel}`);
    }
  }
  return { text: out.join('\n'), unresolved };
}

/// AI preview state for ResolveConflictSheet. `idle` = no proposal yet
/// (manual editing mode); `busy` = CLI in flight; `done`/`error` =
/// terminal preview the user can accept or reject.
type AiPreview =
  | { kind: 'idle' }
  | { kind: 'busy'; tool: LlmTool }
  | { kind: 'done'; tool: LlmTool; content: string }
  | { kind: 'error'; tool: LlmTool; message: string; partial: string };

function ResolveConflictSheet({
  repoId,
  path,
}: {
  repoId: UUID;
  path: string;
}): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId));
  const markResolved = useStore((s) => s.markResolved);
  const pushToast = useStore((s) => s.pushToast);
  const refreshStatus = useStore((s) => s.refreshRepoStatus);
  const refreshChanges = useStore((s) => s.refreshRepoChanges);
  const cli = useStore((s) => s.cliPresence);

  const aiTool: LlmTool | null = useMemo(() => {
    if (cli?.claude) return 'claude';
    if (cli?.codex) return 'codex';
    if (cli?.gemini) return 'gemini';
    return null;
  }, [cli]);

  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedConflict | null>(null);
  const [saving, setSaving] = useState(false);
  const [ai, setAi] = useState<AiPreview>({ kind: 'idle' });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const firstHunkRef = useRef<HTMLDivElement | null>(null);

  // First *unresolved* hunk index — drives the auto-scroll on mount and
  // the "Jump to next" button in the toolbar. Recomputed when the user
  // makes a choice so "next" walks forward through the file.
  const firstUnresolvedIdx = useMemo(() => {
    if (!parsed) return -1;
    for (const idx of parsed.hunkIndexes) {
      const seg = parsed.segments[idx];
      if (typeof seg === 'string') continue;
      if (seg.choice === null) return idx;
    }
    return -1;
  }, [parsed]);

  // Scroll the first unresolved hunk into view once the file finishes
  // parsing. Without this, large files (like the user's Java enum with
  // thousands of context lines) would show the literal preamble and
  // the conflict region would be way below the fold.
  useEffect(() => {
    if (!parsed || firstUnresolvedIdx < 0) return;
    requestAnimationFrame(() => {
      firstHunkRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, [parsed, firstUnresolvedIdx]);

  // Resolve the absolute path the same way the editor does — repo root
  // joined with the repo-relative path. fs:readFile expects the rel path.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRaw(null);
    setParsed(null);
    void window.overgit
      .invoke('fs:readFile', { repoId, path })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setRaw(res.content);
        setParsed(parseConflicts(res.content));
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, path]);

  const setHunkChoice = (idx: number, choice: ConflictHunk['choice']) => {
    setParsed((cur) => {
      if (!cur) return cur;
      const next = { ...cur, segments: cur.segments.slice() };
      const seg = next.segments[idx];
      if (typeof seg === 'string') return cur;
      const updated: ConflictHunk = { ...seg, choice };
      // Seed the edit buffer when entering edit mode so the user has
      // something to start from rather than an empty textarea.
      if (choice === 'edit' && !seg.editText) {
        updated.editText = seg.ours;
      }
      next.segments[idx] = updated;
      return next;
    });
  };

  const setHunkEdit = (idx: number, text: string) => {
    setParsed((cur) => {
      if (!cur) return cur;
      const next = { ...cur, segments: cur.segments.slice() };
      const seg = next.segments[idx];
      if (typeof seg === 'string') return cur;
      next.segments[idx] = { ...seg, editText: text };
      return next;
    });
  };

  const swapBothOrder = (idx: number) => {
    setParsed((cur) => {
      if (!cur) return cur;
      const next = { ...cur, segments: cur.segments.slice() };
      const seg = next.segments[idx];
      if (typeof seg === 'string') return cur;
      next.segments[idx] = {
        ...seg,
        bothOrder: seg.bothOrder === 'ours' ? 'theirs' : 'ours',
      };
      return next;
    });
  };

  const onResolveAll = (side: 'ours' | 'theirs') => {
    setParsed((cur) => {
      if (!cur) return cur;
      const next = { ...cur, segments: cur.segments.slice() };
      for (const idx of cur.hunkIndexes) {
        const seg = next.segments[idx];
        if (typeof seg === 'string') continue;
        next.segments[idx] = { ...seg, choice: side };
      }
      return next;
    });
  };

  const summary = useMemo(() => {
    if (!parsed) return { total: 0, resolved: 0 };
    let resolved = 0;
    for (const idx of parsed.hunkIndexes) {
      const seg = parsed.segments[idx];
      if (typeof seg === 'string') continue;
      if (seg.choice !== null) resolved += 1;
    }
    return { total: parsed.hunkIndexes.length, resolved };
  }, [parsed]);

  const allResolved = parsed !== null && summary.resolved === summary.total && summary.total > 0;
  const noConflicts = parsed !== null && summary.total === 0;

  const runAi = async () => {
    if (!aiTool) return;
    setAi({ kind: 'busy', tool: aiTool });
    const res = await window.overgit.invoke('cli:resolveConflict', {
      repoId,
      path,
      tool: aiTool,
    });
    if (!res.ok) {
      setAi({
        kind: 'error',
        tool: res.tool,
        message: res.error ?? 'CLI failed',
        partial: res.content,
      });
      return;
    }
    setAi({ kind: 'done', tool: res.tool, content: res.content });
  };

  const writeAndMarkResolved = async (content: string) => {
    setSaving(true);
    try {
      const writeRes = await window.overgit.invoke('fs:writeFile', {
        repoId,
        path,
        content,
      });
      if (!writeRes.ok) {
        pushToast({ kind: 'error', message: writeRes.error ?? 'Write failed' });
        return;
      }
      const addRes = await markResolved(repoId, [path]);
      if (!addRes.ok) {
        pushToast({ kind: 'error', message: addRes.error ?? 'git add failed' });
        return;
      }
      await Promise.all([refreshStatus(repoId), refreshChanges(repoId)]);
      pushToast({ kind: 'success', message: `Resolved ${path}.` });
      setSheet(null);
    } finally {
      setSaving(false);
    }
  };

  const onSave = async () => {
    if (!parsed) return;
    const { text, unresolved } = serializeResolution(parsed);
    if (unresolved > 0) return;
    await writeAndMarkResolved(text);
  };

  const onAcceptAi = async () => {
    if (ai.kind !== 'done') return;
    await writeAndMarkResolved(ai.content);
  };

  return (
    <>
      <SheetHeader title={`Resolve conflicts — ${path}`} onClose={() => setSheet(null)} />
      <div className="px-5 py-2 border-b border-card flex items-center gap-2 text-[11px]">
        <span className="text-ink-muted">
          {ai.kind === 'busy'
            ? `Drafting resolution with ${ai.tool}…`
            : ai.kind === 'done'
              ? `Proposed by ${ai.tool} — review the diff below.`
              : ai.kind === 'error'
                ? `${ai.tool} could not resolve: ${ai.message}`
                : summary.total === 0
                  ? 'No conflict markers found in this file.'
                  : `${summary.resolved}/${summary.total} hunks resolved`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {aiTool && ai.kind !== 'done' && (
            <button
              disabled={summary.total === 0 || ai.kind === 'busy'}
              onClick={runAi}
              className="px-2 py-1 rounded border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50"
              title={`Ask ${aiTool} to propose a full-file resolution (you'll review before it's written)`}
            >
              {ai.kind === 'busy' ? `Drafting with ${ai.tool}…` : `✨ Resolve with ${aiTool}`}
            </button>
          )}
          {ai.kind === 'idle' && (
            <>
              <button
                disabled={firstUnresolvedIdx < 0}
                onClick={() =>
                  firstHunkRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                }
                className="px-2 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
                title="Scroll to the next unresolved hunk"
              >
                Jump to next
              </button>
              <button
                disabled={summary.total === 0}
                onClick={() => onResolveAll('ours')}
                className="px-2 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
                title="Take HEAD's version for every hunk"
              >
                Take all ours
              </button>
              <button
                disabled={summary.total === 0}
                onClick={() => onResolveAll('theirs')}
                className="px-2 py-1 rounded border border-card hover:bg-card disabled:opacity-50"
                title="Take the merging branch's version for every hunk"
              >
                Take all theirs
              </button>
            </>
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-5 py-3 flex flex-col gap-2 font-mono text-[11px] leading-snug"
      >
        {error && (
          <div className="px-3 py-2 rounded border border-red-500/30 bg-red-500/10 text-red-300 text-xs">
            {error}
          </div>
        )}
        {ai.kind === 'idle' && parsed && noConflicts && (
          <div className="px-3 py-2 rounded border border-card bg-card text-xs text-ink-faint">
            This file has no conflict markers. It may have been resolved already — close this
            and click "Mark resolved" in the conflict banner.
          </div>
        )}
        {ai.kind === 'idle' &&
          parsed?.segments.map((seg, idx) => {
            if (typeof seg === 'string') {
              if (!seg) return null;
              // Truncate context segments to 3 lines top + 3 lines bottom
              // by default — the conflict hunk is what the user came here
              // for, so we don't bury it under thousands of unrelated lines.
              const isFirst = idx === 0;
              const isLast = idx === (parsed?.segments.length ?? 0) - 1;
              return (
                <ContextSegment
                  key={`s-${idx}`}
                  text={seg}
                  showLeading={!isFirst}
                  showTrailing={!isLast}
                />
              );
            }
            return (
              <ConflictHunkBlock
                key={`h-${idx}`}
                hunk={seg}
                hunkRef={idx === firstUnresolvedIdx ? firstHunkRef : undefined}
                onChoice={(c) => setHunkChoice(idx, c)}
                onEdit={(t) => setHunkEdit(idx, t)}
                onSwapBoth={() => swapBothOrder(idx)}
              />
            );
          })}
        {ai.kind === 'busy' && (
          <div className="px-3 py-6 text-center text-ink-muted text-xs">
            Asking {ai.tool} to propose a resolution… (up to 90s)
          </div>
        )}
        {ai.kind === 'error' && (
          <div className="px-3 py-2 rounded border border-red-500/30 bg-red-500/10 text-red-300 text-xs whitespace-pre-wrap">
            {ai.message}
            {ai.partial && (
              <>
                <div className="mt-2 text-ink-faint">Partial output:</div>
                <pre className="mt-1 whitespace-pre-wrap text-ink-muted">{ai.partial}</pre>
              </>
            )}
          </div>
        )}
        {ai.kind === 'done' && raw !== null && (
          <AiResolutionPreview original={raw} proposed={ai.content} />
        )}
        {raw === null && !error && (
          <div className="text-xs text-ink-faint">Loading file…</div>
        )}
      </div>
      <div className="px-5 py-3 border-t border-card flex items-center justify-end gap-2">
        <span className="text-[11px] text-ink-faint mr-auto truncate font-mono">
          {repo?.path ? `${repo.path}/${path}` : path}
        </span>
        {ai.kind === 'done' ? (
          <>
            <button
              onClick={() => setAi({ kind: 'idle' })}
              className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
            >
              Reject &amp; edit manually
            </button>
            <button
              disabled={saving}
              onClick={onAcceptAi}
              className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
            >
              {saving ? 'Saving…' : `Accept ${ai.tool}'s resolution`}
            </button>
          </>
        ) : ai.kind === 'error' ? (
          <>
            <button
              onClick={() => setAi({ kind: 'idle' })}
              className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
            >
              Back to manual
            </button>
            <button
              onClick={runAi}
              className="text-xs px-3 py-1.5 rounded border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setSheet(null)}
              className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
            >
              Cancel
            </button>
            <button
              disabled={!allResolved || saving || ai.kind === 'busy'}
              onClick={onSave}
              className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save & mark resolved'}
            </button>
          </>
        )}
      </div>
    </>
  );
}

/// Side-by-side preview of the AI's proposed resolution. We don't pull
/// in a diff library — for conflict resolution review the user mostly
/// wants to scan the final result, with the original (markers included)
/// next to it for quick cross-reference. Lines that don't appear in the
/// original at all are tinted green to draw the eye to actually-new code.
function AiResolutionPreview({
  original,
  proposed,
}: {
  original: string;
  proposed: string;
}): JSX.Element {
  const originalLineSet = useMemo(() => new Set(original.split('\n')), [original]);
  const proposedLines = useMemo(() => proposed.split('\n'), [proposed]);
  const originalLines = useMemo(() => original.split('\n'), [original]);

  return (
    <div className="grid grid-cols-2 gap-3 min-h-0">
      <div className="flex flex-col min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-ink-faint mb-1 px-1">
          Current (with conflict markers)
        </div>
        <pre className="whitespace-pre-wrap text-ink-muted bg-card/40 px-3 py-2 rounded border border-card overflow-x-auto">
          {originalLines.map((line, i) => {
            const marker =
              line.startsWith('<<<<<<<') ||
              line.startsWith('=======') ||
              line.startsWith('>>>>>>>') ||
              line.startsWith('|||||||');
            return (
              <div
                key={i}
                className={marker ? 'bg-red-500/20 text-red-200 -mx-3 px-3' : undefined}
              >
                {line || ' '}
              </div>
            );
          })}
        </pre>
      </div>
      <div className="flex flex-col min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-ink-faint mb-1 px-1">
          Proposed resolution
        </div>
        <pre className="whitespace-pre-wrap text-ink-muted bg-card/40 px-3 py-2 rounded border border-card overflow-x-auto">
          {proposedLines.map((line, i) => {
            const isNew = line.trim() !== '' && !originalLineSet.has(line);
            return (
              <div
                key={i}
                className={isNew ? 'bg-emerald-500/15 text-emerald-100 -mx-3 px-3' : undefined}
              >
                {line || ' '}
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}

/// Collapsed-by-default literal context around a conflict hunk.
/// We show 3 lines on the leading edge and 3 lines on the trailing edge
/// — adjacent to a hunk those lines are the most informative — and hide
/// the middle behind an "Expand N lines" toggle. The first segment in
/// the file gets only a trailing tail (nothing before it is "context"),
/// and the last segment gets only a leading head.
function ContextSegment({
  text,
  showLeading,
  showTrailing,
}: {
  text: string;
  showLeading: boolean;
  showTrailing: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split('\n');
  const CONTEXT = 3;
  const head = showLeading ? lines.slice(0, CONTEXT) : [];
  const tail = showTrailing ? lines.slice(-CONTEXT) : [];
  const overlap = head.length + tail.length >= lines.length;
  if (expanded || overlap) {
    return (
      <pre className="whitespace-pre-wrap text-ink-muted bg-card/40 px-3 py-2 rounded border border-card">
        {text}
      </pre>
    );
  }
  const hidden = lines.length - head.length - tail.length;
  return (
    <div className="flex flex-col">
      {head.length > 0 && (
        <pre className="whitespace-pre-wrap text-ink-muted bg-card/40 px-3 py-2 rounded-t border border-b-0 border-card">
          {head.join('\n')}
        </pre>
      )}
      {hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="text-[10px] uppercase tracking-wide text-ink-faint hover:text-ink bg-card/30 hover:bg-card border-x border-card px-3 py-1 text-left"
        >
          ⤢ Expand {hidden} more {hidden === 1 ? 'line' : 'lines'}
        </button>
      )}
      {tail.length > 0 && (
        <pre className="whitespace-pre-wrap text-ink-muted bg-card/40 px-3 py-2 rounded-b border border-t-0 border-card">
          {tail.join('\n')}
        </pre>
      )}
    </div>
  );
}

function ConflictHunkBlock({
  hunk,
  hunkRef,
  onChoice,
  onEdit,
  onSwapBoth,
}: {
  hunk: ConflictHunk;
  hunkRef?: React.Ref<HTMLDivElement>;
  onChoice: (c: ConflictHunk['choice']) => void;
  onEdit: (t: string) => void;
  onSwapBoth: () => void;
}): JSX.Element {
  const oursActive = hunk.choice === 'ours';
  const theirsActive = hunk.choice === 'theirs';
  const bothActive = hunk.choice === 'both';
  const editActive = hunk.choice === 'edit';
  const cls = (active: boolean) =>
    `text-[10px] px-2 py-1 rounded border ${
      active
        ? 'border-accent bg-accent/15 text-ink'
        : 'border-card hover:bg-card text-ink-muted'
    }`;
  // When Both is active, render the panes in the saved order so the
  // numbered "1" / "2" badges and the visual reading order both match
  // what will end up in the file. Default to ours-first.
  const oursFirst = hunk.bothOrder === 'ours';
  return (
    <div
      ref={hunkRef}
      style={{ scrollMarginTop: 60 }}
      className="rounded border-2 border-amber-500/40 bg-amber-500/[0.04] overflow-hidden shadow-lg"
    >
      <div className="flex items-center gap-1 px-2 py-1 border-b border-amber-500/30 bg-amber-500/10">
        <span className="text-[10px] uppercase tracking-wide text-amber-300 font-sans font-semibold">
          Conflict
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => onChoice('ours')} className={cls(oursActive)}>
            Take ours
          </button>
          <button onClick={() => onChoice('theirs')} className={cls(theirsActive)}>
            Take theirs
          </button>
          <button
            onClick={() => onChoice('both')}
            className={cls(bothActive)}
            title="Keep both sides — concatenated in the chosen order"
          >
            Keep both
          </button>
          <button onClick={() => onChoice('edit')} className={cls(editActive)}>
            Edit
          </button>
        </div>
      </div>
      {editActive ? (
        <textarea
          value={hunk.editText}
          onChange={(e) => onEdit(e.target.value)}
          rows={Math.max(3, Math.min(20, (hunk.editText.match(/\n/g)?.length ?? 0) + 1))}
          className="w-full bg-surface-elevated px-3 py-2 outline-none resize-y font-mono text-[11px]"
          placeholder="Edit the resolved text…"
        />
      ) : (
        <>
          {/* Side-by-side ours vs theirs. When `bothActive` we re-order
              the panes so the leftmost pane is what's saved first; that
              way the visual order matches the file order. The numbered
              badges hammer it home for users skimming. */}
          <div className="grid grid-cols-2 divide-x divide-amber-500/20">
            {(oursFirst || !bothActive
              ? (['ours', 'theirs'] as const)
              : (['theirs', 'ours'] as const)
            ).map((side) => {
              const isOurs = side === 'ours';
              const active = isOurs ? oursActive : theirsActive;
              const tint = isOurs ? 'bg-emerald-500/[0.06]' : 'bg-sky-500/[0.06]';
              const label = isOurs ? 'Ours' : 'Theirs';
              const subLabel = isOurs ? hunk.oursLabel : hunk.theirsLabel;
              const text = isOurs ? hunk.ours : hunk.theirs;
              const labelTone = isOurs ? 'text-emerald-300' : 'text-sky-300';
              const order = bothActive
                ? side === (oursFirst ? 'ours' : 'theirs')
                  ? 1
                  : 2
                : null;
              return (
                <div
                  key={side}
                  className={`p-3 ${active || bothActive ? tint : ''}`}
                >
                  <div className={`flex items-center gap-2 mb-1 ${labelTone}`}>
                    {order !== null && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-card text-ink font-bold">
                        {order}
                      </span>
                    )}
                    <span className="text-[10px] uppercase tracking-wide font-sans">
                      {label}
                      {subLabel ? ` · ${subLabel}` : ''}
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap text-ink">{text || '(empty)'}</pre>
                </div>
              );
            })}
          </div>
          {bothActive && (
            <div className="border-t border-amber-500/30 bg-amber-500/[0.06]">
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-amber-500/20">
                <span className="text-[10px] uppercase tracking-wide text-ink font-sans font-semibold">
                  Result preview
                </span>
                <span className="text-[10px] text-ink-faint">
                  Saved as: {oursFirst ? 'ours, then theirs' : 'theirs, then ours'}
                </span>
                <button
                  onClick={onSwapBoth}
                  className="ml-auto text-[10px] px-2 py-0.5 rounded border border-card hover:bg-card text-ink-muted"
                  title="Swap the order — put the other side first"
                >
                  ⇄ Swap order
                </button>
              </div>
              <pre className="whitespace-pre-wrap text-ink px-3 py-2 bg-surface-elevated/40">
                {(() => {
                  const first = oursFirst ? hunk.ours : hunk.theirs;
                  const second = oursFirst ? hunk.theirs : hunk.ours;
                  return `${first}\n${second}`;
                })()}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
