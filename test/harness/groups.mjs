// KAN-44: tab folder chrome in the strip (Chrome-style contiguous groups).
//   npm run build && node test/harness/groups.mjs
//
// Proves against the real running app that:
//   1. a group renders as ONE unbroken run — its members occupy consecutive
//      positions in the flat strip and all sit under a single wrapper whose
//      2px colour bar spans the whole run (not one bar per tab);
//   2. clicking the label collapses it: members disappear, the label shows
//      `name (n)`, and expanding restores the exact previous order;
//   3. dragging a loose tab into the group's span joins it, and dragging a
//      member out to open space leaves it ungrouped;
//   4. name, colour and collapsed state survive a restart;
//   5. Ungroup keeps every tab OPEN;
//   6. Close group's tabs never strands `active` on a closed tab, even when
//      the focused tab is a group member other than the last one in the loop
//      (KAN-44 review #1 — closeTab's re-pick reads `active` from its own
//      render closure, so only the first of several closeTab calls in a loop
//      can win that race).
//
// Drag is dispatched as real DragEvents rather than via Playwright's mouse:
// Chromium does not synthesise HTML5 drag-and-drop from raw mouse moves. The
// three phases are separate evaluate() calls on purpose — TabBar's onDrop reads
// `over`/`dragFrom` out of its render closure, so React has to commit the
// dragstart/dragover state before the drop is dispatched or the drop is a no-op
// (which is exactly what a single combined evaluate produces).
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

async function groupMenu(win, itemText) {
  await win.locator('.group-label').first().click({ button: 'right' });
  await win.waitForTimeout(250);
  await win.locator('.ctx-item', { hasText: itemText }).first().click();
  await win.waitForTimeout(400);
}

/** Drag the tab at flat index `from` onto `side` of the tab at flat index `to`. */
async function dragTab(win, from, to, side) {
  await win.evaluate((i) => {
    window.__dt = new DataTransfer();
    const src = document.querySelectorAll('.tab:not(.add)')[i];
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__dt }));
  }, from);
  await win.waitForTimeout(150);
  const point = await win.evaluate(([j, s]) => {
    const dst = document.querySelectorAll('.tab:not(.add)')[j];
    const r = dst.getBoundingClientRect();
    const x = s === 'right' ? r.right - 3 : r.left + 3;
    const y = r.top + r.height / 2;
    dst.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: x, clientY: y,
    }));
    return { x, y };
  }, [to, side]);
  await win.waitForTimeout(200);
  await win.evaluate(([j, i, p]) => {
    const dst = document.querySelectorAll('.tab:not(.add)')[j];
    dst.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: p.x, clientY: p.y,
    }));
    document.querySelectorAll('.tab:not(.add)')[i]
      ?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt }));
  }, [to, from, point]);
  await win.waitForTimeout(350);
}

/** Everything the assertions need about the group chrome, in one round trip. */
const probe = (win) => win.evaluate(() => {
  const all = [...document.querySelectorAll('.tab:not(.add)')];
  const wrappers = [...document.querySelectorAll('.tabgroup')];
  const w = wrappers[0];
  const cs = w ? getComputedStyle(w) : null;
  return {
    wrapperCount: wrappers.length,
    visibleTabs: all.length,
    memberIdx: all.map((t, i) => (t.closest('.tabgroup') ? i : -1)).filter((i) => i >= 0),
    label: w ? w.querySelector('.group-label').textContent.trim() : null,
    barWidth: cs ? parseFloat(cs.borderTopWidth) : 0,
    barColor: cs ? cs.borderTopColor : null,
    wrapperWidth: w ? w.getBoundingClientRect().width : 0,
    memberWidthSum: w
      ? [...w.querySelectorAll('.tab')].reduce((a, t) => a + t.getBoundingClientRect().width, 0)
      : 0,
    // Tab heights, to prove the group chrome did not reintroduce a per-type
    // height difference (the KAN-33 regression this must not cause).
    heights: all.map((t) => t.getBoundingClientRect().height),
  };
});

const consecutive = (xs) => xs.length > 0 && xs.every((v, i) => i === 0 || v === xs[i - 1] + 1);

let clayColor; let sageColor; let orderBeforeCollapse;

// ===========================================================================
// Run 0: closing a group's tabs must never strand `active` on a closed tab.
// Its own throwaway profile, NOT the module-shared TMP_PROFILE that Run 1/
// Run 2 deliberately reuse across their restart — sharing it here would leave
// Run 1 to inherit this run's leftover tabs instead of the fresh single
// home-folder tab it assumes it's starting from.
// ===========================================================================
{
  const run0Profile = path.join(os.tmpdir(), `claude-explorer-harness-groups-run0-${process.pid}`);
  fs.rmSync(run0Profile, { recursive: true, force: true });
  const { win, close } = await launchApp({ userDataDir: run0Profile });
  await win.waitForSelector('.entry');
  for (let i = 0; i < 3; i++) { await win.click('.tab.add'); await win.waitForTimeout(700); }
  for (const [i, n] of [[0, 'A'], [1, 'B'], [2, 'C'], [3, 'D']]) await renameTab(win, i, n);

  // Group A and B. Then: click B (bumps its lastActivated ahead of C/D, so
  // it's the "most recently activated remaining tab" once A closes), THEN
  // click A to actually focus it — A is FIRST in doomed-iteration order, so
  // closeTab(A) is the call that matches `id === active` and does the
  // re-pick, and B (still un-closed at that point) is what it wrongly picks:
  // exactly the failure mode of the loop calling closeTab against a shared
  // render closure instead of the post-A-removal tab list.
  await tabMenu(win, 0, 'New group from this tab');
  await tabMenu(win, 1, /^Add to /);
  await win.locator('.tab:not(.add)').nth(1).click();
  await win.waitForTimeout(200);
  await win.locator('.tab:not(.add)').nth(0).click();
  await win.waitForTimeout(200);

  await groupMenu(win, "Close group's tabs");
  await win.waitForTimeout(400);

  const p = await win.evaluate(() => ({
    activeCount: document.querySelectorAll('.tab.active').length,
    contentChildren: document.querySelector('.content').children.length,
  }));
  const survivors = await titles(win);
  check('closing a group never strands `active` on a closed tab',
    p.activeCount === 1, JSON.stringify(p));
  check('the content pane still renders something, not blank',
    p.contentChildren > 0, JSON.stringify(p));
  check('the two surviving tabs are C and D', survivors.join('') === 'CD', survivors.join(' '));

  await close();
}

// ===========================================================================
// Run 1: build a group, exercise collapse and drag, then set up the restart.
// ===========================================================================
{
  const { win, close } = await launchApp();
  await win.waitForSelector('.entry');
  for (let i = 0; i < 3; i++) { await win.click('.tab.add'); await win.waitForTimeout(700); }
  for (const [i, n] of [[0, 'A'], [1, 'B'], [2, 'C'], [3, 'D']]) await renameTab(win, i, n);
  check('four named tabs to work with', (await titles(win)).join('') === 'ABCD', (await titles(win)).join(' '));

  // --- group B, then add C -------------------------------------------------
  await tabMenu(win, 1, 'New group from this tab');
  await tabMenu(win, 2, /^Add to /);

  {
    const p = await probe(win);
    const t = await titles(win);
    check('exactly one group wrapper is drawn', p.wrapperCount === 1, `${p.wrapperCount}`);
    check('the group renders as ONE unbroken run (consecutive positions in the strip)',
      consecutive(p.memberIdx) && p.memberIdx.length === 2, JSON.stringify(p.memberIdx));
    check('the run is B,C and the flat order is untouched', t.join('') === 'ABCD', t.join(' '));
    check('the colour bar is 2px and spans the whole run, not one tab',
      p.barWidth === 2 && p.wrapperWidth > p.memberWidthSum,
      `bar=${p.barWidth}px wrapper=${p.wrapperWidth} members=${p.memberWidthSum}`);
    check('the label chip renders the group name', p.label === 'Group', `"${p.label}"`);
    const hs = p.heights;
    check('KAN-33 held: every tab in the strip is still the same height',
      Math.max(...hs) - Math.min(...hs) < 0.5, JSON.stringify(hs));
    clayColor = p.barColor;
    orderBeforeCollapse = t.join('');
  }

  // --- collapse / expand ---------------------------------------------------
  await win.locator('.group-label').first().click();
  await win.waitForTimeout(400);
  {
    const p = await probe(win);
    check('collapsing hides the members', p.visibleTabs === 2, `${p.visibleTabs} tabs visible`);
    check('the collapsed label shows the count', p.label === 'Group (2)', `"${p.label}"`);
  }
  await win.locator('.group-label').first().click();
  await win.waitForTimeout(400);
  check('expanding restores the members in their original order',
    (await titles(win)).join('') === orderBeforeCollapse, (await titles(win)).join(' '));

  // --- drag D into the group's span → joins --------------------------------
  await dragTab(win, 3, 1, 'left');
  {
    const p = await probe(win);
    const t = await titles(win);
    check('dragging a loose tab into the group\'s span joins it',
      p.memberIdx.length === 3 && consecutive(p.memberIdx),
      `members=${JSON.stringify(p.memberIdx)} order=${t.join(' ')}`);
    check('and it landed where it was dropped', t.join('') === 'ADBC', t.join(' '));
  }

  // --- drag C (a FOUNDING member, not the one that just joined) out to open
  // space → ungrouped. Deliberately not the tab from the previous case: that
  // one only leaves a group it had to have joined first, so the assertion
  // would pass for free whenever the join silently didn't happen.
  await dragTab(win, 3, 0, 'left');
  {
    const p = await probe(win);
    const t = await titles(win);
    check('dragging a member out to open space leaves it ungrouped',
      p.wrapperCount === 1 && p.memberIdx.length === 2 && consecutive(p.memberIdx),
      `wrappers=${p.wrapperCount} members=${JSON.stringify(p.memberIdx)} order=${t.join(' ')}`);
    check('the moved tab is C, now first and outside the group', t.join('') === 'CADB', t.join(' '));
  }

  // --- rename, recolor, collapse, then let the debounced save land ---------
  await groupMenu(win, 'Rename group');
  await win.locator('.tab-rename').fill('Repo');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(300);
  await groupMenu(win, 'Sage');
  {
    const p = await probe(win);
    sageColor = p.barColor;
    check('recolour actually changed the bar colour', sageColor !== clayColor,
      `clay=${clayColor} sage=${sageColor}`);
    check('rename landed on the chip', p.label === 'Repo', `"${p.label}"`);
  }
  await win.locator('.group-label').first().click();
  await win.waitForTimeout(1600); // 400ms debounce + margin
  await close();
}

// ===========================================================================
// Run 2: same profile, fresh process — does the group survive?
// ===========================================================================
{
  const { win, close } = await launchApp();
  await win.waitForSelector('.tab:not(.add)');
  await win.waitForTimeout(1500);

  const p = await probe(win);
  check('the group itself survived the restart', p.wrapperCount === 1, `${p.wrapperCount} wrappers`);
  check('its NAME and COLLAPSED state survived', p.label === 'Repo (2)', `"${p.label}"`);
  check('its COLOUR survived', p.barColor === sageColor, `${p.barColor} vs ${sageColor}`);
  check('collapsed members are still hidden after restore', p.visibleTabs === 2, `${p.visibleTabs}`);

  // Expand, then Ungroup — the container goes, the contents stay.
  await win.locator('.group-label').first().click();
  await win.waitForTimeout(400);
  const before = await titles(win);
  check('expanding after the restart brings the run back in order',
    before.join('') === 'CADB', before.join(' '));

  await groupMenu(win, 'Ungroup');
  const after = await titles(win);
  const q = await probe(win);
  check('Ungroup removed the group chrome', q.wrapperCount === 0, `${q.wrapperCount} wrappers`);
  check('Ungroup kept every tab OPEN', after.length === before.length && after.join('') === before.join(''),
    `${before.join(' ')} -> ${after.join(' ')}`);

  await close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
