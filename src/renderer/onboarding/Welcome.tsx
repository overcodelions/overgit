// The first-run screen. Shown in place of the sidebar and main pane while
// overgit has nothing in it — no repos, workspaces or worksets. Derived from
// state rather than a "seen" flag, so it can't get stuck on or off: add a
// repo and it's gone; remove everything and it's back to help you start.
//
// Two jobs, in order: make sure git is here (nothing works without it),
// then get the user's repos in. The three nouns sit beside the tool check
// so the first thing read is what overgit is, not what's missing.

import { useStore } from '../store';
import { AppMark, Kbd } from './helpChrome';
import { ToolRowView, useSetupPlan, useToolingWatch } from './ToolList';
import { keyLabel } from './shortcuts';

const NOUNS = [
  {
    name: 'Repo',
    color: '#8a78ff',
    body: 'A folder with a .git in it. overgit remembers where it is — nothing is copied, moved or written inside .git.',
  },
  {
    name: 'Workspace',
    color: '#5eead4',
    body: 'A lasting group of repos, like “Platform” or a client. Fetch every repo in it, or reset them all to their default branch, in one click.',
  },
  {
    name: 'Workset',
    color: '#fbbf24',
    body: 'The ticket you’re shipping across a few repos. Branch, commit, push and open PRs together, check it will land, then archive it.',
  },
] as const;

export function Welcome(): JSX.Element {
  const pickAndAddRepo = useStore((s) => s.pickAndAddRepo);
  const setSheet = useStore((s) => s.setSheet);
  const plan = useSetupPlan();
  const git = plan.rows[0];
  const blocked = !plan.gitReady;
  const blockedReason = plan.checking && git.state === 'checking' ? 'One moment…' : 'Install git first';

  // Only git blocks this screen, so only a missing git is worth polling for.
  useToolingWatch(git.state === 'missing');

  return (
    <main className="flex-1 min-w-0 overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-[980px] flex-col justify-center px-10 py-12">
        <div className="flex items-center gap-3">
          <AppMark size={36} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
            Welcome to overgit
          </span>
        </div>

        <h1 className="mt-5 max-w-[20ch] text-[34px] font-semibold leading-[1.12] tracking-[-0.025em] text-ink">
          Plain git, across every repo you work in.
        </h1>
        <p className="mt-3 max-w-[64ch] text-[14px] leading-[1.65] text-ink-muted">
          Add the repos you work on and overgit shows what’s changed, behind or ready to push in all of
          them at once. Every button runs an ordinary <code className="font-mono text-[12.5px] text-ink">git</code>{' '}
          command in the repo’s own folder, so everything stays exactly as your other tools expect.
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <button
            onClick={() => void pickAndAddRepo()}
            disabled={blocked}
            title={blocked ? blockedReason : 'Pick a repo, or a folder that holds several'}
            className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white shadow-[0_8px_20px_-12px_var(--c-accent)] hover:bg-accent-strong disabled:opacity-40 disabled:hover:bg-accent"
          >
            Add repos…
          </button>
          <button
            onClick={() => setSheet({ kind: 'cloneRepo' })}
            disabled={blocked}
            title={blocked ? blockedReason : 'From a URL, GitHub, GitLab or Bitbucket'}
            className="rounded-lg border border-card px-4 py-2 text-[13px] font-medium text-ink hover:bg-card disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Clone a repo
          </button>
          <span className="text-[12px] text-ink-faint">
            <Kbd>{keyLabel('Mod')}</Kbd> <Kbd>O</Kbd> works too
          </span>
        </div>
        <p className="mt-2.5 text-[12px] text-ink-faint">
          Tip: pick the folder that holds all your checkouts — overgit adds every repo one level down.
        </p>
        <div className="mt-1.5 flex flex-wrap gap-x-4 text-[12px]">
          <button onClick={() => setSheet({ kind: 'basics' })} className="text-ink-faint hover:text-ink">
            or read how overgit works →
          </button>
          <button onClick={() => setSheet({ kind: 'shortcuts' })} className="text-ink-faint hover:text-ink">
            or see the shortcuts →
          </button>
        </div>

        <div className="mt-10 grid gap-5 md:grid-cols-[1.15fr_1fr]">
          <section>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Three things to know
              </span>
              <span className="h-px flex-1 bg-card" />
            </div>
            <dl className="mt-3 flex flex-col gap-3">
              {NOUNS.map((n) => (
                <div key={n.name} className="flex gap-3">
                  <span className="mt-[7px] h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: n.color }} />
                  <div className="min-w-0">
                    <dt className="text-[13px] font-semibold text-ink">{n.name}</dt>
                    <dd className="mt-0.5 text-[12px] leading-[1.55] text-ink-muted">{n.body}</dd>
                  </div>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-[11.5px] leading-[1.55] text-ink-faint">
              A repo can sit in many workspaces and many worksets at once. Stop using overgit any time and
              nothing on disk has changed.
            </p>
          </section>

          <section
            className={`rounded-xl border px-4 pt-3.5 pb-2 ${
              git.state === 'missing' ? 'border-amber-500/40 bg-amber-500/[0.05]' : 'border-card bg-surface-elevated'
            }`}
          >
            <div className="flex items-baseline gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">This machine</span>
              <span className="h-px flex-1 bg-card" />
            </div>
            <div className="mt-2 text-[13px] font-semibold text-ink">{plan.headline}</div>
            {git.state === 'missing' && (
              <div className="mt-0.5 text-[11.5px] leading-snug text-ink-muted">{plan.lead}</div>
            )}
            <ul className="mt-1.5">
              {plan.rows.map((r) => (
                <ToolRowView key={r.key} row={r} compact />
              ))}
            </ul>
            <div className="flex items-center gap-2 border-t border-card pt-2 text-[11px] text-ink-faint">
              <span className="flex-1">
                {git.state === 'missing'
                  ? 'Watching for git — no need to restart overgit.'
                  : 'Only git is required. The others each switch on a feature.'}
              </span>
              <button onClick={() => setSheet({ kind: 'setup' })} className="rounded px-1.5 py-0.5 hover:bg-card hover:text-ink">
                Setup details →
              </button>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
