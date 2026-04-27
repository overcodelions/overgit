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
            ? 'w-[760px] max-w-[92vw] h-[85vh]'
            : sheet.kind === 'about'
              ? 'w-[720px] max-w-[92vw] max-h-[85vh]'
              : sheet.kind === 'settings'
                ? 'w-[760px] max-w-[92vw] h-[80vh]'
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

type SettingsTab = 'general' | 'ai' | 'repos' | 'shortcuts';

const SETTINGS_TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: 'general', label: 'General', hint: 'Theme, library' },
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
  const workspaces = useStore((s) => s.workspaces);

  const updateTheme = async (theme: 'light' | 'dark' | 'system') => {
    const next = { ...settings, theme };
    useStore.setState({ settings: next });
    await window.overgit.invoke('store:saveSettings', next);
    applyTheme(theme);
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
        eyebrow="State"
        title="Library"
        subtitle="What overgit currently tracks. Nothing is written into your repos."
      >
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Repos" value={repos.length.toString()} />
          <Stat label="Workspaces" value={workspaces.length.toString()} />
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
        subtitle="Each repo's trunk — the branch overgit treats as the base for compare/PR-base and as the recovery target during a workspace sync-and-branch. Auto-detected from origin/HEAD on add."
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
          <ShortcutRow keys="⌘ N" what="New branch (in a workspace)" />
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
  const steps = [
    {
      title: 'Add a repo',
      body:
        'Overgit records the path in its own store. Your repo on disk is untouched — we never write inside .git.',
    },
    {
      title: 'Group into a workspace',
      body:
        'A workspace is a named list of repo IDs. No symlinks, no synthetic root — just a coordinator that fans operations out.',
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
    title: 'Workspaces, not single repos.',
    body:
      'Group polyrepo services into one workspace and switch them onto the same branch in one go. Status, PRs, and pull/push fan out across every member.',
  },
  {
    color: '#5eead4',
    kicker: 'Overlay',
    title: 'No metadata in your repo.',
    body:
      'Overgit never writes inside .git. Every action runs as a plain git command in the repo\'s existing directory — stop using overgit any time and nothing changes.',
  },
  {
    color: '#fbbf24',
    kicker: 'AI in the loop',
    title: 'Review and commit faster.',
    body:
      'Pipe a diff to claude, codex, or gemini for a quick review. Have an LLM CLI draft your commit message from the staged diff. Uses your existing CLI auth.',
  },
] as const;

const ABOUT_FEATURES = [
  { title: 'Workspace-wide branching', body: 'Sync to default → pull → branch, across N repos at once.' },
  { title: 'Branch picker + cherry-pick', body: 'Searchable popover, ↑↓/Enter, per-branch commit picker.' },
  { title: 'AI review & suggest', body: 'claude / codex / gemini on the staged or working diff.' },
  { title: 'File editor', body: 'Syntax-highlighted, sandboxed to registered repos.' },
  { title: 'Branch graph', body: 'Per-lane colored visualization with ref labels.' },
  { title: 'Cmd+K palette', body: 'Branches, files, repos, workspaces, actions — one keystroke.' },
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
              A workspace-overlay git client. Coordinate many repos at once
              without owning their state.
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

        <SectionLabel className="mt-6">What's in the box</SectionLabel>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {ABOUT_FEATURES.map((f) => (
            <FeatureRow key={f.title} title={f.title} body={f.body} />
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between rounded-xl border border-card bg-card/40 px-4 py-3 text-xs">
          <div>
            <div className="font-semibold text-ink">Sibling of overcli.</div>
            <div className="mt-0.5 text-ink-muted">
              Apache-2.0 · feedback welcome.
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
          href="https://github.com/lionelfarr/overgit"
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
      <div className="flex-1 min-h-0 p-5 flex flex-col gap-4 text-sm overflow-y-auto">
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
