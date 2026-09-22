import React from 'react';

/// The one spinner. Background work (fetch, sync, reset, refresh) can
/// run for 5–15s on a slow remote, and a button that only dims while
/// it works reads as "nothing happened". Every in-flight button shows
/// this next to its verb so the click is visibly doing something.
///
/// Sizes itself off `size` and inherits `currentColor`, so it sits
/// inside a button without any per-call-site styling.
export function Spinner({ size = 10 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className="animate-spin flex-shrink-0"
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
