// KAN-52: sliding tab drag — the strip reflows LIVE, before you let go.
//   npm run build && node test/harness/slidingdrag.mjs
//
// Every assertion here is on real geometry read off the running app, and the
// load-bearing ones are read MID-DRAG: after dragover, before drop. That is the
// whole ticket. A test that only checked the order after the drop would pass
// against the old snapping behaviour and prove nothing — so each MID-DRAG probe
// below is one that goes red on the pre-KAN-52 build, where the other tabs do
// not move at all until release.
//
// Proves:
//   1. mid-drag the displaced tabs have physically moved, the dragged tab is
//      under the pointer, a transform transition is in flight — and the drop
//      commits exactly the order already on screen;
//   2. dragging into a group's span visibly opens a slot INSIDE the run (the
//      tab is inside the .tabgroup wrapper before release);
//   3. dragging past the run's edge into open space visibly leaves it, run
//      still contiguous;
//   4. reordering within a run keeps every member in it;
//   5. dragging a group by its label chip moves every member live, preserves
//      their internal order and lands them contiguous;
//   6. the KAN-53 pinned boundary is not crossable — mid-drag OR after;
//   7. under `prefers-reduced-motion: reduce` nothing animates, the strip is
//      already at the final position, and the outcome is identical.
//
// Drag is dispatched as real DragEvents rather than via Playwright's mouse, and
// in separate evaluate() calls — see the note at the top of groups.mjs. Unlike
// the older harnesses, dragover/drop go to the STRIP: KAN-52 steers from
// `.tabbar` because the element under the pointer keeps changing as tabs slide.
// Each move dispatches dragover TWICE, which is what a real pointer does: the
// first event establishes the preview, the second re-anchors the held tab to
// the pointer against the layout that preview produced.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** The strip as geometry: order, left edges, widths, grouping, pinning. */
const strip = (win) => win.evaluate(() => {
  const tabs = [...document.querySelectorAll('.tab:not(.add)')].map((t) => {
    const r = t.getBoundingClientRect();
    return {
      name: (t.querySelector('.tab-title')?.textContent ?? t.getAttribute('title') ?? '').trim(),
      left: Math.round(r.left), w: Math.round(r.width), h: r.height,
      pinned: t.classList.contains('pinned'),
      grouped: !!t.closest('.tabgroup'),
    };
  });
  return {
    tabs,
    order: tabs.map((t) => t.name).join(' '),
    left: Object.fromEntries(tabs.map((t) => [t.name, t.left])),
    width: Object.fromEntries(tabs.map((t) => [t.name, t.w])),
    memberIdx: tabs.map((t, i) => (t.grouped ? i : -1)).filter((i) => i >= 0),
    wrappers: document.querySelectorAll('.tabgroup').length,
    groupLeft: Math.round(document.querySelector('.tabgroup')?.getBoundingClientRect().left ?? -1),
  };
});

/** Leftover drag state that a cancelled drag must NOT leave behind: a
 *  `.dragging` element (intercepts pointer events — review #1 measured a
 *  30s-timeout stuck tab from exactly this) or a live inline transform. */
const dragArtifacts = (win) => win.evaluate(() => ({
  dragging: document.querySelectorAll('.tab.dragging, .tabgroup.dragging').length,
  transformed: [...document.querySelectorAll('.tabbar [data-slide]')]
    .filter((n) => n.style.transform).length,
}));

/** Is a transform TRANSITION actually in flight in the strip right now?
 *  Filtered to transitions on purpose — a Claude tab's status dot runs a
 *  keyframe animation forever and would make this true for free. */
const animating = (win) => win.evaluate(() =>
  [...document.querySelectorAll('.tabbar *')]
    .some((n) => n.getAnimations().some((a) => a.playState === 'running' && a.transitionProperty === 'transform')));

const consecutive = (xs) => xs.length > 0 && xs.every((v, i) => i === 0 || v === xs[i - 1] + 1);
const pinnedFirst = (s) => {
  const flags = s.tabs.map((t) => t.pinned);
  const last = flags.lastIndexOf(true);
  const first = flags.indexOf(false);
  return last === -1 || first === -1 || last < first;
};

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
  await win.waitForTimeout(450);
}

/** Viewport x at a fraction across the tab currently at flat index `i`. */
const xOfTab = (win, i, frac = 0.5) => win.evaluate(([j, f]) => {
  const r = document.querySelectorAll('.tab:not(.add)')[j].getBoundingClientRect();
  return r.left + r.width * f;
}, [i, frac]);

/** dragstart, grabbed at the element's centre — a real drag has a grab point,
 *  and TabBar anchors the held element to it. The source element is stashed
 *  on `window.__src` (review #2): a preview that reparents it across a group
 *  boundary detaches it from the tree, and a real browser always fires
 *  `dragend` on the node that started the drag, not on whatever the pointer
 *  happens to be over — dispatching on `.tabbar` instead is the one thing a
 *  real browser never does, and would not have caught review #1. */
const dragStart = (win, sel, nth = 0) => win.evaluate(([s, n]) => {
  window.__dt = new DataTransfer();
  const el = document.querySelectorAll(s)[n];
  window.__src = el;
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new DragEvent('dragstart', {
    bubbles: true, dataTransfer: window.__dt,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  }));
}, [sel, nth]).then(() => win.waitForTimeout(150));

const startTabDrag = (win, i) => dragStart(win, '.tab:not(.add)', i);
const startGroupDrag = (win) => dragStart(win, '.group-label', 0);

/** One dragover on the strip at viewport x. */
const move = (win, x) => win.evaluate((cx) => {
  const bar = document.querySelector('.tabbar');
  const r = bar.getBoundingClientRect();
  bar.dispatchEvent(new DragEvent('dragover', {
    bubbles: true, cancelable: true, dataTransfer: window.__dt,
    clientX: cx, clientY: r.top + r.height / 2,
  }));
}, x);

/** Move and let the 160ms slide finish. */
async function moveTo(win, x) {
  await move(win, x);
  await win.waitForTimeout(60);
  await move(win, x);
  await win.waitForTimeout(320);
}

async function release(win) {
  await win.evaluate(() => {
    const bar = document.querySelector('.tabbar');
    bar.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
    // dragend goes to the SOURCE node (review #2), not `.tabbar` — a preview
    // that reparented it across a group boundary means `.tabbar` may not
    // even be an ancestor of it any more by drop time.
    (window.__src ?? bar).dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt }));
  });
  await win.waitForTimeout(400);
}

/** Cancel a drag mid-flight: dragend with no drop. A real browser fires this
 *  on Escape, a drop outside the window, or a drop anywhere outside
 *  `.tabbar` — dispatched on the SOURCE node for the same reason as
 *  `release()`. */
async function cancel(win) {
  await win.evaluate(() => {
    (window.__src ?? document.querySelector('.tabbar'))
      .dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt }));
  });
  await win.waitForTimeout(400);
}

async function namedTabs(win, names) {
  for (let i = 1; i < names.length; i++) { await win.click('.tab.add'); await win.waitForTimeout(700); }
  for (let i = 0; i < names.length; i++) await renameTab(win, i, names[i]);
}

const profile = (tag) => {
  const p = path.join(os.tmpdir(), `ce-slidingdrag-${tag}-${process.pid}`);
  fs.rmSync(p, { recursive: true, force: true });
  return p;
};

// ===========================================================================
// Run 1: THE ticket. Do the other tabs move BEFORE release?
// ===========================================================================
{
  const { win, close } = await launchApp({ userDataDir: profile('reorder') });
  await win.waitForSelector('.entry');
  await namedTabs(win, ['A', 'B', 'C', 'D']);

  const before = await strip(win);
  check('four named tabs to work with', before.order === 'A B C D', before.order);

  // Grab A, hold the pointer over C. Nothing is dropped yet.
  await startTabDrag(win, 0);
  const x = await xOfTab(win, 2, 0.6);
  await move(win, x);
  const flying = await animating(win);
  await win.waitForTimeout(60);
  await move(win, x);
  await win.waitForTimeout(320);
  const mid = await strip(win);

  check('MID-DRAG: B and C have physically moved left to open A’s slot — before any drop',
    mid.left.B < before.left.B - 20 && mid.left.C < before.left.C - 20,
    `B ${before.left.B}->${mid.left.B}  C ${before.left.C}->${mid.left.C}`);
  check('MID-DRAG: the strip already reads B C A D — the order the drop will commit',
    mid.order === 'B C A D', mid.order);
  check('MID-DRAG: D, which this move does not displace, has NOT moved',
    Math.abs(mid.left.D - before.left.D) <= 1, `${before.left.D} -> ${mid.left.D}`);
  check('MID-DRAG: the held tab is under the pointer, not in its old slot',
    Math.abs(mid.left.A - (x - mid.width.A / 2)) <= 3 && Math.abs(mid.left.A - before.left.A) > 20,
    `A ${before.left.A} -> ${mid.left.A}, pointer ${Math.round(x)} w ${mid.width.A}`);
  check('the displaced tabs SLID there — a transform transition was in flight', flying, `${flying}`);

  await release(win);
  const after = await strip(win);
  // Both of these name the expected order as well as comparing before/after: a
  // build where the drag does nothing at all would otherwise satisfy
  // `after === mid` for free and these would prove nothing.
  check('dropping commits exactly what was already on screen',
    after.order === mid.order && after.order === 'B C A D', `${mid.order} -> ${after.order}`);
  check('and the displaced tabs stay exactly where the preview had put them',
    after.order === 'B C A D'
      && Math.abs(after.left.B - mid.left.B) <= 2 && Math.abs(after.left.C - mid.left.C) <= 2,
    JSON.stringify({ mid: mid.left, after: after.left }));
  check('KAN-33 held: every tab is still the same height after a drag',
    Math.max(...after.tabs.map((t) => t.h)) - Math.min(...after.tabs.map((t) => t.h)) < 0.5,
    JSON.stringify(after.tabs.map((t) => t.h)));

  // --- reduced motion: same outcome, no animation, no slide ----------------
  await win.emulateMedia({ reducedMotion: 'reduce' });
  const rBefore = await strip(win); // B C A D
  await startTabDrag(win, 0);       // B
  const rx = await xOfTab(win, 2, 0.6); // over A
  await move(win, rx);
  await win.waitForTimeout(40);
  const rFlying = await animating(win);
  const rMid = await strip(win);
  check('REDUCED MOTION: nothing animates', !rFlying, `${rFlying}`);
  check('REDUCED MOTION: the strip is ALREADY at the final position — no slide needed',
    rMid.order === 'C A B D' && rMid.left.C < rBefore.left.C - 20,
    `${rMid.order}  C ${rBefore.left.C}->${rMid.left.C}`);
  await release(win);
  check('REDUCED MOTION: identical outcome to the animated drag',
    (await strip(win)).order === 'C A B D', (await strip(win)).order);
  await win.emulateMedia({ reducedMotion: 'no-preference' });

  await close();
}

// ===========================================================================
// Run 2: groups — join, reorder within, leave, and drag the whole run by head.
// ===========================================================================
{
  const { win, close } = await launchApp({ userDataDir: profile('groups') });
  await win.waitForSelector('.entry');
  await namedTabs(win, ['A', 'B', 'C', 'D']);
  await tabMenu(win, 1, 'New group from this tab'); // B
  await tabMenu(win, 2, /^Add to /);                // C
  {
    const s = await strip(win);
    check('a two-member group B,C to drag into and out of',
      s.order === 'A B C D' && JSON.stringify(s.memberIdx) === '[1,2]',
      `${s.order} members=${JSON.stringify(s.memberIdx)}`);
  }

  // --- drag D INTO the run -------------------------------------------------
  {
    const before = await strip(win);
    await startTabDrag(win, 3);
    await moveTo(win, await xOfTab(win, 1, 0.6)); // over B, inside the run
    const mid = await strip(win);
    check('MID-DRAG: the run visibly opened a slot — D is INSIDE the group wrapper before release',
      mid.tabs.find((t) => t.name === 'D')?.grouped === true && mid.wrappers === 1,
      `${mid.order} members=${JSON.stringify(mid.memberIdx)}`);
    check('MID-DRAG: C slid right to make room and the run is still one block',
      mid.left.C > before.left.C + 10 && consecutive(mid.memberIdx) && mid.memberIdx.length === 3,
      `C ${before.left.C}->${mid.left.C} members=${JSON.stringify(mid.memberIdx)}`);
    await release(win);
    const after = await strip(win);
    check('dropping into a group joins it, and the tab landed where it was shown landing',
      after.order === mid.order && after.order === 'A B D C'
        && after.tabs.find((t) => t.name === 'D').grouped,
      `${mid.order} -> ${after.order}`);
    check('the run is still contiguous after the join',
      consecutive(after.memberIdx) && after.memberIdx.length === 3, JSON.stringify(after.memberIdx));
  }

  // --- reorder WITHIN the run ---------------------------------------------
  {
    const before = await strip(win); // A [B D C]
    await startTabDrag(win, 1);      // B
    await moveTo(win, await xOfTab(win, 2, 0.6)); // over D
    const mid = await strip(win);
    check('MID-DRAG: reordering inside a run shows the swap and nobody leaves the group',
      mid.order === 'A D B C' && mid.memberIdx.length === 3 && consecutive(mid.memberIdx)
        && mid.left.D < before.left.D - 10,
      `${mid.order} members=${JSON.stringify(mid.memberIdx)} D ${before.left.D}->${mid.left.D}`);
    await release(win);
    const after = await strip(win);
    check('reordering within a group keeps every member in it',
      after.order === 'A D B C' && after.memberIdx.length === 3 && consecutive(after.memberIdx)
        && after.wrappers === 1,
      `${after.order} members=${JSON.stringify(after.memberIdx)}`);
  }

  // --- drag an interior member OUT, past the run's left edge ---------------
  {
    const before = await strip(win); // A [D B C]
    await startTabDrag(win, 2);      // B
    await moveTo(win, await xOfTab(win, 0, 0.2)); // left of A, open space
    const mid = await strip(win);
    check('MID-DRAG: dragging past the run’s edge visibly LEAVES the group',
      mid.tabs.find((t) => t.name === 'B')?.grouped === false && mid.order === 'B A D C',
      `${mid.order} members=${JSON.stringify(mid.memberIdx)}`);
    check('MID-DRAG: A slid right and the remaining run is still contiguous',
      mid.left.A > before.left.A + 10 && consecutive(mid.memberIdx) && mid.memberIdx.length === 2,
      `A ${before.left.A}->${mid.left.A} members=${JSON.stringify(mid.memberIdx)}`);
    await release(win);
    const after = await strip(win);
    check('dropping in open space commits the leave, run still contiguous',
      after.order === 'B A D C' && !after.tabs.find((t) => t.name === 'B').grouped
        && consecutive(after.memberIdx) && after.memberIdx.length === 2,
      `${after.order} members=${JSON.stringify(after.memberIdx)}`);
  }

  // --- drag the whole group by its head ------------------------------------
  {
    const before = await strip(win); // B A [D C]
    await startGroupDrag(win);
    await moveTo(win, await xOfTab(win, 0, 0.2)); // to the far left
    const mid = await strip(win);
    check('MID-DRAG: grabbing the label chip moves the WHOLE run, live',
      mid.order === 'D C B A' && mid.groupLeft < before.groupLeft - 20,
      `${mid.order}  groupLeft ${before.groupLeft}->${mid.groupLeft}`);
    check('MID-DRAG: the members kept their internal order and stayed together',
      mid.memberIdx.join() === '0,1' && mid.tabs[0].name === 'D' && mid.tabs[1].name === 'C',
      `${mid.order} members=${JSON.stringify(mid.memberIdx)}`);
    await release(win);
    const after = await strip(win);
    check('dropping a group by its head lands every member contiguous, order preserved',
      after.order === 'D C B A' && after.wrappers === 1
        && consecutive(after.memberIdx) && after.memberIdx.join() === '0,1',
      `${after.order} members=${JSON.stringify(after.memberIdx)}`);
    check('and both members are still in the group, the loose tabs still loose',
      after.tabs[0].grouped && after.tabs[1].grouped && !after.tabs[2].grouped && !after.tabs[3].grouped,
      JSON.stringify(after.tabs.map((t) => t.grouped)));
  }

  await close();
}

// ===========================================================================
// Run 3: the KAN-53 pinned boundary is not crossable by a sliding drag — the
// preview must never promise a drop the model then refuses.
// ===========================================================================
{
  const { win, close } = await launchApp({ userDataDir: profile('pinned') });
  await win.waitForSelector('.entry');
  await namedTabs(win, ['A', 'B', 'C', 'D']);
  await tabMenu(win, 0, 'Pin tab'); // A -> pinned, holds index 0
  const base = await strip(win);
  check('one pinned tab holding the left zone',
    base.tabs[0].pinned && base.order === 'A B C D' && pinnedFirst(base), base.order);

  // Unpinned D dragged as far left as the strip goes: stops at the seam.
  await startTabDrag(win, 3);
  await moveTo(win, await xOfTab(win, 0, 0.1)); // over the pinned tab's left edge
  const mid = await strip(win);
  check('MID-DRAG: an unpinned tab dragged into the pinned zone stops at the seam',
    mid.order === 'A D B C' && mid.tabs[0].pinned && pinnedFirst(mid), mid.order);
  check('MID-DRAG: the pinned tab itself did not budge, but B did',
    Math.abs(mid.left.A - base.left.A) <= 1 && mid.left.B > base.left.B + 10,
    `A ${base.left.A}->${mid.left.A}  B ${base.left.B}->${mid.left.B}`);
  await release(win);
  const after = await strip(win);
  check('the drop honours the seam the preview showed',
    after.order === mid.order && after.order === 'A D B C' && pinnedFirst(after),
    `${mid.order} -> ${after.order}`);

  // The pinned tab cannot be dragged out of its zone either.
  await startTabDrag(win, 0);
  await moveTo(win, await xOfTab(win, 3, 0.9)); // as far right as it goes
  const pmid = await strip(win);
  check('MID-DRAG: a pinned tab dragged right never previews past the seam',
    pmid.order === 'A D B C' && pmid.tabs[0].pinned && pinnedFirst(pmid), pmid.order);
  await release(win);
  const pafter = await strip(win);
  check('pinned-before-unpinned survives the drop', pinnedFirst(pafter) && pafter.order === 'A D B C',
    pafter.order);

  await close();
}

// ===========================================================================
// Run 4: cancelling a drag that crossed a group boundary (review #1). The
// preview reparents the dragged tab into the `.tabgroup` wrapper, which
// remounts it — a `dragend` listener that only lives on `.tabbar` never sees
// that detached node's event, so a cancel here used to leave the strip
// permanently stuck: one `.dragging` element with a live transform,
// intercepting pointer events forever.
// ===========================================================================
{
  const { win, close } = await launchApp({ userDataDir: profile('cancel') });
  await win.waitForSelector('.entry');
  await namedTabs(win, ['A', 'B', 'C', 'D']);
  await tabMenu(win, 1, 'New group from this tab'); // B
  await tabMenu(win, 2, /^Add to /);                // C
  const before = await strip(win);
  check('a two-member group B,C to drag into and cancel out of',
    before.order === 'A B C D' && JSON.stringify(before.memberIdx) === '[1,2]', before.order);

  // Drag D into the run — same move as Run 2's join case — then cancel
  // instead of dropping: Escape, a drop outside the window, and a drop
  // anywhere outside `.tabbar` all surface to the page as exactly this,
  // `dragend` with no preceding `drop`.
  await startTabDrag(win, 3);
  await moveTo(win, await xOfTab(win, 1, 0.6)); // over B, inside the run
  const mid = await strip(win);
  check('MID-DRAG: the preview joined the run, same as a real drop would',
    mid.tabs.find((t) => t.name === 'D')?.grouped === true, mid.order);
  await cancel(win);

  const after = await strip(win);
  const artifacts = await dragArtifacts(win);
  check('CANCEL: the strip reverted to its pre-drag order, not the previewed one',
    after.order === 'A B C D' && JSON.stringify(after.memberIdx) === '[1,2]',
    `${before.order} -> (previewed ${mid.order}) -> ${after.order}`);
  check('CANCEL: no .dragging element and no leftover inline transform survive',
    artifacts.dragging === 0 && artifacts.transformed === 0, JSON.stringify(artifacts));

  await close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
