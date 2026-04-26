// Disk-backed app store. Persists overgit's view of which repos and
// workspaces the user has registered — but NOT any git state itself.
// A single overgit.json under Electron's userData; small, atomic writes.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  AppSettings,
  DEFAULT_SETTINGS,
  Repo,
  StoreSnapshot,
  Workspace,
} from '../shared/types';

function storePath(): string {
  return path.join(app.getPath('userData'), 'overgit.json');
}

function emptyState(): StoreSnapshot {
  return {
    repos: [],
    workspaces: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

function loadFromDisk(): StoreSnapshot {
  const p = storePath();
  if (!fs.existsSync(p)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return {
      ...emptyState(),
      ...parsed,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
    };
  } catch (err) {
    console.error('Failed to load overgit.json, starting fresh:', err);
    return emptyState();
  }
}

let cached: StoreSnapshot | null = null;

function current(): StoreSnapshot {
  if (!cached) cached = loadFromDisk();
  return cached;
}

function save(): void {
  if (!cached) return;
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Atomic write: tmp + rename so a crash mid-write doesn't leave a
  // half-written JSON that refuses to decode on next launch.
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cached, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

export const Store = {
  load(): StoreSnapshot {
    return current();
  },
  saveRepos(repos: Repo[]): void {
    current().repos = repos;
    save();
  },
  saveWorkspaces(workspaces: Workspace[]): void {
    current().workspaces = workspaces;
    save();
  },
  saveSettings(settings: AppSettings): void {
    current().settings = settings;
    save();
  },
};
