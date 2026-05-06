// Electron main process entry. Creates the main window and registers
// every IPC handler the renderer invokes. Main-process state lives here:
// the Store (persisted) and the cached CliPresence probe.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import {
  abortCherryPick,
  abortMerge,
  abortRebase,
  addRemote,
  adoptWorktreeBranch,
  amendCommit,
  applyPatch,
  applyStash,
  applyStashForce,
  blameFile,
  branchSummaries,
  continueCherryPick,
  continueRebase,
  createTag,
  changes as gitChanges,
  checkoutBranch,
  checkoutCommit,
  cherryPick,
  commitAll,
  commitGraph,
  commitStaged,
  createBranch,
  deleteBranch,
  renameBranch,
  deleteTag,
  detectDefaultBranch,
  diff as gitDiff,
  diffFile,
  discardFiles,
  dropStash,
  fetch as gitFetch,
  fileLog as gitFileLog,
  lfsStatus,
  listBranches,
  listBranchCommits,
  listRemotes,
  listStashes,
  listSubmodules,
  listTags,
  listWorktrees,
  pruneCandidates,
  pruneSquashCandidates,
  pruneWorktrees,
  squashMergeLinks,
  pushTag,
  removeRemote,
  removeWorktree,
  initRepo,
  log as gitLog,
  looksLikeRepo,
  markResolved,
  mergeBranch,
  resolveConflictSide,
  readMergeMsg,
  commitMerge,
  pull as gitPull,
  pullForce as gitPullForce,
  push as gitPush,
  rawDiff,
  readGitConfigIdentity,
  rebaseOnto,
  setRemoteUrl,
  stageFiles,
  stash as gitStash,
  stashDiff,
  stashFiles as gitStashFiles,
  status as gitStatus,
  unstageFiles,
} from './git';
import { listFilesUnder, listRepoFiles, readFileUnderRoot, writeFileUnderRoot } from './fs';
import {
  aggregateWorkspaceDirtyDiff,
  workspaceActivity,
  workspaceBranchSuggestions,
  workspaceCheckout,
  workspaceCommitAll,
  workspaceFetch,
  workspaceListPRs,
  workspaceOpenPRs,
  workspaceResetToDefault,
  workspacePushAll,
  workspaceStatus,
  workspaceSyncAndBranch,
  workspaceSyncMemberToBranch,
  workspaceWorktrees,
} from './workspace';
import { detectCliPresence, reviewDiffWithLlm, suggestCommitMessage } from './cli';
import { Identity, Repo, ResolvedIdentity } from '../shared/types';

/// Resolve which identity should be applied (via env override) when
/// committing in this repo. Mirrors the precedence the renderer
/// surfaces in the commit composer:
///   1. per-repo overgit override (Repo.identity)        → return it
///   2. repo's local .git/config user.name + user.email  → null (let
///      git pick it up naturally; no env override needed)
///   3. global default in settings.defaultIdentity       → return it
///   4. otherwise                                        → null (git
///      resolves through global ~/.gitconfig itself)
async function pickCommitIdentity(repo: Repo): Promise<Identity | undefined> {
  if (repo.identity) return repo.identity;
  const local = await readGitConfigIdentity(repo.path, 'local');
  if (local.name && local.email) return undefined;
  const global = Store.load().settings.defaultIdentity;
  if (global) return global;
  return undefined;
}

/// Compute the ResolvedIdentity object the renderer renders above the
/// commit composer. Same precedence as pickCommitIdentity but returns
/// the source label and best-effort name/email for display in every
/// branch — including the `system` and `unset` branches where commit
/// itself wouldn't pass an env override.
async function resolveDisplayIdentity(repo: Repo): Promise<ResolvedIdentity> {
  if (repo.identity) {
    return { source: 'override', name: repo.identity.name, email: repo.identity.email };
  }
  const local = await readGitConfigIdentity(repo.path, 'local');
  if (local.name && local.email) {
    return { source: 'repo-config', name: local.name, email: local.email };
  }
  const global = Store.load().settings.defaultIdentity;
  if (global) {
    return { source: 'global-default', name: global.name, email: global.email };
  }
  const effective = await readGitConfigIdentity(repo.path, 'effective');
  if (effective.name && effective.email) {
    return { source: 'system', name: effective.name, email: effective.email };
  }
  return { source: 'unset', name: effective.name ?? '', email: effective.email ?? '' };
}

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

  ipcMain.handle(
    'repo:init',
    async (_e, args: { path: string; initialBranch?: string }) => {
      const init = await initRepo(args.path, { initialBranch: args.initialBranch });
      if (!init.ok) {
        return { ok: false as const, error: init.error ?? 'git init failed' };
      }
      const repo = await addRepoFromPath(args.path);
      return { ok: true as const, repo };
    },
  );

  ipcMain.handle('repo:pickAndAdd', async () => {
    if (!mainWindow) return { ok: false, error: 'No window' };
    const result = await dialog.showOpenDialog(mainWindow, {
      // multiSelections lets the user shift/cmd-click multiple
      // folders; the loop below also expands a single picked parent
      // ("~/code") into every immediate child that's a repo.
      properties: ['openDirectory', 'multiSelections'],
      title: 'Add repositories',
      buttonLabel: 'Add',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, cancelled: true };
    }

    const added: Repo[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const seen = new Set<string>();

    for (const chosen of result.filePaths) {
      if (seen.has(chosen)) continue;
      seen.add(chosen);

      if (looksLikeRepo(chosen)) {
        added.push(await addRepoFromPath(chosen));
        continue;
      }
      // Not a repo itself — try one level deep. Common case: the user
      // picked their `~/code` parent and wants every repo inside.
      let children: string[];
      try {
        children = fs.readdirSync(chosen);
      } catch (err) {
        skipped.push({ path: chosen, reason: `Could not read folder (${String(err)})` });
        continue;
      }
      const childRepos: string[] = [];
      for (const name of children) {
        if (name.startsWith('.')) continue;
        const childPath = path.join(chosen, name);
        if (looksLikeRepo(childPath)) childRepos.push(childPath);
      }
      if (childRepos.length === 0) {
        skipped.push({ path: chosen, reason: 'No .git found here or in any direct child' });
        continue;
      }
      for (const r of childRepos) {
        if (seen.has(r)) continue;
        seen.add(r);
        added.push(await addRepoFromPath(r));
      }
    }

    return { ok: true as const, repos: added, skipped };
  });

  ipcMain.handle('repo:status', async (_e, repoId: string) => {
    const repo = Store.load().repos.find((r) => r.id === repoId);
    if (!repo) {
      return {
        repoId,
        branch: null,
        dirtyCount: 0,
        worktreeAdds: null,
        worktreeDels: null,
        ahead: null,
        behind: null,
        aheadDefault: null,
        behindDefault: null,
        defaultRef: null,
        inProgress: null,
        conflicts: [],
        error: 'Unknown repo',
      };
    }
    return gitStatus(repo.id, repo.path, repo.defaultBranch);
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

  ipcMain.handle(
    'repo:stashFiles',
    async (_e, args: { repoId: string; paths: string[]; message?: string }) => {
      const repo = Store.load().repos.find((r) => r.id === args.repoId);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return gitStashFiles(repo.path, args.paths, args.message);
    },
  );

  ipcMain.handle('repo:commitAll', async (_e, args: { repoId: string; message: string }) => {
    const repo = Store.load().repos.find((r) => r.id === args.repoId);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    const identity = await pickCommitIdentity(repo);
    return commitAll(repo.path, args.message, identity);
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
    const identity = await pickCommitIdentity(repo);
    return commitStaged(repo.path, args.message, identity);
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

  ipcMain.handle(
    'repo:pullForce',
    async (
      _e,
      args: {
        repoId: string;
        conflicts: string[];
        strategy: 'stash' | 'discard';
      },
    ) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return gitPullForce(repo.path, args.conflicts, args.strategy);
    },
  );

  ipcMain.handle('repo:fetch', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return gitFetch(repo.path);
  });

  ipcMain.handle(
    'repo:createBranch',
    async (
      _e,
      args: { repoId: string; name: string; checkout: boolean; from?: string },
    ) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return createBranch(repo.path, args.name, args.checkout, args.from);
    },
  );

  ipcMain.handle(
    'repo:checkoutCommit',
    async (_e, args: { repoId: string; sha: string }) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return checkoutCommit(repo.path, args.sha);
    },
  );

  ipcMain.handle(
    'repo:applyPatch',
    async (
      _e,
      args: { repoId: string; patch: string; mode: 'stage' | 'unstage' | 'discard' },
    ) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return applyPatch(repo.path, args.patch, args.mode);
    },
  );

  ipcMain.handle(
    'repo:amendCommit',
    async (_e, args: { repoId: string; message: string | null }) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      const identity = await pickCommitIdentity(repo);
      return amendCommit(repo.path, args.message, identity);
    },
  );

  ipcMain.handle(
    'repo:merge',
    async (
      _e,
      args: { repoId: string; branch: string; mode: 'merge' | 'ff-only' | 'squash' },
    ) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return mergeBranch(repo.path, args.branch, args.mode);
    },
  );

  ipcMain.handle('repo:abortMerge', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return abortMerge(repo.path);
  });

  ipcMain.handle(
    'repo:resolveConflictSide',
    async (_e, args: { repoId: string; path: string; side: 'ours' | 'theirs' }) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return resolveConflictSide(repo.path, args.path, args.side);
    },
  );

  ipcMain.handle('repo:readMergeMsg', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return { ok: false, message: null, error: 'Unknown repo' };
    return readMergeMsg(repo.path);
  });

  ipcMain.handle(
    'repo:commitMerge',
    async (_e, args: { repoId: string; message: string | null }) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return commitMerge(repo.path, args.message);
    },
  );

  ipcMain.handle('repo:rebase', async (_e, args: { repoId: string; onto: string }) => {
    const repo = repoFromArg(args);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return rebaseOnto(repo.path, args.onto);
  });

  ipcMain.handle('repo:abortRebase', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return abortRebase(repo.path);
  });

  ipcMain.handle('repo:continueRebase', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return continueRebase(repo.path);
  });

  ipcMain.handle('repo:abortCherryPick', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return abortCherryPick(repo.path);
  });

  ipcMain.handle('repo:continueCherryPick', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return continueCherryPick(repo.path);
  });

  ipcMain.handle(
    'repo:markResolved',
    async (_e, args: { repoId: string; paths: string[] }) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, remaining: [], error: 'Unknown repo' };
      return markResolved(repo.path, args.paths);
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

  ipcMain.handle('repo:pruneCandidates', async (_e, args: { repoId: string }) => {
    const repo = repoFromArg(args);
    if (!repo) return [];
    // Trust the user's stored override when present, otherwise detect
    // — we never want to suggest deleting a branch the user considers
    // their trunk, regardless of what `origin/HEAD` says.
    const def = repo.defaultBranch ?? (await detectDefaultBranch(repo.path));
    return pruneCandidates(repo.path, def);
  });

  ipcMain.handle(
    'repo:pruneSquashCandidates',
    async (_e, args: { repoId: string }) => {
      const repo = repoFromArg(args);
      if (!repo) return [];
      const def = repo.defaultBranch ?? (await detectDefaultBranch(repo.path));
      return pruneSquashCandidates(repo.path, def);
    },
  );

  ipcMain.handle('repo:squashMergeLinks', async (_e, args: { repoId: string }) => {
    const repo = repoFromArg(args);
    if (!repo) return [];
    const def = repo.defaultBranch ?? (await detectDefaultBranch(repo.path));
    return squashMergeLinks(repo.path, def);
  });

  ipcMain.handle(
    'repo:renameBranch',
    async (
      _e,
      args: { repoId: string; from: string | null; to: string; force: boolean },
    ) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return renameBranch(repo.path, args.to, args.from, args.force);
    },
  );

  ipcMain.handle(
    'repo:diffFile',
    async (
      _e,
      args: { repoId: string; path: string; side: 'staged' | 'unstaged' | 'combined' },
    ) => {
      const repo = repoFromArg(args);
      if (!repo) return [];
      return diffFile(repo.path, args.path, args.side);
    },
  );

  ipcMain.handle('repo:graph', async (_e, args: { repoId: string; limit?: number }) => {
    const repo = repoFromArg(args);
    if (!repo) return [];
    return commitGraph(repo.path, args.limit ?? 200, repo.defaultBranch);
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
    'repo:applyStashForce',
    async (_e, args: { repoId: string; index: number; pop: boolean }) => {
      const repo = repoFromArg(args);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return applyStashForce(repo.path, args.index, args.pop);
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
    'repo:fileLog',
    async (_e, args: { repoId: string; path: string; limit?: number }) => {
      const repo = repoFromArg(args.repoId);
      if (!repo) return [];
      return gitFileLog(repo.path, args.path, args.limit);
    },
  );

  ipcMain.handle(
    'repo:fileBlame',
    async (_e, args: { repoId: string; path: string }) => {
      const repo = repoFromArg(args.repoId);
      if (!repo) return [];
      return blameFile(repo.path, args.path);
    },
  );

  ipcMain.handle('repo:listTags', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return [];
    return listTags(repo.path);
  });

  ipcMain.handle(
    'repo:createTag',
    async (
      _e,
      args: { repoId: string; name: string; ref: string | null; message: string | null },
    ) => {
      const repo = repoFromArg(args.repoId);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return createTag(repo.path, {
        name: args.name,
        ref: args.ref,
        message: args.message,
      });
    },
  );

  ipcMain.handle(
    'repo:deleteTag',
    async (_e, args: { repoId: string; name: string }) => {
      const repo = repoFromArg(args.repoId);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return deleteTag(repo.path, args.name);
    },
  );

  ipcMain.handle(
    'repo:pushTag',
    async (_e, args: { repoId: string; name: string; remote: string }) => {
      const repo = repoFromArg(args.repoId);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return pushTag(repo.path, args.name, args.remote);
    },
  );

  ipcMain.handle('repo:listRemotes', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return [];
    return listRemotes(repo.path);
  });

  ipcMain.handle(
    'repo:addRemote',
    async (_e, args: { repoId: string; name: string; url: string }) => {
      const repo = repoFromArg(args.repoId);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return addRemote(repo.path, args.name, args.url);
    },
  );

  ipcMain.handle(
    'repo:removeRemote',
    async (_e, args: { repoId: string; name: string }) => {
      const repo = repoFromArg(args.repoId);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return removeRemote(repo.path, args.name);
    },
  );

  ipcMain.handle(
    'repo:setRemoteUrl',
    async (
      _e,
      args: { repoId: string; name: string; url: string; kind: 'fetch' | 'push' },
    ) => {
      const repo = repoFromArg(args.repoId);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return setRemoteUrl(repo.path, args.name, args.url, args.kind);
    },
  );

  ipcMain.handle('repo:listSubmodules', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return [];
    return listSubmodules(repo.path);
  });

  ipcMain.handle('repo:lfsStatus', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return { enabled: false, patternCount: 0 };
    return lfsStatus(repo.path);
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

  ipcMain.handle(
    'repo:setIdentity',
    (_e, args: { repoId: string; identity: Identity | null }) => {
      const state = Store.load();
      const updated = state.repos.map((r) =>
        r.id === args.repoId ? { ...r, identity: args.identity ?? undefined } : r,
      );
      Store.saveRepos(updated);
    },
  );

  ipcMain.handle('repo:resolveIdentity', async (_e, repoId: string) => {
    const repo = Store.load().repos.find((r) => r.id === repoId);
    if (!repo) {
      return { source: 'unset' as const, name: '', email: '' };
    }
    return resolveDisplayIdentity(repo);
  });

  ipcMain.handle('repo:resolveAllIdentities', async () => {
    const repos = Store.load().repos;
    // Fan out — every resolution is independent and the per-repo cost
    // is two cheap `git config` reads. Keeps the Settings → Identity
    // table snappy even for users with dozens of repos.
    const entries = await Promise.all(
      repos.map(async (r): Promise<[string, ResolvedIdentity]> => [
        r.id,
        await resolveDisplayIdentity(r),
      ]),
    );
    return Object.fromEntries(entries);
  });

  ipcMain.handle('fs:listFiles', (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return [];
    return listFilesUnder(repo.path);
  });

  ipcMain.handle('fs:listRepoFiles', async (_e, repoId: string) => {
    const repo = repoFromArg(repoId);
    if (!repo) return [];
    return listRepoFiles(repo.path);
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

  ipcMain.handle('workspace:branchSuggestions', async (_e, workspaceId: string) => {
    const { workspaces, repos } = Store.load();
    return workspaceBranchSuggestions(workspaceId, workspaces, repos);
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

  ipcMain.handle(
    'workspace:syncMemberToBranch',
    async (_e, args: { repoId: string; branch: string }) => {
      const { repos } = Store.load();
      return workspaceSyncMemberToBranch(args.repoId, args.branch, repos);
    },
  );

  ipcMain.handle(
    'workspace:commitAll',
    async (_e, args: { workspaceId: string; message: string }) => {
      const { workspaces, repos, settings } = Store.load();
      return workspaceCommitAll(args.workspaceId, args.message, workspaces, repos, settings);
    },
  );

  ipcMain.handle('workspace:worktrees', async (_e, workspaceId: string) => {
    const { workspaces, repos } = Store.load();
    return workspaceWorktrees(workspaceId, workspaces, repos);
  });

  ipcMain.handle('workspace:pushAll', async (_e, workspaceId: string) => {
    const { workspaces, repos } = Store.load();
    return workspacePushAll(workspaceId, workspaces, repos);
  });

  ipcMain.handle(
    'workspace:activity',
    async (_e, args: { workspaceId: string; perRepo?: number }) => {
      const { workspaces, repos } = Store.load();
      return workspaceActivity(
        args.workspaceId,
        args.perRepo ?? 25,
        workspaces,
        repos,
      );
    },
  );

  ipcMain.handle(
    'workspace:openPRs',
    async (
      _e,
      args: { workspaceId: string; title: string; body: string; draft: boolean },
    ) => {
      const { workspaces, repos } = Store.load();
      return workspaceOpenPRs(
        args.workspaceId,
        args.title,
        args.body,
        args.draft,
        workspaces,
        repos,
      );
    },
  );

  ipcMain.handle('workspace:resetToDefault', async (_e, workspaceId: string) => {
    const { workspaces, repos } = Store.load();
    return workspaceResetToDefault(workspaceId, workspaces, repos);
  });

  ipcMain.handle('repo:worktrees', async (_e, repoId: string) => {
    const repo = Store.load().repos.find((r) => r.id === repoId);
    if (!repo) return [];
    return listWorktrees(repo.path);
  });

  ipcMain.handle(
    'repo:adoptWorktreeBranch',
    async (
      _e,
      args: {
        repoId: string;
        worktreePath: string;
        branch: string;
        forceRemove: boolean;
        commitMessage?: string;
      },
    ) => {
      const repo = Store.load().repos.find((r) => r.id === args.repoId);
      if (!repo) return { ok: false as const, step: 'precheck' as const, error: 'Unknown repo' };
      const identity = await pickCommitIdentity(repo);
      return adoptWorktreeBranch(
        repo.path,
        args.worktreePath,
        args.branch,
        args.forceRemove,
        args.commitMessage,
        identity,
      );
    },
  );

  ipcMain.handle(
    'repo:removeWorktree',
    async (_e, args: { repoId: string; worktreePath: string; force: boolean }) => {
      const repo = Store.load().repos.find((r) => r.id === args.repoId);
      if (!repo) return { ok: false, error: 'Unknown repo' };
      return removeWorktree(repo.path, args.worktreePath, args.force);
    },
  );

  ipcMain.handle('repo:pruneWorktrees', async (_e, repoId: string) => {
    const repo = Store.load().repos.find((r) => r.id === repoId);
    if (!repo) return { ok: false, error: 'Unknown repo' };
    return pruneWorktrees(repo.path);
  });

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
    async (
      _e,
      args: { repoId: string; tool: 'claude' | 'codex' | 'gemini'; paths?: string[] },
    ) => {
      const repo = repoFromArg(args);
      if (!repo) {
        return { ok: false, error: 'Unknown repo', tool: args.tool };
      }
      // When a path list is provided (simple/select-vs-stage mode), diff
      // those paths vs HEAD so we summarize what the user will commit,
      // not what happens to be staged. Without paths we keep the old
      // behavior — diff `--cached` for advanced staging users.
      const diff = await rawDiff(repo.path, 'staged', args.paths);
      if (!diff.ok) {
        return { ok: false, error: diff.error ?? 'Could not read staged diff', tool: args.tool };
      }
      if (!diff.text.trim()) {
        const empty =
          args.paths && args.paths.length > 0
            ? 'Selected files have no changes vs HEAD.'
            : 'No staged changes to summarize.';
        return { ok: false, error: empty, tool: args.tool };
      }
      return suggestCommitMessage(args.tool, diff.text);
    },
  );

  ipcMain.handle(
    'workspace:reviewChanges',
    async (
      _e,
      args: { workspaceId: string; tool: 'claude' | 'codex' | 'gemini' },
    ) => {
      const { workspaces, repos } = Store.load();
      const aggregate = await aggregateWorkspaceDirtyDiff(
        args.workspaceId,
        workspaces,
        repos,
      );
      if (!aggregate.text.trim()) {
        return {
          ok: false,
          output: '',
          error: 'No dirty on-branch changes to review.',
          tool: args.tool,
          truncated: aggregate.truncated,
        };
      }
      const result = await reviewDiffWithLlm(args.tool, aggregate.text);
      return { ...result, truncated: aggregate.truncated };
    },
  );

  ipcMain.handle(
    'workspace:suggestCommitMessage',
    async (
      _e,
      args: { workspaceId: string; tool: 'claude' | 'codex' | 'gemini' },
    ) => {
      const { workspaces, repos } = Store.load();
      const aggregate = await aggregateWorkspaceDirtyDiff(
        args.workspaceId,
        workspaces,
        repos,
      );
      if (!aggregate.text.trim()) {
        return {
          ok: false as const,
          error: 'No dirty on-branch changes to summarize.',
          tool: args.tool,
          truncated: aggregate.truncated,
        };
      }
      const result = await suggestCommitMessage(args.tool, aggregate.text);
      return { ...result, truncated: aggregate.truncated };
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
