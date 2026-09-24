import { describe, expect, it } from 'vitest';
import { buildSetupPlan, detectPlatform } from './setupPlan';
import type { CliPresence } from '@shared/types';

const none: CliPresence = { gh: false, glab: false, jj: false, claude: false, codex: false, gemini: false };
const all: CliPresence = { gh: true, glab: true, jj: true, claude: true, codex: true, gemini: true };

describe('buildSetupPlan', () => {
  it('treats an unanswered probe as checking, never as missing', () => {
    const plan = buildSetupPlan({ git: null, cli: null, platform: 'mac' });
    expect(plan.checking).toBe(true);
    expect(plan.gitReady).toBe(false);
    expect(plan.rows.every((r) => r.state === 'checking')).toBe(true);
    expect(plan.rows.every((r) => !r.install)).toBe(true);
    expect(plan.headline).toMatch(/Checking/);
  });

  it('blocks on missing git with a platform install command', () => {
    const git = { installed: false, version: null, landingCheck: false };
    const mac = buildSetupPlan({ git, cli: none, platform: 'mac' });
    expect(mac.gitReady).toBe(false);
    expect(mac.headline).toBe('Install git to get started');
    expect(mac.rows[0].install).toBe('xcode-select --install');
    expect(buildSetupPlan({ git, cli: none, platform: 'windows' }).rows[0].install).toMatch(/winget/);
  });

  it('calls git ready even when every optional CLI is missing', () => {
    const plan = buildSetupPlan({
      git: { installed: true, version: '2.45.0', landingCheck: true },
      cli: none,
      platform: 'linux',
    });
    expect(plan.gitReady).toBe(true);
    expect(plan.headline).toMatch(/that’s all overgit needs/);
    expect(plan.rows.find((r) => r.key === 'gh')?.install).toBe('sudo apt install gh');
    expect(plan.rows.find((r) => r.key === 'claude')?.then).toMatch(/sign in/);
  });

  it('keeps old git usable but explains Landing Check', () => {
    const plan = buildSetupPlan({
      git: { installed: true, version: '2.30.1', landingCheck: false },
      cli: all,
      platform: 'mac',
    });
    expect(plan.gitReady).toBe(true);
    expect(plan.rows[0].state).toBe('outdated');
    expect(plan.rows[0].detail).toMatch(/2\.38/);
    expect(plan.headline).not.toBe('You’re set up');
  });

  it('says so when everything is present', () => {
    const plan = buildSetupPlan({
      git: { installed: true, version: '2.45.0', landingCheck: true },
      cli: all,
      platform: 'mac',
    });
    expect(plan.headline).toBe('You’re set up');
    expect(plan.readyCount).toBe(plan.rows.length);
    expect(plan.rows.every((r) => !r.install)).toBe(true);
  });
});

describe('detectPlatform', () => {
  it('reads the user agent', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('mac');
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });
});
