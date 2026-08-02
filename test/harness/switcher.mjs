// KAN-101: Alt-Tab-style space switcher — hold Ctrl, Tab through a panel, commit
// once on release.
//   npm run build && node test/harness/switcher.mjs
//
// WHAT IS INSTRUMENTED, AND WHY
//
// The ticket's whole rationale is that today's Ctrl+Tab COMMITS ON EVERY PRESS:
// getting from the first space to the fourth switches three times, and each
// switch reveals a hidden pane, which fires a real ResizeObserver -> ptyResize ->
// ConPTY re-emits its entire screen buffer (the 0.10.0 amber-flicker finding, and
// the reason `.pane[hidden]` is a 0x0 box rather than an unmount). "We ended on
// the fourth space" is true on BOTH builds and proves nothing at all, so this
// file measures the PATH, never the destination, with two independent
// instruments, each calibrated against a known-good switch before anything
// relies on it:
//
//   1. MAIN PROCESS, `ipcMain.on('pty:resize')` — the same additive-listener seam
//      paste.mjs uses for `pty:write`. Every space this gesture passes through
//      reveals that space's terminal and costs one ptyResize against a DIFFERENT
//      ptyId. One held cycle across four spaces must resize exactly ONE pty.
//      That is the performance claim, stated in the units the user pays in.
//   2. RENDERER, a MutationObserver on `.spacemenu-name`'s text with
//      `characterDataOldValue` — every space the app actually LANDED on, in
//      order, including the ones it left again 150 ms later. React updates that
//      span's text node in place, so the old values reconstruct the whole path.
//      Recorded as departures, so N records == N switches.
//
// Both are calibrated in §0. An observer that silently records nothing would make
// "exactly one switch" vacuously true on every build, which is precisely the
// shape of assertion this repo has shipped seven of.
//
// ESCAPE IS TESTED WITH A TERMINAL FOCUSED, ON PURPOSE. That is the entire reason
// the plan requires capture-phase listeners: xterm calls stopPropagation on keys
// it owns, so a bubble-phase window listener never sees Escape while a terminal
// has focus — and a terminal has focus most of the time in this app. An
// Escape test run from a focused `.tabbar` passes against a bubble-phase
// implementation and therefore proves nothing about the case that matters.
//
// LABELS. Every assertion below is one of exactly two kinds, and says which:
//   [RED-on-unmodified]     — measured FAILING against the pre-KAN-101 build.
//   [GREEN-regression-guard] — passes today and must keep passing.
// The measured split for the unmodified build is printed at the bottom of the
// run. MEASURED on the pre-implementation build (branch feat/kan-101-space-
// switcher at 77d08fd, `npm run build` first): 11/28 passed — all 17 RED
// failing, all 11 GREEN passing. Two assertions were changed rather than
// rationalised when the first run showed them green, and both are documented
// where they stand (§6's selection check, and §7's `.last()` tab).
//
// Plain PowerShell tabs, never Claude: the claim is about pane reveals and pty
// resizes, which are the same machinery either way, and this costs no tokens.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const RED = '[RED-on-unmodified]';
const GREEN = '[GREEN-regression-guard]';

const results = [];
const check = (name, kind, pass, detail = '') => {
  results.push({ name, kind, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  ${kind}${detail ? `  — ${detail}` : ''}`);
};

// Throwaway profile, pid-suffixed: the app restores the previous workspace, and
// the single-instance lock is keyed on userData — two concurrent harness runs
// sharing one would silently forward into each other's window.
const PROFILE = path.join(os.tmpdir(), `claude-explorer-switcher-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

const VIS = '.pane:not([hidden]) ';
const clean = (t) => (t ?? '').replace(/[^A-Za-z0-9 _-]/gu, '').replace(/\s+/g, ' ').trim();

const { app, win, close } = await launchApp({ userDataDir: PROFILE });
win.on('pageerror', (e) => console.log('  [pageerror]', e.message));

// --- instrument 1: every pty:resize the renderer asks for, in the real main ---
await app.evaluate(({ ipcMain }) => {
  globalThis.__ceResizes = [];
  ipcMain.on('pty:resize', (_e, id, cols, rows) => globalThis.__ceResizes.push({ id, cols, rows }));
  globalThis.__ceWrites = [];
  ipcMain.on('pty:write', (_e, id, data) => globalThis.__ceWrites.push({ id, data }));
});
const allResizes = () => app.evaluate(() => globalThis.__ceResizes);
const resizeMark = async () => (await allResizes()).length;
const resizesSince = async (from) => (await allResizes()).slice(from);
const allWrites = () => app.evaluate(() => globalThis.__ceWrites);
const writeMark = async () => (await allWrites()).length;
const sentTo = async (ptyId, from) => (await allWrites()).slice(from).filter((m) => m.id === ptyId);
// A pane going off screen blurs its xterm, which reports the blur as ESC[O under
// DECSET 1004 (paste.mjs §11 measures exactly this). That byte is a consequence
// of the pane being hidden, not of the keystroke, so it is filtered out wherever
// a space actually changes.
const nonFocus = (sent) => sent.map((m) => m.data).join('').replace(/\x1b\[[IO]/g, '');
const printable = (s) => JSON.stringify(s).replace(/\\u001b/g, 'ESC').replace(/\x7f/g, 'DEL');

/** The ptyId of the terminal the user can see (Terminal.tsx's data-pty seam). */
const visiblePty = () => win.evaluate(() =>
  [...document.querySelectorAll('[data-pty]')].find((el) => !el.closest('.pane[hidden]'))?.dataset.pty);

// --- instrument 2 (+3): what the renderer did, watched from inside ------------
await win.evaluate(() => {
  // Every space the app LANDED on, as departures. `characterDataOldValue` is
  // what makes this an ordered path and not just a final reading: the observer
  // callback is microtask-batched, so reading textContent inside it would give
  // the same (final) value for every record.
  globalThis.__ceSeq = [];
  new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.target.parentElement?.classList?.contains('spacemenu-name')) {
        globalThis.__ceSeq.push(r.oldValue);
      }
    }
  }).observe(document.body, { subtree: true, characterData: true, characterDataOldValue: true });

  // Did the panel EVER exist, even for one frame? A poll cannot prove the
  // absence of a 40 ms flash; a childList observer can.
  globalThis.__ceSwitcherSeen = 0;
  new MutationObserver(() => {
    if (document.querySelector('.spaceswitch')) globalThis.__ceSwitcherSeen++;
  }).observe(document.body, { subtree: true, childList: true });
});
const seqMark = async () => (await win.evaluate(() => globalThis.__ceSeq)).length;
const seqSince = async (from) => (await win.evaluate(() => globalThis.__ceSeq)).slice(from);
const flashMark = () => win.evaluate(() => globalThis.__ceSwitcherSeen);

// --- the panel under test ----------------------------------------------------
const panelCount = () => win.locator('.spaceswitch').count();
const panelRows = () =>
  win.locator('.spaceswitch-row').allTextContents().then((ts) => ts.map(clean));
const highlight = () =>
  win.locator('.spaceswitch-row.is-active').allTextContents().then((ts) => ts.map(clean));

// --- space plumbing, lifted from spaces.mjs rather than reinvented ------------
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
  await win.waitForTimeout(700);
}
async function tabMenu(i, itemText) {
  await win.locator('.tab:not(.add)').nth(i).click({ button: 'right' });
  await win.waitForTimeout(250);
  await win.locator('.ctx-item', { hasText: itemText }).first().click();
  await win.waitForTimeout(600);
}
async function focusTerm() {
  await win.locator(`${VIS}.xterm-screen`).click();
  await win.waitForTimeout(150);
}
/** Give the current (empty) space a live PowerShell and leave it active. */
async function addTerminal() {
  await win.click('.tab.add');
  await win.waitForTimeout(800);
  await tabMenu(0, 'Open Terminal');
  await win.waitForSelector(`${VIS}.xterm`, { timeout: 20_000 });
  await win.waitForTimeout(1200);
}

/**
 * Quiet the machine before a measured window. Terminal.tsx coalesces resizes
 * with a 120 ms settle timer that survives the pane being hidden again, so a
 * measurement started too soon inherits the previous section's tail.
 */
const settle = () => win.waitForTimeout(1200);

// ===========================================================================
console.log('\nsetup: four spaces, each with a live terminal as its active tab');
// ===========================================================================
await win.waitForSelector('.entry');
await win.waitForTimeout(600);
await addTerminal();                       // the default space gets one too
for (const name of ['Beta', 'Gamma', 'Delta']) {
  await createSpace(name);
  await addTerminal();
}
await switchSpaceViaMenu('Space');
await settle();

// Display order is read from the app's OWN dropdown, never hardcoded: the panel
// contract is "the same top-to-bottom order the dropdown shows", so asserting
// the panel against a literal would let both of them drift together.
await openSpaceMenu();
const DISPLAY = (await win.locator('.spacemenu-item-name').allTextContents()).map(clean);
await win.keyboard.press('Escape');
await win.waitForTimeout(300);
console.log(`  display order: ${DISPLAY.join(' | ')}`);
if (DISPLAY.length !== 4) throw new Error(`switcher.mjs: expected 4 spaces, got ${DISPLAY.join('|')}`);

// ===========================================================================
console.log('\n0. calibration — both instruments can see a switch at all');
// ===========================================================================
{
  await settle();
  const rfrom = await resizeMark();
  const sfrom = await seqMark();
  await switchSpaceViaMenu('Beta');
  await win.waitForTimeout(1200);
  const rs = await resizesSince(rfrom);
  const seq = await seqSince(sfrom);
  // Both [GREEN-regression-guard], and both load-bearing: an instrument that
  // records nothing makes every "exactly one" assertion below vacuously true.
  check('a single menu-driven space switch is visible to the pty:resize log', GREEN,
    new Set(rs.map((r) => r.id)).size === 1,
    `${rs.length} resize(s), ${new Set(rs.map((r) => r.id)).size} distinct pty`);
  check('and to the space-name observer, as exactly one departure', GREEN,
    seq.length === 1 && seq[0] === 'Space', JSON.stringify(seq));

  await switchSpaceViaMenu('Space');
  await settle();
}

// ===========================================================================
console.log('\n1. holding the modifier opens a panel; a quick tap never does');
// ===========================================================================
{
  const before = await flashMark();
  await win.click('.tabbar');
  await win.waitForTimeout(150);
  const sfrom = await seqMark();
  // A tap: press and release inside one gesture, faster than the 120 ms grace.
  await win.keyboard.down('Control');
  await win.keyboard.press('Tab');
  await win.keyboard.up('Control');
  await win.waitForTimeout(800);
  check('a QUICK TAP shows no panel at all — not even for one frame', GREEN,
    (await flashMark()) === before && (await panelCount()) === 0,
    `flashes ${(await flashMark()) - before}, panels now ${await panelCount()}`);
  check('and it still switches exactly one space, as it always has (AC-6)', GREEN,
    (await spaceName()) === DISPLAY[1] && (await seqSince(sfrom)).length === 1,
    `${await spaceName()}, departures ${JSON.stringify(await seqSince(sfrom))}`);

  await switchSpaceViaMenu('Space');
  await settle();

  await win.click('.tabbar');
  await win.waitForTimeout(150);
  await win.keyboard.down('Control');
  await win.keyboard.press('Tab');
  await win.waitForTimeout(400);            // past the 120 ms grace period
  const rows = await panelRows();
  const hl = await highlight();
  const panels = await panelCount();
  await win.keyboard.up('Control');
  await win.waitForTimeout(700);

  check('HOLDING the modifier opens the switcher panel', RED, panels === 1, `${panels} .spaceswitch`);
  check('the panel lists every space, top-to-bottom, in the dropdown\'s display order', RED,
    rows.join('|') === DISPLAY.join('|'), `${rows.join(' | ')}  (want ${DISPLAY.join(' | ')})`);
  check('exactly ONE row is highlighted, and it is the NEXT space, not the current one', RED,
    hl.length === 1 && hl[0] === DISPLAY[1], `${hl.length} highlighted: ${hl.join(' | ')}`);

  await switchSpaceViaMenu('Space');
  await settle();
}

// ===========================================================================
console.log('\n2. THE TICKET: first -> fourth under ONE held modifier is ONE switch');
// ===========================================================================
{
  await win.click('.tabbar');
  await win.waitForTimeout(150);
  await settle();
  const rfrom = await resizeMark();
  const sfrom = await seqMark();

  const seen = [];
  await win.keyboard.down('Control');
  for (let i = 0; i < 3; i++) {
    await win.keyboard.press('Tab');
    await win.waitForTimeout(180);
    seen.push((await highlight())[0] ?? '(none)');
  }
  const panelsHeld = await panelCount();
  const nameHeld = await spaceName();
  await win.keyboard.up('Control');
  await win.waitForTimeout(1500);           // let every settle timer land
  const panelsAfter = await panelCount();
  const rs = await resizesSince(rfrom);
  const ptys = new Set(rs.map((r) => r.id));
  const seq = await seqSince(sfrom);

  check('the highlight walks 2nd -> 3rd -> 4th while the modifier stays down', RED,
    seen.join('|') === [DISPLAY[1], DISPLAY[2], DISPLAY[3]].join('|'), seen.join(' | '));
  check('and NOTHING has switched yet while it is still held', RED,
    nameHeld === DISPLAY[0] && seq.length === 0,
    `on "${nameHeld}", departures ${JSON.stringify(seq)}`);
  check('THE WHOLE GESTURE COMMITS EXACTLY ONE SPACE SWITCH, not three', RED,
    seq.length === 1 && seq[0] === DISPLAY[0], `${seq.length} departure(s): ${JSON.stringify(seq)}`);
  check('and resizes EXACTLY ONE pty — three reveals is three ConPTY screen repaints', RED,
    ptys.size === 1, `${rs.length} pty:resize across ${ptys.size} distinct pty`);
  check('releasing the modifier closes the panel', RED,
    panelsHeld === 1 && panelsAfter === 0, `held ${panelsHeld}, after ${panelsAfter}`);
  check('and you do land on the fourth space (the destination, guarding the path checks)', GREEN,
    (await spaceName()) === DISPLAY[3], await spaceName());

  await switchSpaceViaMenu('Space');
  await settle();
}

// ===========================================================================
console.log('\n3. Escape cancels — WITH A TERMINAL FOCUSED, which is the whole point');
// ===========================================================================
{
  await focusTerm();
  const shellPty = await visiblePty();
  if (!shellPty) throw new Error('switcher.mjs: no visible terminal in the first space');
  await settle();
  const wfrom = await writeMark();
  const sfrom = await seqMark();

  await win.keyboard.down('Control');
  await win.keyboard.press('Tab');
  await win.waitForTimeout(400);
  const panelsBefore = await panelCount();
  await win.keyboard.press('Escape');
  await win.waitForTimeout(400);
  const panelsAfter = await panelCount();
  await win.keyboard.up('Control');
  await win.waitForTimeout(900);
  const sent = await sentTo(shellPty, wfrom);
  const seq = await seqSince(sfrom);

  check('ESCAPE CANCELS: release the modifier and you are still on the space you started in', RED,
    (await spaceName()) === DISPLAY[0] && seq.length === 0,
    `on "${await spaceName()}", departures ${JSON.stringify(seq)}`);
  check('and the panel is gone the moment Escape lands, before the release', RED,
    panelsBefore === 1 && panelsAfter === 0, `before ${panelsBefore}, after ${panelsAfter}`);
  // Measured, not assumed: on the unmodified build the Ctrl+Tab has ALREADY
  // switched space by the time Escape is pressed, which hides the pane and
  // blurs its xterm — so the ESC never reaches a focused terminal there either,
  // and this passes for a reason that has nothing to do with swallowing it.
  // Kept, labelled honestly, paired with the two assertions above that do
  // distinguish the builds. On a bubble-phase implementation the terminal
  // still HAS focus here, xterm owns the key, and this is the one that goes red.
  check('and no ESC byte reaches the pty — the keystroke is swallowed, not forwarded', GREEN,
    nonFocus(sent) === '',
    `${sent.length} pty:write — ${printable(sent.map((m) => m.data).join(''))}`);
}

// ===========================================================================
console.log('\n4. Shift is the direction toggle, not a commit');
// ===========================================================================
{
  await switchSpaceViaMenu('Space');
  await win.click('.tabbar');
  await win.waitForTimeout(150);
  await settle();
  const sfrom = await seqMark();

  await win.keyboard.down('Control');
  await win.keyboard.down('Shift');
  await win.keyboard.press('Tab');          // backward: wraps to the LAST space
  await win.waitForTimeout(300);
  const hlBack = (await highlight())[0] ?? '(none)';
  await win.keyboard.up('Shift');           // Ctrl still down: NOT a release
  await win.waitForTimeout(400);
  const panelsAfterShift = await panelCount();
  const nameAfterShift = await spaceName();
  const seqAfterShift = await seqSince(sfrom);
  await win.keyboard.press('Tab');          // forward again: back to the origin
  await win.waitForTimeout(300);
  const hlFwd = (await highlight())[0] ?? '(none)';
  await win.keyboard.up('Control');
  await win.waitForTimeout(900);
  const seq = await seqSince(sfrom);

  check('Shift+Tab under the hold highlights BACKWARD, wrapping to the last space', RED,
    hlBack === DISPLAY[3], hlBack);
  check('releasing SHIFT mid-gesture does not commit — the panel is still open', RED,
    panelsAfterShift === 1 && nameAfterShift === DISPLAY[0] && seqAfterShift.length === 0,
    `panels ${panelsAfterShift}, on "${nameAfterShift}", departures ${JSON.stringify(seqAfterShift)}`);
  check('and Tab keeps cycling from where the highlight was left', RED,
    hlFwd === DISPLAY[0], hlFwd);
  check('the whole back-and-forth costs ZERO switches: it landed back where it began', RED,
    seq.length === 0 && (await spaceName()) === DISPLAY[0],
    `departures ${JSON.stringify(seq)}, on "${await spaceName()}"`);

  await switchSpaceViaMenu('Space');
  await settle();
}

// ===========================================================================
console.log('\n5. losing the window commits — the OS eats the keyup when you Alt-Tab out');
// ===========================================================================
{
  await win.click('.tabbar');
  await win.waitForTimeout(150);
  await settle();

  await win.keyboard.down('Control');
  await win.keyboard.press('Tab');
  await win.waitForTimeout(400);
  const panelsBefore = await panelCount();
  await win.evaluate(() => window.dispatchEvent(new Event('blur')));
  await win.waitForTimeout(700);
  const panelsAfter = await panelCount();
  const landed = await spaceName();
  await win.keyboard.up('Control');
  await win.waitForTimeout(700);

  check('a window blur mid-gesture commits the highlight and closes the panel', RED,
    panelsBefore === 1 && panelsAfter === 0 && landed === DISPLAY[1],
    `before ${panelsBefore}, after ${panelsAfter}, on "${landed}"`);
  check('and the late keyup that follows does not switch again', GREEN,
    (await spaceName()) === DISPLAY[1], await spaceName());

  await switchSpaceViaMenu('Space');
  await settle();
}

// ===========================================================================
console.log('\n6. a pointerdown commits, and does NOT also act on what it hit');
// ===========================================================================
{
  await win.locator('.tab:not(.add)').nth(0).click();     // the files tab
  await win.waitForTimeout(500);
  const entries = await win.locator(`${VIS}.entry`).count();
  if (entries < 3) throw new Error(`switcher.mjs: need 3 file rows, saw ${entries}`);
  await win.locator(`${VIS}.entry`).nth(1).click();
  await win.waitForTimeout(300);
  check('a plain click selects a file row, and Ctrl+click is what adds to it (baseline)', GREEN,
    (await win.locator(`${VIS}.entry.selected`).count()) === 1,
    String(await win.locator(`${VIS}.entry.selected`).count()));
  await settle();

  // Four Tabs across four spaces wraps the highlight back to the origin, so the
  // commit is a no-op for the pane and the file list is still on screen.
  await win.keyboard.down('Control');
  for (let i = 0; i < 4; i++) { await win.keyboard.press('Tab'); await win.waitForTimeout(150); }
  const panelsBefore = await panelCount();
  await win.locator(`${VIS}.entry`).nth(2).click();       // Ctrl is still down
  await win.waitForTimeout(500);
  const panelsAfter = await panelCount();
  // THE CLICKED ROW's own state, not the total selected count. The count was
  // measured first and PASSED on the unmodified build for a reason that has
  // nothing to do with swallowing anything: today's four presses are four real
  // space switches, the file pane is left and re-entered, and its selection is
  // reset on the way — so the Ctrl+click landed on an empty selection and made
  // it exactly 1. That is the "green while the feature is broken" shape, so it
  // was replaced rather than rationalised. Whether the row the click hit ends
  // up selected is independent of what the selection was before it.
  const hitSelected = await win.locator(`${VIS}.entry`).nth(2)
    .evaluate((el) => el.classList.contains('selected'));
  const selAfter = await win.locator(`${VIS}.entry.selected`).count();
  await win.keyboard.up('Control');
  await win.waitForTimeout(700);

  check('a pointerdown mid-gesture commits and closes the panel', RED,
    panelsBefore === 1 && panelsAfter === 0, `before ${panelsBefore}, after ${panelsAfter}`);
  check('and it is SWALLOWED — the click that committed does not also select the row it hit', RED,
    hitSelected === false, `row hit selected=${hitSelected}, ${selAfter} row(s) selected in total`);
}

// ===========================================================================
console.log('\n7. regression guards — what already worked must keep working');
// ===========================================================================
{
  await switchSpaceViaMenu('Space');
  // `.last()`, never a literal index: the default space already owned a files
  // tab before setup added one, so the terminal is the THIRD tab here and the
  // second everywhere else. A hardcoded 1 clicked a files tab and the whole
  // section died on a 30 s wait for an xterm that was never going to appear.
  await win.locator('.tab:not(.add)').last().click();     // back to the terminal
  await win.waitForTimeout(600);
  await focusTerm();
  const shellPty = await visiblePty();
  await settle();

  const wfrom = await writeMark();
  await win.keyboard.press('Control+Tab');                // the plain tap path
  await win.waitForTimeout(800);
  const sent = await sentTo(shellPty, wfrom);
  check('a tapped Ctrl+Tab from a focused terminal still puts no tab byte on the wire (KAN-82)', GREEN,
    nonFocus(sent) === '',
    `${sent.length} pty:write — ${printable(sent.map((m) => m.data).join(''))}`);
  check('and it still cycles forward one space', GREEN,
    (await spaceName()) === DISPLAY[1], await spaceName());

  await switchSpaceViaMenu('Gamma');
  await win.click('.tabbar');
  await win.waitForTimeout(150);
  await win.keyboard.press('Control+1');
  await win.waitForTimeout(800);
  check('Ctrl+1 still selects the first space (KAN-45 untouched)', GREEN,
    (await spaceName()) === DISPLAY[0], await spaceName());
}

await close();

const failed = results.filter((r) => !r.pass);
const red = results.filter((r) => r.kind === RED);
const green = results.filter((r) => r.kind === GREEN);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(`  ${red.length} labelled ${RED} (${red.filter((r) => r.pass).length} currently passing)`);
console.log(`  ${green.length} labelled ${GREEN} (${green.filter((r) => r.pass).length} currently passing)`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
