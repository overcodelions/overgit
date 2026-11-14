import type { BranchSummary } from '@shared/types';
import { LANE_COLORS } from './theme';

/// Stable color for a commit author, so one person's branches share a
/// color across lists and launches. Git doesn't record who created a
/// branch; callers pass the tip commit's author as the closest signal.
export function authorColor(author: string): string {
  let h = 0;
  for (const ch of author.trim().toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LANE_COLORS[h % LANE_COLORS.length];
}

/// Rows past this many per remote sit behind "Show all". A busy origin
/// can carry thousands of refs and rendering them all makes the tab
/// sluggish to open and to filter.
export const REMOTE_GROUP_CAP = 100;

export interface RemoteBranchRow {
  branch: BranchSummary;
  /// The remote's name — the first segment of `origin/feat/x`.
  remote: string;
  /// Local branch whose upstream is this ref, if any. Those rows are
  /// hidden by default: the user already has the branch locally.
  trackedBy: string | null;
}

export interface RemoteBranchGroup {
  remote: string;
  rows: RemoteBranchRow[];
  /// Visible rows for this remote before the cap is applied.
  total: number;
}

export interface RemoteBranchView {
  groups: RemoteBranchGroup[];
  /// Visible rows across every remote, ignoring the cap — the number
  /// shown on the Remote subtab.
  count: number;
  /// Rows matching the filter but hidden because a local branch tracks them.
  hiddenTracked: number;
  /// True when at least one group was cut short by REMOTE_GROUP_CAP.
  capped: boolean;
}

/// Branches with no commits for this long are dimmed — likely Prune
/// candidates.
const STALE_MS = 90 * 24 * 60 * 60 * 1000;

export function isStale(iso: string, now = Date.now()): boolean {
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && now - t > STALE_MS;
}

export function sameAuthor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function branchMatchesFilter(b: BranchSummary, q: string): boolean {
  if (!q) return true;
  return (
    b.name.toLowerCase().includes(q) ||
    b.subject.toLowerCase().includes(q) ||
    b.shortSha.toLowerCase().includes(q)
  );
}

/// Build the Remote subtab: filter by `q` (already trimmed and
/// lower-cased) and tip author (when set), hide refs a local branch
/// tracks unless `showTracked`, then group by remote — `origin` first,
/// the rest alphabetically. Input order is kept within a group;
/// `branchSummaries` returns refs newest first, so the cap keeps the
/// most recent.
export function remoteBranchView(
  branches: BranchSummary[],
  q: string,
  showTracked: boolean,
  showAll: boolean,
  author: string | null = null,
): RemoteBranchView {
  const trackedBy = new Map<string, string>();
  for (const b of branches) {
    if (b.kind === 'local' && b.upstream) trackedBy.set(b.upstream, b.shortName);
  }

  const byRemote = new Map<string, RemoteBranchRow[]>();
  let count = 0;
  let hiddenTracked = 0;
  for (const b of branches) {
    if (b.kind !== 'remote' || !branchMatchesFilter(b, q)) continue;
    if (author && !sameAuthor(b.author, author)) continue;
    const tracker = trackedBy.get(b.name) ?? null;
    if (tracker && !showTracked) {
      hiddenTracked++;
      continue;
    }
    const remote = b.name.split('/')[0];
    const rows = byRemote.get(remote) ?? [];
    rows.push({ branch: b, remote, trackedBy: tracker });
    byRemote.set(remote, rows);
    count++;
  }

  const names = [...byRemote.keys()].sort((a, b) =>
    a === 'origin' ? -1 : b === 'origin' ? 1 : a.localeCompare(b),
  );
  let capped = false;
  const groups = names.map((remote) => {
    const rows = byRemote.get(remote)!;
    if (!showAll && rows.length > REMOTE_GROUP_CAP) capped = true;
    return {
      remote,
      rows: showAll ? rows : rows.slice(0, REMOTE_GROUP_CAP),
      total: rows.length,
    };
  });
  return { groups, count, hiddenTracked, capped };
}
