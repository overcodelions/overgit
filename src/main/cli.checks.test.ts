import { describe, expect, it } from 'vitest';
import { summarizeChecks } from './cli';

describe('summarizeChecks', () => {
  it('reports none when there are no checks', () => {
    expect(summarizeChecks(null).state).toBe('none');
    expect(summarizeChecks([]).total).toBe(0);
  });

  it('counts passing check runs, including neutral and skipped', () => {
    const s = summarizeChecks([
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'NEUTRAL' },
    ]);
    expect(s).toMatchObject({ state: 'success', passed: 3, failed: 0, pending: 0, total: 3 });
  });

  it('treats an incomplete run as pending whatever its conclusion', () => {
    const s = summarizeChecks([
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
    ]);
    expect(s).toMatchObject({ state: 'pending', passed: 1, pending: 1 });
  });

  it('lets any failure win and names the failing checks', () => {
    const s = summarizeChecks([
      { __typename: 'CheckRun', name: 'e2e', status: 'QUEUED' },
      { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'deploy', status: 'COMPLETED', conclusion: 'CANCELLED' },
    ]);
    expect(s.state).toBe('failure');
    expect(s.failing).toEqual(['unit', 'deploy']);
  });

  it('reads legacy commit statuses by state', () => {
    const s = summarizeChecks([
      { __typename: 'StatusContext', context: 'ci/jenkins', state: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'ci/circle', state: 'PENDING' },
      { __typename: 'StatusContext', context: 'codecov', state: 'ERROR' },
    ]);
    expect(s).toMatchObject({ state: 'failure', passed: 1, pending: 1, failed: 1 });
    expect(s.failing).toEqual(['codecov']);
  });
});
