import { describe, expect, it } from 'vitest';
import { gettingStartedSteps, shouldShowGettingStarted } from './gettingStarted';

describe('getting started checklist', () => {
  it('stays away until there is a repo — the first-run screen covers that', () => {
    const steps = gettingStartedSteps({ repos: 0, workspaces: 0, worksets: 0 });
    expect(shouldShowGettingStarted(steps, false)).toBe(false);
  });

  it('shows with a repo and open steps', () => {
    const steps = gettingStartedSteps({ repos: 3, workspaces: 0, worksets: 1 });
    expect(steps.map((s) => s.done)).toEqual([true, false, true]);
    expect(shouldShowGettingStarted(steps, undefined)).toBe(true);
  });

  it('retires itself once every step is done', () => {
    const steps = gettingStartedSteps({ repos: 3, workspaces: 1, worksets: 1 });
    expect(shouldShowGettingStarted(steps, false)).toBe(false);
  });

  it('respects Hide', () => {
    const steps = gettingStartedSteps({ repos: 3, workspaces: 0, worksets: 0 });
    expect(shouldShowGettingStarted(steps, true)).toBe(false);
  });
});
