import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RepoStatus } from '@shared/types';

// This module owns a module-level TTL cache (`_lastRefresh` / `_inflight`,
// not exported) keyed by the string 'refreshAllRepoStatuses'. That state
// persists across `it()` blocks unless the module is re-imported fresh,
// so every test resets modules and re-imports `useStore` from scratch.
let invoke: ReturnType<typeof vi.fn>;
let useStore: typeof import('./store').useStore;

function makeStatus(branch: string): RepoStatus {
  return {
    repoId: 'r1',
    branch,
    dirtyCount: 0,
    worktreeAdds: null,
    worktreeDels: null,
    ahead: null,
    behind: null,
    hasUpstream: false,
  } as RepoStatus;
}

beforeEach(async () => {
  vi.resetModules();
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'repo:status') return makeStatus('main');
    throw new Error(`unexpected channel: ${channel}`);
  });
  (globalThis as unknown as { window: unknown }).window = {
    overgit: { invoke, onMainEvent: vi.fn() },
  };
  ({ useStore } = await import('./store'));
  useStore.setState({
    repos: [{ id: 'r1', name: 'repo1', path: '/tmp/repo1' } as never],
  });
});

describe('refreshAllRepoStatuses TTL/force interaction', () => {
  it('a second unforced call within the TTL window is skipped (no repo:status IPC)', async () => {
    await useStore.getState().refreshAllRepoStatuses();
    expect(invoke).toHaveBeenCalledTimes(1);

    await useStore.getState().refreshAllRepoStatuses();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('force=true re-issues the fan-out even immediately after a prior refresh', async () => {
    await useStore.getState().refreshAllRepoStatuses();
    expect(invoke).toHaveBeenCalledTimes(1);

    await useStore.getState().refreshAllRepoStatuses(true);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('reproduces the reported bug: an unforced post-mutation refresh misses a branch change picked up only by a forced one', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'repo:status') return makeStatus('old-branch');
      throw new Error(`unexpected channel: ${channel}`);
    });
    await useStore.getState().refreshAllRepoStatuses();
    expect(useStore.getState().repoStatus.r1?.branch).toBe('old-branch');

    // Simulate the on-disk branch changing underneath us (e.g. a
    // workspace "Reset all"), then calling refreshAllRepoStatuses again
    // without force, as every call site used to do before this fix.
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'repo:status') return makeStatus('main');
      throw new Error(`unexpected channel: ${channel}`);
    });
    await useStore.getState().refreshAllRepoStatuses();
    expect(useStore.getState().repoStatus.r1?.branch).toBe('old-branch');

    // The fix: passing force=true bypasses the TTL skip and the branch
    // column catches up immediately, with no extra user action needed.
    await useStore.getState().refreshAllRepoStatuses(true);
    expect(useStore.getState().repoStatus.r1?.branch).toBe('main');
  });
});
