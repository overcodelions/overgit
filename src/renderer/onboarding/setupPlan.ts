// What this machine can run, and what to do about what it can't. Pure so
// the first-run screen and Help → Setup read the same plan, and so the
// copy for every state is pinned by a test instead of by eyeballing.
//
// Only git is required. Everything else switches a feature on, so the
// plan never calls a missing optional tool a problem.

import type { CliPresence, GitInfo } from '@shared/types';

export type Platform = 'mac' | 'windows' | 'linux';
export type ToolKey = 'git' | 'gh' | 'claude' | 'codex' | 'gemini';
/// `outdated` is git older than 2.38: everything works except Landing Check.
export type ToolState = 'checking' | 'ready' | 'missing' | 'outdated';

export interface ToolRow {
  key: ToolKey;
  group: 'required' | 'forge' | 'ai';
  state: ToolState;
  /// What overgit does with it, in one line.
  unlocks: string;
  /// Shown under the name when the state needs explaining.
  detail?: string;
  /// One command to paste into a terminal. Absent when ready.
  install?: string;
  /// The step after installing, e.g. signing in.
  then?: string;
  docs: string;
}

export interface SetupPlan {
  rows: ToolRow[];
  /// Git answered and is usable. Everything in overgit waits on this.
  gitReady: boolean;
  checking: boolean;
  headline: string;
  lead: string;
  readyCount: number;
}

const INSTALL_GIT: Record<Platform, { cmd: string; then?: string }> = {
  mac: { cmd: 'xcode-select --install', then: 'Or, with Homebrew: brew install git' },
  windows: { cmd: 'winget install --id Git.Git -e', then: 'Then quit and reopen overgit so it sees the new PATH.' },
  linux: { cmd: 'sudo apt install git', then: "Or your distribution's package manager (dnf, pacman, …)." },
};

const INSTALL_GH: Record<Platform, string> = {
  mac: 'brew install gh',
  windows: 'winget install --id GitHub.cli -e',
  linux: 'sudo apt install gh',
};

export function detectPlatform(userAgent: string): Platform {
  const ua = userAgent.toLowerCase();
  if (ua.includes('mac')) return 'mac';
  if (ua.includes('win')) return 'windows';
  return 'linux';
}

export function buildSetupPlan(args: {
  git: GitInfo | null;
  cli: CliPresence | null;
  platform: Platform;
}): SetupPlan {
  const { git, cli, platform } = args;
  const optional = (present: boolean | undefined): ToolState =>
    present === undefined ? 'checking' : present ? 'ready' : 'missing';

  const gitState: ToolState = !git
    ? 'checking'
    : !git.installed
      ? 'missing'
      : git.landingCheck
        ? 'ready'
        : 'outdated';

  const rows: ToolRow[] = [
    {
      key: 'git',
      group: 'required',
      state: gitState,
      unlocks: 'Every action. overgit runs the same git commands you would.',
      detail:
        gitState === 'ready'
          ? `Version ${git!.version}`
          : gitState === 'outdated'
            ? `Version ${git!.version}. Everything works except Landing Check, which needs 2.38 or newer.`
            : gitState === 'missing'
              ? 'overgit can’t do anything without it.'
              : undefined,
      install: gitState === 'missing' || gitState === 'outdated' ? INSTALL_GIT[platform].cmd : undefined,
      then: gitState === 'missing' || gitState === 'outdated' ? INSTALL_GIT[platform].then : undefined,
      docs: 'https://git-scm.com/downloads',
    },
    {
      key: 'gh',
      group: 'forge',
      state: optional(cli?.gh),
      unlocks: 'Pull requests: list them across a workset and open them in one pass.',
      install: cli?.gh === false ? INSTALL_GH[platform] : undefined,
      then: cli?.gh === false ? 'Then sign in once: gh auth login' : undefined,
      docs: 'https://cli.github.com',
    },
    {
      key: 'claude',
      group: 'ai',
      state: optional(cli?.claude),
      unlocks: 'AI review of a diff, and a drafted commit message.',
      install: cli?.claude === false ? 'npm install -g @anthropic-ai/claude-code' : undefined,
      then: cli?.claude === false ? 'Then run claude once in a terminal to sign in.' : undefined,
      docs: 'https://docs.anthropic.com/en/docs/claude-code',
    },
    {
      key: 'codex',
      group: 'ai',
      state: optional(cli?.codex),
      unlocks: 'The same review and commit drafting, through OpenAI.',
      install: cli?.codex === false ? 'npm install -g @openai/codex' : undefined,
      then: cli?.codex === false ? 'Then run codex once in a terminal to sign in.' : undefined,
      docs: 'https://github.com/openai/codex',
    },
    {
      key: 'gemini',
      group: 'ai',
      state: optional(cli?.gemini),
      unlocks: 'The same review and commit drafting, through Google.',
      install: cli?.gemini === false ? 'npm install -g @google/gemini-cli' : undefined,
      then: cli?.gemini === false ? 'Then run gemini once in a terminal to sign in.' : undefined,
      docs: 'https://github.com/google-gemini/gemini-cli',
    },
  ];

  const checking = rows.some((r) => r.state === 'checking');
  const gitReady = gitState === 'ready' || gitState === 'outdated';
  const readyCount = rows.filter((r) => r.state === 'ready' || r.state === 'outdated').length;
  const allReady = rows.every((r) => r.state === 'ready');

  let headline: string;
  let lead: string;
  if (gitState === 'checking') {
    headline = 'Checking what this machine has…';
    lead = 'One moment — overgit is asking git and the optional CLIs for their versions.';
  } else if (gitState === 'missing') {
    headline = 'Install git to get started';
    lead = 'overgit is a window onto git, so git has to be on this machine. This screen notices it on its own once it’s installed.';
  } else if (allReady) {
    headline = 'You’re set up';
    lead = 'Git and every optional CLI are here. Anything they’re signed into, overgit can use.';
  } else {
    headline = 'Git is ready — that’s all overgit needs';
    lead = 'Everything else below switches on a feature. Skip any of them; the buttons they drive just stay hidden.';
  }

  return { rows, gitReady, checking, headline, lead, readyCount };
}
