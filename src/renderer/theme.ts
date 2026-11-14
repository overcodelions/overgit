export type ThemeChoice = 'light' | 'dark' | 'system';

/// Accent hues shared by the History graph's lanes and the Branches
/// tab's per-author branch icons.
export const LANE_COLORS = [
  '#8a78ff',
  '#5eead4',
  '#fbbf24',
  '#f472b6',
  '#60a5fa',
  '#a3e635',
  '#fb923c',
  '#22d3ee',
];

/// Single point of theme application: toggle the `dark` class on <body>.
/// CSS variables in styles.css read off that class. `system` follows the
/// OS via prefers-color-scheme.
export function applyTheme(theme: ThemeChoice | undefined): void {
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

/// Apply the saved theme, and keep following the OS while it's `system`.
/// index.html starts dark so the first paint doesn't flash white; this
/// corrects it as soon as settings load. Returns a cleanup.
export function followTheme(theme: ThemeChoice | undefined): () => void {
  applyTheme(theme);
  if (theme === 'light' || theme === 'dark') return () => {};
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => applyTheme('system');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
