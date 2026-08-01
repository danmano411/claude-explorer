// KAN-83 — customizable space keybinds: the capture UI, its refuse/warn
// conflict handling, and the pair of assertions the ticket calls out as most
// likely to be skipped and most important: a REBOUND key must switch spaces
// AND be suppressed in the terminal, in the SAME already-open tab, with no
// app restart — otherwise this re-ships KAN-59 (the app switches AND the pty
// gets a control byte) for any binding other than the hardcoded default.
//
//   npm run build && node test/harness/keybinds.mjs
//
// RED-FIRST: run against `feat/kan-81-pinned-keys` (this ticket's base) —
// `git checkout <that sha> -- src/` (never `git stash`, which is
// repository-global here), rebuild, run. There is no Keybinds section on that
// branch at all, so §1-§4's selectors fail outright and §6 — the sharpest
// single proof — has no rebind to make in the first place: pressing Alt+3
// does nothing, and Ctrl+3 still both switches AND leaks its ESC (or would,
// if KAN-59/KAN-82 were also reverted; on the base branch as it stands,
// Ctrl+3 switches and is correctly suppressed — it is the REBOUND chord that
// has no equivalent to fall back on).
//
// Split from paste.mjs (which already covers the unmodified Ctrl+1..9 /
// Ctrl+Shift+1..9 / Ctrl+Tab pair exhaustively) rather than folding in:
// this file's whole reason to exist is a binding paste.mjs's fixtures never
// produce — one the Settings modal wrote a moment ago, in-process, no restart.
//
// Same pty:write spy paste.mjs uses (an ADDITIVE `ipcMain.on`, so the app's
// own handler still runs): the terminal echoes what it is SENT, not what the
// user typed, so watching the wire is the only way to tell "suppressed" from
// "not yet visible".
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// Throwaway, pid-suffixed profile — the single-instance lock is keyed on
// userData and this repo runs several worktrees at once.
const PROFILE = path.join(os.tmpdir(), `ce-k83-kb-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
const SETTINGS = path.join(PROFILE, 'settings.json');
const onDisk = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return null; } };

const VIS = '.pane:not([hidden]) ';

const { app, win, close } = await launchApp({ userDataDir: PROFILE });
win.on('pageerror', (e) => console.log('  [pageerror]', e.message));

await app.evaluate(({ ipcMain }) => {
  globalThis.__ceWrites = [];
  ipcMain.on('pty:write', (_e, id, data) => globalThis.__ceWrites.push({ id, data }));
});
const allWrites = () => app.evaluate(() => globalThis.__ceWrites);
const mark = async () => (await allWrites()).length;
const sentTo = async (ptyId, from) => (await allWrites()).slice(from).filter((m) => m.id === ptyId);
const printable = (s) => JSON.stringify(s).replace(/\\u001b/g, 'ESC').replace(/\x7f/g, 'DEL');
// A hidden pane's terminal blurs and, with focus reporting on, reports it as
// ESC[I/ESC[O — a consequence of the SWITCH, not of the keystroke that caused
// it. Lifted from paste.mjs's §11, which calibrates this filter against a
// mouse-driven switch before relying on it; not re-calibrated here since
// nothing about that mechanism is this ticket's to change.
const nonFocus = (sent) => sent.map((m) => m.data).join('').replace(/\x1b\[[IO]/g, '');

const visiblePty = () => win.evaluate(() =>
  [...document.querySelectorAll('[data-pty]')].find((el) => !el.closest('.pane[hidden]'))?.dataset.pty);
async function focusTerm() {
  await win.locator(`${VIS}.xterm-screen`).click();
  await win.waitForTimeout(150);
}
async function clearLine() {
  await focusTerm();
  await win.keyboard.press('Control+c');
  await win.waitForTimeout(400);
}
async function tabMenu(i, itemText) {
  await win.locator('.tab:not(.add)').nth(i).click({ button: 'right' });
  await win.waitForTimeout(250);
  await win.locator('.ctx-item', { hasText: itemText }).first().click();
  await win.waitForTimeout(600);
}
const spaceName = () => win.locator('.spacemenu-name').textContent().then((t) => t.trim());
const openSpaceMenu = async () => {
  await win.click('.spacemenu-btn');
  await win.waitForSelector('.spacemenu-dropdown');
  await win.waitForTimeout(150);
};
async function createSpace(name) {
  await openSpaceMenu();
  await win.locator('.spacemenu-item', { hasText: 'New empty space' }).click();
  await win.waitForSelector('.spacemenu-rename');
  await win.locator('.spacemenu-rename').fill(name);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(600);
}
async function switchSpaceViaMenu(name) {
  await openSpaceMenu();
  await win.locator('.spacemenu-item-name', { hasText: name }).first().click();
  await win.waitForTimeout(600);
}

// Same replay-the-real-event mechanism allowanceui.mjs/autolink.mjs/mcp.mjs
// use to open Settings — NOT a simulated Ctrl+, keypress, because that IS an
// Electron-native menu accelerator (menu.ts) and would be just as likely to
// be swallowed before this renderer ever saw it as the ones §4's comment
// below explains staying away from.
const openSettings = async () => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'open-settings');
  });
  await win.waitForSelector('.modal', { timeout: 5_000 });
};
const saveSettings = async () => {
  await win.locator('.modal-actions button.primary').click();
  await win.waitForSelector('.modal', { state: 'detached', timeout: 5_000 });
  await win.waitForTimeout(300);
};
const cancelSettings = async () => {
  await win.locator('.modal-actions button:not(.primary)').click();
  await win.waitForSelector('.modal', { state: 'detached', timeout: 5_000 });
};
const keybindValue = (win_) => (action) => win_.locator(`[data-keybind="${action}"] .keybind-value`).textContent();
const changeBtn = (action) => win.locator(`[data-keybind="${action}"] button`).first();
const resetBtn = (action) => win.locator(`[data-keybind="${action}"] button`).nth(1);
const keybindValueOf = keybindValue(win);
const keybindMsg = () => win.locator('.keybind-warning').textContent().catch(() => null);

console.log('\n0. a plain shell terminal');
await win.waitForSelector('.entry');
await win.waitForTimeout(400);
await tabMenu(0, 'Open Terminal');
await win.waitForSelector(`${VIS}.xterm`, { timeout: 20_000 });
await win.waitForTimeout(2500);
const shellPty = await visiblePty();
check('a shell terminal is up and has a ptyId', !!shellPty, `pty ${shellPty}`);

console.log('\n1. the Keybinds section shows today\'s hardcoded defaults');
{
  await openSettings();
  check('switch-to-space: Ctrl+1..9', (await keybindValueOf('switchUnpinned')) === 'Ctrl+1..9',
    await keybindValueOf('switchUnpinned'));
  check('switch-to-pinned: Ctrl+Shift+1..9', (await keybindValueOf('switchPinned')) === 'Ctrl+Shift+1..9',
    await keybindValueOf('switchPinned'));
  check('next space: Ctrl+Tab', (await keybindValueOf('cycleNext')) === 'Ctrl+Tab',
    await keybindValueOf('cycleNext'));
  check('previous space: Ctrl+Shift+Tab', (await keybindValueOf('cyclePrev')) === 'Ctrl+Shift+Tab',
    await keybindValueOf('cyclePrev'));
  await cancelSettings();
}

console.log('\n2. capture-a-keystroke: Escape cancels, a bare digit is refused, a real rebind sticks');
{
  await openSettings();

  await changeBtn('switchUnpinned').click();
  await win.keyboard.press('Escape');
  await win.waitForTimeout(200);
  check('Escape cancels a capture without changing anything',
    (await keybindValueOf('switchUnpinned')) === 'Ctrl+1..9', await keybindValueOf('switchUnpinned'));

  await changeBtn('switchUnpinned').click();
  await win.keyboard.press('3'); // no modifier held at all
  await win.waitForTimeout(200);
  check('a bare digit with no modifier is REFUSED, not silently accepted as "no modifier required"',
    /modifier/i.test((await keybindMsg()) ?? ''), String(await keybindMsg()));
  await win.keyboard.press('Escape');
  await win.waitForTimeout(200);

  await changeBtn('switchUnpinned').click();
  await win.keyboard.press('Alt+3');
  await win.waitForTimeout(200);
  check('capturing Alt+3 rebinds switch-to-space to Alt — the digit pressed is discarded, only the mods are kept',
    (await keybindValueOf('switchUnpinned')) === 'Alt+1..9', await keybindValueOf('switchUnpinned'));
}

console.log('\n3. duplicate refusal (acceptance #5): switch-to-pinned cannot claim switch-to-space\'s new Alt');
{
  await changeBtn('switchPinned').click();
  await win.keyboard.press('Alt+5');
  await win.waitForTimeout(200);
  check('rebinding switch-to-pinned onto Alt (switch-to-space\'s CURRENT, just-captured mods) is refused',
    /already/i.test((await keybindMsg()) ?? ''), String(await keybindMsg()));
  check('and switch-to-pinned keeps its old value — a refusal must not save anything',
    (await keybindValueOf('switchPinned')) === 'Ctrl+Shift+1..9', await keybindValueOf('switchPinned'));
}

console.log('\n4. warn-but-allow a known app shortcut, then Reset');
{
  // Ctrl+F, not Ctrl+T/Ctrl+W/Ctrl+Shift+D/Ctrl+Shift+G: those four are either
  // Electron-native menu accelerators (menu.ts) or App.tsx's OWN capture-phase
  // grid-picker listener, registered before this modal's and liable to
  // consume the press (or have it consumed at the OS/Electron layer) before
  // this capture-recorder ever sees it — see knownAppShortcut's doc in
  // keys.ts for the caveat this harness is deliberately built around rather
  // than tripped by. Ctrl+F (FileBrowser's search box) is a plain bubble-
  // phase React handler on an inner element, which this modal's
  // capture-phase, stopPropagation-ing listener reliably pre-empts.
  await changeBtn('cycleNext').click();
  await win.keyboard.press('Control+f');
  await win.waitForTimeout(200);
  check('rebinding "next space" onto Ctrl+F WARNS that it collides with Search...',
    /Search/i.test((await keybindMsg()) ?? ''), String(await keybindMsg()));
  check('...but SAVES it anyway — warn, not refuse, for a known app shortcut',
    (await keybindValueOf('cycleNext')) === 'Ctrl+F', await keybindValueOf('cycleNext'));

  await resetBtn('cycleNext').click();
  check('Reset restores the built-in default (acceptance #3)',
    (await keybindValueOf('cycleNext')) === 'Ctrl+Tab', await keybindValueOf('cycleNext'));
}

console.log('\n5. Save persists the Alt rebind to settings.json — no restart has happened yet');
await saveSettings();
check('settings.json now stores the Alt-only switchUnpinned override',
  JSON.stringify(onDisk()?.spaceKeybinds?.switchUnpinned) === JSON.stringify({ alt: true }),
  JSON.stringify(onDisk()?.spaceKeybinds));

// ===========================================================================
console.log('\n6. THE pair that matters: a REBOUND key switches AND is suppressed in the ALREADY-OPEN terminal');
// ===========================================================================
{
  // Same shell tab that has been open since §0 — proving "no restart" means
  // proving it against a terminal that predates the Save, not a fresh one.
  await createSpace('Beta');
  await createSpace('Gamma');            // three spaces: (Alt|Ctrl)+3 now has a target
  await switchSpaceViaMenu('Space');
  await clearLine();

  {
    const from = await mark();
    await focusTerm();
    await win.keyboard.press('Alt+3');
    await win.waitForTimeout(700);
    const sent = await sentTo(shellPty, from);
    check('Alt+3 — the REBOUND key, saved seconds ago with the app never restarted — switches to the third space',
      (await spaceName()) === 'Gamma', await spaceName());
    check('and the pty in that SAME tab receives NOTHING for it: Terminal.tsx suppresses the CURRENT binding',
      nonFocus(sent) === '', `${sent.length} pty:write — ${printable(sent.map((m) => m.data).join(''))}`);
  }

  {
    // The other half of "replaced, not widened": if Terminal.tsx (or App.tsx)
    // still carried the OLD Ctrl-only chord alongside the new Alt one, Ctrl+3
    // would ALSO still switch, and/or still have its byte suppressed. Neither
    // should be true any more — this is what tells a real rebind apart from
    // an accidentally ADDITIONAL one.
    await switchSpaceViaMenu('Space');
    await focusTerm();
    const from = await mark();
    await win.keyboard.press('Control+3');
    await win.waitForTimeout(700);
    const sent = await sentTo(shellPty, from);
    check('the OLD default Ctrl+3 no longer switches spaces — the rebind REPLACED it rather than adding to it',
      (await spaceName()) === 'Space', await spaceName());
    check('and Ctrl+3 now reaches the pty as an ordinary control byte — Terminal.tsx stopped suppressing THAT chord',
      nonFocus(sent) !== '', `${sent.length} pty:write — ${printable(sent.map((m) => m.data).join(''))}`);
  }
}

await close();
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* %TEMP% */ }
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
