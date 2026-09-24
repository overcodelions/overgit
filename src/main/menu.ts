// The native menu. Electron's default one shipped until now, which meant a
// Help menu full of links about Electron and a View → Reload bound to ⌘R —
// the same key overgit uses to refresh a pane. Items that open a sheet or a
// picker can't do it from main, so they send a `menu:command` event and the
// renderer acts on it.
//
// Keys the renderer already handles (⌘K, ⌘,, ⌘\, ⌘/) are shown here with
// `registerAccelerator: false`: the menu advertises them, the renderer's
// keydown handler stays the single owner.

import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '../shared/types';

const REPO_URL = 'https://github.com/overcodelions/overgit';

export function installAppMenu(send: (command: MenuCommand) => void): void {
  const isMac = process.platform === 'darwin';
  const item = (
    label: string,
    command: MenuCommand,
    accelerator?: string,
    owned = false,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    // `owned` = this menu is the only thing listening for the key.
    registerAccelerator: owned,
    click: () => send(command),
  });

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              item('About Overgit', 'about'),
              { type: 'separator' },
              item('Settings…', 'settings', 'CmdOrCtrl+,'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        item('Add Repositories…', 'addRepos', 'CmdOrCtrl+O', true),
        item('Clone Repository…', 'cloneRepo', 'CmdOrCtrl+Shift+O', true),
        { type: 'separator' },
        ...(isMac
          ? [{ role: 'close' } as const]
          : [item('Settings…', 'settings', 'Ctrl+,'), { type: 'separator' } as const, { role: 'quit' } as const]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        item('Command Palette…', 'palette', 'CmdOrCtrl+K'),
        item('Toggle Sidebar', 'toggleSidebar', 'CmdOrCtrl+\\'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        item('How Overgit Works', 'basics'),
        item('Setup — Git and CLIs', 'setup'),
        item('Keyboard Shortcuts', 'shortcuts', 'CmdOrCtrl+/'),
        { type: 'separator' },
        { label: 'Documentation', click: () => void shell.openExternal(`${REPO_URL}#readme`) },
        { label: 'Report an Issue', click: () => void shell.openExternal(`${REPO_URL}/issues/new/choose`) },
        ...(isMac ? [] : [{ type: 'separator' } as const, item('About Overgit', 'about')]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
