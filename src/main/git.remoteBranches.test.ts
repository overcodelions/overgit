import { describe, expect, it } from 'vitest';
import { parseRemoteBranchRefs } from './git';

describe('parseRemoteBranchRefs', () => {
  it('drops the origin/HEAD alias, which the short form shows as just "origin"', () => {
    const out = [
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
      'refs/remotes/origin/feat/rate-limit',
      'refs/remotes/upstream/HEAD',
      'refs/remotes/upstream/main',
      '',
    ].join('\n');
    expect(parseRemoteBranchRefs(out)).toEqual([
      'origin/main',
      'origin/feat/rate-limit',
      'upstream/main',
    ]);
  });

  it('ignores anything that is not a remote branch', () => {
    expect(parseRemoteBranchRefs('refs/heads/main\nrefs/remotes/origin\n')).toEqual([]);
  });
});
