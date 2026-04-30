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
  /// Total inserted / deleted line counts across the working tree
  /// (staged + unstaged) vs HEAD. Computed via `git diff --shortstat
  /// HEAD`. Does NOT count untracked files — git diff doesn't see
  /// them. null on fresh repos with no commits or when shortstat
  /// reports nothing parseable.
  worktreeAdds: number | null;
  worktreeDels: number | null;
  /// Commits ahead/behind upstream. null if no upstream is configured.
  ahead: number | null;
  behind: number | null;
  /// Commits ahead/behind the repo's default branch — `origin/<default>`
  /// when available, else the local default. The renderer surfaces
  /// this as a pill so the user knows whether their feature branch is
  /// drifting from main without having to git fetch + rev-list. null
  /// when no default branch is configured or the user is currently on
  /// the default branch (the comparison would be self-vs-self).
  aheadDefault: number | null;
  behindDefault: number | null;
  /// The ref string we compared against (e.g. "origin/main"). null
  /// matches the null counts; the renderer uses it as a label.
  defaultRef: string | null;
  /// In-progress operation: merge, rebase, or cherry-pick. Detected by
  /// the presence of MERGE_HEAD / rebase-merge / CHERRY_PICK_HEAD in
  /// the .git directory. null when nothing's pending. The renderer
  /// surfaces a conflict banner so the user has somewhere to land:
  /// abort, continue, or manually resolve.
  inProgress: InProgressOp | null;
  /// Conflicting paths from `git status --porcelain` (entries marked
  /// `UU`, `AA`, `DU`, `UD`, etc.). Empty when there are no conflicts.
  conflicts: string[];
  /// Most recent error from git on this repo, if any.
  error?: string;
}

export type InProgressOp = 'merge' | 'rebase' | 'cherry-pick';

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

/// One linked working tree from `git worktree list --porcelain`. Overgit
/// uses the main worktree (the one that holds .git/) as the canonical
/// "repo" but surfaces siblings here so the user can see, at a glance,
/// every checkout of the same repo. Detached worktrees come back with
/// `branch: null` and `head` set; missing-on-disk worktrees come back
/// with `prunable: true`.
export interface Worktree {
  /// Absolute path of the worktree's working directory.
  path: string;
  /// HEAD sha. null only for an unborn branch (very rare).
  head: string | null;
  /// Branch name without refs/heads/, or null in detached HEAD.
  branch: string | null;
  /// True for the worktree that owns the .git directory (the original
  /// clone). The renderer pins this one to the top of the list.
  isMain: boolean;
  /// User has run `git worktree lock`. We don't try to unlock here;
  /// it's just informational so the user knows why a stale entry
  /// hasn't been pruned.
  locked: boolean;
  /// `git worktree list` flagged this entry as missing on disk.
  prunable: boolean;
}

/// Per-repo result of the workspace-wide commit-all action. Mirrors
/// SyncAndBranchOutcome's shape so the renderer can reuse the same
/// per-repo result row.
export interface CommitAllOutcome {
  repoId: UUID;
  result: 'committed' | 'detached' | 'clean' | 'commit-failed';
  message?: string;
}

/// Per-repo result of the workspace-wide push-all action. `up-to-date`
/// is the no-op case (already in sync with upstream) — kept distinct
/// from `pushed` so the result list isn't all green when nothing
/// actually moved. `no-upstream-set` means the push had to set the
/// upstream on first push (we ran `git push -u origin HEAD`); we report
/// it as a separate result so the user knows tracking was just wired.
export interface WorkspacePushOutcome {
  repoId: UUID;
  result: 'pushed' | 'pushed-new-upstream' | 'up-to-date' | 'detached' | 'push-failed';
  /// Number of commits the local branch was ahead of its upstream when
  /// we started — purely for the result-row label so the user knows how
  /// much shipped.
  ahead?: number;
  branch?: string;
  message?: string;
}

/// Per-repo result of the workspace-wide "open PRs" action. We keep the
/// failure modes named distinctly (`unpushed` vs `no-remote` vs
/// `no-gh`) so the renderer can render an appropriate fix-it action per
/// row instead of a generic error.
export interface WorkspaceOpenPROutcome {
  repoId: UUID;
  result:
    | 'created'
    | 'already-open'
    | 'detached'
    | 'on-default-branch'
    | 'unpushed'
    | 'no-gh'
    | 'no-remote'
    | 'create-failed';
  branch?: string;
  baseBranch?: string;
  /// PR url — set on `created` and `already-open`.
  url?: string;
  /// PR number — set on `created` and `already-open`.
  number?: number;
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
  /// Full commit message body (everything after the subject line).
  /// Empty string when the commit has no body. Comes from `%b` in the
  /// log format and carries embedded newlines.
  body: string;
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
/// renderer just draws lines between (lane, row) pairs. We carry
/// enough metadata (authorEmail, body) so the unified history view
/// can render full commit detail without a follow-up roundtrip.
export interface GraphCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  author: string;
  authorEmail: string;
  date: string;
  body: string;
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
  /// Width of the History tab's commit-list aside. Same persistence
  /// idea as `sidebarWidth` — independent because the History pane is
  /// usually wider than the app sidebar (it carries the lane rail +
  /// ref badges + subject + meta on one row).
  historyAsideWidth: number;
  /// Per-workspace "last seen" timestamps (ISO 8601). Used by the
  /// activity feed to mark commits / PRs that arrived since the user
  /// last opened the workspace pane. Wiped when a workspace is
  /// removed; never written for repos (workspace-scoped only).
  workspaceLastSeen?: Record<UUID, string>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  sidebarVisible: true,
  sidebarWidth: 288,
  historyAsideWidth: 480,
  workspaceLastSeen: {},
};

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 520;
export const HISTORY_ASIDE_MIN_WIDTH = 320;
export const HISTORY_ASIDE_MAX_WIDTH = 900;

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
  'repo:fetch': (repoId: UUID) => { ok: boolean; error?: string };
  'repo:createBranch': (args: {
    repoId: UUID;
    name: string;
    checkout: boolean;
    /// Optional starting commit (sha). When omitted the branch is
    /// created from the current HEAD, which is the default flow.
    from?: string;
  }) => { ok: boolean; error?: string };
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
  }) => { ok: boolean; error?: string; conflicts?: string[] };
  /// Same as applyStash but first deletes the working-tree files git
  /// flagged as "already exists, no checkout" so the apply can proceed.
  /// Destructive — the renderer must confirm before calling.
  'repo:applyStashForce': (args: {
    repoId: UUID;
    index: number;
    pop: boolean;
  }) => { ok: boolean; error?: string; removed?: string[] };
  'repo:dropStash': (args: { repoId: UUID; index: number }) => { ok: boolean; error?: string };
  'repo:stashDiff': (args: { repoId: UUID; index: number }) => FileDiff[];
  'repo:branchSummaries': (repoId: UUID) => BranchSummary[];
  'repo:branchCommits': (args: { repoId: UUID; ref: string; limit?: number }) => Commit[];
  'repo:cherryPick': (args: { repoId: UUID; shas: string[] }) => { ok: boolean; error?: string };
  /// Detach HEAD onto a sha. Used by the History view's "Checkout this
  /// commit" affordance.
  'repo:checkoutCommit': (args: { repoId: UUID; sha: string }) => { ok: boolean; error?: string };
  /// Apply a unified-diff patch in one of three modes. The renderer
  /// constructs a sub-patch from selected hunks and sends it here so
  /// staging / unstaging / discarding can target a single hunk at a time
  /// (or any subset of hunks within a file).
  'repo:applyPatch': (args: {
    repoId: UUID;
    patch: string;
    mode: 'stage' | 'unstage' | 'discard';
  }) => { ok: boolean; error?: string };
  /// `git commit --amend`. When `message` is null we keep the previous
  /// message and just fold staged changes onto the previous commit.
  'repo:amendCommit': (args: {
    repoId: UUID;
    message: string | null;
  }) => { ok: boolean; error?: string };
  /// Merge a branch into the current one. Modes mirror git's:
  ///   merge   → create a merge commit (--no-ff)
  ///   ff-only → fast-forward only (--ff-only); refuses if a merge
  ///             commit would be needed
  ///   squash  → squash the branch into a single index entry; the
  ///             user still has to commit (we leave the squash staged)
  'repo:merge': (args: {
    repoId: UUID;
    branch: string;
    mode: 'merge' | 'ff-only' | 'squash';
  }) => { ok: boolean; error?: string };
  'repo:abortMerge': (repoId: UUID) => { ok: boolean; error?: string };
  /// `git rebase <onto>`. Starts the rebase; if conflicts arise the
  /// renderer surfaces them via the in-progress + conflicts fields on
  /// repo:status, and the user resolves + calls continueRebase.
  'repo:rebase': (args: { repoId: UUID; onto: string }) => { ok: boolean; error?: string };
  'repo:abortRebase': (repoId: UUID) => { ok: boolean; error?: string };
  'repo:continueRebase': (repoId: UUID) => { ok: boolean; error?: string };
  'repo:abortCherryPick': (repoId: UUID) => { ok: boolean; error?: string };
  'repo:continueCherryPick': (repoId: UUID) => { ok: boolean; error?: string };
  /// Mark conflicted paths as resolved by `git add`-ing them. Returns
  /// the still-conflicted set (if any) so the renderer can show
  /// progress as the user works through them.
  'repo:markResolved': (args: {
    repoId: UUID;
    paths: string[];
  }) => { ok: boolean; remaining: string[]; error?: string };
  /// Pull, with conflict-list reporting when local changes would be
  /// overwritten. Renderer routes the user to a recovery sheet when
  /// `conflicts` is populated.
  'repo:pull': (repoId: UUID) => { ok: boolean; error?: string; conflicts?: string[] };
  /// Recover from a blocked pull. `strategy: 'stash'` saves the
  /// listed paths to a named stash, then pulls. `'discard'` resets
  /// them to HEAD before pulling — destructive.
  'repo:pullForce': (args: {
    repoId: UUID;
    conflicts: string[];
    strategy: 'stash' | 'discard';
  }) => { ok: boolean; error?: string; stashed?: boolean };
  'repo:detectDefaultBranch': (repoId: UUID) => string | null;
  /// History of one file (`git log --follow`). `path` is repo-relative.
  /// Used by the in-app history sheet — the diff for any commit is
  /// available via the existing `repo:diff` call.
  'repo:fileLog': (args: { repoId: UUID; path: string; limit?: number }) => FileLogCommit[];
  /// `git blame --porcelain` for one file. `path` is repo-relative.
  /// Returns one BlameLine per line of the file at HEAD.
  'repo:fileBlame': (args: { repoId: UUID; path: string }) => BlameLine[];
  'repo:setDefaultBranch': (args: { repoId: UUID; branch: string | null }) => void;
  'repo:worktrees': (repoId: UUID) => Worktree[];
  /// Move a linked worktree's branch into the main checkout. Removes
  /// the worktree at `worktreePath` first (with `--force` if
  /// `forceRemove`), then `git switch <branch>` in the main repo. Step
  /// names tell the renderer how far we got so a partial failure is
  /// recoverable ("removed but couldn't switch — branch is dangling").
  'repo:adoptWorktreeBranch': (args: {
    repoId: UUID;
    worktreePath: string;
    branch: string;
    forceRemove: boolean;
    /// If set, run `git add -A && git commit -m <commitMessage>` inside
    /// the worktree before removing it. Lets the user keep work that's
    /// dirty in the linked checkout instead of having to discard it.
    commitMessage?: string;
  }) =>
    | { ok: true }
    | { ok: false; step: 'precheck' | 'commit' | 'remove' | 'checkout'; error: string };
  'repo:removeWorktree': (args: {
    repoId: UUID;
    worktreePath: string;
    force: boolean;
  }) => { ok: boolean; error?: string };
  'repo:pruneWorktrees': (repoId: UUID) => { ok: boolean; error?: string; output?: string };

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
  /// Stage and commit every dirty repo in the workspace with a shared
  /// message. Repos in detached-HEAD state are skipped (returned as
  /// `detached`) — committing onto a detached HEAD orphans the commit.
  /// Clean repos come back as `clean` so the result table is symmetric.
  'workspace:commitAll': (args: {
    workspaceId: UUID;
    message: string;
  }) => CommitAllOutcome[];
  /// Aggregate `git worktree list` across the workspace's repos so the
  /// renderer can show siblings per repo without N round-trips.
  'workspace:worktrees': (workspaceId: UUID) => { repoId: UUID; worktrees: Worktree[] }[];
  'repo:listTags': (repoId: UUID) => Tag[];
  /// Create a tag. `message` makes it annotated; omitting (or empty
  /// string) makes it lightweight. `ref` defaults to HEAD when null.
  'repo:createTag': (args: {
    repoId: UUID;
    name: string;
    ref: string | null;
    message: string | null;
  }) => { ok: boolean; error?: string };
  'repo:deleteTag': (args: { repoId: UUID; name: string }) => { ok: boolean; error?: string };
  /// Push a single tag to a remote (`git push <remote> <tag>`).
  'repo:pushTag': (args: {
    repoId: UUID;
    name: string;
    remote: string;
  }) => { ok: boolean; error?: string };

  'repo:listRemotes': (repoId: UUID) => Remote[];
  'repo:addRemote': (args: {
    repoId: UUID;
    name: string;
    url: string;
  }) => { ok: boolean; error?: string };
  'repo:removeRemote': (args: {
    repoId: UUID;
    name: string;
  }) => { ok: boolean; error?: string };
  'repo:setRemoteUrl': (args: {
    repoId: UUID;
    name: string;
    url: string;
    /// 'fetch' = `git remote set-url <name> <url>`,
    /// 'push'  = `git remote set-url --push <name> <url>`.
    kind: 'fetch' | 'push';
  }) => { ok: boolean; error?: string };

  'repo:listSubmodules': (repoId: UUID) => Submodule[];
  'repo:lfsStatus': (repoId: UUID) => LfsStatus;

  /// Aggregated "what happened recently" across the workspace. Walks
  /// `git log` on the current branch of each repo (capped per-repo and
  /// in total) and merges in the gh PR list. Returned items are sorted
  /// newest-first; the renderer marks any newer than `lastSeen` as new.
  'workspace:activity': (args: {
    workspaceId: UUID;
    /// Per-repo log limit (default 25). Total across the workspace is
    /// implicitly capped at members × this.
    perRepo?: number;
  }) => WorkspaceActivity[];

  /// `git push` every workspace repo whose branch is ahead of its
  /// upstream. Repos in detached HEAD are skipped. Repos with no
  /// upstream get `git push -u origin HEAD` so the first push wires up
  /// tracking — same as the single-repo Push button.
  'workspace:pushAll': (workspaceId: UUID) => WorkspacePushOutcome[];
  /// Open a GitHub PR on every workspace repo that's on a non-default
  /// branch with commits pushed to its upstream. `gh pr create` runs in
  /// each repo with the shared `title`/`body`/`draft`. Each repo's PR
  /// targets that repo's `defaultBranch` (per-repo override is not yet
  /// surfaced — keep it simple). Repos that already have an open PR for
  /// the current branch are returned as `already-open` so re-running
  /// the flow is idempotent.
  'workspace:openPRs': (args: {
    workspaceId: UUID;
    title: string;
    body: string;
    draft: boolean;
  }) => WorkspaceOpenPROutcome[];

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

  /// Run an LLM CLI review across every dirty on-branch repo in the
  /// workspace. Diffs are concatenated under `=== <repo name> ===`
  /// headers and capped at a byte budget; repos that overflow are
  /// replaced with their `git diff --stat HEAD` summary and listed in
  /// `truncated` so the renderer can warn the user.
  'workspace:reviewChanges': (args: {
    workspaceId: UUID;
    tool: LlmTool;
  }) => ReviewResult & { truncated: WorkspaceDiffTruncation[] };
  /// Same shape as `workspace:reviewChanges` but drafts a single shared
  /// commit message from the aggregated diff.
  'workspace:suggestCommitMessage': (args: {
    workspaceId: UUID;
    tool: LlmTool;
  }) =>
    | {
        ok: true;
        message: string;
        tool: LlmTool;
        truncated: WorkspaceDiffTruncation[];
      }
    | {
        ok: false;
        error: string;
        tool: LlmTool;
        truncated: WorkspaceDiffTruncation[];
      };
}

/// One repo whose working-tree diff exceeded the workspace-aggregate
/// byte cap and was replaced with a shortstat summary in the prompt
/// sent to the LLM.
export interface WorkspaceDiffTruncation {
  repoId: UUID;
  repoName: string;
  /// Original diff size in bytes before substitution.
  originalBytes: number;
}

/// One row in the workspace activity feed. We model commits and PR
/// events under one type so the renderer can sort them together by
/// `at` descending — the user thinks of "what happened recently" as
/// a single timeline, not two separate lists.
export type WorkspaceActivity =
  | {
      kind: 'commit';
      repoId: UUID;
      repoName: string;
      sha: string;
      shortSha: string;
      branch: string;
      subject: string;
      author: string;
      /// ISO 8601 author date — sortable lexicographically.
      at: string;
    }
  | {
      kind: 'pr';
      repoId: UUID;
      repoName: string;
      number: number;
      title: string;
      url: string;
      state: 'OPEN' | 'MERGED' | 'CLOSED';
      author: string;
      /// PR `updatedAt` from gh — covers both open events and state
      /// transitions in one timestamp.
      at: string;
    };

/// One git tag with its kind. Annotated tags carry a message; the UI
/// renders them with a small icon to distinguish them from lightweight
/// tags, which are just refs.
export interface Tag {
  name: string;
  /// 'lightweight' — just a ref pointing at a commit; 'annotated' —
  /// a tag object with a message and tagger metadata.
  kind: 'lightweight' | 'annotated';
  /// Sha of the commit the tag resolves to (peeled).
  sha: string;
  shortSha: string;
  /// First line of the tag message for annotated tags; empty for
  /// lightweight tags.
  subject: string;
  /// Tagger / author name for annotated; empty otherwise.
  tagger: string;
  /// ISO 8601 tag/author date.
  date: string;
}

/// One configured remote. We store URLs separately for fetch and push;
/// `git remote -v` emits both, and they often differ for repos using a
/// pull-from-upstream / push-to-fork setup.
export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/// One git submodule (parsed from `git submodule status`). Submodules
/// are an overlay-friendly thing to surface — overgit doesn't manage
/// them, just shows the user that they exist and what commit each is
/// pinned to. The `state` field encodes git's status prefix:
///   ' ' → up-to-date, '+' → checked-out commit ≠ pinned, '-' → not
///   initialized, 'U' → merge conflict in submodule.
export interface Submodule {
  path: string;
  sha: string;
  shortSha: string;
  /// `(<ref>)` suffix git emits — e.g. "v1.2.0" or
  /// "heads/main-1-gabcdef" — kept as-is so the renderer can show what
  /// commit description git knew.
  describe: string;
  state: 'up-to-date' | 'modified' | 'uninitialized' | 'conflict';
}

/// LFS presence summary. We deliberately don't enumerate every lfs ptr
/// in the repo — too expensive for a passive badge. The renderer just
/// shows "uses LFS" when `enabled` is true.
export interface LfsStatus {
  enabled: boolean;
  /// Number of distinct filter patterns in `.gitattributes` that route
  /// through `filter=lfs`. > 0 implies enabled.
  patternCount: number;
}

/// One commit in a file's history (`git log --follow -- <path>`).
/// Includes the path the file had at the commit, since `--follow`
/// surfaces renames; rendering "old/path → new/path" in the row makes
/// the rename history readable instead of pretending the file always
/// lived at one location.
export interface FileLogCommit {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  /// ISO 8601 author date.
  authorDate: string;
  subject: string;
  /// Path the file had at this commit. Same as the requested path for
  /// commits that didn't rename it; older path for commits before a
  /// rename was introduced (only set when --follow detected the move).
  pathAtCommit: string;
}

/// One contiguous line of `git blame --porcelain` output, attributed
/// to its originating commit. We render the gutter as `<shortSha>
/// <author>` and the content alongside.
export interface BlameLine {
  /// 1-based line number in the file at HEAD.
  lineNumber: number;
  content: string;
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  /// ISO 8601 author date.
  authorDate: string;
  summary: string;
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
