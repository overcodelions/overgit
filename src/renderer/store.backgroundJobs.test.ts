import { beforeEach, describe, expect, it, vi } from 'vitest';

let useStore: typeof import('./store').useStore;

beforeEach(async () => {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = {
    overgit: { invoke: vi.fn(), onMainEvent: vi.fn() },
  };
  ({ useStore } = await import('./store'));
});

const job = (id = 'job-1') => ({
  id,
  verb: 'Syncing',
  scope: 'acme',
  done: 2,
  total: 5,
});

describe('background jobs', () => {
  it('starts empty so the title bar stays quiet', () => {
    expect(useStore.getState().backgroundJobs).toEqual([]);
  });

  it('registers a job and advances its progress', () => {
    const s = useStore.getState();
    s.beginBackgroundJob(job());
    s.advanceBackgroundJob('job-1', 4);
    expect(useStore.getState().backgroundJobs).toEqual([{ ...job(), done: 4 }]);
  });

  it('ignores progress for a run that was never backgrounded', () => {
    // Sheet workers call advance unconditionally — a foregrounded run
    // must not put a pill in the title bar.
    useStore.getState().advanceBackgroundJob('job-1', 3);
    expect(useStore.getState().backgroundJobs).toEqual([]);
  });

  it('clears the job when it ends', () => {
    const s = useStore.getState();
    s.beginBackgroundJob(job());
    s.beginBackgroundJob(job('job-2'));
    s.endBackgroundJob('job-1');
    expect(useStore.getState().backgroundJobs.map((j) => j.id)).toEqual(['job-2']);
  });

  it('replaces a re-registered job rather than doubling it', () => {
    const s = useStore.getState();
    s.beginBackgroundJob(job());
    s.beginBackgroundJob({ ...job(), done: 5 });
    expect(useStore.getState().backgroundJobs).toHaveLength(1);
    expect(useStore.getState().backgroundJobs[0].done).toBe(5);
  });
});
