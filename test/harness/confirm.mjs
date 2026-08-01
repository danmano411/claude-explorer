// KAN-57: confirm what is genuinely unrecoverable, refuse what is pinned.
//   npm run build && node test/harness/confirm.mjs
//
// Proves against the real running app that:
//
//   1. SELECTIVITY. A files tab closes on one click with no dialog at all. This
//      is the control the whole ticket hangs on — a guard that fires on every
//      close is worse than no guard, because it is clicked through by habit.
//   2. A SHELL RUNNING A SILENT CHILD prompts, and Cancel leaves the PROCESS
//      running, not merely the tab on screen. Proved with a heartbeat file the
//      child appends to: a killed pty stops writing, and nothing in the renderer
//      can fake bytes landing on disk. Confirm then closes it AND stops the
//      heartbeat — so "still alive after Cancel" cannot be a close that silently
//      no-opped.
//  2b. A SHELL AT AN IDLE PROMPT closes with NO dialog (KAN-100), on a pty the
//      liveness probe says is alive — so "no dialog" is the guard deciding, not
//      a tab that never got a process. Together with 2 that is the whole of
//      KAN-100: two shells built the same way, opposite answers, decided only by
//      whether a child is running in the console.
//   3. A LIVE CLAUDE tab prompts, with the Claude wording, and Cancel leaves
//      its pty alive and its xterm INSTANCE untouched (the probe is planted on
//      the element: ConPTY repaints its whole buffer on resize, so surviving
//      TEXT proves nothing about the terminal having survived).
//   4. PINNED MEANS UN-CLOSABLE. The context menu's Close is greyed and does
//      nothing, and File ▸ Close Tab (Ctrl+W) closes nothing either — driven
//      from the MAIN process, because native menu items are not in the DOM.
//      Both are paired with a positive control (unpin, then the same route
//      closes it), so "nothing happened" cannot be a dead code path.
//   5. "Close group's tabs" over a 3-tab group asks ONCE: one dialog, nothing
//      closed while it is open, and ONE Continue closes all three with no
//      second dialog left behind. Cancel is all-or-nothing.
//   6. A pinned space offers no Delete, and unpinning brings it back.
//   7. Both pins survive a restart.
//   8. Switching space with the confirm still open (Ctrl+1..9 works over the
//      modal's Cancel button) does NOT leave the origin space with a dead
//      remembered tab and a blank window body when you come back to it.
//   9. Deleting a space closes its PINNED tabs — kept deliberately — and the
//      delete confirm names them, because every other close route refuses one.
//
// PTY LIVENESS. Two independent instruments, and the cheap one is calibrated
// against the expensive one before it is trusted:
//   * the heartbeat file (ground truth, shell only);
//   * ptyProbe(): resize the pty and count the bytes that come back. ConPTY
//     repaints its screen buffer on resize, and PtyManager.kill() deletes the
//     handle — so a resize on a dead id reaches nothing. Section 2 shows this
//     probe reading ALIVE and DEAD on the very shell whose heartbeat says the
//     same thing, which is what earns it the right to answer for the Claude
//     pty in section 3 (a Claude session has no heartbeat to offer).
//
// WHY EVERY "BUSY SHELL" HERE IS AN EXTERNAL `node` CHILD AND NOT A POWERSHELL
// LOOP (KAN-100). The signal behind the shell arm is ConPTY's console process
// list, so an EXTERNAL process is the whole of what it can see. Measured
// directly against a live PowerShell pty: `Start-Sleep -Seconds 8` and a
// `while($true){ Add-Content …; Start-Sleep … }` cmdlet loop — which is what
// this file's heartbeat used to be — both report NOT BUSY, because a cmdlet
// runs inside powershell.exe and attaches nothing new to the console. That is a
// known, deliberate ceiling (see the ponytail note in src/main/pty.ts), and it
// is why the instrument had to change: a heartbeat written by a cmdlet would
// have made "a live shell prompts" pass for the wrong reason on the old build
// and fail on the new one. Every child below is `node -e`, which is external,
// and every one of them is SILENT — it writes to a FILE and prints nothing —
// because a child that produces no output at all is exactly the case a
// byte-traffic heuristic gets backwards and the one KAN-100 has to get right.
//
// Exactly ONE real Claude spawn, and it never has to finish starting: the pty
// is alive from the moment node-pty returns, which is all sections 3 needs.
// Everything else runs on PowerShell.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// Pid-suffixed: the single-instance lock is keyed on userData, so two runs from
// two worktrees would otherwise silently forward into each other's window.
const PROFILE = path.join(os.tmpdir(), `claude-explorer-confirm-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });
const BEAT = path.join(os.tmpdir(), `ce-confirm-beat-${process.pid}.txt`);
fs.rmSync(BEAT, { force: true });

/** A PINNED tab renders no `.tab-title`, so its identity is left only in the
 *  `title` attribute — the same fallback pinned.mjs's strip() uses. Reading
 *  textContent alone reports '' for it, which would quietly turn "the pinned
 *  tab is still there" into an assertion about an empty string. */
const titles = (win) => win.evaluate(() => [...document.querySelectorAll('.tab:not(.add)')].map((t) =>
  (t.querySelector('.tab-title')?.textContent ?? t.getAttribute('title') ?? '')
    .replace(/[\u{1F4C1}▶×]/gu, '').replace(/\s+/g, ' ').trim()));
const tabCount = (win) => win.locator('.tab:not(.add)').count();
const modals = (win) => win.locator('.modal-backdrop').count();
const modalText = (win) => win.locator('.modal p').first().textContent().then((t) => t.trim()).catch(() => '');
const beats = () => (fs.existsSync(BEAT) ? fs.readFileSync(BEAT, 'utf8').length : 0);

/** Wait for a dialog, but never throw: a confirm that never rendered has to be
 *  reported by the assertion below as a FAIL, not thrown out of the run. */
const settleModal = async (win) => {
  await win.waitForSelector('.modal-backdrop', { timeout: 2500 }).catch(() => {});
  await win.waitForTimeout(200);
};

// EVERY interaction below is caught and given a short timeout, for the reason
// filemenu.mjs spells out: a regression makes some of these impossible (a tab
// that a broken guard already closed, a menu row that does not exist), and an
// escaping Playwright rejection would skip every remaining assertion, the
// summary and close() — reporting one stack trace instead of the list of things
// that broke. Nothing is asserted by a helper: each is followed by a PRE-STATE
// or an outcome check, so a click that silently did not happen still shows up
// as a FAIL naming what it was supposed to do.
const soft = (p) => p.catch(() => {});
const softClick = (loc, opts) => soft(loc.click({ timeout: 3000, ...opts }));

async function renameTab(win, i, name) {
  await softClick(win.locator('.tab:not(.add)').nth(i), { button: 'right' });
  await win.waitForTimeout(250);
  await softClick(win.locator('.ctx-item', { hasText: /^Rename$/ }).first());
  await win.waitForTimeout(200);
  await soft(win.locator('.tab-rename').fill(name, { timeout: 3000 }));
  await win.keyboard.press('Enter');
  await win.waitForTimeout(250);
}

async function tabMenu(win, i, itemText) {
  await softClick(win.locator('.tab:not(.add)').nth(i), { button: 'right' });
  await win.waitForTimeout(250);
  await softClick(win.locator('.ctx-item', { hasText: itemText }).first());
  await win.waitForTimeout(500);
  // A row that does not exist on this build leaves the menu open, and its
  // backdrop then swallows every later click — which would report as a
  // Playwright timeout somewhere unrelated instead of as the missing row.
  if (await win.locator('.ctx-backdrop').count()) await dismissMenu(win);
}

/** Every context-menu row with its ENABLED state — the disabled flag is the
 *  point, so text alone is not enough. Leaves the menu OPEN. */
const tabMenuEntries = async (win, i) => {
  await softClick(win.locator('.tab:not(.add)').nth(i), { button: 'right' });
  await win.waitForTimeout(250);
  return win.evaluate(() => [...document.querySelectorAll('.ctx-item')].map((el) => ({
    label: el.textContent.trim(), disabled: el.classList.contains('disabled'),
  })));
};
const dismissMenu = async (win) => { await win.mouse.click(4, 4); await win.waitForTimeout(200); };

async function groupMenu(win, itemText) {
  await softClick(win.locator('.group-label').first(), { button: 'right' });
  await win.waitForTimeout(250);
  await softClick(win.locator('.ctx-item', { hasText: itemText }).first());
  await win.waitForTimeout(500);
  // A row that does not exist on this build leaves the menu open, and its
  // backdrop then swallows every later click — which would report as a
  // Playwright timeout somewhere unrelated instead of as the missing row.
  if (await win.locator('.ctx-backdrop').count()) await dismissMenu(win);
}

/** Close the tab at flat index `i` with its own × button. */
const closeX = async (win, i) => {
  await softClick(win.locator('.tab:not(.add)').nth(i));
  await win.waitForTimeout(250);
  await softClick(win.locator('.tab:not(.add)').nth(i).locator('.close'));
  await win.waitForTimeout(400);
};

const clickCancel = async (win) => {
  await softClick(win.locator('.modal-actions button').first());
  await win.waitForTimeout(500);
};
const clickDanger = async (win) => {
  await softClick(win.locator('.modal button.danger'));
  await win.waitForTimeout(600);
};

/** The JS for a child that is SILENT on screen and visible only on disk. Never
 *  `echo`: a terminal echoes what you TYPE, so anything the command line
 *  contains is on screen before the command runs — the marker has to be
 *  produced by the child itself for its presence to mean anything. */
const posix = (p) => p.replace(/\\/g, '/');
const heartbeatJs = (file) =>
  `const fs=require('fs');setInterval(()=>fs.appendFileSync('${posix(file)}','tick'),300)`;
const markThenSleepJs = (file) =>
  `require('fs').writeFileSync('${posix(file)}','up');setTimeout(()=>{},600000)`;

/** Start a silent external child in the CURRENT terminal and wait until it has
 *  proved it is running by writing `mark`. Returns whether it did — folded into
 *  a PRE-STATE by every caller, so a child that never started shows up as a
 *  named failure instead of quietly making the next assertion vacuous. */
async function startSilentChild(win, mark) {
  fs.rmSync(mark, { force: true });
  await runInTerminal(win, `node -e "${markThenSleepJs(mark)}"`);
  for (let i = 0; i < 40 && !fs.existsSync(mark); i++) await win.waitForTimeout(250);
  return fs.existsSync(mark);
}

async function runInTerminal(win, line) {
  await win.locator('.pane:not([hidden]) .xterm-screen').click();
  await win.waitForTimeout(200);
  await win.keyboard.type(line);
  await win.waitForTimeout(200);
  await win.keyboard.press('Enter');
}

const openSpaceMenu = async (win) => {
  // The button TOGGLES, so clicking it on a dropdown a failed item click left
  // open would shut it — and the wait below would then blame the space menu for
  // the missing row somewhere upstream.
  if (!(await win.locator('.spacemenu-dropdown').count())) await softClick(win.locator('.spacemenu-btn'));
  await soft(win.waitForSelector('.spacemenu-dropdown', { timeout: 5000 }));
  await win.waitForTimeout(200);
};
const spaceMenuItems = (win) =>
  win.locator('.spacemenu-item').allTextContents().then((ts) => ts.map((t) => t.trim()));
const spaceName = (win) => win.locator('.spacemenu-name').textContent().then((t) => t.trim());
async function createSpace(win, name) {
  await openSpaceMenu(win);
  await win.locator('.spacemenu-item', { hasText: 'New empty space' }).click();
  await win.waitForSelector('.spacemenu-rename');
  await win.locator('.spacemenu-rename').fill(name);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(500);
}

// ===========================================================================
// Run 1
// ===========================================================================
const { app, win, close } = await launchApp({ userDataDir: PROFILE });
await win.waitForSelector('.entry');
await win.waitForTimeout(600);

/** Fire a native application-menu row by id (they are not in the DOM). */
const clickItem = (id) => app.evaluate(({ Menu }, wanted) => {
  const item = Menu.getApplicationMenu()?.getMenuItemById(wanted);
  if (!item) return false;
  item.click();
  return true;
}, id);

// Byte counter per ptyId, installed once. Doubles as the ptyId registry — the
// renderer never exposes a tab's ptyId, but every live pty announces itself.
await win.evaluate(() => {
  window.__pty = {};
  window.api.onPtyData((id, d) => { window.__pty[id] = (window.__pty[id] ?? 0) + d.length; });
});
const ptyIds = () => win.evaluate(() => Object.keys(window.__pty));
/** Nudge the pty's size twice and count what comes back. >0 ⇒ the handle is
 *  still in PtyManager and the process repainted; 0 ⇒ nothing is there. */
const ptyProbe = async (id) => {
  await win.evaluate((i) => { window.__pty[i] = 0; }, id);
  await win.evaluate((i) => window.api.ptyResize(i, 90, 25), id);
  await win.waitForTimeout(500);
  await win.evaluate((i) => window.api.ptyResize(i, 112, 32), id);
  await win.waitForTimeout(1500);
  return win.evaluate((i) => window.__pty[i] ?? 0, id);
};

// ---------------------------------------------------------------------------
// 1. Selectivity: a files tab must NOT prompt.
// ---------------------------------------------------------------------------
console.log('\n1. a files tab closes with no dialog');
{
  await win.click('.tab.add');
  await win.waitForTimeout(700);
  const before = await tabCount(win);
  await closeX(win, 1);
  await settleModal(win);
  check('closing a files tab raises NO confirm', (await modals(win)) === 0,
    `${await modals(win)} dialog(s): "${await modalText(win)}"`);
  const after = await tabCount(win);
  check('…and it closed on that one click', before === 2 && after === 1, `${before} → ${after}`);
}

// ---------------------------------------------------------------------------
// 2. A live SHELL: prompt, Cancel keeps the process, Continue kills it.
// ---------------------------------------------------------------------------
console.log('\n2. a shell running a SILENT child — the dialog, and the process behind it');
let shellId = null;
{
  await tabMenu(win, 0, 'Open Terminal');
  await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 20_000 }).catch(() => {});
  await win.waitForTimeout(1500);
  await win.evaluate(() => { document.querySelector('.pane:not([hidden]) .xterm').dataset.ceProbe = 'shell'; });

  // The heartbeat is the only witness to a process nobody is looking at — and
  // since KAN-100 it is also the child that makes this shell BUSY at all. An
  // external `node`, not a cmdlet loop: see the header note on why that
  // distinction is the difference between this section passing for the right
  // reason and passing for the wrong one.
  await runInTerminal(win, `node -e "${heartbeatJs(BEAT)}"`);
  await win.waitForTimeout(2500);
  const b0 = beats();
  await win.waitForTimeout(1200);
  check('PRE-STATE: the shell is genuinely running something (its heartbeat grows)',
    b0 > 0 && beats() > b0, `${b0} → ${beats()} bytes`);

  shellId = (await ptyIds())[0] ?? null;
  check('its pty announced itself, so the liveness probe has an id to aim at', !!shellId, String(shellId));

  const beforeTabs = await tabCount(win);
  await closeX(win, 1);
  await settleModal(win);
  // KAN-100's other half. The child prints NOTHING, so on pty bytes this shell
  // is indistinguishable from one sitting at an empty prompt — and 2b closes
  // exactly that with no dialog at all. Whatever decides between them cannot be
  // byte traffic.
  check('closing a shell running a SILENT child raises a confirm', (await modals(win)) === 1, `${await modals(win)}`);
  check('…naming the live terminal, not a generic "are you sure"',
    /terminal is still running/.test(await modalText(win)), await modalText(win));
  check('…and nothing has closed while the dialog is up',
    (await tabCount(win)) === beforeTabs, `${beforeTabs} → ${await tabCount(win)}`);

  await clickCancel(win);
  check('Cancel dismisses the dialog', (await modals(win)) === 0, `${await modals(win)}`);
  check('Cancel leaves the TAB', (await tabCount(win)) === beforeTabs, `${beforeTabs} → ${await tabCount(win)}`);
  check('Cancel leaves the very same xterm INSTANCE, never a remount',
    (await win.evaluate(() => document.querySelector('.xterm')?.dataset.ceProbe ?? null)) === 'shell');

  const b1 = beats();
  await win.waitForTimeout(2000);
  check('CANCEL LEFT THE PTY ALIVE — the heartbeat is still growing',
    beats() > b1, `${b1} → ${beats()} bytes`);
  const aliveBytes = await ptyProbe(shellId);
  check('the resize probe agrees with the heartbeat: this pty is ALIVE',
    aliveBytes > 0, `${aliveBytes} bytes back from a resize`);

  // Continue: the other half of the two-sided proof. Without it, "still alive
  // after Cancel" is satisfied by a close path that never worked at all.
  await closeX(win, 1);
  await settleModal(win);
  check('the same × prompts again', (await modals(win)) === 1, `${await modals(win)}`);
  await clickDanger(win);
  check('Continue closes the tab', (await tabCount(win)) === beforeTabs - 1,
    `${beforeTabs} → ${await tabCount(win)}`);
  const b2 = beats();
  await win.waitForTimeout(2000);
  check('…and kills the pty — the heartbeat stopped', beats() === b2, `${b2} → ${beats()} bytes`);
  const deadBytes = await ptyProbe(shellId);
  check('the resize probe reads DEAD for the same id — so it discriminates',
    deadBytes === 0, `${deadBytes} bytes back from a resize`);
}

// ---------------------------------------------------------------------------
// 2b. KAN-100: a shell at an IDLE PROMPT closes with no dialog.
//
// `closeRisk` measured a shell's risk as "a pty exists and has not exited",
// which is true from spawn until exit — so every shell close in the app was
// confirmed, which is precisely the click-through training closeguard.ts's own
// doctrine exists to prevent. This is the same tab section 2 builds, by the
// same route, differing only in that nothing is running in it.
//
// THE PRE-STATE IS LOAD-BEARING. "No dialog" is also what a tab with no process
// at all looks like, and a broken spawn would satisfy this section for entirely
// the wrong reason — so the pty is proved ALIVE with the resize probe section 2
// calibrated against the heartbeat, immediately before the close.
// ---------------------------------------------------------------------------
console.log('\n2b. a shell at an idle prompt closes with NO dialog (KAN-100)');
{
  const known = new Set(await ptyIds());
  await tabMenu(win, 0, 'Open Terminal');
  await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 20_000 }).catch(() => {});
  await win.waitForTimeout(3000);   // let PowerShell reach its prompt

  const idleId = (await ptyIds()).find((id) => !known.has(id)) ?? null;
  const aliveBytes = idleId ? await ptyProbe(idleId) : 0;
  check('PRE-STATE: this shell has a LIVE pty — so a missing dialog is the guard, not a dead tab',
    !!idleId && aliveBytes > 0, `id=${idleId}, ${aliveBytes} bytes back from a resize`);

  const beforeTabs = await tabCount(win);
  await closeX(win, 1);
  await settleModal(win);
  check('closing a shell AT AN IDLE PROMPT raises NO confirm',
    (await modals(win)) === 0, `${await modals(win)} dialog(s): "${await modalText(win)}"`);
  check('…and it closed on that one click', (await tabCount(win)) === beforeTabs - 1,
    `${beforeTabs} → ${await tabCount(win)}`);
  check('…and its pty really is gone, so the silent close was a close',
    (idleId ? await ptyProbe(idleId) : 1) === 0);
}

// ---------------------------------------------------------------------------
// 3. A live CLAUDE tab. One real spawn; it never has to finish starting.
// ---------------------------------------------------------------------------
console.log('\n3. a live Claude tab');
{
  const known = new Set(await ptyIds());
  await win.click('.tab.add');
  await win.waitForTimeout(700);
  await win.waitForSelector('.entry-open', { timeout: 10_000 }).catch(() => {});
  await win.locator('.entry-open').first().click();
  await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 30_000 }).catch(() => {});

  let claudeId = null;
  for (let i = 0; i < 40 && !claudeId; i++) {
    await win.waitForTimeout(500);
    claudeId = (await ptyIds()).find((id) => !known.has(id)) ?? null;
  }
  check('a Claude pty spawned and is producing output', !!claudeId, String(claudeId));
  check('the tab renders as a Claude terminal (the status dot, not a folder glyph)',
    (await win.locator('.tab:not(.add)').nth(1).locator('.tab-status').count()) === 1);
  await win.evaluate(() => { document.querySelector('.pane:not([hidden]) .xterm').dataset.ceProbe = 'claude'; });

  const beforeTabs = await tabCount(win);
  await closeX(win, 1);
  await settleModal(win);
  check('closing a LIVE Claude tab raises a confirm', (await modals(win)) === 1, `${await modals(win)}`);
  check('…naming the Claude session and the unsaved scrollback',
    /Claude session is still running/.test(await modalText(win)), await modalText(win));
  check('…and nothing has closed while the dialog is up',
    (await tabCount(win)) === beforeTabs, `${beforeTabs} → ${await tabCount(win)}`);

  await clickCancel(win);
  check('Cancel leaves the Claude TAB', (await tabCount(win)) === beforeTabs,
    `${beforeTabs} → ${await tabCount(win)}`);
  check('Cancel leaves the very same xterm INSTANCE',
    (await win.evaluate(() => document.querySelector('.pane:not([hidden]) .xterm')?.dataset.ceProbe ?? null)) === 'claude');
  const alive = claudeId ? await ptyProbe(claudeId) : 0;
  check('CANCEL LEFT THE CLAUDE PTY ALIVE — a resize still comes back',
    alive > 0, `${alive} bytes`);

  await closeX(win, 1);
  await settleModal(win);
  await clickDanger(win);
  check('Continue closes the Claude tab', (await tabCount(win)) === beforeTabs - 1,
    `${beforeTabs} → ${await tabCount(win)}`);
  await win.waitForTimeout(1500);
  const dead = claudeId ? await ptyProbe(claudeId) : 1;
  check('…and its pty is gone', dead === 0, `${dead} bytes`);
}

// ---------------------------------------------------------------------------
// 4. Pinned means un-closable — context menu AND the native File menu.
// ---------------------------------------------------------------------------
console.log('\n4. a pinned tab refuses to close');
{
  for (let i = 0; i < 2; i++) { await win.click('.tab.add'); await win.waitForTimeout(700); }
  await renameTab(win, 0, 'A');
  await renameTab(win, 1, 'P');
  await renameTab(win, 2, 'B');
  await tabMenu(win, 1, 'Pin tab');
  const before = await tabCount(win);
  check('PRE-STATE: three tabs, P pinned and at the head of the strip',
    before === 3 && (await win.locator('.tab.pinned').count()) === 1
    && (await win.locator('.tab:not(.add)').nth(0).getAttribute('title')) === 'P',
    `${before} tabs, title="${await win.locator('.tab:not(.add)').nth(0).getAttribute('title')}"`);

  const entries = await tabMenuEntries(win, 0);
  const closeItem = entries.find((e) => e.label === 'Close');
  check('the pinned tab still OFFERS Close, greyed — the refusal explains itself where it happens',
    !!closeItem && closeItem.disabled === true, JSON.stringify(closeItem ?? entries.map((e) => e.label)));
  await softClick(win.locator('.ctx-item', { hasText: /^Close$/ }).first());
  await win.waitForTimeout(400);
  await dismissMenu(win);
  check('CLICKING it closes nothing', (await tabCount(win)) === before
    && (await win.locator('.tab.pinned').count()) === 1, `${before} → ${await tabCount(win)}`);
  check('…and raised no dialog either — it is a refusal, not a question',
    (await modals(win)) === 0, `${await modals(win)}`);

  // --- the native File ▸ Close Tab route (Ctrl+W), driven from main ---------
  await softClick(win.locator('.tab:not(.add)').nth(0));
  await win.waitForTimeout(300);
  check('PRE-STATE: the pinned tab is the ACTIVE one, so Ctrl+W is aimed at it',
    (await win.locator('.tab.active.pinned').count()) === 1);
  const fired = await clickItem('file:close-tab');
  await win.waitForTimeout(700);
  check('File ▸ Close Tab (Ctrl+W) closes NOTHING while a pinned tab is focused',
    fired && (await tabCount(win)) === before && (await win.locator('.tab.pinned').count()) === 1,
    `fired=${fired}, ${before} → ${await tabCount(win)}`);
  check('…and it did not take an innocent bystander instead',
    (await titles(win)).sort().join('|') === 'A|B|P', (await titles(win)).join(' | '));

  // Positive control for BOTH refusals: unpin, and the same two routes work.
  await tabMenu(win, 0, 'Unpin tab');
  await softClick(win.locator('.tab:not(.add)').nth(0));
  await win.waitForTimeout(300);
  await clickItem('file:close-tab');
  await win.waitForTimeout(800);
  check('POSITIVE CONTROL: unpinned, the very same Ctrl+W closes it',
    (await tabCount(win)) === before - 1 && !(await titles(win)).includes('P'),
    (await titles(win)).join(' | '));
}

// ---------------------------------------------------------------------------
// 5. "Close group's tabs" asks ONCE.
// ---------------------------------------------------------------------------
console.log("\n5. Close group's tabs — one dialog for the whole group");
{
  // KAN-100: each shell needs something actually RUNNING in it, or the group
  // close is all-idle and correctly raises no dialog at all — which would leave
  // this section asserting nothing about asking once.
  const started = [];
  for (let i = 0; i < 2; i++) {
    await tabMenu(win, 0, 'Open Terminal');
    await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 20_000 }).catch(() => {});
    await win.waitForTimeout(2500);
    started.push(await startSilentChild(win, `${BEAT}.g${i}`));
  }
  await renameTab(win, 2, 'S1');
  await renameTab(win, 3, 'S2');
  await tabMenu(win, 1, 'New group from this tab');   // B
  await tabMenu(win, 2, /^Add to /);                  // S1
  await tabMenu(win, 3, /^Add to /);                  // S2
  const before = await tabCount(win);
  const grouped = await win.evaluate(() => document.querySelectorAll('.tabgroup .tab').length);
  check('PRE-STATE: a 3-tab group, two of them shells with a silent child running',
    before === 4 && grouped === 3 && started.every(Boolean),
    `${before} tabs, ${grouped} in the group, children started=${JSON.stringify(started)}`);

  await groupMenu(win, "Close group's tabs");
  await settleModal(win);
  check('the group close asks EXACTLY ONCE, not once per tab', (await modals(win)) === 1,
    `${await modals(win)} dialog(s)`);
  check('…and the sentence counts the batch and the live members',
    /^Close 3 tabs\? 2 are live terminals/.test(await modalText(win)), await modalText(win));
  check('…with nothing closed while it is open', (await tabCount(win)) === before,
    `${before} → ${await tabCount(win)}`);

  await clickCancel(win);
  check('Cancel is ALL-OR-NOTHING — even the tab that carried no risk is still open',
    (await tabCount(win)) === before && (await titles(win)).sort().join('|') === 'A|B|S1|S2',
    (await titles(win)).join(' | '));

  await groupMenu(win, "Close group's tabs");
  await settleModal(win);
  await clickDanger(win);
  check('ONE Continue closes all three — no second dialog is waiting behind it',
    (await tabCount(win)) === 1 && (await modals(win)) === 0,
    `${await tabCount(win)} tab(s) left, ${await modals(win)} dialog(s)`);
}

// ---------------------------------------------------------------------------
// 6. A pinned space offers no Delete.
// ---------------------------------------------------------------------------
console.log('\n6. a pinned space');
{
  await createSpace(win, 'Two');
  await win.click('.tabbar');
  await win.waitForTimeout(150);
  await win.keyboard.press('Control+1');
  await win.waitForTimeout(700);
  await tabMenu(win, 0, 'Pin tab');   // leave a pinned TAB here for run 2

  await openSpaceMenu(win);
  const before = await spaceMenuItems(win);
  await win.keyboard.press('Escape');
  await win.waitForTimeout(200);
  check('PRE-STATE: two spaces exist, so Delete is on offer at all',
    (await spaceName(win)) === 'Space' && before.includes('Delete') && before.includes('Pin space'),
    before.join(' | '));

  await openSpaceMenu(win);
  await softClick(win.locator('.spacemenu-item', { hasText: /^Pin space$/ }));
  await win.waitForTimeout(400);
  await openSpaceMenu(win);
  const after = await spaceMenuItems(win);
  await win.keyboard.press('Escape');
  await win.waitForTimeout(200);
  check('a PINNED space offers no Delete', !after.includes('Delete'), after.join(' | '));
  check('…and offers Unpin space instead, so the state is visible and one click from reversible',
    after.includes('Unpin space'), after.join(' | '));

  await win.waitForTimeout(1600); // 400ms persist debounce + margin
  await close();
}

// ===========================================================================
// Run 2 — same profile, fresh process: did both pins survive?
// ===========================================================================
console.log('\n7. after a restart');
{
  const { win, close } = await launchApp({ userDataDir: PROFILE });
  await win.waitForSelector('.tab:not(.add)');
  await win.waitForTimeout(1800);

  check('the pinned TAB came back pinned — icon-only, no close button',
    (await win.locator('.tab.pinned').count()) === 1
    && (await win.locator('.tab:not(.add)').nth(0).locator('.close').count()) === 0,
    `${await win.locator('.tab.pinned').count()} pinned`);

  await openSpaceMenu(win);
  const items = await spaceMenuItems(win);
  const spaces = (await win.locator('.spacemenu-item-name').allTextContents()).map((t) => t.trim());
  await win.keyboard.press('Escape');
  await win.waitForTimeout(200);
  check('both spaces came back, so Delete is not merely hidden by the last-space floor',
    spaces.join('|') === 'Space|Two', spaces.join(' | '));
  check('the SPACE pin survived the restart — still no Delete, still Unpin space',
    !items.includes('Delete') && items.includes('Unpin space'), items.join(' | '));

  // Positive control: the absence of Delete is the PIN, not a broken menu.
  await openSpaceMenu(win);
  await softClick(win.locator('.spacemenu-item', { hasText: /^Unpin space$/ }));
  await win.waitForTimeout(400);
  await openSpaceMenu(win);
  const unpinned = await spaceMenuItems(win);
  await win.keyboard.press('Escape');
  check('POSITIVE CONTROL: unpinning the space brings Delete back',
    unpinned.includes('Delete') && !unpinned.includes('Unpin space'), unpinned.join(' | '));

  await close();
}

// ===========================================================================
// Run 3 — a fresh profile, two spaces. Both of these are review findings.
// ===========================================================================
{
  const PROFILE3 = path.join(os.tmpdir(), `claude-explorer-confirm3-${process.pid}`);
  fs.rmSync(PROFILE3, { recursive: true, force: true });
  const { win, close } = await launchApp({ userDataDir: PROFILE3 });
  await win.waitForSelector('.entry');
  await win.waitForTimeout(600);

  /** The three numbers that say whether the window body is showing anything. */
  const shape = () => win.evaluate(() => ({
    strip: document.querySelectorAll('.tab:not(.add)').length,
    panes: document.querySelectorAll('.pane:not([hidden])').length,
    active: document.querySelectorAll('.tab.active').length,
    modals: document.querySelectorAll('.modal-backdrop').length,
    space: document.querySelector('.spacemenu-name')?.textContent?.trim() ?? '',
  }));
  const toSpace = async (n) => {
    await win.click('.tabbar');
    await win.waitForTimeout(150);
    await win.keyboard.press(`Control+${n}`);
    await win.waitForTimeout(800);
  };

  // -------------------------------------------------------------------------
  // 8. Switching space while the confirm is up must not blank the origin space.
  //
  // A confirm OUTLIVES the render that opened it, and Ctrl+1..9 is live while it
  // is up (KAN-59 made it live over a focused terminal too; it was always live
  // over the modal's own Cancel button). Continue then ran `closeTab` against
  // WHICHEVER SPACE WAS ACTIVE BY THEN, so the origin space kept the dead id in
  // `tabIds`, in its layout cell and as its remembered `activeTabId` — and
  // coming back to it focused a tab that no longer existed:
  //   BACK IN SPACE 1: {"strip":1,"panes":0,"active":0}  ← blank window body.
  // The mechanism pre-dates KAN-57 (the control channel could reach it), but
  // this is the route a human can walk.
  // -------------------------------------------------------------------------
  console.log('\n8. switching space with the confirm still open');
  {
    await tabMenu(win, 0, 'Open Terminal');
    await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 20_000 }).catch(() => {});
    await win.waitForTimeout(2500);
    // KAN-100: this section needs the close to RAISE the confirm, so the shell
    // has to be running something. Silent, external — see the header note.
    const ran = await startSilentChild(win, `${BEAT}.s8`);
    await createSpace(win, 'Two');   // lands ON Two
    await toSpace(1);
    const before = await shape();
    check('PRE-STATE: space 1 shows a files tab, a busy shell, and a pane',
      before.strip === 2 && before.panes === 1 && before.active === 1 && before.space === 'Space' && ran,
      `${JSON.stringify(before)} child=${ran}`);

    await closeX(win, 1);
    await settleModal(win);
    check('PRE-STATE: closing the busy shell raised the confirm', (await modals(win)) === 1,
      JSON.stringify(await shape()));

    await win.keyboard.press('Control+2');   // focus is the modal's Cancel button
    await win.waitForTimeout(700);
    const away = await shape();
    check('PRE-STATE: Ctrl+2 switched space with the dialog still up',
      away.space === 'Two' && away.modals === 1, JSON.stringify(away));

    await clickDanger(win);
    await toSpace(1);
    const back = await shape();
    check('BACK IN THE ORIGIN SPACE: the surviving tab is on screen, not a blank window body',
      back.panes === 1 && back.active === 1, JSON.stringify(back));
    check('…and the confirm still closed the tab it was asked about',
      back.strip === 1 && back.space === 'Space', JSON.stringify(back));
  }

  // -------------------------------------------------------------------------
  // 9. Deleting a space closes its PINNED tabs — and the confirm says so.
  //
  // The BEHAVIOUR is deliberate and stays: a space delete is explicit, already
  // behind its own dialog, and the tool for "do not delete this" is pinning the
  // SPACE. What was wrong is that it happened silently while every other close
  // route in the app refuses a pinned tab. The sentence is the fix.
  // -------------------------------------------------------------------------
  console.log('\n9. deleting a space names the pinned tabs it will close');
  {
    await toSpace(2);
    await win.click('.tab.add');
    await win.waitForTimeout(700);
    await tabMenu(win, 0, 'Open Terminal');
    await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 20_000 }).catch(() => {});
    await win.waitForTimeout(3000);   // let PowerShell reach its prompt
    await tabMenu(win, 0, 'Pin tab');
    const pre = await shape();
    check('PRE-STATE: «Two» holds 2 tabs, one pinned and one a shell at an idle prompt',
      pre.space === 'Two' && pre.strip === 2
      && (await win.locator('.tab.pinned').count()) === 1,
      `${JSON.stringify(pre)} pinned=${await win.locator('.tab.pinned').count()}`);

    // KAN-100 reaches the SPACE DELETE too, and that is not incidental:
    // deleteSpaceReason consumes the very same CloseRisk[] as the close confirm,
    // so a fix that lived at the close call site instead of in closeRisk would
    // leave this sentence calling an idle prompt "a live terminal".
    await openSpaceMenu(win);
    await softClick(win.locator('.spacemenu-item', { hasText: /^Delete$/ }));
    await settleModal(win);
    const idle = await modalText(win);
    check('the delete confirm does NOT call an idle shell live work (KAN-100)',
      /^Delete «Two» and close its 2 tabs\? 1 is pinned/.test(idle), idle);
    check('…while still admitting it will close the pinned tab',
      /1 is pinned — deleting the space closes it anyway\./.test(idle), idle);

    // POSITIVE CONTROL. Without this, "no live clause" is equally satisfied by a
    // sentence that lost the ability to say it at all. Same space, same tabs —
    // only a running child is added.
    await clickCancel(win);
    await softClick(win.locator('.tab:not(.add)').nth(1));
    await win.waitForTimeout(400);
    const ran = await startSilentChild(win, `${BEAT}.s9`);
    await openSpaceMenu(win);
    await softClick(win.locator('.spacemenu-item', { hasText: /^Delete$/ }));
    await settleModal(win);
    const busy = await modalText(win);
    check('POSITIVE CONTROL: with a silent child running, the live clause comes back',
      ran && /^Delete «Two» and close its 2 tabs\? 1 is a live terminal, and that work is not saved anywhere\./
        .test(busy), `child=${ran} ${busy}`);
    check('…and the pinned clause is still there alongside it',
      /1 is pinned — deleting the space closes it anyway\./.test(busy), busy);

    await clickDanger(win);
    await win.waitForTimeout(800);
    const after = await shape();
    check('and it does: the pinned tab went with the space (the decision, asserted)',
      after.space === 'Space' && (await win.locator('.tab.pinned').count()) === 0,
      `${JSON.stringify(after)} pinned=${await win.locator('.tab.pinned').count()}`);
  }

  await close();
  fs.rmSync(PROFILE3, { recursive: true, force: true });
}

fs.rmSync(BEAT, { force: true });
for (const suffix of ['.g0', '.g1', '.s8', '.s9']) fs.rmSync(`${BEAT}${suffix}`, { force: true });
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
