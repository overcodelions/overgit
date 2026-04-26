import { useEffect, useMemo } from 'react';
import { useStore } from './store';
import type { GraphCommit, UUID } from '@shared/types';

const ROW_HEIGHT = 26;
const LANE_WIDTH = 14;
const NODE_RADIUS = 4;
const PADDING_X = 10;

const LANE_COLORS = [
  '#8a78ff',
  '#5eead4',
  '#fbbf24',
  '#f472b6',
  '#60a5fa',
  '#a3e635',
  '#fb923c',
  '#22d3ee',
];

/// Compact branch visualization. Renders a vertical commit graph with a
/// per-lane color, parent-edge lines, and ref labels. Driven by the
/// `repo:graph` IPC, which already lays commits onto lanes.
export function BranchGraph({ repoId }: { repoId: UUID }): JSX.Element {
  const commits = useStore((s) => s.repoGraph[repoId] ?? null);
  const refresh = useStore((s) => s.refreshRepoGraph);

  useEffect(() => {
    if (commits == null) refresh(repoId);
  }, [commits, refresh, repoId]);

  const maxLane = useMemo(
    () => (commits ? commits.reduce((m, c) => Math.max(m, c.lane, ...c.parentLanes), 0) : 0),
    [commits],
  );
  const indexBySha = useMemo(() => {
    const m = new Map<string, number>();
    if (commits) commits.forEach((c, i) => m.set(c.sha, i));
    return m;
  }, [commits]);

  if (commits == null) {
    return <div className="p-6 text-xs text-ink-faint">Loading graph…</div>;
  }
  if (commits.length === 0) {
    return <div className="p-6 text-xs text-ink-faint">No commits yet.</div>;
  }

  const graphWidth = PADDING_X * 2 + (maxLane + 1) * LANE_WIDTH;
  const totalHeight = commits.length * ROW_HEIGHT + 12;

  return (
    <div className="h-full overflow-auto">
      <div className="flex">
        {/* SVG rail with the graph itself, sticky to the left so labels
            scroll horizontally while the graph stays put on x. */}
        <svg
          width={graphWidth}
          height={totalHeight}
          className="flex-shrink-0 sticky left-0 bg-surface"
          style={{ minHeight: totalHeight }}
        >
          {commits.map((c, i) => (
            <g key={c.sha}>
              {c.parentLanes.map((pLane, idx) => {
                const parentIdx = indexBySha.get(c.parents[idx]);
                if (parentIdx == null) return null;
                const x1 = PADDING_X + c.lane * LANE_WIDTH + LANE_WIDTH / 2;
                const y1 = i * ROW_HEIGHT + ROW_HEIGHT / 2 + 4;
                const x2 = PADDING_X + pLane * LANE_WIDTH + LANE_WIDTH / 2;
                const y2 = parentIdx * ROW_HEIGHT + ROW_HEIGHT / 2 + 4;
                // Quadratic bezier with the control point pulled down a
                // half-row from the child — gives a clean S-curve when
                // the lane changes, a straight line when it doesn't.
                const cy = y1 + ROW_HEIGHT * 0.6;
                const d =
                  x1 === x2
                    ? `M${x1},${y1} L${x2},${y2}`
                    : `M${x1},${y1} Q${x1},${cy} ${(x1 + x2) / 2},${cy} T${x2},${y2}`;
                return (
                  <path
                    key={`${c.sha}:${idx}`}
                    d={d}
                    stroke={laneColor(pLane)}
                    strokeWidth="1.5"
                    fill="none"
                    opacity="0.85"
                  />
                );
              })}
              <circle
                cx={PADDING_X + c.lane * LANE_WIDTH + LANE_WIDTH / 2}
                cy={i * ROW_HEIGHT + ROW_HEIGHT / 2 + 4}
                r={NODE_RADIUS}
                fill={laneColor(c.lane)}
                stroke="var(--c-surface)"
                strokeWidth="1.5"
              />
            </g>
          ))}
        </svg>
        <div className="flex-1 min-w-0">
          <ul>
            {commits.map((c, i) => (
              <li
                key={c.sha}
                className="flex items-center gap-2 pr-3 border-b border-card text-xs"
                style={{ height: ROW_HEIGHT }}
              >
                <RefBadges refs={c.refs} laneColor={laneColor(c.lane)} />
                <span className="font-mono text-ink-faint w-16 truncate">{c.shortSha}</span>
                <span className="truncate flex-1" title={c.subject}>
                  {c.subject || <span className="text-ink-faint">(no subject)</span>}
                </span>
                <span className="text-ink-faint truncate hidden md:inline">{c.author}</span>
                <span className="text-ink-faint w-20 truncate text-right">
                  {formatDate(c.date)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function RefBadges({
  refs,
  laneColor,
}: {
  refs: string[];
  laneColor: string;
}): JSX.Element | null {
  if (refs.length === 0) return null;
  return (
    <div className="flex gap-1 flex-shrink-0">
      {refs.map((r) => {
        const clean = r.replace(/^HEAD -> /, '');
        const isHead = r.startsWith('HEAD');
        return (
          <span
            key={r}
            className="px-1.5 py-0.5 rounded text-[10px] font-mono"
            style={{
              background: `color-mix(in srgb, ${laneColor} 22%, transparent)`,
              border: `1px solid color-mix(in srgb, ${laneColor} 50%, transparent)`,
              color: isHead ? laneColor : 'var(--c-ink-muted)',
              fontWeight: isHead ? 600 : 400,
            }}
            title={r}
          >
            {clean}
          </span>
        );
      })}
    </div>
  );
}

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

function formatDate(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const today = new Date();
    const sameYear = d.getFullYear() === today.getFullYear();
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: sameYear ? undefined : 'numeric',
    });
  } catch {
    return iso;
  }
}

// Re-export GraphCommit so consumers don't need to also import from shared/types
export type { GraphCommit };
