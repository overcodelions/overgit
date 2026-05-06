import React from 'react';
import { useStore } from './store';

/// Wraps an actionable element so that hovering or focusing it pipes a
/// hint into the bottom Learning bar (rendered once in App.tsx). When
/// Settings → Explain mode is off this is a transparent passthrough —
/// no DOM, no listeners, no cost. The wrapper keeps the wrapped
/// element's layout untouched (`display: contents`) so toolbars don't
/// shift when the mode is toggled.
export function Explain({
  command,
  plain,
  children,
}: {
  command: string;
  plain: string;
  children: React.ReactNode;
}): JSX.Element {
  const explain = useStore((s) => s.settings.explainMode);
  const setHint = useStore((s) => s.setLearningHint);
  if (!explain) return <>{children}</>;
  return (
    <span
      className="contents"
      onMouseEnter={() => setHint({ command, plain })}
      onMouseLeave={() => setHint(null)}
      onFocus={() => setHint({ command, plain })}
      onBlur={() => setHint(null)}
    >
      {children}
    </span>
  );
}
