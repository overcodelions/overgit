import { useEffect, useState } from 'react';

/// Corner toast for the auto-updater. Subscribes to the `update:*` main
/// events (src/main/updater.ts) on its own rather than going through the
/// store's toast queue, because it is a live progress bar that turns into
/// a prompt, not a one-shot message.
///
/// Install is deferred to quit anyway, so "Later" just hides the toast —
/// the update still applies the next time the app quits.
type UpdateState =
  | { phase: 'idle' }
  | { phase: 'downloading'; percent: number }
  | { phase: 'ready'; version: string };

export function UpdateToast(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    return window.overgit.onMainEvent((evt) => {
      if (evt.kind === 'update:available') {
        setDismissed(false);
        setState({ phase: 'downloading', percent: 0 });
      } else if (evt.kind === 'update:progress') {
        setState({ phase: 'downloading', percent: evt.percent });
      } else if (evt.kind === 'update:downloaded') {
        setDismissed(false);
        setState({ phase: 'ready', version: evt.version });
      }
    });
  }, []);

  if (state.phase === 'idle' || dismissed) return null;

  return (
    <div className="fixed bottom-4 left-4 z-[60] w-[300px] max-w-[80vw] bg-surface-elevated border border-card rounded-lg shadow-xl px-4 py-3 text-xs flex flex-col gap-2">
      {state.phase === 'downloading' ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-faint">Downloading update…</span>
            <span className="text-ink tabular-nums">{state.percent}%</span>
          </div>
          <div className="h-1 rounded-full bg-card overflow-hidden">
            <div
              className="h-full bg-accent transition-[width] duration-300"
              style={{ width: `${state.percent}%` }}
            />
          </div>
        </>
      ) : (
        <>
          <div className="text-ink">
            Overgit <span className="font-medium">{state.version}</span> is ready.
          </div>
          <div className="flex items-center gap-2">
            <button
              className="px-3 py-1 rounded-md bg-accent text-white border border-accent hover:bg-accent-strong"
              onClick={() => void window.overgit.invoke('update:quitAndInstall')}
            >
              Restart to update
            </button>
            <button
              className="px-2 py-1 rounded-md text-ink-faint hover:text-ink"
              onClick={() => setDismissed(true)}
            >
              Later
            </button>
          </div>
        </>
      )}
    </div>
  );
}
