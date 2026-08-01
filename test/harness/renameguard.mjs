// KAN-69: rename the inline `.rename-input` in the file pane and every OTHER
// event type the row still listens for leaks through it — the input only ever
// stopped propagation for `click`. Reported: double-click a word to select it,
// and the item opens instead.
//   npm run build && node test/harness/renameguard.mjs
//
// Nothing in the repo had DOM-level coverage of FileBrowser's inline rename
// before this file — not even "type a name, press Enter, the file is
// renamed" (every existing rename harness drives TabBar's `.tab-rename`
// instead). Section 5 below is that missing baseline; sections 1-4 are the
// guards around it, one per leaking event type named in the ticket.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// Throwaway profile, pid-suffixed — see CLAUDE.md's testing notes on why.
const PROFILE = path.join(os.tmpdir(), `claude-explorer-renameguard-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

// Fixtures live in their own throwaway folder, not ~/claudetest — nothing
// here needs a real Claude session, so there's no reason to share (and
// potentially collide with) the fixture folder every other harness uses.
const FIXTURE_DIR = path.join(os.tmpdir(), `ce-renameguard-${process.pid}`);
fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
fs.mkdirSync(FIXTURE_DIR, { recursive: true });

const NAMES = {
  select: 'kan69-select-me.txt',
  ctxmenu: 'kan69-ctxmenu.txt',
  drag: 'kan69-dragselect.txt',
  enter: 'kan69-e2e-enter.txt',
  escape: 'kan69-e2e-escape.txt',
  blur: 'kan69-e2e-blur.txt',
};
for (const n of Object.values(NAMES)) fs.writeFileSync(path.join(FIXTURE_DIR, n), `fixture ${n}\n`);

// §4 needs its own back-history and forward-history, each in its own isolated
// sub-block (see §4's own comment for why NOT at once). Three throwaway
// folders — B holds the rename target, A and C sit either side of it in the
// back/forward stack the three sub-blocks build up as they need it.
const NAV_A = path.join(os.tmpdir(), `ce-renameguard-navA-${process.pid}`);
const NAV_B = path.join(os.tmpdir(), `ce-renameguard-navB-${process.pid}`);
const NAV_C = path.join(os.tmpdir(), `ce-renameguard-navC-${process.pid}`);
for (const d of [NAV_A, NAV_B, NAV_C]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
const NAV_FILE = 'kan69-navguard.txt';
fs.writeFileSync(path.join(NAV_B, NAV_FILE), 'fixture kan69-navguard.txt\n');

const VIS = '.pane:not([hidden]) ';
const { win, close } = await launchApp({ userDataDir: PROFILE });
win.on('pageerror', (e) => console.log('  [pageerror]', e.message));

const entryRow = (name) => win.locator(`${VIS}.entry`, { hasText: name }).first();
const renameInput = () => win.locator(`${VIS}.rename-input`);
const tabCount = () => win.locator('.tab:not(.add)').count();
const activeTabId = () => win.locator('.tab.active').first().getAttribute('data-slide');
const breadcrumb = () => win.locator(`${VIS}.breadcrumb`).first().textContent();

/** Same address-bar edit every other harness uses (autolink.mjs / mcp.mjs /
 *  copypath.mjs) — not reinvented. */
async function navigateTab(i, folder) {
  await win.locator('.tab:not(.add)').nth(i).click();
  await win.waitForTimeout(150);
  await win.locator(`${VIS}.address`).click();
  await win.waitForTimeout(100);
  await win.locator(`${VIS}.address-input`).fill(folder);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(500);
}

/** Back on tab 0, looking at the fixture folder. Sections run against the
 *  UNMODIFIED build too (that's the whole point — see the RED/GREEN notes
 *  below), where §1's own double-click genuinely opens a new tab and
 *  navigates away; without this, that real failure would strand every
 *  section after it instead of letting each one report its own red/green. */
async function resetPane() {
  await dismissMenu();
  await win.locator('.tab:not(.add)').first().click();
  await win.waitForTimeout(150);
  const crumbs = await breadcrumb().catch(() => '');
  if (!crumbs || !crumbs.includes(path.basename(FIXTURE_DIR))) await navigateTab(0, FIXTURE_DIR);
}

/** Click the row, F2 to start renaming it — the one entry point that always
 *  starts from a single-selected row (F2 requires selectedPaths.length===1),
 *  so every section below reaches the same real state a user reaches. */
async function startRename(name) {
  await resetPane();
  await entryRow(name).click();
  await win.waitForTimeout(150);
  await win.keyboard.press('F2');
  await win.waitForSelector(`${VIS}.rename-input`, { timeout: 5_000 });
}

/** Escape always cancels cleanly, whatever state a section left renaming in —
 *  used between sections so one section's leftovers can't taint the next. */
async function cancelRename() {
  if (await renameInput().count()) {
    await renameInput().press('Escape').catch(() => {});
    await win.waitForTimeout(150);
  }
}

/** Against the UNMODIFIED build §2 leaves a real `.ctx-backdrop` open (that IS
 *  the red proof), and it eats every click behind it — including resetPane's
 *  own tab click — until something closes it. A user would click it away too. */
async function dismissMenu() {
  if (await win.locator('.ctx-backdrop').count()) {
    await win.locator('.ctx-backdrop').click({ force: true }).catch(() => {});
    await win.waitForTimeout(150);
  }
}

try {
  console.log('\n0. a Files tab pointed at the fixture folder');
  await win.waitForSelector('.tab:not(.add)');
  await navigateTab(0, FIXTURE_DIR);
  await win.waitForSelector(`${VIS}.entry`, { timeout: 10_000 });
  for (const n of Object.values(NAMES)) {
    check(`fixture visible in the pane: ${n}`, (await entryRow(n).count()) > 0);
  }
  const filesTabId = await activeTabId();

  // ===========================================================================
  console.log('\n1. double-click a word in the rename box selects it — the file does NOT open');
  // ===========================================================================
  {
    await startRename(NAMES.select);
    const beforeTabs = await tabCount();
    const beforeActive = await activeTabId();

    const box = await renameInput().boundingBox();
    // A few px in from the left edge, inside the mono-font text
    // ("kan69-select-me.txt") and well clear of the padding — not the
    // bounding box's CENTER, which given `.rename-input { width: 60% }` can
    // sit past the end of a short value in empty input padding.
    await renameInput().dblclick({ position: { x: 14, y: Math.round(box.height / 2) } });
    await win.waitForTimeout(200);

    const sel = await renameInput().evaluate((el) => ({
      start: el.selectionStart, end: el.selectionEnd, value: el.value,
    })).catch(() => null);
    check('a word got selected (selectionStart !== selectionEnd)',
      !!sel && sel.start !== sel.end, JSON.stringify(sel));

    const afterTabs = await tabCount();
    const afterActive = await activeTabId();
    check('the file did NOT open — no new tab, same active tab',
      afterTabs === beforeTabs && afterActive === beforeActive,
      `tabs ${beforeTabs}→${afterTabs}, active ${beforeActive}→${afterActive}`);
    check('...and the rename box is still open, untouched',
      (await renameInput().count()) === 1 && sel?.value === NAMES.select,
      `value now ${JSON.stringify(sel?.value)}`);

    await cancelRename();
    // Referee KAN-69 finding: the original version of this check compared
    // `filesTabId` (read once, before §1 even starts) against `beforeActive`
    // (also read BEFORE the double-click) — both operands frozen pre-dblclick,
    // so it was tab 0's id equalling tab 0's id and could never fail no matter
    // what the double-click actually did. Re-read the active tab now, AFTER
    // cancelRename(), so an unguarded dblclick (which switches the active tab
    // to a new one and leaves this pane's tab hidden, so cancelRename() can't
    // reach its rename box at all) shows up here too.
    const afterSectionActive = await activeTabId();
    check('§1 sanity: back on the original Files tab afterward',
      afterSectionActive === filesTabId, `${filesTabId} vs ${afterSectionActive}`);
  }

  // ===========================================================================
  console.log('\n2. right-click in the rename box opens no context menu (and cannot mutate selection)');
  // ===========================================================================
  // Referee KAN-69 finding: F2 (the original version's entry point) always
  // starts from a row that's already selected, so the ctx-menu handler's
  // `if (!inSel) setSelection(...)` branch is unreachable there — inSel is
  // always true, so "selection unchanged" passed even with the guard deleted
  // outright. The ticket's own reachable repro is New Folder: createThenRename
  // starts a rename on the freshly-created row WITHOUT ever touching
  // `selection`, so that row is real and un-selected at the same time — the
  // one shape where the vulnerable branch actually runs. Select an unrelated
  // anchor file, Ctrl+Shift+N, then right-click the (unselected) new row.
  {
    await resetPane();
    // NOT the alphabetically-first fixture: "New folder" sorts ahead of every
    // file here (dirs-first), so selecting the file that WAS at index 0 would
    // have its index land right back on the new dir after the shift, which is
    // a different (and misleading) coincidence, not the gap this is proving.
    // kan69-dragselect.txt sits at index 1 before creation, which the shift
    // moves off onto a THIRD file — matching the referee's own repro shape.
    await entryRow(NAMES.drag).click();
    await win.waitForTimeout(150);

    await win.keyboard.press('Control+Shift+N');
    await win.waitForSelector(`${VIS}.rename-input`, { timeout: 5_000 });
    const newFolderName = await renameInput().evaluate((el) => el.value);
    const rowClassBefore = await renameInput().evaluate((el) => el.closest('li').className);
    check('§2 setup: the new row being renamed is NOT selected (the reachable repro)',
      !rowClassBefore.includes('selected'), rowClassBefore);

    // Whatever IS selected right now, by DOM identity — not by filename, since
    // inserting "New folder" can itself shift which index the (index-based)
    // selection resolves to. Querying live DOM sidesteps that entirely: this
    // is "the selected row(s), whatever they are" both before and after.
    const selectionSnapshot = () => win.evaluate(() =>
      Array.from(document.querySelectorAll('.pane:not([hidden]) .entry.selected'))
        .map((el) => el.textContent.trim()));
    const selBefore = await selectionSnapshot();
    check('§2 setup: something is selected before the right-click', selBefore.length > 0, JSON.stringify(selBefore));

    const box = await renameInput().boundingBox();
    await renameInput().click({ button: 'right', position: { x: 14, y: Math.round(box.height / 2) } });
    await win.waitForTimeout(300);

    check('no context menu (.ctx-backdrop) appeared', (await win.locator('.ctx-backdrop').count()) === 0);
    // NOT "the rename box is still open": opening a context menu never blurs
    // the input either way, so that check passed even with the guard deleted
    // and a real menu open — structurally guaranteed, not a signal.
    const selAfter = await selectionSnapshot();
    check('the row selection is unchanged by the right-click',
      JSON.stringify(selBefore) === JSON.stringify(selAfter), `${JSON.stringify(selBefore)} → ${JSON.stringify(selAfter)}`);

    await cancelRename();
    fs.rmSync(path.join(FIXTURE_DIR, newFolderName), { recursive: true, force: true });
  }

  // ===========================================================================
  console.log('\n3. dragging in the rename box selects text — it does NOT start a file drag');
  // ===========================================================================
  {
    await startRename(NAMES.drag);
    await win.evaluate(() => {
      window.__ceDragstarts = 0;
      document.addEventListener('dragstart', () => { window.__ceDragstarts++; }, true);
    });

    const box = await renameInput().boundingBox();
    const y = box.y + Math.round(box.height / 2);
    await win.mouse.move(box.x + 6, y);
    await win.mouse.down();
    await win.mouse.move(box.x + 60, y, { steps: 8 });
    await win.waitForTimeout(150);
    await win.mouse.up();
    await win.waitForTimeout(200);

    const dragstarts = await win.evaluate(() => window.__ceDragstarts);
    check('no dragstart event fired anywhere in the pane', dragstarts === 0, `${dragstarts} dragstart event(s)`);

    const sel = await renameInput().evaluate((el) => ({ start: el.selectionStart, end: el.selectionEnd })).catch(() => null);
    check('the drag gesture selected text instead (selectionStart !== selectionEnd)',
      !!sel && sel.start !== sel.end, JSON.stringify(sel));

    await cancelRename();
  }

  // ===========================================================================
  console.log('\n4. Alt+Left / Alt+Right / F5 do not navigate or refresh while renaming');
  // ===========================================================================
  // FileBrowser's `history` (back/forward) is local component state, and
  // FileBrowser is mounted ONLY while its tab is visible (App.tsx: "Files and
  // viewer panes are mounted only while visible") — a real tab switch (which
  // resetPane() does, and which earlier sections' bugs can force too)
  // discards it. Each of the three sub-blocks below drives the tab and
  // address bar directly and rebuilds whatever history state IT needs from
  // scratch (always via an absolute address-bar entry, never by depending on
  // where a PREVIOUS sub-block's shortcut — buggy or not — left the pane), so
  // none of the three can taint another's setup.
  //
  // Alt+Left and Alt+Right are proved in fully separate rename sessions, not
  // a single shared before/after breadcrumb: back-then-forward round-trips to
  // the same breadcrumb it started at even if BOTH shortcuts fired for real —
  // Alt+Right's own goForward() would walk back to exactly the spot Alt+Left
  // had just left, so one before/after check spanning both cannot fail. That
  // combined shape was tried first here and caught its own vacuousness RED:
  // Alt+Left alone reported FAIL, and then Alt+Right's follow-up passed by
  // cancelling it out.
  {
    console.log('  4a. Alt+Left, alone');
    await navigateTab(0, NAV_A);
    await navigateTab(0, NAV_B); // current=NAV_B, back=[NAV_A], forward=[]
    const atB = await breadcrumb();
    check('§4a setup: on NAV_B with a real back step available', atB.includes(path.basename(NAV_B)), atB);

    await win.locator(`${VIS}.entry`, { hasText: NAV_FILE }).first().click();
    await win.waitForTimeout(150);
    await win.keyboard.press('F2');
    await win.waitForSelector(`${VIS}.rename-input`, { timeout: 5_000 });

    await win.keyboard.press('Alt+ArrowLeft');
    await win.waitForTimeout(300);
    const afterLeft = await breadcrumb();
    check('Alt+Left did not navigate to the back step', afterLeft === atB, `${atB} → ${afterLeft}`);
    check('the rename box is still open after Alt+Left', (await renameInput().count()) === 1);
    await cancelRename();

    // Referee KAN-69 finding: every §4 assertion up to here proves only the
    // negative half of a gate this diff ADDS — an over-broad `if (false)`
    // (the three shortcuts dead everywhere, not just while renaming) leaves
    // all of them green. Same session, same back-step: fire the identical
    // shortcut once the rename box is gone and nothing is being typed into,
    // and require it to actually navigate this time.
    await win.locator(`${VIS}.entries`).click({ position: { x: 5, y: 5 } });
    await win.waitForTimeout(150);
    await win.keyboard.press('Alt+ArrowLeft');
    await win.waitForTimeout(300);
    const controlLeft = await breadcrumb();
    check('control: Alt+Left DOES navigate when nothing is being typed into',
      controlLeft.includes(path.basename(NAV_A)), `${atB} → ${controlLeft}`);
  }
  {
    console.log('  4b. Alt+Right, alone — a fresh forward-step, unrelated to §4a');
    await navigateTab(0, NAV_B);
    await navigateTab(0, NAV_C); // current=NAV_C, back=[..., NAV_B], forward=[]
    await win.locator(`${VIS}.nav-btn`).first().click(); // UI back button, NOT the shortcut: NAV_B, forward=[NAV_C]
    await win.waitForTimeout(300);
    const atB = await breadcrumb();
    check('§4b setup: on NAV_B with a real forward step available', atB.includes(path.basename(NAV_B)), atB);

    await win.locator(`${VIS}.entry`, { hasText: NAV_FILE }).first().click();
    await win.waitForTimeout(150);
    await win.keyboard.press('F2');
    await win.waitForSelector(`${VIS}.rename-input`, { timeout: 5_000 });

    await win.keyboard.press('Alt+ArrowRight');
    await win.waitForTimeout(300);
    const afterRight = await breadcrumb();
    check('Alt+Right did not navigate to the forward step', afterRight === atB, `${atB} → ${afterRight}`);
    check('the rename box is still open after Alt+Right', (await renameInput().count()) === 1);
    await cancelRename();

    // Positive control — see §4a's comment for why this half matters.
    await win.locator(`${VIS}.entries`).click({ position: { x: 5, y: 5 } });
    await win.waitForTimeout(150);
    await win.keyboard.press('Alt+ArrowRight');
    await win.waitForTimeout(300);
    const controlRight = await breadcrumb();
    check('control: Alt+Right DOES navigate when nothing is being typed into',
      controlRight.includes(path.basename(NAV_C)), `${atB} → ${controlRight}`);
  }
  {
    console.log('  4c. F5, alone — no back/forward step involved at all');
    await navigateTab(0, NAV_B);
    // Against the UNMODIFIED build, §4b's Alt+Right genuinely navigates away
    // mid-rename (that IS its red proof) without clearing `renaming` state,
    // which is keyed by PATH, not by directory — so landing back on NAV_B
    // resurrects the very same row as a stale, already-open rename box
    // instead of a normal label. A real user would see and dismiss this too;
    // clear it before this sub-block starts its own rename.
    await cancelRename();
    await win.locator(`${VIS}.entry`, { hasText: NAV_FILE }).first().click();
    await win.waitForTimeout(150);
    await win.keyboard.press('F2');
    await win.waitForSelector(`${VIS}.rename-input`, { timeout: 5_000 });

    // A file dropped on disk mid-rename: if F5 is NOT guarded, refresh()
    // reloads the listing and this shows up; if it IS guarded, nothing
    // re-reads the directory and it stays invisible. Nothing else in
    // FileBrowser polls or watches the filesystem, so this is a real,
    // load-bearing signal for "did a refresh actually happen" — not a marker
    // read out of app state.
    const marker = 'kan69-f5-marker.txt';
    fs.writeFileSync(path.join(NAV_B, marker), 'planted after rename started\n');

    await win.keyboard.press('F5');
    await win.waitForTimeout(500);
    // NOT "the rename box is still open after F5": refresh() only ever calls
    // load(), which never touches `renaming` state — the box stays open
    // whether F5 actually fired or not, so that check is structurally
    // guaranteed true and was never a signal. The marker-visibility check
    // below is the real (and only available) probe for "did a refresh happen".
    check('F5 did not refresh the listing (the marker file dropped mid-rename is still invisible)',
      (await win.locator(`${VIS}.entry`, { hasText: marker }).count()) === 0);

    await cancelRename();

    // Positive control — see §4a's comment for why this half matters.
    await win.locator(`${VIS}.entries`).click({ position: { x: 5, y: 5 } });
    await win.waitForTimeout(150);
    await win.keyboard.press('F5');
    await win.waitForTimeout(500);
    check('control: F5 DOES refresh when nothing is being typed into',
      (await win.locator(`${VIS}.entry`, { hasText: marker }).count()) > 0);

    fs.rmSync(path.join(NAV_B, marker), { force: true });
  }

  // ===========================================================================
  console.log('\n5. rename end to end — never asserted anywhere in this repo before');
  // ===========================================================================
  {
    // --- 5a. type + Enter commits --------------------------------------------
    const oldPath = path.join(FIXTURE_DIR, NAMES.enter);
    const newName = 'kan69-e2e-enter-RENAMED.txt';
    const newPath = path.join(FIXTURE_DIR, newName);
    await startRename(NAMES.enter);
    await win.keyboard.press('Control+a');
    await win.keyboard.type(newName);
    await win.keyboard.press('Enter');
    await win.waitForTimeout(800);
    check('§5a Enter: rename box closed', (await renameInput().count()) === 0);
    check('§5a Enter: new name appears in the pane', (await entryRow(newName).count()) > 0);
    check('§5a Enter: old name is gone from the pane', (await entryRow(NAMES.enter).count()) === 0);
    check('§5a Enter: renamed ON DISK', !fs.existsSync(oldPath) && fs.existsSync(newPath),
      `old exists=${fs.existsSync(oldPath)}, new exists=${fs.existsSync(newPath)}`);

    // --- 5b. type + Escape cancels -------------------------------------------
    const escOld = path.join(FIXTURE_DIR, NAMES.escape);
    const garbage = 'kan69-e2e-escape-SHOULD-NOT-EXIST.txt';
    await startRename(NAMES.escape);
    await win.keyboard.press('Control+a');
    await win.keyboard.type(garbage);
    await win.keyboard.press('Escape');
    await win.waitForTimeout(500);
    check('§5b Escape: rename box closed', (await renameInput().count()) === 0);
    check('§5b Escape: original name still in the pane', (await entryRow(NAMES.escape).count()) > 0);
    check('§5b Escape: nothing renamed on disk',
      fs.existsSync(escOld) && !fs.existsSync(path.join(FIXTURE_DIR, garbage)),
      `original exists=${fs.existsSync(escOld)}, garbage exists=${fs.existsSync(path.join(FIXTURE_DIR, garbage))}`);

    // --- 5c. type + blur commits ---------------------------------------------
    // "Focus-order-sensitive under a harness": a real click elsewhere is also a
    // click ON something, and that something's own click handler can run before
    // or interleaved with the blur it incidentally causes, racing commitRename.
    // Calling the DOM's own .blur() sidesteps that ambiguity entirely while
    // still firing a genuine 'blur' event through the same onBlur={commitRename}
    // React wires up for a real user-driven blur — it does not touch commitRename
    // or React state directly.
    const blurOld = path.join(FIXTURE_DIR, NAMES.blur);
    const blurNew = 'kan69-e2e-blur-RENAMED.txt';
    const blurNewPath = path.join(FIXTURE_DIR, blurNew);
    await startRename(NAMES.blur);
    await win.keyboard.press('Control+a');
    await win.keyboard.type(blurNew);
    await win.evaluate(() => { document.activeElement?.blur(); });
    await win.waitForTimeout(800);
    check('§5c blur: rename box closed', (await renameInput().count()) === 0);
    check('§5c blur: new name appears in the pane', (await entryRow(blurNew).count()) > 0);
    check('§5c blur: renamed ON DISK', !fs.existsSync(blurOld) && fs.existsSync(blurNewPath),
      `old exists=${fs.existsSync(blurOld)}, new exists=${fs.existsSync(blurNewPath)}`);
  }
} finally {
  await close();
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  for (const d of [NAV_A, NAV_B, NAV_C]) fs.rmSync(d, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log('  -', f.name);
}
process.exit(failed.length ? 1 : 0);
