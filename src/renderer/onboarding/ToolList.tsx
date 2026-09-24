// Renders a SetupPlan: one row per tool with a status dot, what it's for,
// and — when it's missing — the command that installs it. Used in full by
// Help → Setup and compact on the first-run screen.

import { useEffect, useMemo } from 'react';
import { useStore } from '../store';
import { buildSetupPlan, detectPlatform, type SetupPlan, type ToolRow, type ToolState } from './setupPlan';
import { CopyCommand } from './helpChrome';

export function useSetupPlan(): SetupPlan {
  const git = useStore((s) => s.gitInfo);
  const cli = useStore((s) => s.cliPresence);
  return useMemo(
    () => buildSetupPlan({ git, cli, platform: detectPlatform(navigator.userAgent) }),
    [git, cli],
  );
}

/// Re-probe the machine while `active`: on window focus (the user is back
/// from a terminal) and every few seconds while the window has focus. So a
/// tool installed mid-session shows up without restarting overgit.
export function useToolingWatch(active: boolean, pollMs = 4000): void {
  const refreshTooling = useStore((s) => s.refreshTooling);
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (document.hasFocus()) void refreshTooling();
    };
    const timer = window.setInterval(tick, pollMs);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [active, pollMs, refreshTooling]);
}

const STATE_DOT: Record<ToolState, string> = {
  checking: 'bg-ink-faint animate-pulse',
  ready: 'bg-emerald-400',
  outdated: 'bg-amber-400',
  missing: 'border border-ink-faint bg-transparent',
};

const STATE_LABEL: Record<ToolState, string> = {
  checking: 'checking',
  ready: 'found',
  outdated: 'old',
  missing: 'not found',
};

const STATE_TEXT: Record<ToolState, string> = {
  checking: 'text-ink-faint',
  ready: 'text-emerald-500 dark:text-emerald-400',
  outdated: 'text-amber-500 dark:text-amber-400',
  missing: 'text-ink-faint',
};

export function ToolStateDot({ state }: { state: ToolState }): JSX.Element {
  return <span className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${STATE_DOT[state]}`} />;
}

export function ToolRowView({
  row,
  compact = false,
}: {
  row: ToolRow;
  compact?: boolean;
}): JSX.Element {
  const showInstall = !!row.install && (!compact || row.group === 'required');
  return (
    <li className={`py-2.5 ${compact ? '' : 'px-3.5'} border-b border-card last:border-0`}>
      <div className="flex items-center gap-3">
        <ToolStateDot state={row.state} />
        <span className={`w-14 font-mono text-[12px] ${row.state === 'missing' ? 'text-ink-muted' : 'text-ink'}`}>
          {row.key}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-muted" title={row.unlocks}>
          {row.unlocks}
        </span>
        <span className={`font-mono text-[10px] uppercase tracking-wide ${STATE_TEXT[row.state]}`}>
          {STATE_LABEL[row.state]}
        </span>
      </div>
      {(row.detail || showInstall) && (
        <div className="mt-1.5 pl-[76px] flex flex-col gap-1.5">
          {row.detail && <div className="text-[11px] leading-snug text-ink-faint">{row.detail}</div>}
          {showInstall && (
            <>
              <CopyCommand command={row.install!} />
              {row.then && <div className="text-[11px] leading-snug text-ink-faint">{row.then}</div>}
            </>
          )}
        </div>
      )}
    </li>
  );
}
