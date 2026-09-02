import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorksetLandingReport } from '@shared/types';

let invoke: ReturnType<typeof vi.fn>;
let useStore: typeof import('./store').useStore;
const report = (): WorksetLandingReport => ({ worksetId: 'ws', checkedAt: '2026-01-01T00:00:00Z', gitVersion: '2.40.0', supported: true, outcomes: [], collisions: [] });

beforeEach(async () => {
  vi.resetModules();
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'workset:landing') return report();
    if (channel === 'workset:fetchAll') return [];
    throw new Error(`unexpected channel: ${channel}`);
  });
  (globalThis as unknown as { window: unknown }).window = { overgit: { invoke, onMainEvent: vi.fn() } };
  ({ useStore } = await import('./store'));
});

describe('refreshWorksetLanding cache behavior', () => {
  it('skips a second unforced refresh within its TTL', async () => {
    await useStore.getState().refreshWorksetLanding('ws');
    await useStore.getState().refreshWorksetLanding('ws');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useStore.getState().worksetLanding.ws).toEqual(report());
  });

  it('force refreshes immediately despite the TTL', async () => {
    await useStore.getState().refreshWorksetLanding('ws');
    await useStore.getState().refreshWorksetLanding('ws', true);
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['workset:landing', 'workset:landing']);
  });

  it('fetches before forcing the landing preflight from the user action', async () => {
    await useStore.getState().runLandingCheck('ws');
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['workset:fetchAll', 'workset:landing']);
    // The explicit re-check is the one path that bypasses the main-process SHA memo.
    expect(invoke.mock.calls[1][1]).toEqual({ worksetId: 'ws', force: true });
    expect(useStore.getState().worksetLanding.ws).toEqual(report());
  });

  it('still runs the preflight when the fetch fails', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'workset:fetchAll') throw new Error('offline');
      if (channel === 'workset:landing') return report();
      throw new Error(`unexpected channel: ${channel}`);
    });
    await expect(useStore.getState().runLandingCheck('ws')).resolves.toBeUndefined();
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['workset:fetchAll', 'workset:landing']);
  });

  it('passes an unforced request from the ambient refresh', async () => {
    await useStore.getState().refreshWorksetLanding('ws');
    expect(invoke.mock.calls[0][1]).toEqual({ worksetId: 'ws' });
  });
});
