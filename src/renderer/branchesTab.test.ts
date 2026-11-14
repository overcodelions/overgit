import { describe, expect, it } from 'vitest';
import type { BranchSummary } from '@shared/types';
import { REMOTE_GROUP_CAP, authorColor, isStale, remoteBranchView } from './branchesTab';

describe('isStale', () => {
  const now = new Date('2026-11-14T00:00:00Z').getTime();
  it('flags tips older than about three months', () => {
    expect(isStale('2026-07-01T00:00:00Z', now)).toBe(true);
    expect(isStale('2026-10-01T00:00:00Z', now)).toBe(false);
    expect(isStale('', now)).toBe(false);
  });
});

describe('authorColor', () => {
  it('gives the same author the same color regardless of case or padding', () => {
    expect(authorColor('Acme Dev One')).toBe(authorColor(' acme dev one '));
  });

  it('spreads different authors across the palette', () => {
    const colors = new Set(['acme-dev-1', 'acme-dev-2', 'acme-dev-3', 'acme-dev-4', 'acme-dev-5', 'acme-dev-6'].map(authorColor));
    expect(colors.size).toBeGreaterThan(2);
  });
});

function branch(name: string, kind: 'local' | 'remote', extra: Partial<BranchSummary> = {}): BranchSummary {
  return {
    name,
    shortName: kind === 'remote' ? name.split('/').slice(1).join('/') : name,
    kind,
    isCurrent: false,
    sha: 'a'.repeat(40),
    shortSha: 'aaaaaaa',
    subject: `tip of ${name}`,
    author: 'someone',
    date: '2026-11-01T00:00:00Z',
    upstream: null,
    track: { ahead: 0, behind: 0, gone: false },
    ...extra,
  };
}

describe('remoteBranchView', () => {
  const branches = [
    branch('main', 'local', { upstream: 'origin/main', isCurrent: true }),
    branch('upstream/main', 'remote'),
    branch('origin/main', 'remote'),
    branch('origin/feat/rate-limit', 'remote'),
  ];

  it('hides refs a local branch tracks and counts them', () => {
    const view = remoteBranchView(branches, '', false, false);
    expect(view.count).toBe(2);
    expect(view.hiddenTracked).toBe(1);
    expect(view.groups.flatMap((g) => g.rows.map((r) => r.branch.name))).toEqual([
      'origin/feat/rate-limit',
      'upstream/main',
    ]);
  });

  it('shows tracked refs with the local branch that tracks them', () => {
    const view = remoteBranchView(branches, '', true, false);
    const row = view.groups[0].rows.find((r) => r.branch.name === 'origin/main');
    expect(row?.trackedBy).toBe('main');
    expect(view.hiddenTracked).toBe(0);
  });

  it('puts origin first, then other remotes alphabetically', () => {
    const view = remoteBranchView(
      [branch('zeta/x', 'remote'), branch('alpha/x', 'remote'), branch('origin/x', 'remote')],
      '',
      false,
      false,
    );
    expect(view.groups.map((g) => g.remote)).toEqual(['origin', 'alpha', 'zeta']);
  });

  it('filters on the full remote ref name', () => {
    expect(remoteBranchView(branches, 'upstream/', false, false).count).toBe(1);
    expect(remoteBranchView(branches, 'rate', false, false).count).toBe(1);
  });

  it('keeps only one author when asked, ignoring case', () => {
    const view = remoteBranchView(
      [branch('origin/a', 'remote', { author: 'Acme-Dev-1' }), branch('origin/b', 'remote', { author: 'acme-dev-2' })],
      '',
      false,
      false,
      'acme-dev-1',
    );
    expect(view.groups.flatMap((g) => g.rows.map((r) => r.branch.name))).toEqual(['origin/a']);
  });

  it('caps each remote unless showAll', () => {
    const many = Array.from({ length: REMOTE_GROUP_CAP + 5 }, (_, i) => branch(`origin/b${i}`, 'remote'));
    const capped = remoteBranchView(many, '', false, false);
    expect(capped.capped).toBe(true);
    expect(capped.groups[0].rows).toHaveLength(REMOTE_GROUP_CAP);
    expect(capped.groups[0].total).toBe(REMOTE_GROUP_CAP + 5);
    expect(capped.count).toBe(REMOTE_GROUP_CAP + 5);

    const all = remoteBranchView(many, '', false, true);
    expect(all.capped).toBe(false);
    expect(all.groups[0].rows).toHaveLength(REMOTE_GROUP_CAP + 5);
  });
});
