// Regenerates the README screenshots in docs/screenshots/.
//
// Runs the built app against a throwaway HOME (fictional acme-* repos, see
// seed.mjs) and its own --user-data-dir, so nothing from your real repos,
// workspaces or settings can end up in an image. PATH is cut down to the
// sandbox's bin/ (git, a stub gh that serves canned PR and CI data, inert
// LLM CLIs) plus system dirs, and the sandbox gitconfig refuses ssh/https,
// so no network call is ever made.
//
//   npm run build
//   npm i --no-save playwright-core
//   node scripts/readme-screenshots/capture.mjs
//
// Framing needs Python 3 with Pillow (`pip3 install pillow`).

import { _electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '..', '..');
const work = path.join(fs.realpathSync(os.tmpdir()), 'overgit-readme-shots');
const raw = path.join(work, 'raw');
const userData = path.join(work, 'userData');
// The real Electron binary, not node_modules/.bin/electron: that shim is a
// node script and node isn't on the sandbox PATH.
const electronBin = createRequire(import.meta.url)(path.join(repo, 'node_modules', 'electron'));

async function launch(ids) {
  const app = await _electron.launch({
    executablePath: electronBin,
    args: ['.', `--user-data-dir=${userData}`, '--force-device-scale-factor=2'],
    cwd: repo,
    // A clean env on purpose: no tokens, no real PATH, no real HOME.
    env: {
      HOME: ids.home,
      PATH: `${ids.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: os.tmpdir(),
      LANG: 'en_US.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.unmaximize();
    w.setSize(1600, 1000);
    w.center();
  });
  await page.waitForTimeout(3000);
  return { app, page };
}

// Rewrites the sandbox HOME to `~` in the DOM and drops hover titles, so
// no temp path shows up in a row or tooltip.
const tidy = (page, home) =>
  page.evaluate((home) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) if (n.nodeValue.includes(home)) n.nodeValue = n.nodeValue.split(home).join('~');
    document.querySelectorAll('[title]').forEach((e) => (e.title = ''));
  }, home);

function seed(theme) {
  execFileSync('node', [path.join(here, 'seed.mjs'), work, userData, theme], { stdio: 'inherit' });
  return JSON.parse(fs.readFileSync(path.join(work, 'seed-ids.json'), 'utf8'));
}

async function session(theme, scenes) {
  const ids = seed(theme);
  const { app, page } = await launch(ids);
  try {
    const shot = async (name, wait = 1500) => {
      await page.waitForTimeout(wait);
      await tidy(page, ids.home);
      await page.mouse.move(1, 999); // park the cursor so nothing is hovered
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(raw, `${name}.png`) });
      console.log('  ', name);
    };
    await scenes(page, shot);
  } finally {
    await app.close();
  }
}

const esc = async (page) => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
};
const sidebar = (page, text) => page.locator('aside, nav').getByText(text, { exact: true }).first();
/// Scroll the main pane so the given section heading sits near the top.
const scrollTo = (page, heading) =>
  page.evaluate((heading) => {
    const h = [...document.querySelectorAll('main h2, h2')].find((e) => e.textContent?.trim().toLowerCase() === heading);
    if (!h) throw new Error(`no section ${heading}`);
    let el = h.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    if (el) el.scrollTop += h.getBoundingClientRect().top - el.getBoundingClientRect().top - 24;
  }, heading);

fs.rmSync(raw, { recursive: true, force: true });
fs.mkdirSync(raw, { recursive: true });

console.log('dark');
await session('dark', async (page, shot) => {
  // Opens on the first workspace.
  await shot('workspace', 2500);

  await sidebar(page, 'Rate-limiter rollout').click();
  // PRs and landing are deferred a beat after the pane mounts.
  await page.getByText('Token-bucket rate limiter at the edge').first().waitFor();
  await shot('hero', 2500);

  await scrollTo(page, 'landing');
  await shot('landing');

  await page.getByRole('button', { name: 'Search', exact: true }).first().click();
  await page.waitForTimeout(600);
  await page.keyboard.type('RATE_LIMIT');
  await page.keyboard.press('Enter');
  await page.getByText('acme-gateway').last().waitFor();
  await shot('search', 2000);
  await esc(page);

  await sidebar(page, 'acme-gateway').click();
  await page.waitForTimeout(1500);
  await page.keyboard.press('Meta+k');
  await shot('palette', 1000);
  await esc(page);
});

console.log('light');
await session('light', async (page, shot) => {
  // The saved theme only takes effect when changed in Settings (index.html
  // boots with body.dark), so apply it the way Settings does.
  await page.evaluate(() => document.body.classList.remove('dark'));
  await sidebar(page, 'acme-gateway').click();
  await page.waitForTimeout(1500);
  await page.getByText('rateLimit.ts').first().click();
  await shot('changes-light', 2000);
});

execFileSync('python3', [path.join(here, 'frame.py'), raw, path.join(repo, 'docs', 'screenshots')], { stdio: 'inherit' });
fs.rmSync(userData, { recursive: true, force: true });
