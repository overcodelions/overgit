// Electron main process entry. Creates the main window and registers
// every IPC handler the renderer invokes. Main-process state lives here:
// the Store (persisted) and the cached CliPresence probe.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import {
  applyStash,
  branchSummaries,
  changes as gitChanges,
  checkoutBranch,
  cherryPick,
  commitAll,
  commitGraph,
  commitStaged,
  createBranch,
  deleteBranch,
  detectDefaultBranch,
  diff as gitDiff,
  diffFile,
  discardFiles,
  dropStash,
  fetch as gitFetch,
  listBranches,
  listBranchCommits,
  listStashes,
  log as gitLog,
  looksLikeRepo,
  pull as gitPull,
  push as gitPush,
  rawDiff,
  stageFiles,
  stash as gitStash,
  stashDiff,
  status as gitStatus,
  unstageFiles,
} from './git';
import { listFilesUnder, readFileUnderRoot, writeFileUnderRoot } from './fs';
import {
  workspaceCheckout,
  workspaceFetch,
  workspaceListPRs,
  workspaceStatus,
  workspaceSyncAndBranch,
} from './workspace';
import { detectCliPresence, reviewDiffWithLlm, suggestCommitMessage } from './cli';
import { Repo } from '../shared/types';

// Dev vs prod: hit the Vite dev server only when VITE_DEV_SERVER_URL is
// set (the dev:electron npm script sets it). Anything else — packaged
// .app, `npm start`, plain `electron .` — loads the built file:// HTML.
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !!DEV_URL;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: 'overgit',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1c1c21',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev && DEV_URL) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'undocked' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Lock the renderer to its initial origin: any navigation (rogue link,
  // redirect, window.open) is denied and bounced to the user's default
  // browser if the URL is plain http(s).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (url === current) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' ||
      u.protocol === 'http:' ||
      u.protocol === 'mailto:' ||
      u.protocol === 'tel:'
    );
  } catch {
    return false;
  }
}

function basename(p: string): string {
  const b = path.basename(p);
  return b || p;
}

function makeRepoFromPath(repoPath: string): Repo {
  return {
    id: randomUUID(),
    name: basename(repoPath),
    path: repoPath,
    lastOpenedAt: new Date().toISOString(),
  };
}

function registerIpc(): void {
  ipcMain.handle('store:load', () => Store.load());
  ipcMain.handle('store:saveRepos', (_e, repos) => Store.saveRepos(repos));
  ipcMain.handle('store:saveWorkspaces', (_e, workspaces) => Store.saveWorkspaces(workspaces));
  ipcMain.handle('store:saveSettings', (_e, settings) => Store.saveSettings(settings));

  // Async helper: add a repo and seed its `defaultBranch` from
  // `origin/HEAD` if available. Detection is best-effort — a fresh
  // local repo with no remote returns null and the user can pick one
  // in Settings.
  const addRepoFromPath = async (chosen: string): Promise<Repo> => {
    const state = Store.load();
    const existing = state.repos.find((r) => r.path === chosen);
    if (existing) return existing;
    const repo = makeRepoFromPath(chosen);
    repo.defaultBranch = (await detectDefaultBranch(chosen)) ?? undefined;
    Store.saveRepos([...state.repos, repo]);
    return repo;
  };

  ipcMain.handle('repo:add', async (_e, repoPath: string) => {
    if (!looksLikeRepo(repoPath)) {
      return { ok: false, error: 'No .git found at that path' };
    }
    const repo = await addRepoFromPath(repoPath);
    return { ok: true, repo };
  });

  ipcMain.handle('repo:pickAndAdd', async () => {
    if (!mainWindow) return { ok: false, error: 'No window' };
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Add a repository',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, cancelled: true };
    }
    const chosen = result.filePaths[0];
    if (!looksLikeRepo(chosen)) {
      return { ok: false, error: 'No .git found at that path' };
    }
    const repo = await addRepoFromPath(chosen);
    return { ok: true, repo };
  });

  ipcMain.handle('repo:status', async (_e, repoId: string) => {
    const repo = Store.load().repos.find((r) => r.id === repoId);
    if (!repo) {
      return { repoId, branch: null, dirtyCount: 0, ahead: null, behind: null, error: 'Unknown repo' };
    }
    return gitStatus(repo.id, repo.path);
  });

  ipcMain.handle('repo:listBranches', async (_e, repoId: string) => {
    const repo = Store.load().repos.find((r) => r.id === repoId);
    if (!repo) return { local: [], remote: [] };
    return listBranches(repo.path);
  });

  ipcMain.handle('repo:log', async (_e, args: { repoId: string; limit?: number }) => {
    const repo = Store.load().repos.find((r) => r.id === args.repoId);
    if (!repo) return [];
    return gitLog(repo.path, args.limit ?? 50);
  });

  ipcMain.handle('repo:diff', async (_e, args: { repoId: string; sha?: string }) => {
    const repo = Store.load().repos.find((r) => r.id === args.repoId);
    if (!repo) return [];
    return gitDiff(repo.path, args.sha);
  });

  ipcMain.handle('repo:stash', async (_e, args: { repoId: string; message?: string }) => {
    const repo = Store.load().repos.find((r) => r.id === args.repoId);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return gitStash(repo.path, args.message);
  });

  ipcMain.handle('repo:commitAll', async (_e, args: { repoId: string; message: string }) => {
    const repo = Store.load().repos.find((r) => r.id === args.repoId);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return commitAll(repo.path, args.message);
  });

  // `retryCheckout` and `checkout` are the same primitive — `checkout` is
  // for explicit branch-picker actions, `retryCheckout` is invoked by the
  // workspace's stash-and-retry flow. Keeping both names makes call sites
  // self-documenting.
  const handleCheckout = async (
    _e: unknown,
    args: { repoId: string; branch: string; createIfMissing: boolean },
  ) => {
    const repo = Store.load().repos.find((r) => r.id === args.repoId);
    if (!repo) {
      return {
        repoId: args.repoId,
        result: 'error' as const,
        branch: args.branch,
        message: 'Unknown repo',
      };
    }
    return checkoutBranch(repo.id, repo.path, args.branch, args.createIfMissing);
  };
  ipcMain.handle('repo:retryCheckout', handleCheckout);
  ipcMain.handle('repo:checkout', handleCheckout);

  const repoFromArg = (idOrArgs: string | { repoId: string }) => {
    const id = typeof idOrArgs === 'string' ? idOrArgs : idOrArgs.repoId;
    return Store.load().repos.find((r) => r.id === id);
  };

  ipcMain.handle('repo:changes', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return { staged: [], unstaged: [] };
    return gitChanges(repo.path);
  });

  ipcMain.handle('repo:stageFiles', async (_e, args: { repoId: string; paths: string[] }) => {
    const repo = repoFromArg(args);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return stageFiles(repo.path, args.paths);
  });

  ipcMain.handle('repo:unstageFiles', async (_e, args: { repoId: string; paths: string[] }) => {
    const repo = repoFromArg(args);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return unstageFiles(repo.path, args.paths);
  });

  ipcMain.handle('repo:discardFiles', async (_e, args: { repoId: string; paths: string[] }) => {
    const repo = repoFromArg(args);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return discardFiles(repo.path, args.paths);
  });

  ipcMain.handle('repo:commit', async (_e, args: { repoId: string; message: string }) => {
    const repo = repoFromArg(args);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return commitStaged(repo.path, args.message);
  });

  ipcMain.handle('repo:push', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return gitPush(repo.path);
  });

  ipcMain.handle('repo:pull', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return gitPull(repo.path);
  });

  ipcMain.handle('repo:fetch', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return gitFetch(repo.path);
  });

  ipcMain.handle(
    'repo:createBranch',
    async (_e, args: { repoId: string; name: string; checkout: boolean }) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return createBranch(repo.path, args.name, args.checkout);
    },
  );

  ipcMain.handle(
    'repo:deleteBranch',
    async (_e, args: { repoId: string; name: string; force: boolean }) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return deleteBranch(repo.path, args.name, args.force);
    },
  );

  ipcMain.handle(
    'repo:diffFile',
    async (
      _e,
      args: { repoId: string; path: string; side: 'staged' | 'unstaged' },
    ) => {
      const repo = repoFromArg(args);
      if (!repo) return [];
      return diffFile(repo.path, args.path, args.side);
    },
  );

  ipcMain.handle('repo:graph', async (_e, args: { repoId: string; limit?: number }) => {
    const repo = repoFromArg(args);
    if (!repo) return [];
    return commitGraph(repo.path, args.limit ?? 200);
  });

  ipcMain.handle('repo:listStashes', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return [];
    return listStashes(repo.path);
  });

  ipcMain.handle(
    'repo:applyStash',
    async (_e, args: { repoId: string; index: number; pop: boolean }) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return applyStash(repo.path, args.index, args.pop);
    },
  );

  ipcMain.handle(
    'repo:dropStash',
    async (_e, args: { repoId: string; index: number }) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return dropStash(repo.path, args.index);
    },
  );

  ipcMain.handle(
    'repo:stashDiff',
    async (_e, args: { repoId: string; index: number }) => {
      const repo = repoFromArg(args);
      if (!repo) return [];
      return stashDiff(repo.path, args.index);
    },
  );

  ipcMain.handle('repo:branchSummaries', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return [];
    return branchSummaries(repo.path);
  });

  ipcMain.handle(
    'repo:branchCommits',
    async (_e, args: { repoId: string; ref: string; limit?: number }) => {
      const repo = repoFromArg(args);
      if (!repo) return [];
      return listBranchCommits(repo.path, args.ref, args.limit ?? 50);
    },
  );

  ipcMain.handle(
    'repo:cherryPick',
    async (_e, args: { repoId: string; shas: string[] }) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return cherryPick(repo.path, args.shas);
    },
  );

  ipcMain.handle('repo:detectDefaultBranch', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return null;
    return detectDefaultBranch(repo.path);
  });

  ipcMain.handle(
    'repo:setDefaultBranch',
    (_e, args: { repoId: string; branch: string | null }) => {
      const state = Store.load();
      const updated = state.repos.map((r) =>
        r.id === args.repoId ? { ...r, defaultBranch: args.branch ?? undefined } : r,
      );
      Store.saveRepos(updated);
    },
  );

  ipcMain.handle('fs:listFiles', (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return [];
    return listFilesUnder(repo.path);
  });

  ipcMain.handle('fs:readFile', (_e, args: { repoId: string; path: string }) => {
    const repo = repoFromArg(args);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return readFileUnderRoot(repo.path, args.path);
  });

  ipcMain.handle(
    'fs:writeFile',
    (_e, args: { repoId: string; path: string; content: string }) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return writeFileUnderRoot(repo.path, args.path, args.content);
    },
  );

  ipcMain.handle('workspace:status', async (_e, workspaceId: string) => {
    const { workspaces, repos } = Store.load();
    return workspaceStatus(workspaceId, workspaces, repos);
  });

  ipcMain.handle(
    'workspace:checkoutBranch',
    async (
      _e,
      args: { workspaceId: string; branch: string; createIfMissing: boolean },
    ) => {
      const { workspaces, repos } = Store.load();
      return workspaceCheckout(args.workspaceId, args.branch, args.createIfMissing, workspaces, repos);
    },
  );

  ipcMain.handle('workspace:fetchAll', async (_e, workspaceId: string) => {
    const { workspaces, repos } = Store.load();
    return workspaceFetch(workspaceId, workspaces, repos);
  });

  ipcMain.handle('workspace:listPRs', async (_e, workspaceId: string) => {
    const { workspaces, repos } = Store.load();
    return workspaceListPRs(workspaceId, workspaces, repos);
  });

  ipcMain.handle(
    'workspace:syncAndBranch',
    async (
      _e,
      args: {
        workspaceId: string;
        branch: string;
        syncDefault: boolean;
        pullBeforeBranch: boolean;
      },
    ) => {
      const { workspaces, repos } = Store.load();
      return workspaceSyncAndBranch(
        args.workspaceId,
        args.branch,
        args.syncDefault,
        args.pullBeforeBranch,
        workspaces,
        repos,
      );
    },
  );

  ipcMain.handle('cli:detect', () => detectCliPresence());

  ipcMain.handle(
    'cli:reviewChanges',
    async (
      _e,
      args: { repoId: string; scope: 'staged' | 'working'; tool: 'claude' | 'codex' | 'gemini' },
    ) => {
      const repo = repoFromArg(args);
      if (!repo) {
        return { ok: false, output: '', error: 'Unknown repo', tool: args.tool };
      }
      const diff = await rawDiff(repo.path, args.scope);
      if (!diff.ok) {
        return { ok: false, output: '', error: diff.error ?? 'Could not read diff', tool: args.tool };
      }
      return reviewDiffWithLlm(args.tool, diff.text);
    },
  );

  ipcMain.handle(
    'cli:suggestCommitMessage',
    async (_e, args: { repoId: string; tool: 'claude' | 'codex' | 'gemini' }) => {
      const repo = repoFromArg(args);
      if (!repo) {
        return { ok: false, error: 'Unknown repo', tool: args.tool };
      }
      const diff = await rawDiff(repo.path, 'staged');
      if (!diff.ok) {
        return { ok: false, error: diff.error ?? 'Could not read staged diff', tool: args.tool };
      }
      return suggestCommitMessage(args.tool, diff.text);
    },
  );
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
