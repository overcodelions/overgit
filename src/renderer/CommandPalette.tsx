import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from 'react';
import { useStore } from './store';
import type { BranchSummary, Repo, UUID, Workspace } from '@shared/types';

// See App.tsx — stable empty fallback for Zustand selectors so React's
// useSyncExternalStore snapshot equality holds across renders.
const EMPTY_BRANCHES: BranchSummary[] = [];
const EMPTY_FILES: string[] = [];

/// Cmd+K command palette. One overlay, one search box, one list. The
/// list is built by concatenating heterogenous sections (Actions,
/// Branches in the open repo, Repos, Workspaces) and filtering against
/// the typed query. Selecting an item runs its `perform` callback.
///
/// Branches in the palette are scoped to the currently-open repo —
/// across-all-repos branch search would explode the list and is rarely
/// what the user means by "switch branch." The first action is always
/// "Create branch in <current repo>" when a repo is open, so the user
/// can type a brand-new name and hit Enter to create it without
/// leaving the keyboard.
export function CommandPalette(): JSX.Element | null {
  const open = useStore((s) => s.paletteOpen);
  const close = useStore((s) => s.togglePalette);

  const repos = useStore((s) => s.repos);
  const workspaces = useStore((s) => s.workspaces);
  const selectedRepoId = useStore((s) => s.selectedRepoId);
  const selectedWsId = useStore((s) => s.selectedWorkspaceId);
  const branchSummaries = useStore((s) =>
    selectedRepoId
      ? s.repoBranchSummaries[selectedRepoId] ?? EMPTY_BRANCHES
      : EMPTY_BRANCHES,
  );
  const fileList = useStore((s) =>
    selectedRepoId ? s.repoFileList[selectedRepoId] ?? EMPTY_FILES : EMPTY_FILES,
  );
  const changes = useStore((s) =>
    selectedRepoId ? s.repoChanges[selectedRepoId] : undefined,
  );
  // Memoize the path arrays so the buildSections useMemo doesn't see a
  // fresh reference every render — `changes.staged` is a new array each
  // tick of the underlying state shape.
  const stagedPaths = useMemo(
    () => changes?.staged.map((f) => f.path) ?? [],
    [changes?.staged],
  );
  const unstagedPaths = useMemo(
    () => changes?.unstaged.map((f) => f.path) ?? [],
    [changes?.unstaged],
  );
  const cli = useStore((s) => s.cliPresence);
  const refreshSummaries = useStore((s) => s.refreshRepoBranchSummaries);
  const refreshFileList = useStore((s) => s.refreshRepoFileList);
  const refreshChanges = useStore((s) => s.refreshRepoChanges);
  const selectRepo = useStore((s) => s.selectRepo);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const checkoutRepo = useStore((s) => s.checkoutRepo);
  const createBranch = useStore((s) => s.createRepoBranch);
  const setSheet = useStore((s) => s.setSheet);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const stageFiles = useStore((s) => s.stageFiles);
  const unstageFiles = useStore((s) => s.unstageFiles);
  const fetchRepo = useStore((s) => s.fetchRepo);
  const pullRepo = useStore((s) => s.pullRepo);
  const pushRepo = useStore((s) => s.pushRepo);
  const openRepoFile = useStore((s) => s.openRepoFile);

  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const activeIdxRef = useRef(activeIdx);
  const busyRef = useRef(busy);
  const flatRef = useRef<PaletteItem[]>([]);

  // Reset query and ensure derived data is fresh whenever the palette
  // opens. The branch / file / changes caches may be cold for a repo
  // that hasn't been visited via its detail view yet — without this
  // refresh the palette would silently show empty sections.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIdx(0);
    // Defer focus past the commit so the input is attached before we
    // steal focus. Some Electron renderers otherwise leave keystrokes on
    // whatever was focused before the palette opened.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    if (selectedRepoId) {
      refreshSummaries(selectedRepoId);
      refreshFileList(selectedRepoId);
      refreshChanges(selectedRepoId);
    }
    return () => cancelAnimationFrame(id);
  }, [open, selectedRepoId, refreshSummaries, refreshFileList, refreshChanges]);

  const sections = useMemo(
    () =>
      buildSections({
        query,
        repos,
        workspaces,
        branches: branchSummaries,
        files: fileList,
        stagedPaths,
        unstagedPaths,
        cli,
        selectedRepoId,
        selectedWsId,
        actions: {
          close: () => close(false),
          selectRepo,
          selectWorkspace,
          checkoutRepo,
          createBranch,
          setSheet,
          toggleSidebar,
          stageFiles,
          unstageFiles,
          fetchRepo,
          pullRepo,
          pushRepo,
          openRepoFile,
        },
      }),
    [
      query,
      repos,
      workspaces,
      branchSummaries,
      fileList,
      stagedPaths,
      unstagedPaths,
      cli,
      selectedRepoId,
      selectedWsId,
      close,
      selectRepo,
      selectWorkspace,
      checkoutRepo,
      createBranch,
      setSheet,
      toggleSidebar,
      stageFiles,
      unstageFiles,
      fetchRepo,
      pullRepo,
      pushRepo,
      openRepoFile,
    ],
  );

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => {
    activeIdxRef.current = activeIdx;
  }, [activeIdx]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    flatRef.current = flat;
  }, [flat]);

  // Keep the keyboard cursor inside the visible list as it shrinks.
  useEffect(() => {
    if (activeIdx >= flat.length) setActiveIdx(Math.max(0, flat.length - 1));
  }, [flat.length, activeIdx]);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const handlePaletteKey = useCallback(
    (e: KeyboardEvent | ReactKeyboardEvent) => {
      const key = keyName(e);
      if (key === 'Escape') {
        stopKeyboardEvent(e);
        close(false);
        return;
      }
      if (key === 'ArrowDown') {
        stopKeyboardEvent(e);
        setActiveIdx((i) => Math.min(Math.max(0, flatRef.current.length - 1), i + 1));
        return;
      }
      if (key === 'ArrowUp') {
        stopKeyboardEvent(e);
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key === 'Enter') {
        stopKeyboardEvent(e);
        const item = flatRef.current[activeIdxRef.current];
        if (!item || busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        void Promise.resolve(item.perform()).finally(() => {
          busyRef.current = false;
          setBusy(false);
        });
      }
    },
    [close],
  );

  // Handle palette navigation before app-wide shortcuts and before the
  // input's default cursor handling. Electron can leave focus outside
  // the modal for a frame, so we listen on both global capture targets
  // and keep a React capture handler on the palette as a local fallback.
  useLayoutEffect(() => {
    if (!open) return;
    window.addEventListener('keydown', handlePaletteKey, true);
    document.addEventListener('keydown', handlePaletteKey, true);
    return () => {
      window.removeEventListener('keydown', handlePaletteKey, true);
      document.removeEventListener('keydown', handlePaletteKey, true);
    };
  }, [open, handlePaletteKey]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-black/40 backdrop-blur-sm"
      onKeyDownCapture={handlePaletteKey}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(false);
      }}
    >
      <div className="w-[600px] max-w-[92vw] max-h-[70vh] bg-surface-elevated border border-card rounded-lg shadow-2xl overflow-hidden flex flex-col">
        <div className="p-2 border-b border-card flex items-center gap-2">
          <span className="text-[10px] font-mono text-ink-faint pl-1">⌘K</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            disabled={busy}
            placeholder={
              selectedRepoId
                ? 'Switch branch · run command · jump to repo / workspace'
                : 'Jump to repo / workspace · run command'
            }
            className="field flex-1 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {flat.length === 0 ? (
            <div className="px-4 py-6 text-xs text-ink-faint text-center">
              No matches.
            </div>
          ) : (
            sections.map((s) => (
              <div key={s.label}>
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-ink-faint">
                  {s.label}
                </div>
                {s.items.map((it) => {
                  const idx = flat.indexOf(it);
                  return (
                    <PaletteRow
                      key={it.id}
                      item={it}
                      active={idx === activeIdx}
                      busy={busy}
                      buttonRef={idx === activeIdx ? activeRowRef : undefined}
                      onClick={async () => {
                        setActiveIdx(idx);
                        setBusy(true);
                        try {
                          await it.perform();
                        } finally {
                          setBusy(false);
                        }
                      }}
                      onHover={() => setActiveIdx(idx)}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="border-t border-card px-3 py-1.5 text-[10px] text-ink-faint flex justify-between">
          <span>↑↓ to move · Enter to run · Esc to close</span>
          {busy && <span className="text-ink-muted">Working…</span>}
        </div>
      </div>
    </div>
  );
}

interface PaletteItem {
  id: string;
  title: string;
  hint?: string;
  glyph?: string;
  perform: () => void | Promise<void>;
}

interface PaletteSection {
  label: string;
  items: PaletteItem[];
}

function PaletteRow({
  item,
  active,
  busy,
  onClick,
  onHover,
  buttonRef,
}: {
  item: PaletteItem;
  active: boolean;
  busy: boolean;
  onClick: () => void;
  onHover: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}): JSX.Element {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      onMouseEnter={onHover}
      disabled={busy}
      aria-selected={active}
      className={`w-full text-left flex items-center gap-2 px-3 py-2 text-sm border-l-2 ${
        active
          ? 'bg-accent/15 border-accent text-ink'
          : 'border-transparent text-ink-muted'
      } disabled:opacity-50`}
    >
      {item.glyph && <span className="text-ink-faint w-4 text-center">{item.glyph}</span>}
      <span className="truncate flex-1">{item.title}</span>
      {item.hint && (
        <span className="text-[11px] text-ink-faint truncate max-w-[200px]">{item.hint}</span>
      )}
    </button>
  );
}

function keyName(e: KeyboardEvent | ReactKeyboardEvent): string {
  if (e.key === 'Down') return 'ArrowDown';
  if (e.key === 'Up') return 'ArrowUp';
  if (e.key === 'Esc') return 'Escape';
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Escape' || e.key === 'Enter') {
    return e.key;
  }
  // Both DOM KeyboardEvent and React's synthetic event have `.code`, so
  // the union always exposes it — no need to dig through nativeEvent.
  const code = e.code;
  if (code === 'ArrowDown' || code === 'ArrowUp' || code === 'Escape' || code === 'Enter') {
    return code;
  }
  return e.key;
}

function stopKeyboardEvent(e: KeyboardEvent | ReactKeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
  if ('stopImmediatePropagation' in e) {
    e.stopImmediatePropagation();
  } else {
    e.nativeEvent.stopImmediatePropagation();
  }
}

interface BuildArgs {
  query: string;
  repos: Repo[];
  workspaces: Workspace[];
  branches: BranchSummary[];
  files: string[];
  stagedPaths: string[];
  unstagedPaths: string[];
  cli: { claude?: boolean; codex?: boolean; gemini?: boolean } | null;
  selectedRepoId: UUID | null;
  selectedWsId: UUID | null;
  actions: {
    close: () => void;
    selectRepo: (id: UUID | null) => void;
    selectWorkspace: (id: UUID | null) => void;
    checkoutRepo: (
      id: UUID,
      branch: string,
      createIfMissing: boolean,
    ) => Promise<{ result: string; message?: string }>;
    createBranch: (id: UUID, name: string, switchTo: boolean) => Promise<{ ok: boolean; error?: string }>;
    setSheet: (s: any) => void;
    toggleSidebar: () => void;
    stageFiles: (id: UUID, paths: string[]) => Promise<unknown>;
    unstageFiles: (id: UUID, paths: string[]) => Promise<unknown>;
    fetchRepo: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
    pullRepo: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
    pushRepo: (id: UUID) => Promise<{ ok: boolean; error?: string }>;
    openRepoFile: (id: UUID, path: string) => Promise<unknown>;
  };
}

function buildSections(args: BuildArgs): PaletteSection[] {
  const {
    query,
    repos,
    workspaces,
    branches,
    files,
    stagedPaths,
    unstagedPaths,
    cli,
    selectedRepoId,
    selectedWsId,
    actions,
  } = args;
  const stagedCount = stagedPaths.length;
  const unstagedCount = unstagedPaths.length;
  const q = query.trim().toLowerCase();
  const matches = (s: string) => !q || s.toLowerCase().includes(q);
  const sections: PaletteSection[] = [];

  // Repo-specific actions take the top slot when a repo is open; users
  // are far more likely to want "Stage all" or "Push" than "Toggle
  // sidebar" while focused on a repo. Each item is filtered by the
  // search string so a query that doesn't match the title hides it.
  const repoForCreate = selectedRepoId
    ? repos.find((r) => r.id === selectedRepoId) ?? null
    : null;
  const repoActionItems: PaletteItem[] = [];
  if (selectedRepoId && q) {
    repoActionItems.push({
      id: `create-branch:${q}`,
      title: `Create branch "${query.trim()}" in ${repoForCreate?.name ?? 'current repo'}`,
      glyph: '+',
      perform: async () => {
        const res = await actions.createBranch(selectedRepoId, query.trim(), true);
        if (!res.ok) alert(res.error ?? 'Create failed');
        actions.close();
      },
    });
  }
  if (selectedRepoId) {
    const anyLlm = !!(cli?.claude || cli?.codex || cli?.gemini);
    const id = selectedRepoId;
    const candidates: PaletteItem[] = [
      {
        id: 'stage-all',
        title: `Stage all changes${unstagedCount ? ` (${unstagedCount})` : ''}`,
        hint: unstagedCount === 0 ? 'nothing to stage' : 'git add -A',
        glyph: '+',
        perform: async () => {
          if (unstagedCount === 0) return actions.close();
          await actions.stageFiles(id, unstagedPaths);
          actions.close();
        },
      },
      {
        id: 'unstage-all',
        title: `Unstage all${stagedCount ? ` (${stagedCount})` : ''}`,
        hint: stagedCount === 0 ? 'nothing staged' : 'git restore --staged',
        glyph: '−',
        perform: async () => {
          if (stagedCount === 0) return actions.close();
          await actions.unstageFiles(id, stagedPaths);
          actions.close();
        },
      },
      {
        id: 'fetch',
        title: 'Fetch from origin',
        hint: 'git fetch --all --prune',
        glyph: '↻',
        perform: async () => {
          const res = await actions.fetchRepo(id);
          if (!res.ok) alert(res.error ?? 'Fetch failed');
          actions.close();
        },
      },
      {
        id: 'pull',
        title: 'Pull latest',
        hint: 'git pull',
        glyph: '↓',
        perform: async () => {
          const res = await actions.pullRepo(id);
          if (!res.ok) alert(res.error ?? 'Pull failed');
          actions.close();
        },
      },
      {
        id: 'push',
        title: 'Push to origin',
        hint: 'git push',
        glyph: '↑',
        perform: async () => {
          const res = await actions.pushRepo(id);
          if (!res.ok) alert(res.error ?? 'Push failed');
          actions.close();
        },
      },
    ];
    if (anyLlm) {
      candidates.push(
        {
          id: 'ai-review',
          title: 'Review changes with AI',
          hint: stagedCount > 0 ? `Staged (${stagedCount})` : `Working tree (${unstagedCount})`,
          glyph: '✨',
          perform: () => {
            actions.setSheet({
              kind: 'reviewChanges',
              repoId: id,
              scope: stagedCount > 0 ? 'staged' : 'working',
            });
            actions.close();
          },
        },
        {
          id: 'suggest-msg',
          title: 'Stage all & suggest commit message',
          hint: 'AI drafts a commit message from staged diff',
          glyph: '✨',
          perform: async () => {
            // Stage everything if nothing is staged yet — that's the
            // "click once and let me commit" flow the user asked for.
            // We don't auto-commit; the user reviews the message in the
            // Changes tab and hits Commit themselves.
            if (stagedCount === 0 && unstagedCount > 0) {
              await actions.stageFiles(id, unstagedPaths);
            }
            // The Suggest button on the Changes tab does the actual
            // call; we just navigate there with a hint.
            window.dispatchEvent(new CustomEvent('overgit:setRepoTab', { detail: 'changes' }));
            window.dispatchEvent(new CustomEvent('overgit:suggestCommitMessage'));
            actions.close();
          },
        },
      );
    }
    for (const a of candidates) {
      if (matches(a.title) || (a.hint && matches(a.hint))) repoActionItems.push(a);
    }
  }
  if (selectedWsId && q) {
    repoActionItems.push({
      id: `create-branch-ws:${q}`,
      title: `Create branch "${query.trim()}" across workspace`,
      glyph: '⎇',
      perform: () => {
        actions.setSheet({ kind: 'newBranchInWorkspace', workspaceId: selectedWsId });
        actions.close();
      },
    });
  }
  if (selectedWsId) {
    const commitAllWs: PaletteItem = {
      id: 'commit-all-ws',
      title: 'Commit all across workspace',
      hint: 'Shared message · skips detached HEAD',
      glyph: '✓',
      perform: () => {
        actions.setSheet({ kind: 'commitAllInWorkspace', workspaceId: selectedWsId });
        actions.close();
      },
    };
    if (matches(commitAllWs.title) || (commitAllWs.hint && matches(commitAllWs.hint))) {
      repoActionItems.push(commitAllWs);
    }
  }
  if (repoActionItems.length)
    sections.push({ label: selectedRepoId ? 'Repo actions' : 'Actions', items: repoActionItems });

  // App-wide builtins below repo actions so muscle memory keeps them
  // accessible without crowding the top.
  const builtinItems: PaletteItem[] = [];
  const builtins: PaletteItem[] = [
    {
      id: 'open-settings',
      title: 'Settings…',
      hint: '⌘ ,',
      glyph: '⚙',
      perform: () => {
        actions.setSheet({ kind: 'settings' });
        actions.close();
      },
    },
    {
      id: 'new-workspace',
      title: 'New workspace…',
      glyph: '+',
      perform: () => {
        actions.setSheet({ kind: 'newWorkspace' });
        actions.close();
      },
    },
    {
      id: 'toggle-sidebar',
      title: 'Toggle sidebar',
      hint: '⌘ \\',
      glyph: '◧',
      perform: () => {
        actions.toggleSidebar();
        actions.close();
      },
    },
  ];
  for (const a of builtins) if (matches(a.title)) builtinItems.push(a);
  if (builtinItems.length) sections.push({ label: 'App', items: builtinItems });

  // Files in the open repo. The full list can be 10k+ entries, so we
  // only render this section when the user has typed at least 2 chars —
  // otherwise the palette would dump the whole tree above branches and
  // commands. Match against the basename and the path.
  if (selectedRepoId && q.length >= 2 && files.length > 0) {
    const repoPath = repos.find((r) => r.id === selectedRepoId)?.path ?? '';
    const fileItems: PaletteItem[] = [];
    for (const full of files) {
      const rel = repoPath && full.startsWith(repoPath + '/')
        ? full.slice(repoPath.length + 1)
        : full;
      if (!matches(rel)) continue;
      fileItems.push({
        id: `file:${full}`,
        title: rel.split('/').pop() ?? rel,
        hint: rel,
        glyph: '📄',
        perform: () => {
          // Switch to Files tab and open this file. Listening on
          // window matches the Cmd+1..4 wiring in App.tsx.
          window.dispatchEvent(
            new CustomEvent('overgit:setRepoTab', { detail: 'files' }),
          );
          void actions.openRepoFile(selectedRepoId, full);
          actions.close();
        },
      });
      if (fileItems.length >= 30) break;
    }
    if (fileItems.length) sections.push({ label: 'Files', items: fileItems });
  }

  // Branches in the open repo. Only render when a repo is open AND
  // there's something matching — across-repos branch search is left
  // for the per-repo BranchPicker.
  if (selectedRepoId && branches.length > 0) {
    const branchItems: PaletteItem[] = [];
    for (const b of branches) {
      if (b.isCurrent) continue;
      const display = b.kind === 'remote' ? b.name : b.shortName;
      if (!matches(display) && !matches(b.subject)) continue;
      branchItems.push({
        id: `branch:${b.kind}:${b.name}`,
        title: `Switch to ${display}`,
        hint: b.subject,
        glyph: b.kind === 'remote' ? '↘' : '⎇',
        perform: async () => {
          const target = b.kind === 'remote' ? b.shortName : b.name;
          const out = await actions.checkoutRepo(selectedRepoId, target, false);
          if (out.result === 'dirty') {
            alert(
              `Can't switch to ${target}: working tree is dirty. Stash or commit first.`,
            );
          } else if (out.result === 'error' || out.result === 'missing-branch') {
            alert(out.message ?? 'Checkout failed');
          }
          actions.close();
        },
      });
      if (branchItems.length >= 50) break;
    }
    if (branchItems.length) sections.push({ label: 'Branches', items: branchItems });
  }

  // Repos to jump to.
  const repoItems: PaletteItem[] = repos
    .filter((r) => r.id !== selectedRepoId && (matches(r.name) || matches(r.path)))
    .slice(0, 30)
    .map((r) => ({
      id: `repo:${r.id}`,
      title: r.name,
      hint: r.path,
      glyph: '📁',
      perform: () => {
        actions.selectRepo(r.id);
        actions.close();
      },
    }));
  if (repoItems.length) sections.push({ label: 'Repos', items: repoItems });

  // Workspaces to jump to.
  const wsItems: PaletteItem[] = workspaces
    .filter((w) => w.id !== selectedWsId && matches(w.name))
    .slice(0, 30)
    .map((w) => ({
      id: `ws:${w.id}`,
      title: w.name,
      hint: `${w.repoIds.length} ${w.repoIds.length === 1 ? 'repo' : 'repos'}`,
      glyph: '⎘',
      perform: () => {
        actions.selectWorkspace(w.id);
        actions.close();
      },
    }));
  if (wsItems.length) sections.push({ label: 'Workspaces', items: wsItems });

  return sections;
}
