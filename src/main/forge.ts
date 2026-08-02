// Browse the repos you already have access to on a forge so "Clone repo"
// doesn't require pasting a URL.
//
// Auth rule for this whole module: overgit never asks for, stores, or
// transmits a token of its own. GitHub goes through the `gh` CLI's
// existing login (same binary the PR features already shell out to);
// Bitbucket reuses whatever credential the user's git credential helper
// already holds for bitbucket.org — i.e. exactly the access they'd get
// from `git clone` in a terminal. No credential ever reaches the
// renderer; only repo metadata does.

import { spawn } from 'node:child_process';
import { ForgeKind, ForgeListResult, ForgeRepo } from '../shared/types';

/// Page size + page cap per source. 500 repos is well past what anyone
/// scrolls; beyond it we set `truncated` and let the user paste a URL.
const PER_PAGE = 100;
const MAX_PAGES = 5;

/// How long a successful listing stays warm. Reopening the sheet inside
/// this window is instant; the picker's Refresh button bypasses it.
const CACHE_TTL_MS = 5 * 60_000;

/// Per-request network budget. A wedged proxy shouldn't leave the clone
/// sheet spinning forever.
const HTTP_TIMEOUT_MS = 15_000;
const CLI_TIMEOUT_MS = 30_000;

interface CacheEntry {
  at: number;
  result: Extract<ForgeListResult, { ok: true }>;
}
const cache = new Map<ForgeKind, CacheEntry>();
/// Coalesce concurrent listings of the same provider — the sheet can
/// mount and refresh in quick succession, and each miss costs seconds
/// of network.
const inFlight = new Map<ForgeKind, Promise<ForgeListResult>>();

export async function listForgeRepos(
  provider: ForgeKind,
  opts: { refresh?: boolean } = {},
): Promise<ForgeListResult> {
  if (!opts.refresh) {
    const hit = cache.get(provider);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  }
  const running = inFlight.get(provider);
  if (running) return running;

  const listers: Record<ForgeKind, () => Promise<ForgeListResult>> = {
    github: listGitHubRepos,
    gitlab: listGitLabRepos,
    bitbucket: listBitbucketRepos,
  };
  const task = listers[provider]()
    .then((result) => {
      if (result.ok) cache.set(provider, { at: Date.now(), result });
      return result;
    })
    .catch((err: unknown) => ({ ok: false as const, error: String(err) }))
    .finally(() => {
      inFlight.delete(provider);
    });
  inFlight.set(provider, task);
  return task;
}

// ---------------------------------------------------------------- GitHub

interface GhRepoJson {
  full_name?: string;
  name?: string;
  owner?: { login?: string };
  description?: string | null;
  private?: boolean;
  default_branch?: string;
  updated_at?: string;
  pushed_at?: string;
  clone_url?: string;
  ssh_url?: string;
  html_url?: string;
}

export function mapGitHubRepo(raw: GhRepoJson): ForgeRepo | null {
  const owner = raw.owner?.login ?? raw.full_name?.split('/')[0] ?? '';
  const name = raw.name ?? raw.full_name?.split('/')[1] ?? '';
  if (!owner || !name) return null;
  const https = raw.clone_url ?? (raw.html_url ? `${raw.html_url}.git` : '');
  if (!https) return null;
  return {
    provider: 'github',
    fullName: raw.full_name ?? `${owner}/${name}`,
    name,
    owner,
    description: raw.description ?? undefined,
    isPrivate: raw.private ?? false,
    defaultBranch: raw.default_branch,
    // `pushed_at` is the more useful "when did this repo last move";
    // `updated_at` also ticks on metadata edits like a description change.
    updatedAt: raw.pushed_at ?? raw.updated_at,
    httpsUrl: https,
    sshUrl: raw.ssh_url ?? `git@github.com:${owner}/${name}.git`,
  };
}

async function listGitHubRepos(): Promise<ForgeListResult> {
  const repos: ForgeRepo[] = [];
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await runCapture('gh', [
      'api',
      '-H',
      'Accept: application/vnd.github+json',
      // `affiliation` is what makes this "everything I can clone" rather
      // than "everything I own" — it covers org repos and repos someone
      // added us to as a collaborator.
      `/user/repos?per_page=${PER_PAGE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
    ]);
    if (!res.ok) return ghFailure(res);

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (err: unknown) {
      return { ok: false, error: `Could not read gh's response: ${String(err)}` };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, error: 'gh returned an unexpected response shape.' };
    }
    for (const item of parsed as GhRepoJson[]) {
      const mapped = mapGitHubRepo(item);
      if (mapped) repos.push(mapped);
    }
    if (parsed.length < PER_PAGE) break;
    if (page === MAX_PAGES) truncated = true;
  }

  return {
    ok: true,
    repos: sortByUpdated(repos),
    truncated,
    fetchedAt: new Date().toISOString(),
  };
}

function ghFailure(res: RunResult): Extract<ForgeListResult, { ok: false }> {
  if (res.code === null) {
    return {
      ok: false,
      // A GUI-launched app doesn't inherit a login shell's PATH, so
      // "couldn't spawn gh" can also mean "installed, just not visible".
      error: "Couldn't run the GitHub CLI (gh).",
      hint: 'Install it (brew install gh) and run `gh auth login`. If it is already installed, launching overgit from a terminal puts it on the PATH overgit sees.',
    };
  }
  const stderr = res.stderr.trim();
  const lower = stderr.toLowerCase();
  if (
    lower.includes('gh auth login') ||
    lower.includes('not logged') ||
    lower.includes('authentication') ||
    lower.includes('http 401')
  ) {
    return {
      ok: false,
      error: 'gh is installed but not signed in to GitHub.',
      hint: 'Run `gh auth login` in a terminal, then hit Refresh.',
    };
  }
  return { ok: false, error: stderr || `gh exited ${res.code}` };
}

// ---------------------------------------------------------------- GitLab

const GITLAB_API = 'https://gitlab.com/api/v4';

interface GlProjectJson {
  path?: string;
  path_with_namespace?: string;
  name?: string;
  description?: string | null;
  visibility?: string;
  default_branch?: string;
  last_activity_at?: string;
  http_url_to_repo?: string;
  ssh_url_to_repo?: string;
  namespace?: { full_path?: string };
}

export function mapGitLabProject(raw: GlProjectJson): ForgeRepo | null {
  const fullName = raw.path_with_namespace ?? '';
  const name = raw.path ?? fullName.split('/').pop() ?? '';
  const owner = raw.namespace?.full_path ?? fullName.split('/').slice(0, -1).join('/');
  if (!fullName || !name || !owner) return null;
  const https = raw.http_url_to_repo ?? '';
  const ssh = raw.ssh_url_to_repo ?? '';
  if (!https && !ssh) return null;
  return {
    provider: 'gitlab',
    fullName,
    name,
    owner,
    description: raw.description?.trim() ? raw.description.trim() : undefined,
    // GitLab has three visibilities; "internal" is not public, so
    // anything that isn't explicitly public gets the private badge.
    isPrivate: raw.visibility !== 'public',
    defaultBranch: raw.default_branch,
    updatedAt: raw.last_activity_at,
    httpsUrl: https || ssh,
    sshUrl: ssh,
  };
}

/// `membership=true` is the GitLab equivalent of GitHub's `affiliation`
/// — projects you own plus every group project you're a member of.
function gitlabProjectsPath(page: number): string {
  return (
    `projects?membership=true&archived=false&order_by=last_activity_at&sort=desc` +
    `&per_page=${PER_PAGE}&page=${page}`
  );
}

async function listGitLabRepos(): Promise<ForgeListResult> {
  // Prefer glab: it already holds the user's token (including for
  // self-managed hosts) exactly the way gh does for GitHub. Returns
  // null when glab isn't installed, so we can fall back to the
  // credential helper for people who clone GitLab but skipped the CLI.
  const viaCli = await listGitLabReposViaGlab();
  if (viaCli) return viaCli;
  return listGitLabReposViaApi();
}

async function listGitLabReposViaGlab(): Promise<ForgeListResult | null> {
  const repos: ForgeRepo[] = [];
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await runCapture('glab', ['api', gitlabProjectsPath(page)]);
    // Not installed — let the caller fall back to the REST path.
    if (res.code === null) return null;
    if (!res.ok) {
      const stderr = res.stderr.trim();
      const lower = stderr.toLowerCase();
      if (lower.includes('glab auth login') || lower.includes('401')) {
        return {
          ok: false,
          error: 'glab is installed but not signed in to GitLab.',
          hint: 'Run `glab auth login` in a terminal, then hit Refresh.',
        };
      }
      return { ok: false, error: stderr || `glab exited ${res.code}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (err: unknown) {
      return { ok: false, error: `Could not read glab's response: ${String(err)}` };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, error: 'glab returned an unexpected response shape.' };
    }
    for (const item of parsed as GlProjectJson[]) {
      const mapped = mapGitLabProject(item);
      if (mapped) repos.push(mapped);
    }
    if (parsed.length < PER_PAGE) break;
    if (page === MAX_PAGES) truncated = true;
  }

  return { ok: true, repos: sortByUpdated(repos), truncated, fetchedAt: new Date().toISOString() };
}

async function listGitLabReposViaApi(): Promise<ForgeListResult> {
  const cred = await readGitCredential('gitlab.com');
  if (!cred) {
    return {
      ok: false,
      error: 'No GitLab CLI (glab) and no saved gitlab.com credential.',
      hint: 'Install glab and run `glab auth login`, or clone a gitlab.com repo over https once so your credential helper stores the login.',
    };
  }

  // Personal access tokens go in PRIVATE-TOKEN; OAuth tokens want
  // Bearer. Probe /user once and reuse whichever the token answers to.
  const auth = await probeAuth(`${GITLAB_API}/user`, [
    { 'PRIVATE-TOKEN': cred.password },
    { Authorization: `Bearer ${cred.password}` },
  ]);
  if (!auth) {
    return {
      ok: false,
      error: 'Your stored gitlab.com credential was rejected (401).',
      hint: 'It has probably expired. Re-authenticate and hit Refresh, or install glab and run `glab auth login`.',
    };
  }

  const repos: ForgeRepo[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await apiFetch(`${GITLAB_API}/${gitlabProjectsPath(page)}`, auth);
    if (!res.ok) return { ok: false, error: `GitLab: ${res.error}` };
    if (!Array.isArray(res.body)) {
      return { ok: false, error: 'GitLab returned an unexpected response shape.' };
    }
    for (const item of res.body as GlProjectJson[]) {
      const mapped = mapGitLabProject(item);
      if (mapped) repos.push(mapped);
    }
    if (res.body.length < PER_PAGE) break;
    if (page === MAX_PAGES) truncated = true;
  }

  return { ok: true, repos: sortByUpdated(repos), truncated, fetchedAt: new Date().toISOString() };
}

// ------------------------------------------------------------- Bitbucket

const BITBUCKET_API = 'https://api.bitbucket.org';

interface BbCloneLink {
  name?: string;
  href?: string;
}
interface BbRepoJson {
  full_name?: string;
  slug?: string;
  name?: string;
  description?: string | null;
  is_private?: boolean;
  updated_on?: string;
  mainbranch?: { name?: string } | null;
  links?: { clone?: BbCloneLink[] };
}

export function mapBitbucketRepo(raw: BbRepoJson): ForgeRepo | null {
  const fullName = raw.full_name ?? '';
  const [ownerFromFull, nameFromFull] = fullName.split('/');
  const owner = ownerFromFull ?? '';
  const name = raw.slug ?? nameFromFull ?? '';
  if (!owner || !name) return null;
  const clone = raw.links?.clone ?? [];
  const https = clone.find((c) => c.name === 'https')?.href ?? '';
  const ssh = clone.find((c) => c.name === 'ssh')?.href ?? '';
  if (!https && !ssh) return null;
  return {
    provider: 'bitbucket',
    fullName: fullName || `${owner}/${name}`,
    name,
    owner,
    description: raw.description?.trim() ? raw.description.trim() : undefined,
    isPrivate: raw.is_private ?? true,
    defaultBranch: raw.mainbranch?.name,
    updatedAt: raw.updated_on,
    // Bitbucket's https clone link embeds the account name
    // (https://user@bitbucket.org/ws/repo.git). Keep it: it's what the
    // credential helper matches on when several accounts are stored.
    httpsUrl: https || ssh,
    sshUrl: ssh,
  };
}

async function listBitbucketRepos(): Promise<ForgeListResult> {
  const cred = await readGitCredential('bitbucket.org');
  if (!cred) {
    return {
      ok: false,
      error: 'No saved Bitbucket credential found on this machine.',
      hint: 'Clone or fetch a bitbucket.org repo over https once so your credential helper stores the login, then hit Refresh.',
    };
  }

  // Two credential shapes are in the wild: OAuth access tokens (what the
  // Git Credential Manager stores) want `Bearer`, app passwords want
  // basic auth. Probe once with a cheap endpoint and reuse the winner.
  const basic = Buffer.from(`${cred.username}:${cred.password}`, 'utf8').toString('base64');
  const auth = await probeAuth(`${BITBUCKET_API}/2.0/user`, [
    { Authorization: `Bearer ${cred.password}` },
    { Authorization: `Basic ${basic}` },
  ]);
  if (!auth) {
    return {
      ok: false,
      error: 'Your stored Bitbucket credential was rejected (401).',
      hint: 'It has probably expired. Re-authenticate (e.g. `git fetch` on a Bitbucket repo, or re-run your credential helper login) and hit Refresh.',
    };
  }

  const workspaces = await fetchBitbucketWorkspaces(auth);
  if (!workspaces.ok) return workspaces.failure;
  if (workspaces.slugs.length === 0) {
    return {
      ok: false,
      error: 'That Bitbucket account is not a member of any workspace.',
    };
  }

  const repos: ForgeRepo[] = [];
  const warnings: string[] = [];
  let truncated = false;

  // Bitbucket removed the cross-workspace repo listing (CHANGE-2770), so
  // this is per-workspace by necessity. Small concurrency keeps a
  // 10-workspace account fast without hammering the API.
  await mapBounded(workspaces.slugs, 3, async (slug) => {
    const query =
      `?role=member&sort=-updated_on&pagelen=${PER_PAGE}` +
      '&fields=next,values.full_name,values.slug,values.name,values.description,' +
      'values.is_private,values.updated_on,values.mainbranch.name,values.links.clone';
    let url: string | null = `${BITBUCKET_API}/2.0/repositories/${encodeURIComponent(slug)}${query}`;

    for (let page = 1; page <= MAX_PAGES && url; page++) {
      const res: ApiResult = await apiFetch(url, auth);
      if (!res.ok) {
        warnings.push(`${slug}: ${res.error}`);
        return;
      }
      const body = res.body as { values?: BbRepoJson[]; next?: string };
      for (const item of body.values ?? []) {
        const mapped = mapBitbucketRepo(item);
        if (mapped) repos.push(mapped);
      }
      const next = typeof body.next === 'string' ? body.next : null;
      // Only ever follow a `next` back to the API host we started on.
      url = next && next.startsWith(`${BITBUCKET_API}/`) ? next : null;
      if (url && page === MAX_PAGES) {
        truncated = true;
        warnings.push(`${slug}: showing the ${PER_PAGE * MAX_PAGES} most recently updated repos.`);
      }
    }
  });

  if (repos.length === 0 && warnings.length > 0) {
    return { ok: false, error: warnings.join(' · ') };
  }

  return {
    ok: true,
    repos: sortByUpdated(repos),
    truncated,
    fetchedAt: new Date().toISOString(),
    warnings: warnings.length ? warnings : undefined,
  };
}

interface WorkspacesOk {
  ok: true;
  slugs: string[];
}
interface WorkspacesErr {
  ok: false;
  failure: Extract<ForgeListResult, { ok: false }>;
}

async function fetchBitbucketWorkspaces(auth: AuthHeaders): Promise<WorkspacesOk | WorkspacesErr> {
  const slugs: string[] = [];
  let url: string | null = `${BITBUCKET_API}/2.0/user/workspaces?pagelen=${PER_PAGE}`;

  for (let page = 1; page <= MAX_PAGES && url; page++) {
    const res: ApiResult = await apiFetch(url, auth);
    if (!res.ok) {
      return {
        ok: false,
        failure: { ok: false, error: `Could not list Bitbucket workspaces: ${res.error}` },
      };
    }
    const body = res.body as {
      values?: { slug?: string; workspace?: { slug?: string } }[];
      next?: string;
    };
    for (const v of body.values ?? []) {
      const slug = v.workspace?.slug ?? v.slug;
      if (slug && !slugs.includes(slug)) slugs.push(slug);
    }
    const next = typeof body.next === 'string' ? body.next : null;
    url = next && next.startsWith(`${BITBUCKET_API}/`) ? next : null;
  }
  return { ok: true, slugs };
}

// ------------------------------------------------------------ REST calls

/// Whatever headers authenticate one request — Bearer / Basic for
/// Bitbucket, PRIVATE-TOKEN or Bearer for GitLab.
type AuthHeaders = Record<string, string>;

type ApiResult =
  | { ok: true; body: unknown; status: number }
  | { ok: false; error: string; status: number };

async function apiFetch(url: string, auth: AuthHeaders): Promise<ApiResult> {
  try {
    const res = await fetch(url, {
      headers: { ...auth, Accept: 'application/json' },
      // A forge that answers a 3xx to somewhere else would otherwise get
      // our Authorization header forwarded to the redirect target.
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: await apiErrorText(res), status: res.status };
    }
    return { ok: true, body: await res.json(), status: res.status };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg, status: 0 };
  }
}

/// Try each auth shape against a cheap "who am I" endpoint and keep the
/// first that isn't rejected. A non-auth failure (offline, 5xx) stops
/// the probe and returns that shape, so the caller reports the real
/// network error instead of a misleading "credential rejected".
async function probeAuth(probeUrl: string, candidates: AuthHeaders[]): Promise<AuthHeaders | null> {
  for (const auth of candidates) {
    const res = await apiFetch(probeUrl, auth);
    if (res.ok) return auth;
    if (res.status !== 401 && res.status !== 403) return auth;
  }
  return null;
}

async function apiErrorText(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as {
      error?: { message?: string } | string;
      message?: string;
    };
    // Bitbucket nests under error.message; GitLab uses a flat `message`
    // or `error` string.
    if (typeof body.error === 'string') detail = body.error;
    else detail = body.error?.message ?? (typeof body.message === 'string' ? body.message : '');
  } catch {
    /* non-JSON error body — the status alone will have to do */
  }
  if (res.status === 410 && detail.includes('CHANGE-2770')) {
    return 'Bitbucket removed this API (CHANGE-2770); overgit needs an update.';
  }
  return detail ? `HTTP ${res.status} — ${detail}` : `HTTP ${res.status}`;
}

// ------------------------------------------------------- git credentials

export interface GitCredential {
  username: string;
  password: string;
}

/// Parse `git credential fill` output — `key=value` lines, blank-line
/// terminated. Values can contain `=`, so only split on the first one.
export function parseGitCredential(stdout: string): GitCredential | null {
  let username = '';
  let password = '';
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === 'username') username = value;
    else if (key === 'password') password = value;
  }
  if (!password) return null;
  return { username: username || 'x-token-auth', password };
}

/// Ask git for the credential it would use for `https://<host>`. Runs
/// strictly non-interactively: if nothing is stored we want an empty
/// answer, never a terminal prompt or a credential-manager popup.
async function readGitCredential(host: string): Promise<GitCredential | null> {
  const res = await runCapture(
    'git',
    ['-c', 'credential.interactive=false', 'credential', 'fill'],
    {
      stdin: `protocol=https\nhost=${host}\n\n`,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true' },
    },
  );
  if (!res.ok) return null;
  return parseGitCredential(res.stdout);
}

// -------------------------------------------------------------- plumbing

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /// null when the binary couldn't be spawned at all (not installed).
  code: number | null;
}

function runCapture(
  cmd: string,
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env } });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      done({ ok: false, stdout, stderr: `${cmd} timed out after ${CLI_TIMEOUT_MS / 1000}s`, code: 1 });
    }, CLI_TIMEOUT_MS);

    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      done({ ok: false, stdout, stderr, code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, stdout, stderr, code });
    });

    try {
      if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
      child.stdin.end();
    } catch {
      /* EPIPE — the close handler reports the real exit code */
    }
  });
}

async function mapBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/// Most-recently-touched first, with undated repos last. Stable enough
/// that the picker's top rows are the ones you're likely to want.
export function sortByUpdated(repos: ForgeRepo[]): ForgeRepo[] {
  return [...repos].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}
