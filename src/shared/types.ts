// Shared types for the overgit IPC contract and on-disk store.
//
// Overgit is workspace-overlay: each `Repo` is a real, standalone git
// repository on disk that overgit does NOT own. A `Workspace` is just a
// named collection of repo IDs — opening a workspace doesn't move files
// or rewrite metadata; it only tells the UI which repos to show together.
// Anything overgit does (checkout, fetch, status) it does by shelling out
// to `git` in each repo's existing directory.

export type UUID = string;

export interface Repo {
  id: UUID;
  /// Display name. Defaults to basename(path) at add time, but the user
  /// can rename without affecting the on-disk repo.
  name: string;
  /// Absolute path to the working tree root (the directory containing .git).
  path: string;
  /// When the user last opened this repo in overgit. ISO-8601.
  lastOpenedAt?: string;
  /// "Trunk" branch of this repo: the one overgit treats as the base
  /// for compare/PR-base flows and as the recovery target if the user
  /// abandons a feature branch. Auto-detected from `origin/HEAD` at add
  /// time; user-overridable in settings.
  defaultBranch?: string;
}

export interface Workspace {
  id: UUID;
  name: string;
  /// Ordered list of repo IDs. A repo can belong to many workspaces.
  repoIds: UUID[];
  /// Optional: the branch the user wants the workspace pinned to. Used
  /// by the "checkout everywhere" action as a default.
  preferredBranch?: string;
}

export interface RepoStatus {
  repoId: UUID;
  /// Current branch name, or null in detached-HEAD state.
  branch: string | null;
  /// Number of files with unstaged changes (modified, deleted, untracked).
  dirtyCount: number;
  /// Commits ahead/behind upstream. null if no upstream is configured.
  ahead: number | null;
  behind: number | null;
  /// Most recent error from git on this repo, if any.
  error?: string;
}

/// Result of a workspace-wide branch checkout. We attempt every repo and
/// report each outcome rather than aborting on the first failure — the
/// user wants to know which ones landed and which need attention.
export interface CheckoutOutcome {
  repoId: UUID;
  /// What happened: switched cleanly, branch didn't exist, dirty tree
  /// blocked the switch, or git returned an unexpected error.
  result: 'switched' | 'already-on-branch' | 'missing-branch' | 'dirty' | 'error';
  branch: string;
  message?: string;
}

/// Per-repo result of the "sync default branch and create new branch"
/// workflow. Each repo can succeed at any point in the chain; the step
/// names tell the renderer how far we got so a partial failure is
/// readable ("synced default but couldn't create branch on origin/foo").
export interface SyncAndBranchOutcome {
  repoId: UUID;
  /// Branch we tried to create.
  branch: string;
  /// Default branch we synced to (or attempted).
  defaultBranch: string | null;
  result:
    | 'created'
    | 'no-default-branch'
    | 'dirty'
    | 'pull-failed'
    | 'create-failed'
    | 'switch-failed';
  message?: string;
}

/// Detected installed CLIs we can shell out to. The first three are
/// review-host CLIs (PR/MR data). The rest are LLM CLIs that can review
/// or comment on a diff in non-interactive mode. Discovered once at
/// startup; the renderer uses presence to gate UI.
export interface CliPresence {
  gh: boolean;
  glab: boolean;
  jj: boolean;
  claude: boolean;
  codex: boolean;
  gemini: boolean;
}

export type LlmTool = 'claude' | 'codex' | 'gemini';

export interface ReviewResult {
  ok: boolean;
  /// Plain-text response from the LLM. For codex this is the post-extraction
  /// "final assistant message", trimmed of timestamps and metadata.
  output: string;
  /// stderr / non-zero-exit message when `ok: false`. Otherwise undefined.
  error?: string;
  /// Which CLI produced this response. Pinned so the renderer can label
  /// the result without re-deriving it from the request.
  tool: LlmTool;
}

export interface Commit {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  author: string;
  authorEmail: string;
  /// ISO-8601 author date.
  date: string;
}

export interface FileDiff {
  /// Path as it appears in the diff header (post-rename "b" path for
  /// renames; for adds it's the new file; for deletes it's the deleted
  /// file). Good enough for a file list.
  path: string;
  /// Single-letter status code from git: A/M/D/R/C, or '?' if unparsed.
  status: 'A' | 'M' | 'D' | 'R' | 'C' | '?';
  /// Raw unified-diff body for this file (no diff header), suitable for
  /// rendering as a single <pre>. Renames with no content change can have
  /// an empty body; the file still appears in the list.
  body: string;
}

/// One row of `git status --porcelain=v1`, split into the index side (X)
/// and the worktree side (Y). A file with `indexStatus !== ' '` is in
/// the staged list; a file with `worktreeStatus !== ' '` (or `?`, which
/// is git's untracked marker) is in the unstaged list. Renames carry
/// `origPath` so the UI can show "old → new".
export interface ChangedFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  origPath?: string;
}

export interface RepoChanges {
  staged: ChangedFile[];
  unstaged: ChangedFile[];
}

/// One stash entry in the user's stash list. The `index` is the
/// stash@{N} reference git uses everywhere — the renderer keeps it
/// alongside the human-readable subject so apply/pop/drop calls can
/// target the exact entry the user clicked, even if the list
/// reshuffles between calls.
export interface Stash {
  /// Numeric index for `stash@{N}`. 0 is the newest.
  index: number;
  ref: string;
  shortSha: string;
  branch: string;
  subject: string;
  date: string;
}

/// One branch in the picker. Carries enough metadata for the row UI
/// (last-commit subject, date, upstream tag) to render without any
/// follow-up IPC calls. Sorted by committer date, newest first.
export interface BranchSummary {
  name: string;
  shortName: string;
  kind: 'local' | 'remote';
  isCurrent: boolean;
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
  upstream: string | null;
}

/// One commit row in the project's branch visualization. `lane` and
/// `parentLanes` come from a greedy stripe layout in main, so the
/// renderer just draws lines between (lane, row) pairs.
export interface GraphCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
  refs: string[];
  lane: number;
  parentLanes: number[];
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  headBranch: string;
  baseBranch: string;
  isDraft: boolean;
  author: string;
  /// ISO-8601 timestamp from gh.
  updatedAt: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
}

/// Result of asking gh for PRs in a single repo. Repos without a GitHub
/// remote (or without gh auth) come back with `prs: null` and a reason.
export interface RepoPRs {
  repoId: UUID;
  prs: PullRequest[] | null;
  error?: string;
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  /// User-controlled visibility of the left sidebar. Persisted so the
  /// title-bar toggle survives relaunch.
  sidebarVisible: boolean;
  /// Sidebar width in pixels. Persisted so the user's drag survives
  /// relaunch. Clamped on read so a stale value can't push the sidebar
  /// off-screen on a smaller display.
  sidebarWidth: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  sidebarVisible: true,
  sidebarWidth: 288,
};

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 520;

/// Typed contract for ipcRenderer.invoke channels. Each entry is the
/// signature the main-process handler implements; the preload exposes
/// a generic `invoke(channel, ...args)` that respects this map.
export interface IPCInvokeMap {
  'store:load': () => StoreSnapshot;
  'store:saveRepos': (repos: Repo[]) => void;
  'store:saveWorkspaces': (workspaces: Workspace[]) => void;
  'store:saveSettings': (settings: AppSettings) => void;

  'repo:add': (path: string) => { ok: true; repo: Repo } | { ok: false; error: string };
  'repo:pickAndAdd': () => { ok: true; repo: Repo } | { ok: false; error: string } | { ok: false; cancelled: true };
  'repo:status': (repoId: UUID) => RepoStatus;
  'repo:listBranches': (repoId: UUID) => { local: string[]; remote: string[] };
  'repo:log': (args: { repoId: UUID; limit?: number }) => Commit[];
  /// Diff for a specific commit (parent..sha) when `sha` is set, otherwise
  /// the working tree vs HEAD (staged + unstaged combined).
  'repo:diff': (args: { repoId: UUID; sha?: string }) => FileDiff[];
  'repo:stash': (args: { repoId: UUID; message?: string }) => { ok: boolean; error?: string };
  'repo:stashFiles': (args: {
    repoId: UUID;
    paths: string[];
    message?: string;
  }) => { ok: boolean; error?: string };
  'repo:commitAll': (args: { repoId: UUID; message: string }) => { ok: boolean; error?: string };
  'repo:retryCheckout': (args: {
    repoId: UUID;
    branch: string;
    createIfMissing: boolean;
  }) => CheckoutOutcome;

  'repo:checkout': (args: {
    repoId: UUID;
    branch: string;
    createIfMissing: boolean;
  }) => CheckoutOutcome;
  'repo:changes': (repoId: UUID) => RepoChanges;
  'repo:stageFiles': (args: { repoId: UUID; paths: string[] }) => { ok: boolean; error?: string };
  'repo:unstageFiles': (args: { repoId: UUID; paths: string[] }) => { ok: boolean; error?: string };
  'repo:discardFiles': (args: { repoId: UUID; paths: string[] }) => { ok: boolean; error?: string };
  'repo:commit': (args: { repoId: UUID; message: string }) => { ok: boolean; error?: string };
  'repo:push': (repoId: UUID) => { ok: boolean; error?: string };
  'repo:pull': (repoId: UUID) => { ok: boolean; error?: string };
  'repo:fetch': (repoId: UUID) => { ok: boolean; error?: string };
  'repo:createBranch': (args: { repoId: UUID; name: string; checkout: boolean }) => { ok: boolean; error?: string };
  'repo:deleteBranch': (args: { repoId: UUID; name: string; force: boolean }) => { ok: boolean; error?: string };
  /// Diff for a single path, scoped to either the index (staged vs HEAD)
  /// or the working tree (unstaged vs index). Used by the Changes pane
  /// when a single file is selected.
  'repo:diffFile': (args: {
    repoId: UUID;
    path: string;
    side: 'staged' | 'unstaged';
  }) => FileDiff[];
  'repo:graph': (args: { repoId: UUID; limit?: number }) => GraphCommit[];
  'repo:listStashes': (repoId: UUID) => Stash[];
  'repo:applyStash': (args: {
    repoId: UUID;
    index: number;
    pop: boolean;
  }) => { ok: boolean; error?: string };
  'repo:dropStash': (args: { repoId: UUID; index: number }) => { ok: boolean; error?: string };
  'repo:stashDiff': (args: { repoId: UUID; index: number }) => FileDiff[];
  'repo:branchSummaries': (repoId: UUID) => BranchSummary[];
  'repo:branchCommits': (args: { repoId: UUID; ref: string; limit?: number }) => Commit[];
  'repo:cherryPick': (args: { repoId: UUID; shas: string[] }) => { ok: boolean; error?: string };
  'repo:detectDefaultBranch': (repoId: UUID) => string | null;
  'repo:setDefaultBranch': (args: { repoId: UUID; branch: string | null }) => void;

  'fs:listFiles': (repoId: UUID) => string[];
  'fs:readFile': (args: {
    repoId: UUID;
    path: string;
  }) => { ok: true; content: string; resolvedPath: string } | { ok: false; error: string };
  'fs:writeFile': (args: {
    repoId: UUID;
    path: string;
    content: string;
  }) => { ok: boolean; error?: string };

  'workspace:status': (workspaceId: UUID) => RepoStatus[];
  'workspace:checkoutBranch': (args: {
    workspaceId: UUID;
    branch: string;
    createIfMissing: boolean;
  }) => CheckoutOutcome[];
  'workspace:fetchAll': (workspaceId: UUID) => { repoId: UUID; ok: boolean; error?: string }[];
  'workspace:listPRs': (workspaceId: UUID) => RepoPRs[];
  'workspace:syncAndBranch': (args: {
    workspaceId: UUID;
    branch: string;
    syncDefault: boolean;
    pullBeforeBranch: boolean;
  }) => SyncAndBranchOutcome[];

  'cli:detect': () => CliPresence;
  'cli:reviewChanges': (args: {
    repoId: UUID;
    scope: 'staged' | 'working';
    tool: LlmTool;
  }) => ReviewResult;
  'cli:suggestCommitMessage': (args: {
    repoId: UUID;
    tool: LlmTool;
  }) => { ok: true; message: string; tool: LlmTool } | { ok: false; error: string; tool: LlmTool };
}

export interface StoreSnapshot {
  repos: Repo[];
  workspaces: Workspace[];
  settings: AppSettings;
}

/// Push channel from main → renderer. Reserved for future streaming
/// status updates (e.g. progress during a workspace fetch).
export type MainToRendererEvent =
  | { kind: 'repo:statusUpdated'; status: RepoStatus }
  | { kind: 'workspace:checkoutProgress'; workspaceId: UUID; outcome: CheckoutOutcome };
