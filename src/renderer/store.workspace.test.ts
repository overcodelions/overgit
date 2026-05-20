import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repo, RepoStatus, Workspace } from '@shared/types';
import type { Sheet } from './store';

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

function workspace(id: string, name: string, repoIds: string[], collapsed?: boolean): Workspace {
  const ws: Workspace = {
    id,
    name,
    repoIds: [...repoIds],
  };
  if (collapsed !== undefined) ws.collapsed = collapsed;
  return ws;
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

function patchStore(partial: Partial<StoreState>): void {
  useStore.setState(partial as Partial<StoreState>);
}

beforeEach(() => {
  useStore.setState(useStore.getInitialState());
  mockInvoke.mockReset();
});

describe('workspace actions', () => {
  it('selectWorkspace sets the selected workspace and clears repo/workset selection without IPC', () => {
    patchStore({
      selectedWorkspaceId: 'workspace-old',
      selectedWorksetId: 'workset-1',
      selectedRepoId: 'repo-1',
    });

    useStore.getState().selectWorkspace('workspace-new');

    expect(useStore.getState().selectedWorkspaceId).toBe('workspace-new');
    expect(useStore.getState().selectedWorksetId).toBeNull();
    expect(useStore.getState().selectedRepoId).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('createWorkspace appends a workspace, stamps createdAt, saves, and returns the id', async () => {
    const existing = workspace('workspace-existing', 'Existing', ['repo-a']);
    patchStore({ workspaces: [existing] });

    const repoIds = ['repo-a', 'repo-b'];
    const id = await useStore.getState().createWorkspace('New Workspace', repoIds);

    const saved = useStore.getState().workspaces;
    expect(saved).toHaveLength(2);
    expect(saved[0]).toEqual(existing);
    expect(saved[1]).toMatchObject({
      id,
      name: 'New Workspace',
      repoIds,
    });
    expect(saved[1].createdAt).toBeDefined();
    expect(new Date(saved[1].createdAt ?? '').toISOString()).toBe(saved[1].createdAt);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorkspaces', saved);
    expect(id).toBe(saved[1].id);
  });

  it('updateWorkspace patches only the targeted workspace name', async () => {
    const first = workspace('workspace-1', 'Alpha', ['repo-a']);
    const second = workspace('workspace-2', 'Beta', ['repo-b']);
    patchStore({ workspaces: [first, second] });

    await useStore.getState().updateWorkspace('workspace-1', { name: 'Alpha Prime' });

    const saved = useStore.getState().workspaces;
    expect(saved).toEqual([
      { ...first, name: 'Alpha Prime' },
      second,
    ]);
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorkspaces', saved);
  });

  it('updateWorkspace patches repoIds independently of name', async () => {
    const first = workspace('workspace-1', 'Alpha', ['repo-a']);
    const second = workspace('workspace-2', 'Beta', ['repo-b']);
    patchStore({ workspaces: [first, second] });

    await useStore.getState().updateWorkspace('workspace-1', { repoIds: ['repo-c', 'repo-d'] });

    const saved = useStore.getState().workspaces;
    expect(saved).toEqual([
      { ...first, repoIds: ['repo-c', 'repo-d'] },
      second,
    ]);
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorkspaces', saved);
  });

  it('removeWorkspace deletes the workspace and clears the selection when it was selected', async () => {
    const first = workspace('workspace-1', 'Alpha', ['repo-a']);
    const second = workspace('workspace-2', 'Beta', ['repo-b']);
    patchStore({
      workspaces: [first, second],
      selectedWorkspaceId: 'workspace-1',
    });

    await useStore.getState().removeWorkspace('workspace-1');

    expect(useStore.getState().workspaces).toEqual([second]);
    expect(useStore.getState().selectedWorkspaceId).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorkspaces', [second]);
  });

  it('removeWorkspace leaves a different selection alone', async () => {
    const first = workspace('workspace-1', 'Alpha', ['repo-a']);
    const second = workspace('workspace-2', 'Beta', ['repo-b']);
    patchStore({
      workspaces: [first, second],
      selectedWorkspaceId: 'workspace-2',
    });

    await useStore.getState().removeWorkspace('workspace-1');

    expect(useStore.getState().workspaces).toEqual([second]);
    expect(useStore.getState().selectedWorkspaceId).toBe('workspace-2');
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorkspaces', [second]);
  });

  it('toggleWorkspaceCollapsed flips undefined to true without changing other workspaces', async () => {
    const first = workspace('workspace-1', 'Alpha', ['repo-a']);
    const second = workspace('workspace-2', 'Beta', ['repo-b'], true);
    patchStore({ workspaces: [first, second] });

    await useStore.getState().toggleWorkspaceCollapsed('workspace-1');

    const saved = useStore.getState().workspaces;
    expect(saved).toEqual([
      { ...first, collapsed: true },
      second,
    ]);
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorkspaces', saved);
  });

  it('toggleWorkspaceCollapsed flips true back to false', async () => {
    const first = workspace('workspace-1', 'Alpha', ['repo-a'], true);
    const second = workspace('workspace-2', 'Beta', ['repo-b']);
    patchStore({ workspaces: [first, second] });

    await useStore.getState().toggleWorkspaceCollapsed('workspace-1');

    const saved = useStore.getState().workspaces;
    expect(saved).toEqual([
      { ...first, collapsed: false },
      second,
    ]);
    expect(mockInvoke).toHaveBeenCalledWith('store:saveWorkspaces', saved);
  });

  it('fetchAllInWorkspace no-ops when the workspace is missing', async () => {
    const pushToast = vi.fn();
    const setSheet = vi.fn();
    patchStore({ pushToast, setSheet, workspaces: [] });

    await useStore.getState().fetchAllInWorkspace('workspace-missing');

    expect(pushToast).not.toHaveBeenCalled();
    expect(setSheet).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('fetchAllInWorkspace warns when the workspace has no repos', async () => {
    const pushToast = vi.fn();
    const setSheet = vi.fn();
    patchStore({
      pushToast,
      setSheet,
      workspaces: [workspace('workspace-1', 'Platform', [])],
    });

    await useStore.getState().fetchAllInWorkspace('workspace-1');

    expect(pushToast).toHaveBeenCalledWith({
      kind: 'warn',
      message: 'Platform has no repos to fetch.',
    });
    expect(setSheet).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('fetchAllInWorkspace opens the fetch progress sheet when repos exist', async () => {
    const pushToast = vi.fn();
    const setSheet = vi.fn();
    patchStore({
      pushToast,
      setSheet,
      workspaces: [workspace('workspace-1', 'Platform', ['repo-a', 'repo-b'])],
    });

    await useStore.getState().fetchAllInWorkspace('workspace-1');

    expect(pushToast).not.toHaveBeenCalled();
    expect(setSheet).toHaveBeenCalledWith({
      kind: 'fetchWorkspaceProgress',
      workspaceId: 'workspace-1',
      repoIds: ['repo-a', 'repo-b'],
    } satisfies Sheet);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('runResetWorkspaceFlow no-ops when the workspace is missing', async () => {
    const pushToast = vi.fn();
    const requestConfirm = vi.fn();
    const setSheet = vi.fn();
    patchStore({ pushToast, requestConfirm, setSheet, workspaces: [] });

    await useStore.getState().runResetWorkspaceFlow('workspace-missing');

    expect(pushToast).not.toHaveBeenCalled();
    expect(requestConfirm).not.toHaveBeenCalled();
    expect(setSheet).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('runResetWorkspaceFlow warns when the workspace has no member repos', async () => {
    const pushToast = vi.fn();
    const requestConfirm = vi.fn();
    const setSheet = vi.fn();
    patchStore({
      pushToast,
      requestConfirm,
      setSheet,
      workspaces: [workspace('workspace-1', 'Platform', ['repo-a'])],
      repos: [],
    });

    await useStore.getState().runResetWorkspaceFlow('workspace-1');

    expect(pushToast).toHaveBeenCalledWith({
      kind: 'warn',
      message: 'Platform has no repos to reset.',
    });
    expect(requestConfirm).not.toHaveBeenCalled();
    expect(setSheet).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('runResetWorkspaceFlow confirms clean workspaces without mentioning dirty repos', async () => {
    const pushToast = vi.fn();
    const requestConfirm = vi.fn().mockResolvedValue(false);
    const setSheet = vi.fn();
    const repos = [repo('repo-a', 'api'), repo('repo-b', 'web')];
    patchStore({
      pushToast,
      requestConfirm,
      setSheet,
      workspaces: [workspace('workspace-1', 'Platform', ['repo-a', 'repo-b'])],
      repos,
      repoStatus: {
        'repo-a': repoStatus('repo-a', 0),
        'repo-b': repoStatus('repo-b', 0),
      },
    });

    await useStore.getState().runResetWorkspaceFlow('workspace-1');

    expect(requestConfirm).toHaveBeenCalledTimes(1);
    const args = requestConfirm.mock.calls[0]?.[0];
    expect(args.title).toBe('Reset Platform to default?');
    expect(args.body).toContain('Fetch, switch to default branch, and pull on every repo in Platform (2).');
    expect(args.body).not.toContain('Will skip');
    expect(setSheet).not.toHaveBeenCalled();
    expect(pushToast).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('runResetWorkspaceFlow includes dirty repo names and opens the reset sheet on confirm', async () => {
    const pushToast = vi.fn();
    const requestConfirm = vi.fn().mockResolvedValue(true);
    const setSheet = vi.fn();
    const repos = [repo('repo-a', 'api'), repo('repo-b', 'web')];
    patchStore({
      pushToast,
      requestConfirm,
      setSheet,
      workspaces: [workspace('workspace-1', 'Platform', ['repo-a', 'repo-b'])],
      repos,
      repoStatus: {
        'repo-a': repoStatus('repo-a', 1),
        'repo-b': repoStatus('repo-b', 0),
      },
    });

    await useStore.getState().runResetWorkspaceFlow('workspace-1');

    expect(requestConfirm).toHaveBeenCalledTimes(1);
    const args = requestConfirm.mock.calls[0]?.[0];
    expect(args.body).toContain('Will skip 1 dirty repo');
    expect(args.body).toContain('api');
    expect(args.body).not.toContain('web');
    expect(setSheet).toHaveBeenCalledWith({
      kind: 'resetWorkspaceProgress',
      workspaceId: 'workspace-1',
      repoIds: ['repo-a', 'repo-b'],
    } satisfies Sheet);
    expect(pushToast).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('resetWorkspaceToDefault proxies to IPC and returns the result', async () => {
    const result = [{ repoId: 'repo-a', defaultBranch: 'main', result: 'reset' }] as any;
    const before = useStore.getState().workspaces;
    mockInvoke.mockResolvedValueOnce(result);

    const returned = await useStore.getState().resetWorkspaceToDefault('workspace-1');

    expect(returned).toBe(result);
    expect(mockInvoke).toHaveBeenCalledWith('workspace:resetToDefault', {
      workspaceId: 'workspace-1',
    });
    expect(useStore.getState().workspaces).toBe(before);
  });
});
