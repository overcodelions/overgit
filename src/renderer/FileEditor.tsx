import { useCallback, useEffect } from 'react';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';
import { useStore } from './store';
import { FileTree } from './FileTree';
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
      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="p-4 text-xs text-ink-faint">Loading…</div>
        ) : error ? (
          <div className="p-4 text-xs text-red-300">{error}</div>
        ) : (
          <Editor
            content={content}
            onChange={setContent}
            language={detectLanguage(file.path)}
          />
        )}
      </div>
    </>
  );
}

/// Two-layer editor: a textarea takes input on top, a syntax-highlighted
/// `<pre>` mirrors the same text underneath. Caret renders from the
/// textarea while colors render from the pre. Same trick overcli uses.
function Editor({
  content,
  onChange,
  language,
}: {
  content: string;
  onChange: (v: string) => void;
  language: string | null;
}): JSX.Element {
  const lines = content.split('\n');
  return (
    <div className="flex text-[12px] font-mono">
      <div className="select-none text-right pr-2 pt-2 text-ink-faint sticky left-0 bg-surface-muted min-w-[3.5em]">
        {lines.map((_, i) => (
          <div key={i + 1}>{i + 1}</div>
        ))}
      </div>
      <div className="flex-1 relative">
        <pre
          aria-hidden
          className="absolute inset-0 pt-2 px-2 m-0 pointer-events-none whitespace-pre overflow-visible"
          dangerouslySetInnerHTML={{ __html: highlight(content, language) }}
        />
        <textarea
          value={content}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className="relative w-full min-h-full bg-transparent text-transparent caret-ink pt-2 px-2 select-text outline-none whitespace-pre resize-none"
          style={{ minHeight: `${Math.max(lines.length, 8) * 1.5}em` }}
        />
      </div>
    </div>
  );
}

function highlight(content: string, language: string | null): string {
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(content, { language, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(content).value;
  } catch {
    return escapeHtml(content);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;',
  );
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  rs: 'rust', go: 'go',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  py: 'python', rb: 'ruby', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini',
  xml: 'xml', html: 'xml', svg: 'xml',
  css: 'css', scss: 'scss',
  md: 'markdown', mdx: 'markdown',
  sql: 'sql', graphql: 'graphql',
  swift: 'swift', kt: 'kotlin',
  java: 'java',
  // hljs/lib/common bundles a curated subset; missing types fall through
  // to highlightAuto, which still picks something reasonable.
};

function detectLanguage(p: string): string | null {
  const name = p.split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'dockerfile';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return LANGUAGE_BY_EXT[ext] ?? null;
}
