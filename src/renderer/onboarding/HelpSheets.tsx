// Help → How overgit works, Help → Setup, and Help → Keyboard shortcuts.
// Each is reachable from the native Help menu, the command palette and the
// first-run screen, and each footer links to the other two, so wherever a
// user lands in help they can walk to the rest.

import { useStore } from '../store';
import {
  HelpFooter,
  HelpHeader,
  HelpLink,
  HelpRow,
  HelpSection,
  KeyCombo,
} from './helpChrome';
import { SHORTCUT_GROUPS } from './shortcuts';
import { ToolRowView, useSetupPlan, useToolingWatch } from './ToolList';

const NOUNS = [
  {
    title: 'Repo',
    kicker: 'A folder you already have',
    body: 'Any git checkout on disk. overgit keeps its path in its own settings file and runs git there. Add one, or pick a parent folder and every repo one level down comes in.',
  },
  {
    title: 'Workspace',
    kicker: 'Lasting',
    body: 'A group that stays: “Platform”, “Payments”, a client. It’s a sidebar section with a health overview, and the target for fetch-all and reset-all-to-default.',
  },
  {
    title: 'Workset',
    kicker: 'In flight',
    body: 'One piece of work across a few repos, optionally bound to a branch. It shows every member’s changes, PRs and whether it will land. Archive it when it ships.',
  },
] as const;

const WORKSET_STEPS = [
  {
    title: 'Start it',
    body: 'New workset: name it after the ticket, pick the repos it touches and, if you know it, the branch name.',
  },
  {
    title: 'Branch everywhere at once',
    body: 'New branch, on the workset page. Each repo fetches, fast-forwards its default branch and cuts the new branch from it. A repo that can’t says why; the others carry on.',
  },
  {
    title: 'Commit, push, open PRs',
    body: 'Work in your editor as usual. The workset page commits and pushes every repo with changes, and opens a PR in each with gh.',
  },
  {
    title: 'Check it will land, then archive',
    body: 'Landing Check simulates the merge onto each default branch without touching your checkout. When the work ships, archive the workset — the repos don’t change.',
  },
] as const;

const PROMISES = [
  {
    title: 'Never writes inside .git',
    body: 'No manifest, no hidden files, no synthetic root. Your repos behave the same in any other tool, whether or not overgit is open.',
  },
  {
    title: 'Stops before losing work',
    body: 'A reset that would throw away commits not on the default branch stops and asks, per repo. Partial success is shown, not hidden.',
  },
  {
    title: 'Shows you the command',
    body: 'With Explain mode on (Settings → General), the bar at the bottom names the git command behind whatever you hover.',
  },
  {
    title: 'Holds no keys',
    body: 'gh, claude, codex and gemini run as you, with the sign-in they already have. overgit never reads or sends a token.',
  },
] as const;

export function BasicsSheet(): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <HelpHeader
        title="overgit runs plain git across many repos at once."
        lead="It keeps a list of your repos and two ways to group them. Every button is an ordinary git command run in the repo’s own folder — the same one you’d type."
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
        <HelpSection title="Three nouns" className="mt-0">
          <div className="grid gap-2.5 md:grid-cols-3">
            {NOUNS.map((n) => (
              <HelpRow key={n.title} title={n.title} kicker={n.kicker} body={n.body} />
            ))}
          </div>
          <p className="mt-2.5 text-[11.5px] leading-[1.55] text-ink-faint">
            Workspaces and worksets don’t compete: the same repo can be in the Platform workspace and in
            two worksets at once.
          </p>
        </HelpSection>

        <HelpSection title="A workset, start to finish">
          <ol className="flex flex-col gap-2">
            {WORKSET_STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3 rounded-lg border border-card bg-card/30 px-3.5 py-2.5">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/15 text-[11px] font-semibold text-accent">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <div className="text-[12.5px] font-semibold text-ink">{s.title}</div>
                  <div className="mt-0.5 text-[11.5px] leading-[1.55] text-ink-muted">{s.body}</div>
                </div>
              </li>
            ))}
          </ol>
        </HelpSection>

        <HelpSection title="What overgit will and won’t do">
          <div className="grid gap-2.5 md:grid-cols-2">
            {PROMISES.map((p) => (
              <HelpRow key={p.title} title={p.title} body={p.body} />
            ))}
          </div>
        </HelpSection>

        <HelpSection title="Finding your way">
          <div className="grid gap-2.5 md:grid-cols-2">
            <HelpRow
              title="The command palette"
              body={
                <>
                  <KeyCombo keys={['Mod', 'K']} /> finds anything: a branch to switch to, a repo, a file, an
                  action, or this help. Start typing.
                </>
              }
            />
            <HelpRow
              title="Hover to learn"
              body="Buttons and tabs carry tooltips; with Explain mode on, the bottom bar says what each one runs before you click."
            />
          </div>
        </HelpSection>
      </div>
      <HelpFooter>
        <HelpLink label="Setup" onClick={() => setSheet({ kind: 'setup' })} />
        <HelpLink label="Keyboard shortcuts" onClick={() => setSheet({ kind: 'shortcuts' })} />
        <HelpLink label="About" onClick={() => setSheet({ kind: 'about' })} />
        <span className="flex-1" />
        <HelpLink label="Done" primary onClick={() => setSheet(null)} />
      </HelpFooter>
    </div>
  );
}

export function SetupSheet(): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  const refreshTooling = useStore((s) => s.refreshTooling);
  const plan = useSetupPlan();
  const required = plan.rows.filter((r) => r.group === 'required');
  const forge = plan.rows.filter((r) => r.group === 'forge');
  const ai = plan.rows.filter((r) => r.group === 'ai');
  // Poll while anything is missing so an install in another window lands here.
  useToolingWatch(plan.rows.some((r) => r.state === 'missing' || r.state === 'outdated'));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <HelpHeader
        title={plan.headline}
        lead={plan.lead}
        trailing={
          <div className="rounded-lg border border-card bg-card/40 px-3 py-1.5 text-right">
            <div className="font-mono text-[15px] leading-tight text-ink">
              {plan.readyCount}/{plan.rows.length}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-ink-faint">found</div>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
        <HelpSection title="Required" className="mt-0">
          <ul className="rounded-lg border border-card bg-card/20">
            {required.map((r) => (
              <ToolRowView key={r.key} row={r} />
            ))}
          </ul>
        </HelpSection>
        <HelpSection
          title="Pull requests"
          lead="GitHub PRs come through the gh CLI. Bitbucket PRs open in your browser instead, so they work without it."
        >
          <ul className="rounded-lg border border-card bg-card/20">
            {forge.map((r) => (
              <ToolRowView key={r.key} row={r} />
            ))}
          </ul>
        </HelpSection>
        <HelpSection
          title="AI review and commit messages"
          lead="Any one is enough. overgit pipes the diff to the CLI and shows what it says; the CLI uses its own sign-in, and nothing goes through overgit."
        >
          <ul className="rounded-lg border border-card bg-card/20">
            {ai.map((r) => (
              <ToolRowView key={r.key} row={r} />
            ))}
          </ul>
        </HelpSection>
        <p className="mt-4 text-[11px] leading-[1.55] text-ink-faint">
          CLIs inherit your shell environment — that’s how their sign-in works. Installed one in a terminal?
          This page notices on its own; no restart needed.
        </p>
      </div>
      <HelpFooter>
        <HelpLink label="How overgit works" onClick={() => setSheet({ kind: 'basics' })} />
        <HelpLink label="Settings" onClick={() => setSheet({ kind: 'settings' })} />
        <span className="flex-1" />
        <HelpLink label="Check again" onClick={() => void refreshTooling()} />
        <HelpLink label="Done" primary onClick={() => setSheet(null)} />
      </HelpFooter>
    </div>
  );
}

export function ShortcutsSheet(): JSX.Element {
  const setSheet = useStore((s) => s.setSheet);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <HelpHeader
        title="Keyboard shortcuts"
        lead={
          <>
            Forget the rest and keep one: <KeyCombo keys={['Mod', 'K']} /> opens the command palette, which can
            do almost everything below.
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
        <div className="grid gap-x-8 md:grid-cols-2">
          {SHORTCUT_GROUPS.map((g, i) => (
            <HelpSection key={g.title} title={g.title} className={i < 2 ? 'mt-0' : 'mt-6'}>
              <ul className="flex flex-col gap-1.5">
                {g.items.map((s) => (
                  <li key={s.label} className="flex items-center gap-3 text-[12px]">
                    <span className="w-[92px] flex-shrink-0">
                      <KeyCombo keys={s.keys} />
                    </span>
                    <span className="text-ink-muted">{s.label}</span>
                  </li>
                ))}
              </ul>
              {g.note && <p className="mt-2.5 text-[11px] leading-[1.5] text-ink-faint">{g.note}</p>}
            </HelpSection>
          ))}
        </div>
      </div>
      <HelpFooter>
        <HelpLink label="How overgit works" onClick={() => setSheet({ kind: 'basics' })} />
        <HelpLink label="Setup" onClick={() => setSheet({ kind: 'setup' })} />
        <span className="flex-1" />
        <HelpLink label="Done" primary onClick={() => setSheet(null)} />
      </HelpFooter>
    </div>
  );
}
