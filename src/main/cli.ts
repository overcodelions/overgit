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

const BACKUP_NAME_PROMPT = `You are naming a git "backup" branch that will preserve about-to-be-discarded local work.

Given the unpushed commits and dirty-tree summary below, return:
- line 1: a short kebab-case branch name beginning with "backup/", 2-5 words, summarizing the work (e.g. "backup/checkout-redesign-stash")
- line 2 onward: ONE sentence (<= 100 chars) summarizing what the work was about so the user can find it again later

Output ONLY those two lines. No quotes, no markdown, no preamble.`;

/// Ask an LLM CLI to invent a backup branch name + one-line summary for
/// the work the user is about to abandon. Used by the Abandon-local-
/// commits sheet so the user gets a meaningful "backup/…-something"
/// instead of the date-only fallback. Best-effort: any failure falls
/// back to the caller's default name without surfacing as an error.
export async function suggestBackupBranchName(
  tool: LlmTool,
  context: string,
): Promise<
  | { ok: true; name: string; summary: string; tool: LlmTool }
  | { ok: false; error: string; tool: LlmTool }
> {
  if (!context.trim()) {
    return { ok: false, error: 'No work to summarize.', tool };
  }
  const result = await runOneShot(tool, BACKUP_NAME_PROMPT + '\n\n' + context);
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'CLI failed', tool };
  }
  const cleaned = stripFences(result.output).trim();
  if (!cleaned) {
    return { ok: false, error: 'CLI returned an empty response.', tool };
  }
  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);
  const rawName = lines[0] ?? '';
  const summary = lines.slice(1).join(' ').trim();
  // Strip any quotes / surrounding punctuation the model sometimes
  // wraps the name in, then enforce a sensible character set so we
  // never hand git something it'll reject.
  const name = rawName
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._/-]/g, '');
  if (!name) {
    return { ok: false, error: 'CLI returned no valid name.', tool };
  }
  return { ok: true, name, summary, tool };
}

function stripFences(s: string): string {
  // Tolerate ```text\n…\n``` or ```\n…\n``` wrappers some CLIs emit.
  const m = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : s;
}

const CONFLICT_RESOLVE_PROMPT = `You are resolving a git merge conflict.

You will receive a single source file that contains one or more conflict regions delimited by:

  <<<<<<< <ours-label>
  …our side…
  ======= (or |||||||  base ... ======= for diff3)
  …their side…
  >>>>>>> <theirs-label>

You may also receive short commit-message logs describing the recent work on each side. Use them to understand *intent*, not just syntax — when both sides edited the same region, prefer the combination that preserves both intents, not just the side that's longer.

Rules:
- Output the ENTIRE file, exactly as it should appear after the resolution.
- Remove every conflict marker (<<<<<<<, |||||||, =======, >>>>>>>). The result must compile / parse as the original language.
- Do NOT add commentary, headings, explanations, or markdown fences. Output the raw file content only.
- Preserve all unchanged context lines verbatim — do not reformat or refactor code outside the conflict regions.
- If a hunk is a pure addition on one side, keep both unless they're clearly mutually exclusive.
- Keep imports, declarations, and ordering consistent with the surrounding file.`;

export interface ConflictResolveResult {
  ok: boolean;
  /// The proposed resolved file content. Always present (may be empty
  /// on failure) so the renderer can show whatever partial output the
  /// CLI produced.
  content: string;
  error?: string;
  tool: LlmTool;
}

/// Ask an LLM CLI to resolve a conflict file end-to-end. The renderer
/// is responsible for *previewing* the result (diff vs. current state)
/// and gating Accept behind explicit user confirmation — this helper
/// never writes to disk.
export async function resolveConflictWithLlm(args: {
  tool: LlmTool;
  fileContent: string;
  filePath: string;
  oursLog: string[] | null;
  theirsLog: string[] | null;
}): Promise<ConflictResolveResult> {
  const { tool, fileContent, filePath, oursLog, theirsLog } = args;
  if (!fileContent.includes('<<<<<<<')) {
    return {
      ok: false,
      content: '',
      error: 'File contains no conflict markers.',
      tool,
    };
  }
  const ctxLines: string[] = [`File: ${filePath}`];
  if (oursLog && oursLog.length) {
    ctxLines.push('', 'Recent commits on our side (HEAD):');
    for (const l of oursLog) ctxLines.push(`  ${l}`);
  }
  if (theirsLog && theirsLog.length) {
    ctxLines.push('', 'Recent commits on their side (MERGE_HEAD):');
    for (const l of theirsLog) ctxLines.push(`  ${l}`);
  }
  const prompt =
    CONFLICT_RESOLVE_PROMPT +
    '\n\n' +
    ctxLines.join('\n') +
    '\n\n----- BEGIN FILE -----\n' +
    fileContent +
    '\n----- END FILE -----\n';
  const result = await runOneShot(tool, prompt);
  if (!result.ok) {
    return { ok: false, content: result.output, error: result.error ?? 'CLI failed', tool };
  }
  const cleaned = stripFences(result.output);
  if (!cleaned.trim()) {
    return { ok: false, content: '', error: 'CLI returned an empty file.', tool };
  }
  if (cleaned.includes('<<<<<<<') || cleaned.includes('=======') || cleaned.includes('>>>>>>>')) {
    return {
      ok: false,
      content: cleaned,
      error: 'CLI left conflict markers in the output — review and edit before accepting.',
      tool,
    };
  }
  return { ok: true, content: cleaned, tool };
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

/// Find the open PR for a repo's current branch via `gh pr view`. We
/// pass `--json number,url,state` so we can distinguish "no PR exists"
/// (gh exits non-zero with "no pull requests found" stderr) from a
/// real failure mode (no GitHub remote, gh auth missing). The caller
/// uses this to keep workset open-PRs idempotent — if a PR already
/// exists we won't try to create a duplicate.
export async function findOpenPRForCurrentBranch(
  repoPath: string,
): Promise<
  | { kind: 'found'; number: number; url: string }
  | { kind: 'none' }
  | { kind: 'no-remote' }
  | { kind: 'no-gh' }
  | { kind: 'error'; message: string }
> {
  const res = await run('gh', ['pr', 'view', '--json', 'number,url,state'], repoPath);
  if (res.ok) {
    try {
      const parsed = JSON.parse(res.stdout) as { number: number; url: string; state: string };
      if (parsed.state === 'OPEN') {
        return { kind: 'found', number: parsed.number, url: parsed.url };
      }
      // A merged or closed PR shouldn't block creating a new one.
      return { kind: 'none' };
    } catch (err: unknown) {
      return { kind: 'error', message: `gh JSON parse failed: ${String(err)}` };
    }
  }
  const stderr = res.stderr.toLowerCase();
  if (res.code === null) return { kind: 'no-gh' };
  if (stderr.includes('no pull requests found') || stderr.includes('no pr')) {
    return { kind: 'none' };
  }
  if (stderr.includes('no github remote') || stderr.includes('not a github repository')) {
    return { kind: 'no-remote' };
  }
  return { kind: 'error', message: res.stderr.trim() || `gh exited ${res.code}` };
}

/// Create a PR via `gh pr create` for the current branch. Returns the
/// created PR's URL (gh prints it to stdout on success) and number
/// (parsed from the URL since gh doesn't print it separately in this
/// mode). `--head` is omitted on purpose — gh defaults to the current
/// branch, which is what we want, and passing it explicitly fails when
/// the branch isn't pushed yet (we precheck for that elsewhere).
export async function createPRWithGh(
  repoPath: string,
  args: { base: string; title: string; body: string; draft: boolean },
): Promise<
  | { ok: true; url: string; number: number }
  | { ok: false; kind: 'no-remote' | 'no-gh' | 'unpushed' | 'error'; error: string }
> {
  const argv = [
    'pr',
    'create',
    '--base',
    args.base,
    '--title',
    args.title,
    '--body',
    args.body,
  ];
  if (args.draft) argv.push('--draft');
  const res = await run('gh', argv, repoPath);
  if (res.ok) {
    const url = res.stdout.trim().split(/\s+/).pop() ?? '';
    const m = url.match(/\/pull\/(\d+)(?:[/?#]|$)/);
    if (!url || !m) {
      return { ok: false, kind: 'error', error: `gh succeeded but URL parse failed: ${res.stdout.trim()}` };
    }
    return { ok: true, url, number: Number.parseInt(m[1], 10) };
  }
  const stderr = res.stderr.toLowerCase();
  if (res.code === null) return { ok: false, kind: 'no-gh', error: 'gh not installed' };
  if (
    stderr.includes('no commits between') ||
    stderr.includes('must first push') ||
    stderr.includes('does not have any commits') ||
    stderr.includes('no remote tracking')
  ) {
    return { ok: false, kind: 'unpushed', error: res.stderr.trim() };
  }
  if (stderr.includes('no github remote') || stderr.includes('not a github repository')) {
    return { ok: false, kind: 'no-remote', error: res.stderr.trim() };
  }
  return { ok: false, kind: 'error', error: res.stderr.trim() || `gh exited ${res.code}` };
}

/// List open PRs for a single repo via `gh pr list --json`. Returns
/// `null` (with a reason) for repos with no GitHub remote, no gh auth,
/// or any other gh error — those are not failures of overgit, just
/// "this repo isn't a GitHub repo from gh's POV". Callers (the workset
/// aggregator) keep the reason and render the rest of the workset.
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
