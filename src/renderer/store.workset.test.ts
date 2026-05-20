import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSettings,
  CheckoutOutcome,
  CommitAllOutcome,
  Repo,
  RepoPRs,
  RepoStatus,
  SyncAndBranchOutcome,
  Workset,
  WorksetOpenPROutcome,
  WorksetPushOutcome,
} from '@shared/types';

const mockInvoke = vi.fn();

vi.stubGlobal('window', {
  overgit: {
    invoke: mockInvoke,
  },
});

const { useStore } = await import('./store');

type StoreState = ReturnType<typeof useStore.getState>;

function repo(id: string, name: string): Repo {
  return {
    id,
    name,
    path: `/repos/${name}`,
  };
}

function repoStatus(id: string, dirtyCount: number): RepoStatus {
  return {
    repoId: id,
    branch: 'main',
    dirtyCount,
    worktreeAdds: null,
    worktreeDels: null,
    ahead: null,
    behind: null,
    hasUpstream: false,
    upstreamGone: false,
    aheadDefault: null,
    behindDefault: null,
    defaultRef: null,
  };
}

function workset(id: string, name: string, repoIds: string[], preferredBranch?: string): Workset {
  const ws: Workset = {
    id,
    name,
    repoIds: [...repoIds],
  };
  if (preferredBranch !== undefined) {
    ws.preferredBranch = preferredBranch;
  }
  return ws;
}

function patchStore(partial: Partial<StoreState>): void {
  useStore.setState(partial as Partial<StoreState>);
}

function invokeCalls(channel: string): Array<[string, unknown]> {
  return mockInvoke.mock.calls.filter(([name]) => name === channel) as Array<[string, unknown]>;
}

function installInvokeHandlers(
  handlers: Record<string, (payload?: unknown) => unknown>,
): void {
  mockInvoke.mockImplementation((channel: string, payload?: unknown) => {
    const handler = handlers[channel];
    if (!handler) throw new Error(`Unexpected invoke: ${channel}`);
    return handler(payload);
  });
}

function settingsWith(overrides: Partial<AppSettings>): AppSettings {
  return {
    ...useStore.getInitialState().settings,
    ...overrides,
  } as AppSettings;
}

beforeEach(() => {
  useStore.setState(useStore.getInitialState());
  mockInvoke.mockReset();
});

describe('workset CRUD actions', () => {
  it('createWorkset appends a workset, trims preferredBranch, selects it, and saves the full list', async () => {
    const existing = workset('workset-existing', 'Existing', ['repo-a']);
    patchStore({
      worksets: [existing],
      selectedRepoId: 'repo-selected',
      selectedWorkspaceId: 'workspace-selected',
    });
    installInvokeHandlers({
      'store:saveWorksets': () => undefined,
      'workset:listPRs': () => [],
    });

    await useStore.getState().createWorkset('New Workset', ['repo-a', 'repo-b'], '  feature/cleanup  ');

    const saved = useStore.getState().worksets;
    expect(saved).toHaveLength(2);
    expect(saved[0]).toEqual(existing);
    expect(saved[1]).toMatchObject({
      name: 'New Workset',
      repoIds: ['repo-a', 'repo-b'],
      preferredBranch: 'feature/cleanup',
    });
    expect(saved[1].createdAt).toBeDefined();
    expect(new Date(saved[1].createdAt ?? '').toISOString()).toBe(saved[1].createdAt);
    expect(useStore.getState().selectedWorksetId).toBe(saved[1].id);
    expect(useStore.getState().selectedRepoId).toBeNull();
    expect(useStore.getState().selectedWorkspaceId).toBeNull();
    expect(invokeCalls('store:saveWorksets')).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorksets', saved);
  });

  it('createWorkset leaves preferredBranch unset when the input is blank', async () => {
    patchStore({ worksets: [] });
    installInvokeHandlers({
      'store:saveWorksets': () => undefined,
      'workset:listPRs': () => [],
    });

    await useStore.getState().createWorkset('Blank Branch', ['repo-a'], '   ');

    const saved = useStore.getState().worksets;
    expect(saved).toHaveLength(1);
    expect(saved[0]).not.toHaveProperty('preferredBranch');
  });

  it('selectWorkset updates selection and clears repo/workspace selection', () => {
    patchStore({
      worksets: [],
      selectedWorksetId: 'workset-old',
      selectedRepoId: 'repo-old',
      selectedWorkspaceId: 'workspace-old',
    });
    installInvokeHandlers({
      'workset:listPRs': () => [],
    });

    useStore.getState().selectWorkset('workset-new');

    expect(useStore.getState().selectedWorksetId).toBe('workset-new');
    expect(useStore.getState().selectedRepoId).toBeNull();
    expect(useStore.getState().selectedWorkspaceId).toBeNull();
  });

  it('updateWorkset patches only the targeted workset name', async () => {
    const first = workset('workset-1', 'Alpha', ['repo-a']);
    const second = workset('workset-2', 'Beta', ['repo-b']);
    patchStore({ worksets: [first, second] });
    installInvokeHandlers({
      'store:saveWorksets': () => undefined,
    });

    await useStore.getState().updateWorkset('workset-1', { name: 'Alpha Prime' });

    const saved = useStore.getState().worksets;
    expect(saved).toEqual([
      { ...first, name: 'Alpha Prime' },
      second,
    ]);
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorksets', saved);
  });

  it('updateWorkset patches only the targeted workset repoIds', async () => {
    const first = workset('workset-1', 'Alpha', ['repo-a']);
    const second = workset('workset-2', 'Beta', ['repo-b']);
    patchStore({ worksets: [first, second] });
    installInvokeHandlers({
      'store:saveWorksets': () => undefined,
    });

    await useStore.getState().updateWorkset('workset-1', { repoIds: ['repo-c', 'repo-d'] });

    const saved = useStore.getState().worksets;
    expect(saved).toEqual([
      { ...first, repoIds: ['repo-c', 'repo-d'] },
      second,
    ]);
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorksets', saved);
  });

  it('removeWorkset removes the selected workset and clears the selection', async () => {
    const first = workset('workset-1', 'Alpha', []);
    const second = workset('workset-2', 'Beta', []);
    patchStore({
      worksets: [first, second],
      selectedWorksetId: 'workset-1',
    });
    installInvokeHandlers({
      'store:saveWorksets': () => undefined,
    });

    await useStore.getState().removeWorkset('workset-1');

    expect(useStore.getState().worksets).toEqual([second]);
    expect(useStore.getState().selectedWorksetId).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorksets', [second]);
  });

  it('removeWorkset preserves a different selected workset', async () => {
    const first = workset('workset-1', 'Alpha', []);
    const second = workset('workset-2', 'Beta', []);
    patchStore({
      worksets: [first, second],
      selectedWorksetId: 'workset-2',
    });
    installInvokeHandlers({
      'store:saveWorksets': () => undefined,
    });

    await useStore.getState().removeWorkset('workset-1');

    expect(useStore.getState().worksets).toEqual([second]);
    expect(useStore.getState().selectedWorksetId).toBe('workset-2');
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorksets', [second]);
  });

  it('archiveWorkset marks the targeted workset archived and clears the selection when selected', async () => {
    const first = workset('workset-1', 'Alpha', []);
    const second = workset('workset-2', 'Beta', []);
    patchStore({
      worksets: [first, second],
      selectedWorksetId: 'workset-1',
    });
    installInvokeHandlers({
      'store:saveWorksets': () => undefined,
    });

    await useStore.getState().archiveWorkset('workset-1');

    const saved = useStore.getState().worksets;
    expect(saved[0].archived).toBe(true);
    expect(saved[0].archivedAt).toBeDefined();
    expect(new Date(saved[0].archivedAt ?? '').toISOString()).toBe(saved[0].archivedAt);
    expect(saved[1]).toEqual(second);
    expect(useStore.getState().selectedWorksetId).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorksets', saved);
  });

  it('archiveWorkset preserves a different selected workset', async () => {
    const first = workset('workset-1', 'Alpha', []);
    const second = workset('workset-2', 'Beta', []);
    patchStore({
      worksets: [first, second],
      selectedWorksetId: 'workset-2',
    });
    installInvokeHandlers({
      'store:saveWorksets': () => undefined,
    });

    await useStore.getState().archiveWorkset('workset-1');

    expect(useStore.getState().worksets[0].archived).toBe(true);
    expect(useStore.getState().selectedWorksetId).toBe('workset-2');
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorksets', useStore.getState().worksets);
  });

  it('unarchiveWorkset clears archived flags and reselects the workset', async () => {
    const archived = {
      ...workset('workset-1', 'Alpha', []),
      archived: true,
      archivedAt: '2025-01-01T00:00:00.000Z',
    };
    patchStore({
      worksets: [archived],
      selectedWorksetId: 'workset-old',
      selectedRepoId: 'repo-old',
      selectedWorkspaceId: 'workspace-old',
    });
    installInvokeHandlers({
      'store:saveWorksets': () => undefined,
      'workset:listPRs': () => [],
    });

    await useStore.getState().unarchiveWorkset('workset-1');

    const saved = useStore.getState().worksets;
    expect(saved[0].archived).toBe(false);
    expect(saved[0].archivedAt).toBeUndefined();
    expect(useStore.getState().selectedWorksetId).toBe('workset-1');
    expect(useStore.getState().selectedRepoId).toBeNull();
    expect(useStore.getState().selectedWorkspaceId).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorksets', saved);
  });

  it('markWorksetSeen stamps the workset and preserves other timestamps', async () => {
    patchStore({
      settings: settingsWith({
        worksetLastSeen: {
          'workset-old': '2025-01-01T00:00:00.000Z',
        },
      }),
    });
    installInvokeHandlers({
      'store:saveSettings': () => undefined,
    });

    await useStore.getState().markWorksetSeen('workset-new');

    const settings = useStore.getState().settings;
    expect(settings.worksetLastSeen?.['workset-old']).toBe('2025-01-01T00:00:00.000Z');
    expect(settings.worksetLastSeen?.['workset-new']).toBeDefined();
    expect(new Date(settings.worksetLastSeen?.['workset-new'] ?? '').toISOString()).toBe(
      settings.worksetLastSeen?.['workset-new'],
    );
    expect(mockInvoke).toHaveBeenCalledWith('store:saveSettings', settings);
  });
});

describe('workset operations', () => {
  it('commitAllWorkset calls IPC with the workset payload and refreshes member statuses', async () => {
    const worksetId = 'workset-commit';
    const repoIds = ['repo-a', 'repo-b'];
    const outcomes: CommitAllOutcome[] = [
      { repoId: 'repo-a', result: 'committed' },
      { repoId: 'repo-b', result: 'clean' },
    ];
    patchStore({
      worksets: [workset(worksetId, 'Alpha', repoIds)],
      repos: [repo('repo-a', 'api'), repo('repo-b', 'web')],
    });
    installInvokeHandlers({
      'workset:commitAll': () => outcomes,
      'repo:status': (payload) => repoStatus(String(payload), 0),
    });

    const returned = await useStore.getState().commitAllWorkset(worksetId, 'Ship it');

    expect(returned).toBe(outcomes);
    expect(mockInvoke).toHaveBeenCalledWith('workset:commitAll', {
      worksetId,
      message: 'Ship it',
    });
    expect(invokeCalls('repo:status')).toHaveLength(2);
    expect(mockInvoke).toHaveBeenCalledWith('repo:status', 'repo-a');
    expect(mockInvoke).toHaveBeenCalledWith('repo:status', 'repo-b');
  });

  it('pushAllWorkset calls IPC and refreshes member statuses after the push', async () => {
    const worksetId = 'workset-push';
    const repoIds = ['repo-a', 'repo-b'];
    const outcomes: WorksetPushOutcome[] = [
      { repoId: 'repo-a', result: 'pushed' },
      { repoId: 'repo-b', result: 'up-to-date' },
    ];
    patchStore({
      worksets: [workset(worksetId, 'Alpha', repoIds)],
      repos: [repo('repo-a', 'api'), repo('repo-b', 'web')],
    });
    installInvokeHandlers({
      'workset:pushAll': () => outcomes,
      'repo:status': (payload) => repoStatus(String(payload), 0),
    });

    const returned = await useStore.getState().pushAllWorkset(worksetId);

    expect(returned).toBe(outcomes);
    expect(mockInvoke).toHaveBeenCalledWith('workset:pushAll', worksetId);
    expect(invokeCalls('repo:status')).toHaveLength(2);
    expect(mockInvoke).toHaveBeenCalledWith('repo:status', 'repo-a');
    expect(mockInvoke).toHaveBeenCalledWith('repo:status', 'repo-b');
  });

  it('openPRsWorkset calls IPC with the PR payload and refreshes the PR cache', async () => {
    const worksetId = 'workset-open-prs';
    const outcomes: WorksetOpenPROutcome[] = [
      { repoId: 'repo-a', result: 'created', number: 42, url: 'https://example.com/pr/42' },
    ];
    const prs: RepoPRs[] = [{ repoId: 'repo-a', prs: [] }];
    patchStore({
      worksets: [workset(worksetId, 'Alpha', [])],
    });
    installInvokeHandlers({
      'workset:openPRs': () => outcomes,
      'workset:listPRs': () => prs,
    });

    const returned = await useStore.getState().openPRsWorkset(worksetId, {
      title: 'Add auth',
      body: 'Ship auth',
      draft: true,
    });

    expect(returned).toBe(outcomes);
    expect(mockInvoke).toHaveBeenCalledWith('workset:openPRs', {
      worksetId,
      title: 'Add auth',
      body: 'Ship auth',
      draft: true,
    });
    expect(mockInvoke).toHaveBeenCalledWith('workset:listPRs', worksetId);
    expect(useStore.getState().worksetPRs[worksetId]).toBe(prs);
  });

  it('checkoutWorksetBranch stores the last checkout and refreshes status', async () => {
    const worksetId = 'workset-checkout';
    const repoIds = ['repo-a', 'repo-b'];
    const outcomes: CheckoutOutcome[] = [
      { repoId: 'repo-a', branch: 'feature/ship', result: 'switched' },
      { repoId: 'repo-b', branch: 'feature/ship', result: 'dirty', message: 'dirty tree' },
    ];
    patchStore({
      worksets: [workset(worksetId, 'Alpha', repoIds)],
      repos: [repo('repo-a', 'api'), repo('repo-b', 'web')],
    });
    installInvokeHandlers({
      'workset:checkoutBranch': () => outcomes,
      'repo:status': (payload) => repoStatus(String(payload), 0),
    });

    await useStore.getState().checkoutWorksetBranch(worksetId, 'feature/ship', true);

    expect(mockInvoke).toHaveBeenCalledWith('workset:checkoutBranch', {
      worksetId,
      branch: 'feature/ship',
      createIfMissing: true,
    });
    expect(useStore.getState().lastCheckout).toEqual({
      worksetId,
      branch: 'feature/ship',
      outcomes,
    });
    expect(invokeCalls('repo:status')).toHaveLength(2);
  });

  it('fetchWorkset fetches the workset and refreshes status plus PRs', async () => {
    const worksetId = 'workset-fetch';
    const repoIds = ['repo-a', 'repo-b'];
    const prs: RepoPRs[] = [{ repoId: 'repo-a', prs: [] }];
    patchStore({
      worksets: [workset(worksetId, 'Alpha', repoIds)],
      repos: [repo('repo-a', 'api'), repo('repo-b', 'web')],
    });
    installInvokeHandlers({
      'workset:fetchAll': () => undefined,
      'repo:status': (payload) => repoStatus(String(payload), 0),
      'workset:listPRs': () => prs,
    });

    await useStore.getState().fetchWorkset(worksetId);

    expect(mockInvoke).toHaveBeenCalledWith('workset:fetchAll', worksetId);
    expect(mockInvoke).toHaveBeenCalledWith('workset:listPRs', worksetId);
    expect(invokeCalls('repo:status')).toHaveLength(2);
    expect(useStore.getState().worksetPRs[worksetId]).toBe(prs);
  });

  it('resumeWorksetBranch uses checkoutBranch when the branch already exists', async () => {
    const worksetId = 'workset-resume-existing';
    const repoIds = ['repo-a', 'repo-b'];
    const outcomes: CheckoutOutcome[] = [
      { repoId: 'repo-a', branch: 'feature/resume', result: 'switched' },
    ];
    patchStore({
      worksets: [workset(worksetId, 'Alpha', repoIds)],
      repos: [repo('repo-a', 'api'), repo('repo-b', 'web')],
    });
    installInvokeHandlers({
      'workset:branchSuggestions': () => [{ branch: 'feature/resume', repoCount: 1 }],
      'workset:checkoutBranch': () => outcomes,
      'repo:status': (payload) => repoStatus(String(payload), 0),
    });

    await useStore.getState().resumeWorksetBranch(worksetId, 'feature/resume');

    expect(mockInvoke).toHaveBeenCalledWith('workset:branchSuggestions', worksetId);
    expect(mockInvoke).toHaveBeenCalledWith('workset:checkoutBranch', {
      worksetId,
      branch: 'feature/resume',
      createIfMissing: false,
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'workset:syncAndBranch',
      expect.anything(),
    );
    expect(useStore.getState().lastCheckout).toEqual({
      worksetId,
      branch: 'feature/resume',
      outcomes,
    });
  });

  it('resumeWorksetBranch falls back to syncAndBranch and normalizes the outcomes', async () => {
    const worksetId = 'workset-resume-new';
    const repoIds = ['repo-a', 'repo-b', 'repo-c'];
    const syncOutcomes: SyncAndBranchOutcome[] = [
      {
        repoId: 'repo-a',
        branch: 'feature/resume',
        defaultBranch: 'main',
        result: 'created',
      },
      {
        repoId: 'repo-b',
        branch: 'feature/resume',
        defaultBranch: 'main',
        result: 'dirty',
        message: 'uncommitted changes',
      },
      {
        repoId: 'repo-c',
        branch: 'feature/resume',
        defaultBranch: 'main',
        result: 'pull-failed',
      },
    ];
    patchStore({
      worksets: [workset(worksetId, 'Alpha', repoIds)],
      repos: [repo('repo-a', 'api'), repo('repo-b', 'web'), repo('repo-c', 'docs')],
    });
    installInvokeHandlers({
      'workset:branchSuggestions': () => [{ branch: 'feature/other', repoCount: 1 }],
      'workset:syncAndBranch': () => syncOutcomes,
      'repo:status': (payload) => repoStatus(String(payload), 0),
    });

    await useStore.getState().resumeWorksetBranch(worksetId, 'feature/resume');

    expect(mockInvoke).toHaveBeenCalledWith('workset:branchSuggestions', worksetId);
    expect(mockInvoke).toHaveBeenCalledWith('workset:syncAndBranch', {
      worksetId,
      branch: 'feature/resume',
      syncDefault: true,
      pullBeforeBranch: true,
    });
    expect(useStore.getState().lastCheckout).toEqual({
      worksetId,
      branch: 'feature/resume',
      outcomes: [
        { repoId: 'repo-a', branch: 'feature/resume', result: 'switched' },
        {
          repoId: 'repo-b',
          branch: 'feature/resume',
          result: 'dirty',
          message: 'uncommitted changes',
        },
        {
          repoId: 'repo-c',
          branch: 'feature/resume',
          result: 'error',
          message: 'pull-failed',
        },
      ],
    });
  });

  it('refreshWorksetPRs stores the result and skips a second call within the TTL', async () => {
    const worksetId = 'workset-pr-cache';
    const prs: RepoPRs[] = [{ repoId: 'repo-a', prs: [] }];
    patchStore({
      worksets: [workset(worksetId, 'Alpha', [])],
    });
    installInvokeHandlers({
      'workset:listPRs': () => prs,
    });

    await useStore.getState().refreshWorksetPRs(worksetId);
    await useStore.getState().refreshWorksetPRs(worksetId);

    expect(invokeCalls('workset:listPRs')).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledWith('workset:listPRs', worksetId);
    expect(useStore.getState().worksetPRs[worksetId]).toBe(prs);
  });
});
