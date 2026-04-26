/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: { DEFAULT: 'var(--c-accent)', strong: 'var(--c-accent-strong)' },
        surface: {
          DEFAULT: 'var(--c-surface)',
          muted: 'var(--c-surface-muted)',
          elevated: 'var(--c-surface-elevated)',
        },
        ink: {
          DEFAULT: 'var(--c-ink)',
          muted: 'var(--c-ink-muted)',
          faint: 'var(--c-ink-faint)',
        },
        card: {
          DEFAULT: 'var(--c-card-bg)',
          border: 'var(--c-card-border)',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'system-ui', 'sans-serif'],
        mono: ['SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
};
