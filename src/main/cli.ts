// Detect which review/comment CLIs are installed and shell out to them
// for review-specific data (PRs, comments) rather than rebuilding API
// integrations. The main process exposes presence + thin wrappers; the
// renderer gates UI on presence.

import { spawn } from 'node:child_process';
import { CliPresence, PullRequest } from '../shared/types';

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, stdout, stderr, code });
    });
    child.on('error', (err) => {
      resolve({ ok: false, stdout, stderr: stderr || String(err), code: null });
    });
  });
}

function probe(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ['--version'], { env: process.env });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
}

export async function detectCliPresence(): Promise<CliPresence> {
  const [gh, glab, jj] = await Promise.all([probe('gh'), probe('glab'), probe('jj')]);
  return { gh, glab, jj };
}

interface GhPrJson {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  author?: { login?: string };
  updatedAt: string;
  state: string;
}

/// List open PRs for a single repo via `gh pr list --json`. Returns
/// `null` (with a reason) for repos with no GitHub remote, no gh auth,
/// or any other gh error — those are not failures of overgit, just
/// "this repo isn't a GitHub repo from gh's POV". Callers (the workspace
/// aggregator) keep the reason and render the rest of the workspace.
export async function listOpenPRs(
  repoPath: string,
): Promise<{ prs: PullRequest[] | null; error?: string }> {
  const fields = [
    'number',
    'title',
    'url',
    'headRefName',
    'baseRefName',
    'isDraft',
    'author',
    'updatedAt',
    'state',
  ].join(',');
  const res = await run('gh', ['pr', 'list', '--state', 'open', '--json', fields], repoPath);
  if (!res.ok) {
    return { prs: null, error: res.stderr.trim() || `gh exited ${res.code}` };
  }
  try {
    const parsed: GhPrJson[] = JSON.parse(res.stdout);
    const prs: PullRequest[] = parsed.map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      headBranch: p.headRefName,
      baseBranch: p.baseRefName,
      isDraft: p.isDraft,
      author: p.author?.login ?? '',
      updatedAt: p.updatedAt,
      state: p.state === 'MERGED' || p.state === 'CLOSED' ? p.state : 'OPEN',
    }));
    return { prs };
  } catch (err: unknown) {
    return { prs: null, error: `gh JSON parse failed: ${String(err)}` };
  }
}
