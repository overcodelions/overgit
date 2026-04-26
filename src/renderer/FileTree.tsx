import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import type { UUID } from '@shared/types';

interface Node {
  name: string;
  fullPath: string;
  /// Stable key for the expanded set — relative to root so it survives
  /// a reindex of `files`.
  key: string;
  isDir: boolean;
  children: Node[];
}

/// Lazily-loaded file tree rooted at a repo's working directory. Walks
/// the path list returned by `fs:listFiles` and renders an expandable
/// tree. Clicking a leaf opens the editor.
export function FileTree({ repoId }: { repoId: UUID }): JSX.Element {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId));
  const files = useStore((s) => s.repoFileList[repoId] ?? null);
  const refresh = useStore((s) => s.refreshRepoFileList);
  const openFilePath = useStore((s) => s.openFile?.path ?? null);
  const openFile = useStore((s) => s.openRepoFile);

  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));

  useEffect(() => {
    if (files == null) refresh(repoId);
  }, [files, refresh, repoId]);

  const tree = useMemo(
    () => buildTree(files ?? [], repo?.path ?? '', filter.trim().toLowerCase()),
    [files, repo?.path, filter],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-card">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files"
          className="field flex-1 px-2 py-1 text-xs"
        />
        <button
          onClick={() => refresh(repoId)}
          className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card"
          title="Reindex"
        >
          ↻
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {files == null ? (
          <div className="text-xs text-ink-faint px-3 py-2">Indexing…</div>
        ) : tree.children.length === 0 ? (
          <div className="text-xs text-ink-faint px-3 py-2">
            No files match{filter ? ` "${filter}"` : ''}.
          </div>
        ) : (
          tree.children.map((node) => (
            <TreeRow
              key={node.fullPath}
              node={node}
              depth={0}
              expanded={expanded}
              toggle={(k) =>
                setExpanded((cur) => {
                  const next = new Set(cur);
                  if (next.has(k)) next.delete(k);
                  else next.add(k);
                  return next;
                })
              }
              selectedPath={openFilePath}
              onPick={(p) => openFile(repoId, p)}
              forceOpen={filter.length > 0}
            />
          ))
        )}
      </div>
    </div>
  );
}

function buildTree(files: string[], root: string, filter: string): Node {
  const sep = root.includes('\\') ? '\\' : '/';
  const rootTrim = root.endsWith(sep) ? root.slice(0, -1) : root;
  const rootNode: Node = { name: '', fullPath: rootTrim, key: '', isDir: true, children: [] };
  for (const full of files) {
    const rel = full.startsWith(rootTrim + sep) ? full.slice(rootTrim.length + sep.length) : full;
    if (filter && !rel.toLowerCase().includes(filter)) continue;
    const parts = rel.split(sep);
    let cursor = rootNode;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      let child = cursor.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          fullPath: [cursor.fullPath, part].join(sep),
          key: parts.slice(0, i + 1).join('/'),
          isDir: !isLeaf,
          children: [],
        };
        cursor.children.push(child);
      }
      cursor = child;
    }
  }
  sortInPlace(rootNode);
  return rootNode;
}

function sortInPlace(node: Node): void {
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of node.children) sortInPlace(c);
}

function TreeRow({
  node,
  depth,
  expanded,
  toggle,
  selectedPath,
  onPick,
  forceOpen,
}: {
  node: Node;
  depth: number;
  expanded: Set<string>;
  toggle: (key: string) => void;
  selectedPath: string | null;
  onPick: (p: string) => void;
  forceOpen: boolean;
}): JSX.Element {
  const isOpen = forceOpen || expanded.has(node.key);
  const selected = selectedPath === node.fullPath;
  if (!node.isDir) {
    return (
      <button
        onClick={() => onPick(node.fullPath)}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={`w-full text-left flex items-center gap-1.5 py-0.5 rounded text-xs truncate ${
          selected ? 'bg-accent/20 text-ink' : 'text-ink-muted hover:bg-card hover:text-ink'
        }`}
        title={node.fullPath}
      >
        <FileGlyph />
        <span className="truncate">{node.name}</span>
      </button>
    );
  }
  return (
    <div>
      <button
        onClick={() => toggle(node.key)}
        style={{ paddingLeft: 8 + depth * 12 }}
        className="w-full text-left flex items-center gap-1.5 py-0.5 rounded text-xs text-ink-muted hover:bg-card hover:text-ink"
      >
        <span
          className={`text-[9px] text-ink-faint flex-shrink-0 transition-transform ${
            isOpen ? 'rotate-90' : ''
          }`}
        >
          ▸
        </span>
        <FolderGlyph />
        <span className="truncate">{node.name}</span>
      </button>
      {isOpen &&
        node.children.map((c) => (
          <TreeRow
            key={c.fullPath}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            toggle={toggle}
            selectedPath={selectedPath}
            onPick={onPick}
            forceOpen={forceOpen}
          />
        ))}
    </div>
  );
}

function FolderGlyph(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <path
        d="M1.5 4.5A1 1 0 012.5 3.5h3.2l1.1 1.3h5.7A1 1 0 0113.5 5.8v5.9A1 1 0 0112.5 12.7h-10A1 1 0 011.5 11.7V4.5z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function FileGlyph(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <path
        d="M3 2.5h6l3 3v8A1 1 0 0111 14.5H3A1 1 0 012 13.5V3.5A1 1 0 013 2.5z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M9 2.5V5.5H12" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
