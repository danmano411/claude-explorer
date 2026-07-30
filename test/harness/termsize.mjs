// KAN-50: the terminal renders horizontally misaligned until you switch tabs.
//   npm run build && node test/harness/termsize.mjs
//
// Both sides of the invariant are read from OUTSIDE the code that maintains them:
//
//   xterm's side  — `data-pty` / `data-cols` / `data-rows` on the `.terminal`
//                   element, written by xterm's OWN onResize event (Terminal.tsx's
//                   test seam), so it reports the grid and not the function that
//                   reports the grid.
//   the pty's side — an extra `ipcMain.on('pty:resize')` listener installed in the
//                   real main process. Every message the renderer sends, in order.
//
// Both are keyed by ptyId and every comparison below is filtered by the ptyId of
// the terminal it is talking about. With a split there is more than one sender.
//
// WHAT IS PROVABLE HERE, AND WHAT IS NOT — read this before adding assertions.
//
// The fix has two halves and they are provable to different depths:
//
//   LEADING EDGE (§1) — provable outright, against the child's own clock. A pty
//   is spawned at 80x24 and a TUI paints its first frame at whatever it reads, so
//   a first ptyResize that waits for a debounce can leave that frame 80 columns
//   wide inside a 179-column pane, with no SIGWINCH on Windows to repaint it.
//   §1 anchors on the child's FIRST BYTE OF OUTPUT rather than on wall clock:
//   the pty must know its real size by the time its child starts writing.
//   Measured on this machine: leading edge -5ms (i.e. before), debounce-only
//   +177ms — the +180 is structural, the mount arms SETTLE_MS and the 60ms font
//   re-fit re-arms it.
//
//   COALESCING (§5, §6) — provable only as a COUNT, and that is not a cop-out.
//   The visible mis-wrap needs an alt-screen TUI: xterm reflows its NORMAL buffer
//   on resize all by itself, so a shell's output re-wraps correctly no matter how
//   many sizes the pty was handed. Measured, not assumed — with the coalescing
//   reverted to one ptyResize per animation frame, a 400-char marker line written
//   before a window drag still came out as rows of exactly [167, 167, 66] at a
//   grid of 167, i.e. perfect. An assertion on visible wrapping therefore cannot
//   go red, and one was written and thrown away. In the alternate buffer, which
//   xterm does NOT reflow, the damage is real — but it is a RACE: whether Claude
//   Code samples its width between two of the ~30 resizes a drag used to fire.
//   Claude Code 2.1 takes ~1.9s to its first paint, so it cannot be made to lose
//   that race on demand either. What the fix actually controls is the number of
//   ConPTY screen-buffer resizes a drag costs, so that is what is asserted — with
//   a bound derived from MAX_HOLD_MS rather than an exact count, because a fixed
//   count reds on any loaded machine that hiccups mid-drag.
//
// So: §5/§6's bound is the discriminator (reverted: ~29 resizes, fixed: <=4), and
// the "came to rest at" checks beside it are regression guards that held before
// the fix too and are labelled as such.
//
// A plain PowerShell tab, not Claude: every claim below is about the xterm/pty
// seam, which is identical either way, and this costs no tokens and no CLI startup.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

/** Terminal.tsx's MAX_HOLD_MS. A burst costs one resize per this much elapsed... */
const MAX_HOLD_MS = 250;
/** ...plus the trailing one, plus the frame that opened the burst. */
const BURST_SLACK = 2;
/** Terminal.tsx's SETTLE_MS — the delay §1 must beat. */
const SETTLE_MS = 120;

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
  ipcMain.on('pty:resize', (_e, id, cols, rows) =>
    globalThis.__ceResizes.push({ id, cols, rows, at: Date.now() }));
});
// The child's side, for §1: when each pty first wrote anything. Same wall clock
// as the main process, and `window.api` is the app's real preload bridge — this
// subscribes to the same broadcast the terminals do.
await win.evaluate(() => {
  globalThis.__ceFirstData = {};
  window.api.onPtyData((id) => { globalThis.__ceFirstData[id] ??= Date.now(); });
});
const firstDataAt = async (ptyId) => (await win.evaluate(() => globalThis.__ceFirstData))[ptyId];
const allSent = () => app.evaluate(() => globalThis.__ceResizes);
/** A cursor into the log, so a section only sees its own traffic. */
const mark = async () => (await allSent()).length;
/** Everything ONE pty was told since `from`. */
const sentFor = async (ptyId, from = 0) => (await allSent()).slice(from).filter((m) => m.id === ptyId);

/** xterm's side, per mounted terminal. */
const gridsOf = () => win.evaluate(() => [...document.querySelectorAll('[data-cols]')].map((el) => ({
  pty: el.dataset.pty, cols: +el.dataset.cols, rows: +el.dataset.rows,
  hidden: !!el.closest('.pane[hidden]'),
})));
/** The terminal the user can see. Everything below is filtered by its ptyId. */
const visible = async () => (await gridsOf()).find((x) => !x.hidden);

/** Regression guard: the pty's LAST word for this terminal is the grid on screen. */
async function agrees(label) {
  const g = await visible();
  const sent = await sentFor(g?.pty);
  const last = sent[sent.length - 1];
  check(`${label}: xterm's grid is the size ITS pty was last told`,
    !!g && !!last && g.cols === last.cols && g.rows === last.rows,
    `xterm ${g?.cols}x${g?.rows}, pty ${last?.cols}x${last?.rows}`);
}

/**
 * The two claims a coalesced drag has to satisfy, for one pty.
 *  - the bound is the discriminator (see the header);
 *  - "ends on the resting size" is the regression guard.
 */
async function checkDrag(label, ptyId, from, elapsedMs) {
  const sent = await sentFor(ptyId, from);
  const g = (await gridsOf()).find((x) => x.pty === ptyId);
  const last = sent[sent.length - 1];
  const bound = Math.ceil(elapsedMs / MAX_HOLD_MS) + BURST_SLACK;
  check(`${label}: the pty is resized a bounded number of times, not once per frame`,
    sent.length > 0 && sent.length <= bound,
    `${sent.length} ptyResize in ${elapsedMs}ms (bound ${bound}): ${sent.map((s) => s.cols).join(',')}`);
  check(`${label}: and the last size it was told is the one the terminal came to rest at`,
    !!last && !!g && last.cols === g.cols && last.rows === g.rows,
    `pty ${last?.cols}x${last?.rows}, xterm ${g?.cols}x${g?.rows}`);
}

const setWidth = (w) => app.evaluate(({ BrowserWindow }, w) =>
  BrowserWindow.getAllWindows()[0].setContentSize(w, 820), w);

/** One `setContentSize` per frame — a held window edge. Returns how long it took. */
const dragWindow = (from, step, frames) => app.evaluate(async ({ BrowserWindow }, [from, step, frames]) => {
  const w = BrowserWindow.getAllWindows()[0];
  const t0 = Date.now();
  for (let i = 0; i < frames; i++) {
    w.setContentSize(from + i * step, 820);
    await new Promise((r) => setTimeout(r, 16));
  }
  return Date.now() - t0;
}, [from, step, frames]);

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
console.log('\n1. spawn — the first size cannot wait');
// ===========================================================================
await win.waitForSelector('.entry');
await win.waitForTimeout(400);
// Wide, so 80x24 is nowhere near right: a first frame painted at it is the
// reported symptom and not a rounding error.
await setWidth(1400);
await win.waitForTimeout(600);
await tabMenu(0, 'Open Terminal');
await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 20_000 });
await win.waitForTimeout(1500);
{
  const g = await visible();
  const sent = await sentFor(g?.pty);
  // Measured against the CHILD, not against wall clock: no polling latency of
  // this harness's own can move either number.
  const lag = sent.length ? sent[0].at - await firstDataAt(g.pty) : Infinity;
  check('the pty knows its real size by the time its child starts writing',
    lag < SETTLE_MS,
    `first ptyResize ${sent[0]?.cols}x${sent[0]?.rows}, ${lag}ms after the child's first byte`);
  check('and that first size is the pane it was spawned into, not the 80x24 default',
    !!g && sent.length > 0 && sent[0].cols === g.cols && sent[0].cols > 80,
    `pty ${sent[0]?.cols}, xterm ${g?.cols}`);
}
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
console.log('\n5. a window-edge drag');
// ===========================================================================
{
  await setWidth(820);
  await win.waitForTimeout(900);
  const pty = (await visible()).pty;
  const from = await mark();
  const elapsed = await dragWindow(820, 14, 30);
  await win.waitForTimeout(1200);
  await checkDrag('a 30-frame window drag', pty, from, elapsed);
}

// ===========================================================================
console.log('\n6. a split-view divider drag, same claim');
// ===========================================================================
await tabMenu(0, 'Split right');
await win.waitForTimeout(1200);
{
  // The terminal's OWN ptyId, so the split's other pane cannot answer for it.
  const pty = (await visible()).pty;
  const from = await mark();
  const d = win.locator('.split-divider').nth(0);
  const b = await d.boundingBox();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const t0 = Date.now();
  await win.mouse.move(cx, cy);
  await win.mouse.down();
  // Real pointer events, a real drag: the divider rewrites the grid template on
  // every move, so each one resizes the pane for real.
  for (let i = 1; i <= 20; i++) {
    await win.mouse.move(cx - i * 10, cy);
    await win.waitForTimeout(16);
  }
  await win.mouse.up();
  const elapsed = Date.now() - t0;
  await win.waitForTimeout(1200);
  await checkDrag('a 20-move divider drag', pty, from, elapsed);
}

// ===========================================================================
console.log('\n7. output through a resize, no manual tab switch');
// ===========================================================================
{
  // The shell reports the width the CONSOLE gives it, which is what a TUI wraps
  // to. Built by powershell from a variable, never typed whole: the terminal
  // echoes what you type, so a literal marker in the command line would match
  // whether or not anything ran.
  //
  // A liveness guard, not a discriminator — see the header. It catches a drag
  // that wedges or kills the session, which a coalescing bug plausibly could.
  await win.locator('.pane:not([hidden]) .xterm-screen').click();
  await win.waitForTimeout(200);
  await win.keyboard.type("$p='CE'+'-W-'; 1..300 | ForEach-Object { Write-Host ($p+$Host.UI.RawUI.WindowSize.Width); Start-Sleep -Milliseconds 60 }");
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1500);

  await dragWindow(1300, -12, 30);
  await win.waitForTimeout(2000);

  const text = await win.$eval('.pane:not([hidden]) .xterm-rows', (el) => el.textContent);
  const widths = [...text.matchAll(/CE-W-(\d+)/g)].map((m) => +m[1]);
  const g = await visible();
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
