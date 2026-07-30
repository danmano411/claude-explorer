// KAN-50: the terminal renders horizontally misaligned until you switch tabs.
//   npm run build && node test/harness/termsize.mjs
//
// The invariant under test is a two-sided one, so both sides are read from
// outside the code that maintains them:
//
//   xterm's side  — `data-cols` / `data-rows` on the `.terminal` element, written
//                   by xterm's OWN onResize event (Terminal.tsx's test seam), so
//                   it reports the grid and not the function that reports the grid.
//   the pty's side — an extra `ipcMain.on('pty:resize')` listener installed in the
//                   real main process. Every message the renderer sends, in order.
//
// Two claims:
//
//   (a) AFTER ANY RESIZE SETTLES the two agree — spawn, window resize, tab switch
//       away and back, space switch away and back, and a divider drag. This is
//       the regression guard; it held before the fix too.
//   (b) EVERY SIZE THE PTY IS TOLD IS ONE THE TERMINAL CAME TO REST AT. This is
//       the bug. A drag used to push one `ptyResize` per animation frame, so a
//       one-second drag handed the pty ~30 widths in ~500ms and ConPTY re-emitted
//       its whole screen buffer at each. All but the last were widths the
//       terminal had already moved past; a TUI that samples its width per frame
//       can render at one of them and stay wrapped to a column the viewport no
//       longer has. Nothing repaints it — which is why a tab switch, whose own
//       resize forces a repaint, looked like a cure.
//       Reverting the fix fails this and only this.
//
// A plain PowerShell tab, not Claude: the claim is about the xterm/pty seam,
// which is identical either way, and this costs no tokens and no CLI startup.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const PROFILE = path.join(os.tmpdir(), `claude-explorer-termsize-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

const { app, win, close } = await launchApp({ userDataDir: PROFILE });
win.on('pageerror', (e) => console.log('  [pageerror]', e.message));

// The pty's side. A second listener on the real channel — ipcMain.on is additive,
// so the app's own handler still runs and this observes exactly what it receives.
await app.evaluate(({ ipcMain }) => {
  globalThis.__ceResizes = [];
  ipcMain.on('pty:resize', (_e, id, cols, rows) => globalThis.__ceResizes.push({ id, cols, rows }));
});
const allSent = () => app.evaluate(() => globalThis.__ceResizes);
const markSent = async () => (await allSent()).length;
/** Everything the pty was told since `from`. */
const sentSince = async (from) => (await allSent()).slice(from);

/** xterm's side, per mounted terminal. */
const gridsOf = () => win.evaluate(() => [...document.querySelectorAll('[data-cols]')].map((el) => ({
  cols: +el.dataset.cols, rows: +el.dataset.rows, hidden: !!el.closest('.pane[hidden]'),
})));

/** (a) for the one terminal on screen. */
async function agrees(label) {
  const [g] = (await gridsOf()).filter((x) => !x.hidden);
  const sent = await allSent();
  const last = sent[sent.length - 1];
  check(`${label}: xterm's grid is the size the pty was last told`,
    !!g && !!last && g.cols === last.cols && g.rows === last.rows,
    `xterm ${g?.cols}x${g?.rows}, pty ${last?.cols}x${last?.rows}`);
}

const setWidth = (w) => app.evaluate(({ BrowserWindow }, w) =>
  BrowserWindow.getAllWindows()[0].setContentSize(w, 820), w);

async function tabMenu(i, itemText) {
  await win.locator('.tab:not(.add)').nth(i).click({ button: 'right' });
  await win.waitForTimeout(250);
  await win.locator('.ctx-item', { hasText: itemText }).first().click();
  await win.waitForTimeout(600);
}

const openSpaceMenu = async () => {
  await win.click('.spacemenu-btn');
  await win.waitForSelector('.spacemenu-dropdown');
  await win.waitForTimeout(150);
};

// ===========================================================================
console.log('\n1. spawn');
// ===========================================================================
await win.waitForSelector('.entry');
await win.waitForTimeout(400);
await tabMenu(0, 'Open Terminal');
await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 20_000 });
await win.waitForTimeout(1500);
await agrees('after the first fit');

// ===========================================================================
console.log('\n2. window resize');
// ===========================================================================
for (const w of [960, 1280, 820]) {
  await setWidth(w);
  await win.waitForTimeout(1000);
}
await agrees('after three window resizes');

// ===========================================================================
console.log('\n3. tab switch away and back');
// ===========================================================================
await win.click('.tab.add');
await win.waitForTimeout(700);
await setWidth(1180);                    // resized while the terminal is hidden
await win.waitForTimeout(800);
await win.locator('.tab:not(.add)').nth(1).click();
await win.waitForTimeout(1200);
await agrees('back on the terminal tab');

// ===========================================================================
console.log('\n4. space switch away and back');
// ===========================================================================
await openSpaceMenu();
await win.locator('.spacemenu-item', { hasText: 'New empty space' }).click();
await win.waitForSelector('.spacemenu-rename');
await win.locator('.spacemenu-rename').fill('Beta');
await win.keyboard.press('Enter');
await win.waitForTimeout(700);
await setWidth(900);                     // resized while the whole space is off screen
await win.waitForTimeout(900);
await win.click('.tabbar');
await win.waitForTimeout(120);
await win.keyboard.press('Control+1');
await win.waitForTimeout(1400);
await agrees('back in the space that owns the terminal');

// ===========================================================================
console.log('\n5. a window-edge drag hands the pty only sizes it came to rest at');
// ===========================================================================
{
  await setWidth(820);
  await win.waitForTimeout(900);
  const from = await markSent();
  // What holding the window edge and dragging produces: a new size every frame.
  await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    for (let i = 0; i < 30; i++) { w.setContentSize(820 + i * 14, 820); await new Promise((r) => setTimeout(r, 16)); }
  });
  await win.waitForTimeout(1200);
  const sent = await sentSince(from);
  const [g] = (await gridsOf()).filter((x) => !x.hidden);
  check('a 30-frame window drag tells the pty exactly one size',
    sent.length === 1, `${sent.length} ptyResize messages: ${sent.map((s) => s.cols).join(',')}`);
  check('and that size is the one the terminal came to rest at',
    sent.length > 0 && sent[sent.length - 1].cols === g.cols && sent[sent.length - 1].rows === g.rows,
    `pty ${sent[sent.length - 1]?.cols}x${sent[sent.length - 1]?.rows}, xterm ${g.cols}x${g.rows}`);
}

// ===========================================================================
console.log('\n6. a split-view divider drag, same claim');
// ===========================================================================
await tabMenu(0, 'Split right');
await win.waitForTimeout(1200);
{
  const from = await markSent();
  const d = win.locator('.split-divider').nth(0);
  const b = await d.boundingBox();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  await win.mouse.move(cx, cy);
  await win.mouse.down();
  // Real pointer events, a real drag: the divider rewrites the grid template on
  // every move, so each one resizes the pane for real.
  for (let i = 1; i <= 20; i++) {
    await win.mouse.move(cx - i * 10, cy);
    await win.waitForTimeout(16);
  }
  await win.mouse.up();
  await win.waitForTimeout(1200);
  const sent = await sentSince(from);
  const [g] = (await gridsOf()).filter((x) => !x.hidden);
  check('a 20-move divider drag tells the pty exactly one size',
    sent.length === 1, `${sent.length} ptyResize messages: ${sent.map((s) => s.cols).join(',')}`);
  check('and that size is the one the terminal came to rest at',
    sent.length > 0 && sent[sent.length - 1].cols === g.cols && sent[sent.length - 1].rows === g.rows,
    `pty ${sent[sent.length - 1]?.cols}x${sent[sent.length - 1]?.rows}, xterm ${g.cols}x${g.rows}`);
}

// ===========================================================================
console.log('\n7. output through a resize, no manual tab switch');
// ===========================================================================
{
  // The shell reports the width the CONSOLE gives it, which is what a TUI wraps
  // to. Built by powershell from a variable, never typed whole: the terminal
  // echoes what you type, so a literal marker in the command line would match
  // whether or not anything ran.
  await win.locator('.pane:not([hidden]) .xterm-screen').click();
  await win.waitForTimeout(200);
  await win.keyboard.type("$p='CE'+'-W-'; 1..300 | ForEach-Object { Write-Host ($p+$Host.UI.RawUI.WindowSize.Width); Start-Sleep -Milliseconds 60 }");
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1500);

  await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    for (let i = 0; i < 30; i++) { w.setContentSize(1300 - i * 12, 820); await new Promise((r) => setTimeout(r, 16)); }
  });
  await win.waitForTimeout(2000);

  const text = await win.$eval('.pane:not([hidden]) .xterm-rows', (el) => el.textContent);
  const widths = [...text.matchAll(/CE-W-(\d+)/g)].map((m) => +m[1]);
  const [g] = (await gridsOf()).filter((x) => !x.hidden);
  check('a terminal writing all through a window drag ends up wrapped to the viewport',
    widths.length > 0 && widths[widths.length - 1] === g.cols,
    `shell last wrote at ${widths[widths.length - 1]} cols, xterm grid is ${g.cols}`);
  check('and it is still writing — the drag did not wedge or kill the session',
    widths.length >= 3, `${widths.length} samples`);
}

await close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log('  -', f.name);
}
process.exit(failed.length ? 1 : 0);
