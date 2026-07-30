// KAN-47: a tab opened FROM another tab joins its group, at the group's right
// edge — Chrome's "opened from this tab" behaviour, gated by
// Settings.groupWithSource.
//   npm run build && node test/harness/autolink.mjs
//
// Proves against the real running app that:
//   1. a viewer double-clicked open from a tab inside group G lands IN G, at
//      G's right edge (not just appended to the far end of the strip — a
//      loose marker tab sits past the group to catch that);
//   2. Settings.groupWithSource: false turns the same action back into
//      today's behaviour (far right, ungrouped);
//   3. an ungrouped source produces an ungrouped new tab even with the
//      setting on;
//   4. a shell tab opened from a tab's own context menu ("Open Terminal")
//      follows the same rule — this is the OTHER open-tab path that has a
//      real per-tab source (the right-clicked tab, not necessarily `active`);
//   5. opening from a tab whose group is COLLAPSED expands the group, so the
//      new tab is actually on the strip instead of joining a run that renders
//      nothing (KAN-44 review #2's defect, on the auto-link path);
//   6. group membership of an auto-linked tab survives a restart, same as any
//      other group membership (KAN-43's persistence, unmodified by this
//      feature — this just proves the auto-linked tab is on that path too);
//   7. the Settings modal's new checkbox round-trips through settings.json.
//
// The setting is flipped via window.api.settingsSet directly (the exact call
// SettingsModal's Save button makes) for the behavioural assertions, so a
// flaky native-menu-accelerator round trip isn't gating the interesting
// logic; the modal's own checkbox wiring gets one direct UI pass at the end
// (opened by replaying the same 'menu:command' event the real Preferences…
// accelerator sends, from the main-process side).
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchApp } from './app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const clean = (t) => t.replace(/[\u{1F4C1}▶×]/gu, '').replace(/\s+/g, ' ').trim();
const titles = (win) => win.locator('.tab:not(.add)').allTextContents().then((ts) => ts.map(clean));
const indexOfTitle = async (win, title) => (await titles(win)).indexOf(title);

async function renameTab(win, i, name) {
  await win.locator('.tab:not(.add)').nth(i).click({ button: 'right' });
  await win.waitForTimeout(250);
  await win.locator('.ctx-item', { hasText: /^Rename$/ }).first().click();
  await win.waitForTimeout(200);
  await win.locator('.tab-rename').fill(name);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(250);
}

async function tabMenu(win, i, itemText) {
  await win.locator('.tab:not(.add)').nth(i).click({ button: 'right' });
  await win.waitForTimeout(250);
  await win.locator('.ctx-item', { hasText: itemText }).first().click();
  await win.waitForTimeout(400);
}

/** Point the tab at index `i` (its NavBar) at an arbitrary folder, via the
 *  same address-bar edit a user would use — no per-tab "open at path" IPC
 *  exists, so this is the real UI path, not a shortcut around it. */
async function navigateTab(win, i, folder) {
  await win.locator('.tab:not(.add)').nth(i).click();
  await win.waitForTimeout(150);
  await win.locator('.address').click();
  await win.waitForTimeout(100);
  await win.locator('.address-input').fill(folder);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(400);
}

const probe = (win) => win.evaluate(() => {
  const all = [...document.querySelectorAll('.tab:not(.add)')];
  const wrappers = [...document.querySelectorAll('.tabgroup')];
  return {
    wrapperCount: wrappers.length,
    visibleTabs: all.length,
    label: wrappers[0] ? wrappers[0].querySelector('.group-label').textContent.trim() : null,
    memberIdx: all.map((t, i) => (t.closest('.tabgroup') ? i : -1)).filter((i) => i >= 0),
  };
});

const consecutive = (xs) => xs.length > 0 && xs.every((v, i) => i === 0 || v === xs[i - 1] + 1);

const PROFILE = path.join(os.tmpdir(), `claude-explorer-autolink-harness-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

// ===========================================================================
// Run 1: viewer + shell auto-link, the setting gate, ungrouped source.
// ===========================================================================
{
  const { win, close } = await launchApp({ userDataDir: PROFILE, extraArgs: ['--open', ROOT] });
  await win.waitForSelector('.entry');

  // Cold start on a fresh profile: tab0 = home, tab1 = ROOT (argv), focused.
  await renameTab(win, 0, 'Home');
  await renameTab(win, 1, 'Repo');
  await win.click('.tab.add'); // tab2, home, loose
  await win.waitForTimeout(700);
  await navigateTab(win, 2, ROOT); // give it real files too, still loose
  await renameTab(win, 2, 'End');
  check('three tabs set up: Home (loose), Repo (to be grouped), End (loose marker past it)',
    (await titles(win)).join('') === 'HomeRepoEnd', (await titles(win)).join(' '));

  await tabMenu(win, 1, 'New group from this tab'); // groups Repo alone

  // --- 1. viewer opened from the grouped tab joins the group, at its right edge ---
  await win.locator('.tab:not(.add)').nth(1).click(); // reactivate Repo
  await win.waitForTimeout(200);
  await win.locator('.entry', { hasText: 'package.json' }).first().dblclick();
  await win.waitForTimeout(400);
  {
    const t = await titles(win);
    const p = await probe(win);
    check('viewer joined the group, inserted right after the source (not at the strip\'s end)',
      t.join('|') === 'Home|Repo|package.json|End', t.join(' | '));
    check('the group is still one contiguous run of 2 (Repo + the new viewer)',
      p.wrapperCount === 1 && p.memberIdx.length === 2 && consecutive(p.memberIdx),
      JSON.stringify(p));
  }

  // --- 2. setting off: the same action lands the tab at the far right, ungrouped ---
  await win.evaluate(() => window.api.settingsSet({ groupWithSource: false }));
  const repoIdx1 = await indexOfTitle(win, 'Repo');
  await win.locator('.tab:not(.add)').nth(repoIdx1).click();
  await win.waitForTimeout(200);
  await win.locator('.entry', { hasText: 'tsconfig.json' }).first().dblclick();
  await win.waitForTimeout(400);
  {
    const t = await titles(win);
    const p = await probe(win);
    check('setting off: the new tab landed at the far right, not inside the group',
      t.at(-1) === 'tsconfig.json', t.join(' | '));
    check('setting off: the group itself is unchanged — still 2 members',
      p.wrapperCount === 1 && p.memberIdx.length === 2, JSON.stringify(p));
  }
  await win.evaluate(() => window.api.settingsSet({ groupWithSource: true })); // restore for the rest of the run

  // --- 3. an ungrouped source produces an ungrouped new tab ---
  const endIdx = await indexOfTitle(win, 'End'); // loose, points at ROOT too
  await win.locator('.tab:not(.add)').nth(endIdx).click();
  await win.waitForTimeout(200);
  await win.locator('.entry', { hasText: 'vitest.config.ts' }).first().dblclick();
  await win.waitForTimeout(400);
  {
    const t = await titles(win);
    const p = await probe(win);
    check('ungrouped source: the new tab is ungrouped too',
      t.at(-1) === 'vitest.config.ts', t.join(' | '));
    check('ungrouped source: the group is still untouched — still 2 members',
      p.wrapperCount === 1 && p.memberIdx.length === 2, JSON.stringify(p));
  }

  // --- 4. "Open Terminal" from a tab's own context menu (openShellTab) follows
  // the same rule — this is the other real per-tab source in the app.
  const repoIdx2 = await indexOfTitle(win, 'Repo');
  await tabMenu(win, repoIdx2, 'Open Terminal');
  await win.waitForTimeout(600);
  {
    const t = await titles(win);
    const p = await probe(win);
    const terminalIdx = t.indexOf('Terminal');
    check('a shell tab opened from the tab context menu exists',
      terminalIdx !== -1, t.join(' | '));
    check('it joined the source tab\'s group, contiguous with it',
      p.wrapperCount === 1 && p.memberIdx.length === 3 && consecutive(p.memberIdx),
      JSON.stringify(p));
  }

  // --- 5. auto-linking into a COLLAPSED group must expand it. A collapsed
  // group renders none of its members, while the pane still shows the active
  // one — so without the expand the new tab is drawn by nothing at all and
  // reads as having vanished, the exact defect KAN-44 review #2 caught on the
  // drag path.
  const repoIdx3 = await indexOfTitle(win, 'Repo');
  await win.locator('.tab:not(.add)').nth(repoIdx3).click();
  await win.waitForTimeout(200);
  await win.locator('.group-label').first().click(); // collapse
  await win.waitForTimeout(400);
  {
    const p = await probe(win);
    check('setup: the group is collapsed — no members on the strip, count on the chip',
      p.memberIdx.length === 0 && p.label === 'Group (3)', JSON.stringify(p));
  }
  // The source tab is hidden but still active, so its FileBrowser is on screen.
  await win.locator('.entry', { hasText: 'README.md' }).first().dblclick();
  await win.waitForTimeout(500);
  {
    const t = await titles(win);
    const p = await probe(win);
    check('opening from a tab in a COLLAPSED group expands it, so the new tab is visible',
      t.includes('README.md') && p.label === 'Group', `${t.join(' | ')} label="${p.label}"`);
    check('and the new tab is INSIDE the run — 4 contiguous members now',
      p.wrapperCount === 1 && p.memberIdx.length === 4 && consecutive(p.memberIdx),
      JSON.stringify(p));
  }

  await win.waitForTimeout(1600); // 400ms persist debounce + margin, for run 2
  await close();
}

// ===========================================================================
// Run 2: same profile, fresh process — did the auto-linked group survive?
// ===========================================================================
{
  const { win, close } = await launchApp({ userDataDir: PROFILE });
  await win.waitForSelector('.tab:not(.add)');
  await win.waitForTimeout(1500);

  const p = await probe(win);
  check('the auto-linked group survived the restart, still contiguous, still 4 members',
    p.wrapperCount === 1 && p.memberIdx.length === 4 && consecutive(p.memberIdx),
    JSON.stringify(p));

  await close();
}

// ===========================================================================
// Run 3: the Settings modal's checkbox actually round-trips the setting.
// ===========================================================================
{
  const { app, win, close } = await launchApp();
  await win.waitForSelector('.entry');

  // Same event the real Preferences… (Ctrl+,) menu accelerator sends.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'open-settings');
  });
  await win.waitForSelector('.modal');
  const checkbox = win.locator('.settings-checkbox input[type="checkbox"]');
  check('the checkbox is present and starts checked (default true)',
    await checkbox.isChecked());

  await checkbox.uncheck();
  await win.locator('.modal-actions .primary').click();
  await win.waitForTimeout(200);
  const after = await win.evaluate(() => window.api.settingsGet());
  check('unchecking + Save persisted groupWithSource: false', after.groupWithSource === false);

  // Reopen: does the modal reflect the persisted value, not just default true?
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'open-settings');
  });
  await win.waitForSelector('.modal');
  check('reopening the modal shows the persisted (unchecked) state',
    !(await win.locator('.settings-checkbox input[type="checkbox"]').isChecked()));

  await close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
