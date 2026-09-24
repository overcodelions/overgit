// The sidebar's getting-started checklist: what to do after the first repo
// is in. Picks up where the first-run screen leaves off and retires itself
// once there's a workspace and a workset (see gettingStarted.ts).

import { useStore } from '../store';
import { gettingStartedSteps, shouldShowGettingStarted, type GettingStartedKey } from './gettingStarted';

export function GettingStarted(): JSX.Element | null {
  const repoCount = useStore((s) => s.repos.length);
  const workspaceCount = useStore((s) => s.workspaces.length);
  const worksetCount = useStore((s) => s.worksets.length);
  const dismissed = useStore((s) => s.settings.gettingStartedDismissed);
  const setSheet = useStore((s) => s.setSheet);
  const dismiss = useStore((s) => s.dismissGettingStarted);

  const steps = gettingStartedSteps({
    repos: repoCount,
    workspaces: workspaceCount,
    worksets: worksetCount,
  });
  if (!shouldShowGettingStarted(steps, dismissed)) return null;

  const done = steps.filter((s) => s.done).length;
  // The first open step gets the button; later ones just say what's next.
  const next = steps.find((s) => !s.done)?.key;
  const actions: Partial<Record<GettingStartedKey, { label: string; run: () => void }>> = {
    workspace: { label: 'New workspace', run: () => setSheet({ kind: 'newWorkspace' }) },
    workset: { label: 'New workset', run: () => setSheet({ kind: 'newWorkset' }) },
  };

  return (
    <div className="mx-2 mb-2 rounded-lg border border-accent/35 bg-accent/[0.06] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">Getting started</span>
        <span className="text-[10px] tabular-nums text-ink-faint">
          {done} of {steps.length}
        </span>
        <button
          onClick={() => void dismiss()}
          className="ml-auto rounded px-1.5 py-0.5 text-[10.5px] text-ink-faint hover:bg-card hover:text-ink"
          title="Hide this checklist. Help → How Overgit Works has the same ground."
        >
          Hide
        </button>
      </div>
      <ol className="mt-2 flex flex-col gap-2">
        {steps.map((s) => {
          const action = s.key === next ? actions[s.key] : undefined;
          return (
            <li key={s.key} className="flex gap-2">
              <span
                className={`mt-[1px] flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[9px] ${
                  s.done ? 'bg-emerald-500/20 text-emerald-500 dark:text-emerald-400' : 'border border-ink-faint/60'
                }`}
                aria-label={s.done ? 'done' : 'to do'}
              >
                {s.done ? '✓' : ''}
              </span>
              <div className="min-w-0 flex-1">
                <div className={`text-[11.5px] font-medium ${s.done ? 'text-ink-faint line-through decoration-ink-faint/50' : 'text-ink'}`}>
                  {s.title}
                </div>
                {!s.done && <div className="mt-0.5 text-[10.5px] leading-snug text-ink-muted">{s.body}</div>}
                {action && (
                  <button
                    onClick={action.run}
                    className="mt-1.5 rounded border border-accent/60 bg-accent/20 px-2 py-0.5 text-[10.5px] font-medium text-accent hover:bg-accent/30"
                  >
                    {action.label}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <button
        onClick={() => setSheet({ kind: 'basics' })}
        className="mt-2 text-[10.5px] text-ink-faint hover:text-ink"
      >
        How overgit works →
      </button>
    </div>
  );
}
