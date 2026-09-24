// Every keyboard shortcut overgit has, in one list. The Shortcuts sheet,
// Settings → Shortcuts and the About sheet all render from here, so a new
// binding in `useGlobalShortcuts` only has to be described once.
//
// `Mod` is ⌘ on macOS and Ctrl elsewhere.

export interface Shortcut {
  keys: string[];
  label: string;
  /// Shown on the About sheet's short list.
  essential?: boolean;
}

export interface ShortcutGroup {
  title: string;
  note?: string;
  items: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Anywhere',
    items: [
      { keys: ['Mod', 'K'], label: 'Command palette: branches, repos, files, actions, help', essential: true },
      { keys: ['Mod', 'O'], label: 'Add repositories' },
      { keys: ['Mod', ','], label: 'Settings', essential: true },
      { keys: ['Mod', '\\'], label: 'Show or hide the sidebar', essential: true },
      { keys: ['Mod', 'R'], label: 'Refresh the repo or workset you’re looking at', essential: true },
      { keys: ['Mod', '/'], label: 'This list (or ? outside a text field)' },
    ],
  },
  {
    title: 'In a repo',
    items: [
      { keys: ['Mod', 'B'], label: 'Branch picker', essential: true },
      { keys: ['Mod', 'N'], label: 'New branch', essential: true },
      { keys: ['Mod', '⏎'], label: 'Commit', essential: true },
      { keys: ['Mod', 'P'], label: 'Push', essential: true },
      { keys: ['Mod', 'F'], label: 'Fetch', essential: true },
      { keys: ['Mod', '1–5'], label: 'Changes · History · Files · Stash · Branches', essential: true },
      { keys: ['Mod', 'S'], label: 'Save the file open in the editor' },
    ],
  },
  {
    title: 'In a workset',
    items: [{ keys: ['Mod', 'N'], label: 'New branch across every repo in the workset' }],
  },
  {
    title: 'Sidebar and pickers',
    note: 'Letter shortcuts are ignored while you type in a field, so they never eat a keystroke. ⌘K and the tab numbers always work.',
    items: [
      { keys: ['/'], label: 'Search the sidebar (while it has focus)' },
      { keys: ['↑', '↓'], label: 'Move through a list' },
      { keys: ['⏎'], label: 'Open the highlighted item' },
      { keys: ['Esc'], label: 'Close a sheet, picker or the palette' },
    ],
  },
];

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
}

export function keyLabel(key: string, mac = isMacPlatform()): string {
  if (key === 'Mod') return mac ? '⌘' : 'Ctrl';
  return key;
}

/// "⌘ K" / "Ctrl K" — for places that want one string, like palette hints.
export function shortcutText(keys: string[], mac = isMacPlatform()): string {
  return keys.map((k) => keyLabel(k, mac)).join(mac ? '' : '+');
}
