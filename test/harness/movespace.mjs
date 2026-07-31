// KAN-66: moving a tab — or a whole group — to another space.
//   npm run build && node test/harness/movespace.mjs
//
// Spaces have existed since M5 with no way to put a tab into one. This proves,
// against the real running app, the five things the feature has to get right
// and the two that break silently:
//
//   1. A LIVE CLAUDE/SHELL SESSION SURVIVES THE MOVE. The pty is never rebuilt
//      and the xterm is never remounted — probed on the .xterm ELEMENT, not on
//      its text, because ConPTY repaints its whole screen buffer on resize and
//      a text probe passes even when every xterm was destroyed (the trap
//      spaces.mjs documents; it caught a real regression there).
//   2. MOVING A TAB OUT OF A SPLIT PANE VACATES THE CELL. `addTabToSpace` only
//      touches `tabIds`, so the source space is otherwise left with a GridCell
//      naming a tab it no longer owns. The render-time `compact` HIDES that
//      while you are looking at the space, which is exactly why this is checked
//      after a RESTART: the dead cell is what gets written, sanitize() prunes
//      the id but does not compact, and the space comes back with an empty
//      track — a hole in the tiling where the pane used to be.
//   3. SELECTIVITY. Exactly one move is questioned — a grouped tab moving on
//      its own, which silently leaves its group. An ungrouped tab and a whole
//      group move on one click. The absence of the dialog is asserted, because
//      a confirm on every move is how the one that matters gets clicked
//      through.
//   4. A whole group arrives complete, in order and still grouped.
//   5. The drag lands the same operation as the menu — including the
//      spring-load that makes it reachable at all (the switcher closes on any
//      outside mousedown, and the mousedown that starts a tab drag is one).
//
// A plain PowerShell tab stands in for Claude: the claim is about pty lifetime,
// which is the same process machinery either way, and this costs no tokens and
// no ~2-minute CLI startup (test/harness/resume.mjs pays that).
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
const spaceName = (win) => win.locator('.spacemenu-name').textContent().then((t) => t.trim());
const activeTitle = (win) =>
  win.locator('.tab.active').first().textContent().then(clean).catch(() => '(none)');
const modals = (win) => win.locator('.modal').count();
const termText = (win) => win.$eval('.pane .xterm-rows', (el) => el.textContent);
/** Members of every group chip on the strip, in strip order. */
const grouped = (win) => win.evaluate(() =>
  [...document.querySelectorAll('.tabgroup')].map((g) => ({
    name: g.querySelector('.group-label-name').textContent.trim(),
    tabs: [...g.querySelectorAll('.tab')].map((t) => t.textContent.replace(/[\u{1F4C1}▶×]/gu, '').trim()),
  })));

/**
 * The strip as the ORDERING assertions need it. A pinned tab has no
 * `.tab-title` (it is icon-only), so its identity is only in the `title`
 * ATTRIBUTE — same idiom as pinned.mjs, and the only reason a pinned tab can be
 * named in an order check at all.
 */
const strip = (win) => win.evaluate(() =>
  [...document.querySelectorAll('.tab:not(.add)')].map((t) => ({
    t: (t.querySelector('.tab-title')?.textContent ?? t.getAttribute('title') ?? '')
      .replace(/[\u{1F4C1}▶×]/gu, '').trim(),
    pinned: t.classList.contains('pinned'),
  })));

/** Every pinned tab left of every unpinned one — the invariant `normalize()`
 *  exists to enforce, read off the DOM rather than off the model. */
const pinnedFirst = (s) => {
  const flags = s.map((t) => t.pinned);
  const last = flags.lastIndexOf(true);
  const first = flags.indexOf(false);
  return last === -1 || first === -1 || last < first;
};

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

async function switchSpaceViaMenu(win, name) {
  await openSpaceMenu(win);
  await win.locator('.spacemenu-item-name', { hasText: name }).first().click();
  await win.waitForTimeout(600);
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

async function addTab(win, name) {
  const before = (await titles(win)).length;
  await win.click('.tab.add');
  await win.waitForTimeout(700);
  await renameTab(win, before, name);
}

/**
 * Open a submenu and pick a row from it. The submenu opens on :hover with no
 * state behind it, so hovering the parent is the whole of "open it" — and the
 * nested <ul> is a CHILD of the parent row, so the pointer travelling onto it
 * never leaves the parent's :hover.
 */
async function pickSub(win, parentText, rowText) {
  await win.locator('.ctx-sub', { hasText: parentText }).hover();
  await win.waitForTimeout(200);
  await win.locator('.ctx-sub .ctx-menu .ctx-item', { hasText: new RegExp(`^${rowText}$`) })
    .first().click();
  await win.waitForTimeout(600);
}

/** Right-click tab `i` → Move Tab to ▸ `space`. Leaves any confirm ON SCREEN. */
async function moveTabViaMenu(win, i, space) {
  await win.locator('.tab:not(.add)').nth(i).click({ button: 'right' });
  await win.waitForTimeout(250);
  await pickSub(win, 'Move Tab to', space);
}

/** Right-click the group chip → Move Group to ▸ `space`. */
async function moveGroupViaMenu(win, groupName, space) {
  await win.locator('.group-label', { hasText: groupName }).first().click({ button: 'right' });
  await win.waitForTimeout(250);
  await pickSub(win, 'Move Group to', space);
}

/**
 * The real gesture: a native HTML5 drag off the strip, over the space switcher
 * (which must SPRING OPEN — the drag's own mousedown has already closed it),
 * and onto a space row. Real mouse throughout, so this is Chromium's own drag
 * machinery and TabBar's own dragstart filling the DataTransfer.
 */
async function dragTabToSpaceRow(win, i, space) {
  const t = await win.locator('.tab:not(.add)').nth(i).boundingBox();
  const y = t.y + t.height / 2;
  await win.mouse.move(t.x + t.width / 2, y);
  await win.mouse.down();
  await win.mouse.move(t.x + t.width / 2 + 26, y + 10); // clear the press threshold
  // PRE-ROLL, and it is load-bearing. Chromium's drag loop does not emit its
  // first `dragover` until a few hundred ms after `mousedown`, and until one
  // reaches the STRIP nothing translates the dragged tab. Leaving immediately
  // means the pointer is already over the switcher before the tab has moved a
  // pixel — measured on a short strip: two dragovers for the whole gesture,
  // both of them already on `.spacemenu-btn`, transform still "". Two paced
  // hops inside the strip first, so the tab is demonstrably following before
  // the traverse begins.
  await win.waitForTimeout(400);
  await win.mouse.move(t.x + t.width / 2 + 14, y);
  await win.waitForTimeout(250);
  const btn = await win.locator('.spacemenu-btn').boundingBox();
  const target = btn.x + btn.width / 2;
  // HUMAN-PACED, and this is load-bearing rather than cosmetic. The spring-load
  // fires from a WINDOW dragover, and the only reason one ever reaches the
  // window is that the dragged tab is translated under the pointer — an event
  // whose target is inside `.spacemenu` is stopPropagation'd by the menu's own
  // handler and never bubbles that far. `mouse.move(..., { steps: 8 })` emits
  // too few dragovers for the tab to keep up, so the pointer arrives over bare
  // menu chrome and NOTHING springs — measured: target `.spacemenu-name`, zero
  // dropdowns. Small hops with a beat between them are what a hand does, and
  // the last dragover then reads `.tab-icon`, as the design intends.
  for (let x = t.x + t.width / 2 + 14; x > target; x -= 12) {
    await win.mouse.move(x, y);
    await win.waitForTimeout(60);
  }
  await win.mouse.move(target, btn.y + btn.height / 2);
  await win.waitForTimeout(500);
  const sprung = await win.locator('.spacemenu-dropdown').count();
  let row = null;
  if (sprung) {
    row = await win.locator('.spacemenu-item-name', { hasText: space }).first().boundingBox();
    await win.mouse.move(row.x + row.width / 2, row.y + row.height / 2, { steps: 8 });
    await win.waitForTimeout(300);
  }
  await win.mouse.up();
  await win.waitForTimeout(900);
  return sprung > 0;
}

/**
 * How much of `.content` the visible panes actually cover, horizontally.
 *
 * A vacated cell that was never taken out of the layout comes back from disk as
 * a track with nothing in it — the panes still tile their own rectangles, so
 * every per-pane check passes, and only the total gives it away.
 */
const tiling = (win) => win.evaluate(() => {
  const c = document.querySelector('.content').getBoundingClientRect();
  const panes = [...document.querySelectorAll('.pane:not([hidden])')].map((p) => p.getBoundingClientRect());
  return {
    panes: panes.length,
    cover: +(panes.reduce((n, r) => n + r.width, 0) / c.width).toFixed(2),
    tracks: getComputedStyle(document.querySelector('.content')).gridTemplateColumns,
  };
});

/** Run 1's final view of the destination strip; Run 2 asserts it survived. */
let betaAsLeft = [];

const PROFILE = path.join(os.tmpdir(), `claude-explorer-movespace-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

// Shell-GENERATED, never typed: the terminal echoes what you type, so a command
// containing the literal joined marker puts it on screen whether or not the
// shell ever ran. `Write-Host ('CE-DONE-'+$t)` echoes as `'CE-DONE-'+$t`.
const TAG = Date.now().toString().slice(-6);
const MARKER = `CE-MARK-${TAG}`;
const DONE = `CE-DONE-${TAG}`;
const ALIVE = `CE-ALIVE-${TAG}`;
const emit = (prefix) => `Write-Host ('${prefix}-'+$t)`;

async function runInTerminal(win, line) {
  await win.locator('.pane:not([hidden]) .xterm-screen').click();
  await win.waitForTimeout(200);
  await win.keyboard.type(line);
  await win.waitForTimeout(200);
  await win.keyboard.press('Enter');
}

// ===========================================================================
// Run 1
// ===========================================================================
{
  const { win, close } = await launchApp({ userDataDir: PROFILE });
  await win.waitForSelector('.entry');
  await win.waitForTimeout(600);

  await createSpace(win, 'Beta');
  await win.click('.tabbar');
  await win.keyboard.press('Control+1');
  await win.waitForTimeout(700);
  check('set-up: back in the first space, which is where every move starts from',
    (await spaceName(win)) === 'Space', await spaceName(win));

  await renameTab(win, 0, 'A1');
  await addTab(win, 'A2');
  await addTab(win, 'A3');
  check('set-up: three tabs in the source space',
    (await titles(win)).join('|') === 'A1|A2|A3', (await titles(win)).join(' | '));

  // --- §1 an UNGROUPED tab: no dialog, and it really leaves ----------------
  await moveTabViaMenu(win, 1, 'Beta');
  check('moving an ungrouped tab raises NO dialog at all (selectivity)',
    (await modals(win)) === 0, `${await modals(win)} modal(s)`);
  check('the tab is gone from the space it left',
    (await titles(win)).join('|') === 'A1|A3', (await titles(win)).join(' | '));
  check('and the move did NOT take the user to the destination',
    (await spaceName(win)) === 'Space', await spaceName(win));

  await switchSpaceViaMenu(win, 'Beta');
  check('it arrived in the destination space',
    (await titles(win)).join('|') === 'A2', (await titles(win)).join(' | '));
  await switchSpaceViaMenu(win, 'Space');

  // --- §2 a LIVE terminal: the pty is never rebuilt -------------------------
  await tabMenu(win, 0, 'Open Terminal');
  await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 20_000 });
  await win.waitForTimeout(1500);
  check('set-up: a real PowerShell tab is open in the source space',
    (await titles(win)).join('|') === 'A1|A3|Terminal', (await titles(win)).join(' | '));

  // MARKER, then 8 ticks at 700ms (~5.6s), then DONE — so DONE can only be
  // produced after the move, by a process the move did not disturb.
  await runInTerminal(win,
    `$t='${TAG}'; ${emit('CE-MARK')}; 1..8 | ForEach-Object { Write-Host "CE-TICK $_"; Start-Sleep -Milliseconds 700 }; ${emit('CE-DONE')}`);
  await win.waitForTimeout(1800);
  await win.evaluate(() => { document.querySelector('.pane .xterm').dataset.ceProbe = 'moved'; });
  const before = await termText(win);
  check('set-up: the shell printed its marker and is still ticking',
    before.includes(MARKER) && !before.includes(DONE),
    before.includes(DONE) ? 'already finished — timing is wrong' : 'ticking');

  await moveTabViaMenu(win, 2, 'Beta');
  check('moving a live terminal raises no dialog either — nothing is being closed',
    (await modals(win)) === 0, `${await modals(win)} modal(s)`);
  check('it left the source strip',
    (await titles(win)).join('|') === 'A1|A3', (await titles(win)).join(' | '));
  const parked = await win.evaluate(() => ({
    xterms: document.querySelectorAll('.xterm').length,
    visible: document.querySelectorAll('.pane:not([hidden]) .xterm').length,
  }));
  check('its pane is still MOUNTED, merely hidden — the move did not unmount anything',
    parked.xterms === 1 && parked.visible === 0, JSON.stringify(parked));

  await win.waitForTimeout(6000); // the ticker finishes while its tab is elsewhere
  await switchSpaceViaMenu(win, 'Beta');
  check('the moved terminal is in the destination space',
    (await titles(win)).join('|') === 'A2|Terminal', (await titles(win)).join(' | '));
  check('and it did NOT steal the destination space\'s remembered focus',
    (await activeTitle(win)) === 'A2', await activeTitle(win));

  // Show it before reading the buffer. A `hidden` pane is `display: none` and
  // xterm does not repaint one, so its rows lag behind the pty — the text probe
  // has to be taken with the terminal on screen. (Which is also why the ELEMENT
  // probe below is the load-bearing half: it is true whether or not anything
  // repainted.)
  await win.locator('.tab:not(.add)').nth(1).click();
  await win.waitForTimeout(1200);

  const after = await termText(win);
  const probe = await win.evaluate(() => document.querySelector('.pane .xterm')?.dataset.ceProbe ?? null);
  check('THE PTY KEPT RUNNING across the move (output only it could have produced)',
    after.includes(DONE), `done=${after.includes(DONE)}`);
  check('and it is the SAME xterm instance, never rebuilt — the ELEMENT probe survived',
    probe === 'moved', String(probe));
  await runInTerminal(win, `$t='${TAG}'; ${emit('CE-ALIVE')}`);
  await win.waitForTimeout(1500);
  check('the shell is still ALIVE in its new space — it answers a new command',
    (await termText(win)).includes(ALIVE));
  await switchSpaceViaMenu(win, 'Space');

  // --- §3 a GROUPED tab, on its own: the one move that asks ----------------
  await tabMenu(win, 0, 'New group from this tab');
  await tabMenu(win, 1, 'Add to');
  check('set-up: a two-member group in the source space',
    JSON.stringify(await grouped(win)) === JSON.stringify([{ name: 'Group', tabs: ['A1', 'A3'] }]),
    JSON.stringify(await grouped(win)));

  // --- §3a dropping onto the space the tab is ALREADY in -------------------
  // Reachable only by DRAG — the submenu filters the owning space out — and it
  // is the row the pointer is nearest when the switcher springs open: the one
  // with the ✓. A tab already here is not moving, so the group-leaving confirm
  // must not be raised. A dialog that names a consequence, is accepted by the
  // user, and then no-ops is exactly the click-through the selectivity rule
  // exists to prevent.
  const wasStrip = (await titles(win)).join('|');
  const wasGroups = JSON.stringify(await grouped(win));
  const ownSprung = await dragTabToSpaceRow(win, 0, 'Space'); // A1, GROUPED, onto its OWN space
  check('set-up: the drag reached the switcher, which sprang open over its own-space row',
    ownSprung, String(ownSprung));
  check('dropping a grouped tab on the space it is ALREADY in raises NO dialog',
    (await modals(win)) === 0,
    `${await modals(win)} modal(s): ${await win.locator('.modal p').textContent().catch(() => '')}`);
  if (await modals(win)) {
    await win.locator('.modal button', { hasText: 'Cancel' }).click();
    await win.waitForTimeout(400);
  }
  check('and it changed nothing — same strip, same group',
    (await titles(win)).join('|') === wasStrip && JSON.stringify(await grouped(win)) === wasGroups,
    `${(await titles(win)).join(' | ')} / ${JSON.stringify(await grouped(win))}`);

  // The control, and the reason the two checks above are not vacuous: the SAME
  // tab and the SAME gesture, one row further down — a row that IS a move —
  // must raise it. So "no dialog" above is the own-space row being declined,
  // not a drop that quietly failed to land anywhere.
  await dragTabToSpaceRow(win, 0, 'Beta');
  const dragSaid = await win.locator('.modal p').textContent().catch(() => '(no dialog)');
  check('the same drag onto a DIFFERENT space DOES raise it — so the drop really lands on rows',
    dragSaid === 'This tab will be removed from the current group and will be moved to that space.',
    dragSaid);
  if (await modals(win)) {
    await win.locator('.modal button', { hasText: 'Cancel' }).click();
    await win.waitForTimeout(400);
  }
  check('and cancelling that leaves everything exactly as it was',
    (await titles(win)).join('|') === wasStrip && JSON.stringify(await grouped(win)) === wasGroups,
    `${(await titles(win)).join(' | ')} / ${JSON.stringify(await grouped(win))}`);

  await moveTabViaMenu(win, 1, 'Beta');
  const said = await win.locator('.modal p').textContent().catch(() => '(no dialog)');
  check('moving a GROUPED tab on its own asks first, naming what it changes',
    said === 'This tab will be removed from the current group and will be moved to that space.', said);

  await win.locator('.modal button', { hasText: 'Cancel' }).click();
  await win.waitForTimeout(500);
  check('Cancel leaves the tab where it was, still in its group',
    JSON.stringify(await grouped(win)) === JSON.stringify([{ name: 'Group', tabs: ['A1', 'A3'] }]),
    JSON.stringify(await grouped(win)));

  await moveTabViaMenu(win, 1, 'Beta');
  await win.locator('.modal button.danger').click();
  await win.waitForTimeout(700);
  check('Continue moves it, and the group it left keeps its other member',
    JSON.stringify(await grouped(win)) === JSON.stringify([{ name: 'Group', tabs: ['A1'] }]),
    JSON.stringify(await grouped(win)));

  await switchSpaceViaMenu(win, 'Beta');
  check('it arrived in the destination — and NOT inside a group there',
    (await titles(win)).join('|') === 'A2|Terminal|A3' && (await grouped(win)).length === 0,
    `${(await titles(win)).join(' | ')} / groups ${JSON.stringify(await grouped(win))}`);
  await switchSpaceViaMenu(win, 'Space');

  // --- §4 a WHOLE group: everything, in order, still grouped, no dialog ----
  await addTab(win, 'G2');
  await tabMenu(win, 1, 'Add to');
  await addTab(win, 'G3');
  await tabMenu(win, 2, 'Add to');
  check('set-up: a three-member group',
    JSON.stringify(await grouped(win)) === JSON.stringify([{ name: 'Group', tabs: ['A1', 'G2', 'G3'] }]),
    JSON.stringify(await grouped(win)));

  await moveGroupViaMenu(win, 'Group', 'Beta');
  check('moving a WHOLE group raises no dialog — it loses nothing',
    (await modals(win)) === 0, `${await modals(win)} modal(s)`);
  check('every member left the source space at once',
    (await titles(win)).length === 0, (await titles(win)).join(' | '));

  await switchSpaceViaMenu(win, 'Beta');
  check('all three arrived, in order, still one group and contiguous',
    JSON.stringify(await grouped(win)) === JSON.stringify([{ name: 'Group', tabs: ['A1', 'G2', 'G3'] }]),
    JSON.stringify(await grouped(win)));

  await switchSpaceViaMenu(win, 'Space');

  // --- §5 the DRAG, onto a space row in the switcher -----------------------
  await addTab(win, 'D1');
  const sprung = await dragTabToSpaceRow(win, 0, 'Beta');
  check('the switcher SPRINGS OPEN under a dragged tab (without it the gesture is unreachable)',
    sprung, String(sprung));
  check('the dragged tab left the source space',
    (await titles(win)).length === 0, (await titles(win)).join(' | '));
  check('and dropping on a row did NOT switch the user to that space',
    (await spaceName(win)) === 'Space', await spaceName(win));
  await switchSpaceViaMenu(win, 'Beta');
  check('the drag landed the same operation the menu does — the tab is here',
    (await titles(win)).includes('D1'), (await titles(win)).join(' | '));
  await switchSpaceViaMenu(win, 'Space');

  // --- §5b a PINNED tab: moves silently, and arrives WHERE A PINNED TAB GOES -
  // `addTabToSpace` appends. That is right for an ordinary tab and wrong for a
  // pinned one: the strip holds every pinned tab left of every unpinned one, so
  // an appended pin draws at the far RIGHT — and then jumps to the left end on
  // the next launch, because sanitize() normalizes on write while the live
  // renderer state never is. Beta already holds seven unpinned tabs, so this
  // only passes if the insert is placed rather than appended.
  await addTab(win, 'P1');
  await tabMenu(win, 0, 'Pin tab');
  check('set-up: P1 is pinned in the source space',
    (await strip(win))[0]?.pinned === true, JSON.stringify(await strip(win)));

  await moveTabViaMenu(win, 0, 'Beta');
  check('moving a PINNED tab raises no dialog — a pin governs closing, not which space it lives in',
    (await modals(win)) === 0, `${await modals(win)} modal(s)`);
  check('the pinned tab left the source space',
    (await titles(win)).length === 0, (await titles(win)).join(' | '));

  await switchSpaceViaMenu(win, 'Beta');
  const withPin = await strip(win);
  check('it arrived still pinned, and LEFT of every unpinned tab there',
    pinnedFirst(withPin) && withPin[0]?.t === 'P1' && withPin[0]?.pinned === true,
    JSON.stringify(withPin));
  await switchSpaceViaMenu(win, 'Space');

  // --- §6 out of a SPLIT pane: the cell has to be vacated ------------------
  await addTab(win, 'S1');
  await addTab(win, 'S2');
  await addTab(win, 'S3');
  await tabMenu(win, 2, 'Split right');   // [S1,S2] | [S3]
  await win.waitForTimeout(600);
  await tabMenu(win, 1, 'Split right');   // [S1] | [S2] | [S3]
  await win.waitForTimeout(800);
  const split = await tiling(win);
  check('set-up: three panes, tiling the whole content area',
    split.panes === 3 && split.cover > 0.95, JSON.stringify(split));

  // S2 is the MIDDLE pane and the only tab in it — so the cell it leaves is a
  // hole with a neighbour on either side, which is precisely the shape the
  // render-time compact cannot be relied on to have written back.
  const s2 = await win.locator('.panestrip .tab:not(.add)').filter({ hasText: 'S2' }).first();
  await s2.click({ button: 'right' });
  await win.waitForTimeout(250);
  await pickSub(win, 'Move Tab to', 'Beta');
  check('moving the lone tab of a middle pane leaves two panes still tiling everything',
    (await tiling(win)).panes === 2 && (await tiling(win)).cover > 0.95,
    JSON.stringify(await tiling(win)));

  // The destination strip exactly as the user last saw it, to be compared with
  // what comes back off disk in Run 2.
  await switchSpaceViaMenu(win, 'Beta');
  betaAsLeft = await strip(win);
  await switchSpaceViaMenu(win, 'Space');

  await win.waitForTimeout(1600); // 400ms debounce + margin
  await close();
}

// ===========================================================================
// Run 2 — same profile, fresh process. The vacated cell is a WRITE-side defect:
// the memo compacts the rendered copy, so it only shows up here.
// ===========================================================================
{
  const { win, close } = await launchApp({ userDataDir: PROFILE });
  await win.waitForSelector('.tab:not(.add)');
  await win.waitForTimeout(1800);

  check('you land back in the space you were in', (await spaceName(win)) === 'Space',
    await spaceName(win));
  check('the moved tab is still gone from it',
    (await titles(win)).sort().join('|') === 'S1|S3', (await titles(win)).join(' | '));
  const t = await tiling(win);
  check('THE VACATED CELL WAS REALLY TAKEN OUT — the surviving panes still tile everything',
    t.panes === 2 && t.cover > 0.95, JSON.stringify(t));

  const ws = JSON.parse(fs.readFileSync(path.join(PROFILE, 'workspace.json'), 'utf8'));
  const src = ws.spaces.find((s) => s.name === 'Space');
  const dst = ws.spaces.find((s) => s.name === 'Beta');
  // Asserted on the GRID, not just on the ids: `sanitize()` runs on write as
  // well as on read, so it prunes a dangling id by itself and an id-level check
  // here can never fail — it would be measuring sanitize, not the move. What
  // sanitize does NOT do is compact, so the vacated rectangle is exactly what
  // survives to disk, and cell coverage is the thing that tells.
  const cells = src.layout?.cells ?? [];
  const covered = cells.reduce((n, c) => n + c.colSpan * c.rowSpan, 0);
  check('the persisted layout is already well-formed — its cells cover the grid, with no vacated hole',
    !!src.layout && covered === src.layout.cols * src.layout.rows
      && cells.flatMap((c) => c.tabIds).every((id) => src.tabIds.includes(id))
      && !src.tabIds.some((id) => dst.tabIds.includes(id)),
    `${covered} of ${src.layout?.cols}x${src.layout?.rows}, cells ${cells.length}`);

  await switchSpaceViaMenu(win, 'Beta');
  const back = await titles(win);
  check('and everything that was moved is in the destination after the restart',
    ['A2', 'Terminal', 'A3', 'A1', 'G2', 'G3', 'D1', 'S2'].every((n) => back.includes(n)),
    back.join(' | '));
  check('the group that moved whole is still one group there',
    JSON.stringify(await grouped(win)) === JSON.stringify([{ name: 'Group', tabs: ['A1', 'G2', 'G3'] }]),
    JSON.stringify(await grouped(win)));

  // The renderer wrote it CLEAN, not "sanitize cleaned it up on the way in":
  // if a move leaves the live order in a state normalize() has to repair, the
  // repair happens on write and the strip silently rearranges itself while the
  // user is away. So the order that comes back must be the order that was left.
  const backStrip = await strip(win);
  check('the destination strip comes back exactly as it was left — nothing was silently reordered',
    JSON.stringify(backStrip) === JSON.stringify(betaAsLeft),
    `left ${JSON.stringify(betaAsLeft)} / back ${JSON.stringify(backStrip)}`);
  check('and the pinned tab that moved here is still pinned, still left of every unpinned one',
    pinnedFirst(backStrip) && backStrip.some((t) => t.t === 'P1' && t.pinned),
    JSON.stringify(backStrip));

  await close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
