import { useStore } from './store';
import { Spinner } from './Spinner';

/// Custom title bar. macOS uses `titleBarStyle: 'hiddenInset'`, so the
/// traffic lights overlay our content — we pad the leading edge enough
/// to clear them. Buttons are inside `.no-drag` so they remain clickable.
export function TitleBar(): JSX.Element {
  const sidebarVisible = useStore((s) => s.settings.sidebarVisible);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setSheet = useStore((s) => s.setSheet);
  const isMac =
    typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
  const leadingInset = isMac ? 'pl-[92px]' : 'pl-2';

  return (
    <div
      className={`draggable flex items-center h-[38px] ${leadingInset} pr-3 bg-surface border-b border-card select-none`}
    >
      <button
        onClick={toggleSidebar}
        className="no-drag p-1 mr-2 text-ink-muted hover:text-ink rounded hover:bg-card"
        title={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
        aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" />
          <line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" />
        </svg>
      </button>
      <span className="text-xs font-medium text-ink-muted no-drag">overgit</span>

      <div className="flex-1" />

      <BackgroundJobs />

      <button
        onClick={() => setSheet({ kind: 'about' })}
        className="no-drag p-1 mr-1 text-ink-muted hover:text-ink rounded hover:bg-card"
        title="About overgit"
        aria-label="About overgit"
      >
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10 8v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="10" cy="5.5" r="0.9" fill="currentColor" />
        </svg>
      </button>
      <button
        onClick={() => setSheet({ kind: 'settings' })}
        className="no-drag p-1 text-ink-muted hover:text-ink rounded hover:bg-card"
        title="Settings"
        aria-label="Open settings"
      >
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" strokeLinejoin="round" strokeLinecap="round">
          <path
            d="M10 2.5 11 4.3a6 6 0 0 1 1.4.6L14.3 4l1.7 1.7-.9 1.9a6 6 0 0 1 .6 1.4L17.5 10l-1.8 1a6 6 0 0 1-.6 1.4l.9 1.9L14.3 16l-1.9-.9a6 6 0 0 1-1.4.6L10 17.5l-1-1.8a6 6 0 0 1-1.4-.6L5.7 16 4 14.3l.9-1.9a6 6 0 0 1-.6-1.4L2.5 10l1.8-1a6 6 0 0 1 .6-1.4L4 5.7 5.7 4l1.9.9A6 6 0 0 1 9 4.3L10 2.5Z"
            stroke="currentColor"
            strokeWidth="1.3"
          />
          <circle cx="10" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
    </div>
  );
}

/// Bulk actions still running after their sheet was dismissed with
/// "Run in background". Without this the window looks idle while a
/// five-repo sync is mid-flight — the action's own progress UI went
/// away with the sheet. Lives in the title bar so it's visible from
/// every pane, and disappears on its own when the job finishes (the
/// result toast takes over from there).
function BackgroundJobs(): JSX.Element | null {
  const jobs = useStore((s) => s.backgroundJobs);
  if (jobs.length === 0) return null;
  return (
    <div className="no-drag flex items-center gap-2 mr-2">
      {jobs.map((job) => (
        <span
          key={job.id}
          className="flex items-center gap-1.5 text-[11px] text-accent bg-accent/10 rounded-full px-2 py-0.5"
          title={`${job.verb} ${job.done} of ${job.total} in ${job.scope} — running in the background`}
          aria-live="polite"
        >
          <Spinner size={10} />
          <span className="tabular-nums">
            {job.verb} {job.done}/{job.total}
          </span>
          <span className="text-accent/70 max-w-[140px] truncate">· {job.scope}</span>
        </span>
      ))}
    </div>
  );
}
