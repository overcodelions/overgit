// Self-update from the GitHub Releases feed declared in package.json
// `build.publish`. Download happens in the background; the install is
// deferred until the user quits so we never yank the app out from under
// a commit or push in flight. Same design as overcli's updater.
//
// macOS note: Squirrel.Mac refuses to install an *unsigned* update, so this
// only works for signed builds. That's why signing is a hard prerequisite.

import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { Store } from './store';
import type { MainToRendererEvent } from '../shared/types';

let wired = false;
let getWindowRef: () => BrowserWindow | null = () => null;
// The channel currently applied to autoUpdater. Lets refreshUpdateChannel()
// no-op when an unrelated settings save comes through with the same channel.
let appliedChannel: 'stable' | 'nightly' | null = null;

// Nightly builds stamp their version as x.y.z-nightly.<date>.<sha>; every
// tagged release is plain x.y.z. That prerelease tag is the only reliable
// marker of which channel the running binary came from.
function isNightlyBuild(): boolean {
  return /-nightly\./.test(app.getVersion());
}

// Map the user's channel setting onto electron-updater's channel + prerelease
// flags. 'stable' follows the `latest` feed (tagged releases); 'nightly'
// follows the rolling `nightly` prerelease feed. The setting is the single
// source of truth regardless of which build was originally installed.
function applyChannel(): void {
  const channel = Store.load().settings.updateChannel ?? 'stable';
  appliedChannel = channel;
  if (channel === 'nightly') {
    autoUpdater.channel = 'nightly';
    autoUpdater.allowPrerelease = true;
  } else {
    autoUpdater.channel = 'latest';
    autoUpdater.allowPrerelease = false;
  }
  // Must come *after* the channel assignment: electron-updater's `channel`
  // setter flips allowDowngrade to true as a documented side effect. Left
  // alone, any older build the feed happens to resolve installs itself
  // silently — a machine on nightly would walk itself back to stable.
  // Going backwards is only ever intentional in one direction: a nightly
  // build whose owner has asked for the stable channel.
  autoUpdater.allowDowngrade = channel === 'stable' && isNightlyBuild();
  console.info(
    `[updater] channel = ${autoUpdater.channel} (downgrade ${autoUpdater.allowDowngrade ? 'allowed' : 'disallowed'})`,
  );
}

function check(): void {
  autoUpdater.checkForUpdates().catch((err) => console.error('[updater] checkForUpdates threw', err));
}

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  getWindowRef = getWindow;
  // Updates only exist for a packaged .app/.exe — skip in dev entirely.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => console.info('[updater]', String(m)),
    warn: (m: unknown) => console.warn('[updater]', String(m)),
    error: (m: unknown) => console.error('[updater]', String(m)),
    debug: () => {},
  };

  const notify = (event: MainToRendererEvent) => {
    const win = getWindowRef();
    if (win && !win.isDestroyed()) win.webContents.send('main:event', event);
  };

  autoUpdater.on('update-available', (info) => {
    notify({ kind: 'update:available', version: info.version });
  });
  autoUpdater.on('download-progress', (p) => {
    notify({ kind: 'update:progress', percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.info(`[updater] update downloaded: ${info.version} (installs on quit)`);
    notify({ kind: 'update:downloaded', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    console.error('[updater] auto-update check failed', err);
  });

  wired = true;
  applyChannel();

  // Check shortly after launch so we don't compete with window creation and
  // the first repo status sweep, then poll every 6 hours for long sessions.
  setTimeout(check, 10_000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

// Called from the store:saveSettings IPC handler so flipping the channel in
// Settings takes effect immediately — re-point the feed and check right away.
// saveSettings fires on every settings change (including sidebar drags), so
// skip the work unless the update channel actually changed.
export function refreshUpdateChannel(): void {
  if (!wired) return;
  const channel = Store.load().settings.updateChannel ?? 'stable';
  if (channel === appliedChannel) return;
  applyChannel();
  check();
}

// Quit and install a downloaded update now — invoked when the user clicks
// "Restart to update" in the UpdateToast instead of waiting for the next quit.
export function quitAndInstall(): void {
  if (!wired) return;
  autoUpdater.quitAndInstall();
}
