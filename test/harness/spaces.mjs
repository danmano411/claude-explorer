// KAN-45: spaces wired into the app — the switcher, the per-space tab strip,
// Ctrl+1..9, and the requirement the whole ticket hangs on.
//   npm run build && node test/harness/spaces.mjs
//
// Proves against the real running app that:
//
//   1. SWITCHING A SPACE DOES NOT KILL THE PTYs OF THE SPACE YOU LEFT. A shell
//      started in space A is still running, still producing output, and still
//      has its scrollback when you come back from B — and it is the SAME xterm
//      instance, not a rebuilt one (rebuilding is the KAN-23 bug: a fresh xterm
//      never sees the alt-screen/application-cursor sequences it missed, so the
//      TUI stops scrolling and the buffer is gone). Proved three ways at once:
//      output that could only have been produced while B was on screen, a
//      marker printed BEFORE the switch that is still there after it, and a DOM
//      probe planted on the .xterm element surviving the round trip.
//   2. create / rename / delete work, and delete DOES kill the tabs' PTYs —
//      the mirror of (1), proved by a loop whose file writes stop.
//   3. each space remembers its own active tab, across a switch and a restart.
//   4. Ctrl+1..9 selects the nth space, and is IGNORED while a terminal or the
//      address bar has focus (one predicate covers the search overlay and the
//      rename inputs too — renderer/keys.ts).
//   5. spaces, their membership and their active tab survive a restart.
//
// A plain PowerShell tab is used rather than Claude: the claim is about pty
// lifetime, which is the same process machinery either way, and this costs no
// tokens and no ~2-minute CLI startup (test/harness/resume.mjs pays that).
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const clean = (t) => t.replace(/[\u{1F4C1}▶×]/gu, '').replace(/\s+/g, ' ').trim();
const titles = (win) => win.locator('.tab:not(.add)').allTextContents().then((ts) => ts.map(clean));
const activeTitle = (win) =>
  win.locator('.tab.active').first().textContent().then(clean).catch(() => '(none)');
const spaceName = (win) => win.locator('.spacemenu-name').textContent().then((t) => t.trim());
/** Terminal text. NOT scoped to the visible pane: half the point is reading a
 *  pane that is hidden because its space is not on screen. */
const termText = (win) => win.$eval('.pane .xterm-rows', (el) => el.textContent);

const openSpaceMenu = async (win) => {
  await win.click('.spacemenu-btn');
  await win.waitForSelector('.spacemenu-dropdown');
  await win.waitForTimeout(150);
};

async function createSpace(win, name) {
  await openSpaceMenu(win);
  await win.locator('.spacemenu-item', { hasText: 'New empty space' }).click();
  await win.waitForSelector('.spacemenu-rename');
  await win.locator('.spacemenu-rename').fill(name);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(500);
}

async function renameSpace(win, name) {
  await openSpaceMenu(win);
  await win.locator('.spacemenu-item', { hasText: /^Rename$/ }).click();
  await win.waitForSelector('.spacemenu-rename');
  await win.locator('.spacemenu-rename').fill(name);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(400);
}

async function deleteSpace(win) {
  await openSpaceMenu(win);
  await win.locator('.spacemenu-item', { hasText: /^Delete$/ }).click();
  await win.waitForSelector('.modal');
  await win.locator('.modal button.danger').click();
  await win.waitForTimeout(600);
}

async function switchSpaceViaMenu(win, name) {
  await openSpaceMenu(win);
  await win.locator('.spacemenu-item-name', { hasText: name }).first().click();
  await win.waitForTimeout(500);
}

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
  await win.waitForTimeout(500);
}

/** Type a line into the visible terminal and submit it. */
async function runInTerminal(win, line) {
  await win.locator('.pane:not([hidden]) .xterm-screen').click();
  await win.waitForTimeout(200);
  await win.keyboard.type(line);
  await win.waitForTimeout(200);
  await win.keyboard.press('Enter');
}

const PROFILE = path.join(os.tmpdir(), `claude-explorer-spaces-harness-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

// Distinct per run: a marker left over from a previous run would make a dead
// terminal look like a live one.
//
// Each marker is CONCATENATED BY POWERSHELL, never typed whole. The terminal
// echoes what you type, so a command containing the literal `CE-DONE-123456`
// puts that string on screen whether or not the shell ever ran — the first cut
// of this harness did exactly that and reported "already done" for a command
// that had barely started. `Write-Host ('CE-DONE-'+$t)` echoes as
// `'CE-DONE-'+$t`, so a search for the joined string can only match OUTPUT.
// (Same trap resume.mjs documents for its Claude marker.)
const TAG = Date.now().toString().slice(-6);
const MARKER = `CE-MARK-${TAG}`;
const DONE = `CE-DONE-${TAG}`;
const ALIVE = `CE-ALIVE-${TAG}`;
const emit = (prefix) => `Write-Host ('${prefix}-'+$t)`;

// ===========================================================================
// Run 1 — the load-bearing one: a live shell in space A survives a round trip
// through space B, plus the shortcut guard and per-space active tabs.
// ===========================================================================
{
  const { win, close } = await launchApp({ userDataDir: PROFILE });
  await win.waitForSelector('.entry');
  await win.waitForTimeout(500);

  check('the tab strip carries a space switcher, showing the default space',
    (await spaceName(win)) === 'Space', await spaceName(win));

  // Beta is made FIRST, empty, so the round trip below leaves space A through a
  // real SWITCH in both directions. Creating the second space at the point of
  // departure instead would leave `switchToSpace` — the one function the
  // requirement is about — untested on the outbound leg.
  await createSpace(win, 'Beta');
  check('the new space is created and switched to', (await spaceName(win)) === 'Beta', await spaceName(win));
  check('a brand-new space starts empty — none of the other space\'s tabs are on its strip',
    (await titles(win)).length === 0, (await titles(win)).join(' | '));

  await win.click('.tabbar');
  await win.waitForTimeout(150);
  await win.keyboard.press('Control+1');
  await win.waitForTimeout(700);
  check('Ctrl+1 selects the first space', (await spaceName(win)) === 'Space', await spaceName(win));

  await win.click('.tab.add');
  await win.waitForTimeout(700);
  await renameTab(win, 0, 'A1');
  await renameTab(win, 1, 'A2');
  await tabMenu(win, 0, 'Open Terminal');            // tab 2: a real PowerShell
  await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 20_000 });
  await win.waitForTimeout(1500);
  check('space A has three tabs, the shell among them',
    (await titles(win)).join('|') === 'A1|A2|Terminal', (await titles(win)).join(' | '));

  // MARKER, then 8 ticks at 700ms (~5.6s), then DONE. The switch below happens
  // ~2s in, so DONE can ONLY be produced while space B is the one on screen.
  await runInTerminal(win,
    `$t='${TAG}'; ${emit('CE-MARK')}; 1..8 | ForEach-Object { Write-Host "CE-TICK $_"; Start-Sleep -Milliseconds 700 }; ${emit('CE-DONE')}`);
  await win.waitForTimeout(1800);

  // Plant a probe on the xterm element itself. Terminal.tsx builds it inside an
  // effect and disposes it on unmount, so this attribute surviving means the
  // very same instance — and therefore the very same scrollback buffer — is
  // still there.
  //
  // This is NOT redundant with the text assertions, which is worth knowing
  // before anyone deletes it: rendering the panes from the active space's slice
  // instead of the whole store (i.e. reintroducing KAN-23 per space switch) was
  // tried against this harness and the marker-still-on-screen check PASSED
  // anyway. A remounted xterm gets a fit()/ptyResize on attach, and ConPTY
  // repaints its whole screen buffer on resize, so the old text reappears
  // without any of it having survived. Only the probe caught it.
  await win.evaluate(() => { document.querySelector('.pane .xterm').dataset.ceProbe = 'run1'; });

  const before = await termText(win);
  check('the shell printed the marker before the switch', before.includes(MARKER));
  check('and had NOT finished yet — so anything after this could only run while B is up',
    !before.includes(DONE), before.includes(DONE) ? 'already done, timing is wrong' : 'still ticking');
  const ticksBefore = [...before.matchAll(/CE-TICK (\d+)/g)].map((m) => +m[1]);
  const maxBefore = Math.max(0, ...ticksBefore);

  // --- leave for the empty space, by the menu (the other switch path) -------
  await switchSpaceViaMenu(win, 'Beta');
  check('the menu switches away from the space holding the live shell',
    (await spaceName(win)) === 'Beta' && (await titles(win)).length === 0,
    `${await spaceName(win)}: ${(await titles(win)).join(' | ')}`);

  const parked = await win.evaluate(() => ({
    panes: document.querySelectorAll('.pane').length,
    xterms: document.querySelectorAll('.xterm').length,
    visiblePanes: document.querySelectorAll('.pane:not([hidden])').length,
  }));
  check('A\'s terminal pane is still MOUNTED while B is on screen, merely hidden',
    parked.panes === 1 && parked.xterms === 1 && parked.visiblePanes === 0, JSON.stringify(parked));

  await win.waitForTimeout(6000); // the ticker finishes here, with B on screen

  // --- come back with Ctrl+1 (nothing typable focused) ----------------------
  await win.click('.tabbar');
  await win.waitForTimeout(150);
  await win.keyboard.press('Control+1');
  await win.waitForTimeout(700);
  check('Ctrl+1 comes back to the space that owns the shell',
    (await spaceName(win)) === 'Space', await spaceName(win));
  check('and its tabs are back, in order',
    (await titles(win)).join('|') === 'A1|A2|Terminal', (await titles(win)).join(' | '));
  check('landing on the tab that had focus in this space (per-space active tab)',
    (await activeTitle(win)) === 'Terminal', await activeTitle(win));

  const after = await termText(win);
  const ticksAfter = [...after.matchAll(/CE-TICK (\d+)/g)].map((m) => +m[1]);
  const maxAfter = Math.max(0, ...ticksAfter);
  const probe = await win.evaluate(() => document.querySelector('.pane .xterm')?.dataset.ceProbe ?? null);

  check('THE PTY KEPT RUNNING while its space was off screen (output only it could have produced)',
    after.includes(DONE) && maxAfter > maxBefore,
    `ticks ${maxBefore} -> ${maxAfter}, done=${after.includes(DONE)}`);
  check('THE SCROLLBACK IS INTACT — the line printed before the switch is still there',
    after.includes(MARKER));
  check('and it is the SAME xterm instance, never rebuilt (KAN-23 discipline held)',
    probe === 'run1', String(probe));

  // Still alive, not merely still on screen: the shell accepts input again.
  await runInTerminal(win, `$t='${TAG}'; ${emit('CE-ALIVE')}`);
  await win.waitForTimeout(1500);
  check('the shell is still ALIVE after the round trip — it answers a new command',
    (await termText(win)).includes(ALIVE));

  // --- Ctrl+1..9 must not fire while a terminal owns the keystrokes ---------
  await win.locator('.pane:not([hidden]) .xterm-screen').click();
  await win.waitForTimeout(200);
  await win.keyboard.press('Control+2');
  await win.waitForTimeout(600);
  check('Ctrl+2 is IGNORED while a terminal has focus (it must reach the shell)',
    (await spaceName(win)) === 'Space', await spaceName(win));

  await win.locator('.tab:not(.add)').nth(0).click();  // a files tab, for its address bar
  await win.waitForTimeout(400);
  const ab = await win.locator('.address').boundingBox();
  await win.mouse.click(ab.x + ab.width - 20, ab.y + ab.height / 2);
  await win.waitForSelector('.address-input');
  await win.keyboard.press('Control+2');
  await win.waitForTimeout(600);
  check('Ctrl+2 is IGNORED while the address bar has focus',
    (await spaceName(win)) === 'Space', await spaceName(win));
  await win.keyboard.press('Escape');

  // Positive control: the same key, nothing typable focused, DOES switch —
  // otherwise the two checks above would pass on a shortcut that never works.
  await win.click('.tabbar');
  await win.waitForTimeout(150);
  await win.keyboard.press('Control+2');
  await win.waitForTimeout(600);
  check('with nothing typable focused, Ctrl+2 DOES select the second space',
    (await spaceName(win)) === 'Beta', await spaceName(win));

  // --- rename, and give each space a distinct active tab for run 2 ---------
  await renameSpace(win, 'Beta Renamed');
  check('renaming the current space relabels the switcher',
    (await spaceName(win)) === 'Beta Renamed', await spaceName(win));

  for (let i = 0; i < 2; i++) { await win.click('.tab.add'); await win.waitForTimeout(700); }
  await renameTab(win, 0, 'B1');
  await renameTab(win, 1, 'B2');
  await win.locator('.tab:not(.add)').nth(0).click();   // B's active tab is B1
  await win.waitForTimeout(300);
  check('the second space holds its own tabs, and only its own',
    (await titles(win)).join('|') === 'B1|B2', (await titles(win)).join(' | '));

  await switchSpaceViaMenu(win, 'Space');
  await win.locator('.tab:not(.add)').nth(2).click();   // A's active tab is Terminal
  await win.waitForTimeout(300);
  check('switching back by menu restores A\'s tabs again',
    (await titles(win)).join('|') === 'A1|A2|Terminal', (await titles(win)).join(' | '));

  await win.waitForTimeout(1600); // 400ms debounce + margin
  await close();
}

// ===========================================================================
// Run 2 — same profile, fresh process: did the spaces come back?
// ===========================================================================
{
  const { win, close } = await launchApp({ userDataDir: PROFILE });
  await win.waitForSelector('.tab:not(.add)');
  await win.waitForTimeout(1500);

  check('the space you were in is the one you land in', (await spaceName(win)) === 'Space',
    await spaceName(win));
  check('its tabs survived the restart, in order',
    (await titles(win)).join('|') === 'A1|A2|Terminal', (await titles(win)).join(' | '));
  check('and its remembered active tab survived too',
    (await activeTitle(win)) === 'Terminal', await activeTitle(win));

  await openSpaceMenu(win);
  const listed = (await win.locator('.spacemenu-item-name').allTextContents()).map((t) => t.trim());
  const accels = (await win.locator('.spacemenu-accel').allTextContents()).map((t) => t.trim());
  await win.keyboard.press('Escape');
  check('both spaces are listed, with their names', listed.join('|') === 'Space|Beta Renamed',
    listed.join(' | '));
  check('and each carries its Ctrl+N accelerator label', accels.join('|') === 'Ctrl+1|Ctrl+2',
    accels.join(' | '));

  await win.click('.tabbar');
  await win.keyboard.press('Control+2');
  await win.waitForTimeout(700);
  check('the second space survived with its own membership',
    (await spaceName(win)) === 'Beta Renamed' && (await titles(win)).join('|') === 'B1|B2',
    `${await spaceName(win)}: ${(await titles(win)).join(' | ')}`);
  check('and with ITS remembered active tab, not the other space\'s',
    (await activeTitle(win)) === 'B1', await activeTitle(win));

  await close();
}

// ===========================================================================
// Run 3 — deleting a space closes its tabs AND kills their processes. The
// mirror of run 1: switching must not kill, deleting must.
// ===========================================================================
{
  const profile = path.join(os.tmpdir(), `claude-explorer-spaces-del-${process.pid}`);
  fs.rmSync(profile, { recursive: true, force: true });
  const beat = path.join(os.tmpdir(), `ce-heartbeat-${process.pid}.txt`);
  fs.rmSync(beat, { force: true });

  const { win, close } = await launchApp({ userDataDir: profile });
  await win.waitForSelector('.entry');
  await win.waitForTimeout(500);

  await createSpace(win, 'Doomed');
  await win.click('.tab.add');
  await win.waitForTimeout(800);
  await tabMenu(win, 0, 'Open Terminal');
  await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 20_000 });
  await win.waitForTimeout(1500);

  // A heartbeat on disk: the only witness to a process that is not on screen.
  await runInTerminal(win,
    `while($true){ Add-Content -Path '${beat.replace(/\\/g, '/')}' -Value 'tick'; Start-Sleep -Milliseconds 400 }`);
  await win.waitForTimeout(3000);
  const beats = () => (fs.existsSync(beat) ? fs.readFileSync(beat, 'utf8').length : 0);
  const running = beats();
  await win.waitForTimeout(1500);
  check('the doomed space\'s shell is genuinely running (its heartbeat grows)',
    running > 0 && beats() > running, `${running} -> ${beats()} bytes`);

  await deleteSpace(win);
  check('deleting a space moves you to a surviving one', (await spaceName(win)) === 'Space',
    await spaceName(win));
  // Counted in XTERMS, not in `.pane` elements. The claim is about the deleted
  // space's TERMINAL still being mounted somewhere, and since KAN-46 a files
  // tab gets a `.pane` wrapper too (it needs a grid area like any other pane) —
  // so the surviving space's own files tab makes the pane count 1, forever, no
  // matter what happened to the doomed one. An xterm exists only for a terminal
  // tab, which is exactly the thing that had to go.
  const mounted = () => win.evaluate(() => ({
    xterms: document.querySelectorAll('.xterm').length,
    panes: document.querySelectorAll('.pane').length,
  }));
  check('its tabs are closed, not merely hidden — nothing of it is left mounted',
    (await mounted()).xterms === 0 && (await titles(win)).length === 1,
    `${JSON.stringify(await mounted())}, tabs: ${(await titles(win)).join(' | ')}`);

  await win.waitForTimeout(1500);      // let any in-flight write land
  const settled = beats();
  await win.waitForTimeout(2500);
  check('and their PTYs were KILLED — the heartbeat stopped', beats() === settled,
    `${settled} -> ${beats()} bytes`);

  await close();
  fs.rmSync(beat, { force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
