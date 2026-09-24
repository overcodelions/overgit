// Shared chrome for the help sheets (How overgit works, Setup, Shortcuts)
// and the first-run screen, so the four read as one set: same header wash,
// same section rule, same key chips, same footer of cross-links.

import { useState } from 'react';
import { keyLabel } from './shortcuts';

export function AppMark({ size = 80 }: { size?: number }): JSX.Element {
  const glyph = Math.round(size * 0.525);
  return (
    <div
      className="relative flex items-center justify-center rounded-[25%] border border-card bg-gradient-to-br from-accent/55 via-accent/20 to-accent/5 shadow-[0_12px_24px_rgba(0,0,0,0.28)] flex-shrink-0"
      style={{ width: size, height: size }}
    >
      <div className="absolute inset-[6%] rounded-[20%] border border-ink/5 bg-surface/30" />
      <svg width={glyph} height={glyph} viewBox="0 0 42 42" fill="none" className="relative">
        {/* Stylized branch glyph: trunk + fork. Reads as "git" without
            being literal. White-on-purple keeps it punchy in dark mode. */}
        <circle cx="13" cy="11" r="3.5" stroke="currentColor" strokeWidth="2.5" className="text-ink" />
        <circle cx="13" cy="31" r="3.5" stroke="currentColor" strokeWidth="2.5" className="text-ink" />
        <circle cx="29" cy="21" r="3.5" stroke="currentColor" strokeWidth="2.5" className="text-ink" />
        <path d="M13 14.5 V 27.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-ink" />
        <path
          d="M13 21 Q 21 21 25.5 21"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="text-ink"
        />
      </svg>
    </div>
  );
}

export function HelpHeader({
  title,
  lead,
  trailing,
}: {
  title: string;
  lead?: React.ReactNode;
  trailing?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="relative overflow-hidden border-b border-card bg-gradient-to-b from-accent/15 via-accent/5 to-transparent px-7 pt-6 pb-5 flex-shrink-0">
      <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-accent/15 blur-3xl" />
      <div className="relative flex items-start gap-4">
        <AppMark size={44} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[19px] font-semibold leading-tight tracking-tight text-ink">{title}</h2>
          {lead && <div className="mt-1.5 max-w-[62ch] text-[12.5px] leading-[1.6] text-ink-muted">{lead}</div>}
        </div>
        {trailing && <div className="flex-shrink-0">{trailing}</div>}
      </div>
    </div>
  );
}

export function HelpSection({
  title,
  lead,
  className = 'mt-6',
  children,
}: {
  title: string;
  lead?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className={className}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">{title}</span>
        <span className="h-px flex-1 bg-card" />
      </div>
      {lead && <p className="mt-2 max-w-[70ch] text-[12px] leading-[1.55] text-ink-muted">{lead}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function HelpRow({
  title,
  kicker,
  body,
}: {
  title: string;
  kicker?: string;
  body: React.ReactNode;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-card bg-card/30 px-3.5 py-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[12.5px] font-semibold text-ink">{title}</span>
        {kicker && <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">{kicker}</span>}
      </div>
      <div className="mt-1 text-[11.5px] leading-[1.55] text-ink-muted">{body}</div>
    </div>
  );
}

export function HelpFooter({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex-shrink-0 flex items-center gap-1 border-t border-card px-5 py-3 text-[11px]">
      {children}
    </div>
  );
}

export function HelpLink({
  label,
  onClick,
  primary = false,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={
        primary
          ? 'rounded bg-accent px-3 py-1 font-medium text-white hover:bg-accent-strong'
          : 'rounded px-2 py-1 text-ink-muted hover:bg-card hover:text-ink'
      }
    >
      {label}
    </button>
  );
}

export function Kbd({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <kbd className="inline-flex min-w-[22px] justify-center rounded border border-card bg-surface/70 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-ink">
      {children}
    </kbd>
  );
}

export function KeyCombo({ keys }: { keys: string[] }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k, i) => (
        <Kbd key={i}>{keyLabel(k)}</Kbd>
      ))}
    </span>
  );
}

/// A command to paste into a terminal, with a Copy button. Install steps
/// are the one place a first-run user has to leave overgit, so the
/// command should be one click from their clipboard.
export function CopyCommand({ command }: { command: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border border-card bg-surface/60 pl-2.5 pr-1 py-1">
      <span className="font-mono text-[10.5px] text-ink-faint select-none">$</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink select-all">{command}</code>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="flex-shrink-0 rounded px-2 py-0.5 text-[10.5px] text-ink-muted hover:bg-card hover:text-ink"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
