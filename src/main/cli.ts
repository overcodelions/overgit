// Detect which review/comment CLIs are installed and shell out to them
// for review-specific data (PRs, comments) rather than rebuilding API
// integrations. The main process exposes presence + thin wrappers; the
// renderer gates UI on presence.

import { spawn } from 'node:child_process';
import { CliPresence, LlmTool, PullRequest, ReviewResult } from '../shared/types';

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
  const [gh, glab, jj, claude, codex, gemini] = await Promise.all([
    probe('gh'),
    probe('glab'),
    probe('jj'),
    probe('claude'),
    probe('codex'),
    probe('gemini'),
  ]);
  return { gh, glab, jj, claude, codex, gemini };
}

/// One-shot LLM review of a diff. Spawns the chosen CLI in non-interactive
/// mode, writes "<prompt>\n\n<diff>" to its stdin, and captures stdout.
/// The CLI is allowed up to 90s; long enough for a Claude/Codex round
/// trip on a moderate diff, short enough that a hung CLI doesn't pin the
/// renderer waiting forever.
export async function reviewDiffWithLlm(
  tool: LlmTool,
  diff: string,
): Promise<ReviewResult> {
  if (!diff.trim()) {
    return { ok: false, output: '', error: 'No diff to review.', tool };
  }

  const args = argsForTool(tool);
  const prompt = REVIEW_PROMPT + '\n\n' + diff;

  return new Promise<ReviewResult>((resolve) => {
    const child = spawn(tool, args, { env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const done = (r: ReviewResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    // Hard timeout. On hit we kill the child and surface a friendly
    // error instead of leaving the user staring at a spinner.
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      done({
        ok: false,
        output: stdout,
        error: `${tool} took longer than 90s — aborted.`,
        tool,
      });
    }, 90_000);

    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const cleaned = tool === 'codex' ? extractCodexBody(stdout) : stdout.trim();
      if (code === 0) {
        done({ ok: true, output: cleaned, tool });
      } else {
        done({
          ok: false,
          output: cleaned,
          error: stderr.trim() || `${tool} exited ${code}`,
          tool,
        });
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, output: '', error: String(err), tool });
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err: unknown) {
      // Most often EPIPE if the CLI exited before reading — the close
      // handler above will surface the real exit code in that case.
      if (!settled) child.kill('SIGTERM');
    }
  });
}

const REVIEW_PROMPT = `You are reviewing a git diff. Be concise and direct.

Respond in three short sections:

1. Summary — one or two sentences on what changed.
2. Concerns — list any bugs, regressions, missing tests, or risky patterns. Skip if nothing notable.
3. Suggested commit message — a single conventional-commit-style line.

Do not include preamble, headings beyond the three above, or markdown fences.`;

const COMMIT_MESSAGE_PROMPT = `You are writing the commit message for the staged git diff below.

Output ONLY the commit message itself — no preamble, no commentary, no markdown fences. Format:

  <type>(<scope>): <subject>

  <body, optional, wrap at 72 chars>

Where <type> is one of: feat, fix, refactor, docs, test, chore, perf. Skip <scope> if not obvious. The subject line must be under 72 characters and start with a lowercase verb. Add a body only if the diff has non-obvious "why" worth recording.`;

/// Run an LLM CLI on the staged diff to draft a commit message. Strips
/// any markdown fences the model wrapped around its answer (some CLIs
/// reflexively add ```text/```), trims trailing whitespace, and returns
/// just the message string for the renderer to drop straight into the
/// commit input.
export async function suggestCommitMessage(
  tool: LlmTool,
  diff: string,
): Promise<
  | { ok: true; message: string; tool: LlmTool }
  | { ok: false; error: string; tool: LlmTool }
> {
  if (!diff.trim()) {
    return { ok: false, error: 'No staged changes to summarize.', tool };
  }
  const result = await runOneShot(tool, COMMIT_MESSAGE_PROMPT + '\n\n' + diff);
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'CLI failed', tool };
  }
  const cleaned = stripFences(result.output).trim();
  if (!cleaned) {
    return { ok: false, error: 'CLI returned an empty message.', tool };
  }
  return { ok: true, message: cleaned, tool };
}

function stripFences(s: string): string {
  // Tolerate ```text\n…\n``` or ```\n…\n``` wrappers some CLIs emit.
  const m = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : s;
}

/// Shared one-shot LLM invocation: spawn `tool argsForTool(tool)`, write
/// `prompt` to stdin, capture stdout, post-process for codex.
async function runOneShot(
  tool: LlmTool,
  prompt: string,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const args = argsForTool(tool);
  return new Promise((resolve) => {
    const child = spawn(tool, args, { env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: { ok: boolean; output: string; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      done({ ok: false, output: stdout, error: `${tool} took longer than 90s — aborted.` });
    }, 90_000);
    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const cleaned = tool === 'codex' ? extractCodexBody(stdout) : stdout.trim();
      if (code === 0) done({ ok: true, output: cleaned });
      else done({ ok: false, output: cleaned, error: stderr.trim() || `${tool} exited ${code}` });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, output: '', error: String(err) });
    });
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      if (!settled) child.kill('SIGTERM');
    }
  });
}

function argsForTool(tool: LlmTool): string[] {
  // The "-" / "exec" args for each CLI come from overcli's reviewer.ts;
  // they're the documented one-shot, stdin-prompt invocations:
  //   claude -p -          : print mode, prompt from stdin
  //   gemini -p -          : same shape as claude
  //   codex exec -         : non-interactive exec, prompt from stdin.
  //                          --skip-git-repo-check lets it run from any cwd.
  switch (tool) {
    case 'claude':
      return ['-p', '-'];
    case 'gemini':
      return ['-p', '-'];
    case 'codex':
      return ['exec', '--skip-git-repo-check', '-'];
  }
}

/// codex emits a structured transcript ("[ts] thinking", "[ts] codex",
/// "[ts] tokens used", …). We want only the "codex" body — that's the
/// final assistant response. Falls back to the trimmed raw output if no
/// "codex" section is found, so we never silently lose the response.
function extractCodexBody(raw: string): string {
  if (!raw) return '';
  const parts: string[] = [];
  let inCodexSection = false;
  for (const line of raw.split('\n')) {
    const m = line.match(/^\[[^\]]+\]\s*([a-z_]+)\s*$/);
    if (m) {
      inCodexSection = m[1] === 'codex';
      continue;
    }
    if (inCodexSection) parts.push(line);
  }
  const joined = parts.join('\n').trim();
  return joined || raw.trim();
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
