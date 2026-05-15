import { useCallback, useEffect } from 'react';
import { useStore } from './store';
import { FileTree } from './FileTree';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import type { UUID } from '@shared/types';

/// Files tab body — left pane is the repo's file tree, right pane is the
/// open file's contents in a syntax-highlighted editor. Cmd/Ctrl+S saves.
export function FileEditor({ repoId }: { repoId: UUID }): JSX.Element {
  const openFile = useStore((s) => s.openFile);
  const sameRepo = openFile?.repoId === repoId;

  return (
    <div className="grid grid-cols-[280px_1fr] h-full min-h-0 overflow-hidden">
      <aside className="border-r border-card overflow-hidden">
        <FileTree repoId={repoId} />
      </aside>
      <section className="overflow-hidden flex flex-col min-h-0">
        {sameRepo && openFile ? (
          <EditorBody />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-ink-faint">
            Pick a file on the left to open it.
          </div>
        )}
      </section>
    </div>
  );
}

function EditorBody(): JSX.Element {
  const file = useStore((s) => s.openFile)!;
  const content = useStore((s) => s.openFileContent);
  const dirty = useStore((s) => s.openFileDirty);
  const error = useStore((s) => s.openFileError);
  const loading = useStore((s) => s.openFileLoading);
  const setContent = useStore((s) => s.setOpenFileContent);
  const closeFile = useStore((s) => s.closeRepoFile);
  const save = useStore((s) => s.saveOpenFile);
  const pushToast = useStore((s) => s.pushToast);
  const setSheet = useStore((s) => s.setSheet);
  const repoPath = useStore(
    (s) => s.repos.find((r) => r.id === file.repoId)?.path,
  );

  // `file.path` is absolute (resolved by fs:readFile). The history /
  // blame backend wants a repo-relative path. Strip the repo root with
  // a separator-aware test so Windows backslashes survive.
  const relPath =
    repoPath && file.path.startsWith(repoPath)
      ? file.path.slice(repoPath.length).replace(/^[/\\]/, '')
      : file.path;

  const openHistory = (tab: 'history' | 'blame') => {
    setSheet({ kind: 'fileHistory', repoId: file.repoId, path: relPath, tab });
  };

  const onSave = useCallback(async () => {
    const res = await save();
    if (!res.ok) pushToast({ kind: 'error', message: res.error ?? 'Save failed' });
  }, [save, pushToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        void onSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSave]);

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-card">
        <span className="text-xs text-ink-muted truncate flex-1 font-mono">
          {file.path}
          {dirty && <span className="text-amber-400"> · modified</span>}
        </span>
        <button
          onClick={() => openHistory('history')}
          className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card"
          title="Show this file's commit history"
        >
          History
        </button>
        <button
          onClick={() => openHistory('blame')}
          className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card"
          title="Show line-by-line blame"
        >
          Blame
        </button>
        {dirty && (
          <button
            onClick={onSave}
            title="Save (⌘S)"
            className="text-xs px-2.5 py-1 rounded bg-accent text-white hover:bg-accent-strong"
          >
            Save
          </button>
        )}
        <button
          onClick={closeFile}
          className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card"
          aria-label="Close file"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <div className="p-4 text-xs text-ink-faint">Loading…</div>
        ) : error ? (
          <div className="p-4 text-xs text-red-300">{error}</div>
        ) : (
          <CodeMirrorEditor
            content={content}
            onChange={setContent}
            language={detectLanguage(file.path)}
          />
        )}
      </div>
    </>
  );
}

/// Extension → CodeMirror language id. Mirrors the map in
/// CodeMirrorEditor.tsx; anything not in the map falls through to "no
/// language" (still rendered, just not colored).
const LANGUAGE_BY_EXT: Record<string, string> = {
  // JS / TS family
  ts: 'typescript', tsx: 'typescript', cts: 'typescript', mts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  // Systems
  rs: 'rust', go: 'go', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', hh: 'cpp',
  cs: 'csharp',
  swift: 'swift', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  java: 'java', groovy: 'groovy',
  // Scripting
  py: 'python', rb: 'ruby', php: 'php', pl: 'perl', lua: 'lua',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  ps1: 'powershell', psm1: 'powershell',
  // Config / data
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  properties: 'ini', conf: 'ini', cfg: 'ini',
  xml: 'xml', svg: 'xml', plist: 'xml',
  env: 'ini',
  // Web
  html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  vue: 'vue', svelte: 'vue',
  // Docs
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  // DB / data query
  sql: 'sql',
  // Build / infra
  dockerfile: 'dockerfile',
  makefile: 'makefile', mk: 'makefile', cmake: 'cmake',
  // Misc
  r: 'r', erl: 'erlang',
  hs: 'haskell', clj: 'clojure', cljs: 'clojure',
  proto: 'protobuf',
};

function detectLanguage(p: string): string | null {
  const name = p.split(/[/\\]/).pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  if (name === 'cmakelists.txt') return 'cmake';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return LANGUAGE_BY_EXT[ext] ?? null;
}
