// KAN-53: Chrome-style pinned tabs.
//   npm run build && node test/harness/pinned.mjs
//
// Proves against the real running app that:
//   1. Pin from the tab menu shrinks the tab to icon-only — no title, no close
//      button, icon kept, same height as every other tab — and moves it to the
//      LEFT END of the strip;
//   2. pinning a GROUP member removes it from the group, and the group's
//      remaining members are still one contiguous run;
//   3. "Add to …" / "New group from this tab" / "Remove from group" are NOT
//      offered for a pinned tab, and "Unpin tab" is;
//   4. a pinned tab dragged into the unpinned region stops at the seam, and an
//      unpinned tab dragged into the pinned region does too — in both cases the
//      tab visibly MOVES (so the assertion cannot pass just because the drag
//      failed to fire) but never crosses;
//   5. unpinning restores the title and the close button and lands the tab at
//      the head of the unpinned region;
//   6. pinned state AND pinned order survive a restart;
//   7. KAN-57: a RESTORED pinned tab refuses to close — the context menu's Close
//      is greyed and clicking it is a no-op, and File ▸ Close Tab (Ctrl+W) takes
//      nothing either — with unpin-then-close as the positive control. This
//      block used to assert the opposite, and passed; that was the defect.
//
// Drag is dispatched as real DragEvents in three separate evaluate() calls, for
// the reason spelled out at the top of groups.mjs: Chromium will not synthesise
// HTML5 DnD from mouse moves, and TabBar's onDrop reads `over`/`dragFrom` out of
// its render closure, so React has to commit between the phases.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/**
 * One round trip for everything the assertions need per tab. `name` reads the
 * .tab-title for an unpinned tab and falls back to the `title` ATTRIBUTE for a
 * pinned one — which is the only place its identity is left, and is exactly what
 * makes the order assertions possible at all.
 */
const strip = (win) => win.evaluate(() => ({
  tabs: [...document.querySelectorAll('.tab:not(.add)')].map((t) => ({
    name: (t.querySelector('.tab-title')?.textContent ?? t.getAttribute('title') ?? '').trim(),
    pinned: t.classList.contains('pinned'),
    hasTitle: !!t.querySelector('.tab-title'),
    hasClose: !!t.querySelector('.close'),
    hasIcon: !!t.querySelector('.tab-icon'),
    grouped: !!t.closest('.tabgroup'),
    w: t.getBoundingClientRect().width,
    h: t.getBoundingClientRect().height,
  })),
  wrappers: document.querySelectorAll('.tabgroup').length,
}));

const names = (s) => s.tabs.map((t) => t.name).join(' ');
/** Indices of the tabs inside a group wrapper — the contiguity probe. */
const memberIdx = (s) => s.tabs.map((t, i) => (t.grouped ? i : -1)).filter((i) => i >= 0);
const consecutive = (xs) => xs.length > 0 && xs.every((v, i) => i === 0 || v === xs[i - 1] + 1);
/** The strip-ordering invariant, read off the DOM rather than off the model. */
const pinnedFirst = (s) => {
  const flags = s.tabs.map((t) => t.pinned);
  const lastPinned = flags.lastIndexOf(true);
  const firstLoose = flags.indexOf(false);
  return lastPinned === -1 || firstLoose === -1 || lastPinned < firstLoose;
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

/** Every context-menu row with its ENABLED state, leaving the menu OPEN — the
 *  disabled flag is the whole point of the KAN-57 block below, so text alone is
 *  not enough. (`tabMenuItems` reads labels only and dismisses.) */
const tabMenuEntries = async (win, i) => {
  await win.locator('.tab:not(.add)').nth(i).click({ button: 'right' });
  await win.waitForTimeout(250);
  return win.evaluate(() => [...document.querySelectorAll('.ctx-item')].map((el) => ({
    label: el.textContent.trim(), disabled: el.classList.contains('disabled'),
  })));
};

/** Every enabled item on a tab's context menu, then dismiss it via the backdrop. */
async function tabMenuItems(win, i) {
  await win.locator('.tab:not(.add)').nth(i).click({ button: 'right' });
  await win.waitForTimeout(250);
  const items = (await win.locator('.ctx-item').allTextContents()).map((s) => s.trim());
  await win.mouse.click(4, 4); // backdrop, well clear of the menu box
  await win.waitForTimeout(200);
  return items;
}

/** Drag the tab at flat index `from` onto `side` of the tab at flat index `to`. */
async function dragTab(win, from, to, side) {
  await win.evaluate((i) => {
    window.__dt = new DataTransfer();
    document.querySelectorAll('.tab:not(.add)')[i]
      .dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__dt }));
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
  await win.waitForTimeout(400);
}

let looseWidth;

// ===========================================================================
// Run 1: pin, unpin, the group interaction and the two drag boundaries.
// ===========================================================================
{
  const { win, close } = await launchApp();
  await win.waitForSelector('.entry');
  for (let i = 0; i < 5; i++) { await win.click('.tab.add'); await win.waitForTimeout(700); }
  for (const [i, n] of [[0, 'A'], [1, 'B'], [2, 'C'], [3, 'D'], [4, 'E'], [5, 'F']]) {
    await renameTab(win, i, n);
  }
  check('six named tabs to work with', names(await strip(win)) === 'A B C D E F', names(await strip(win)));

  // A three-member group, so pinning its MIDDLE member leaves two behind —
  // enough for "the rest are still one contiguous run" to mean something.
  await tabMenu(win, 1, 'New group from this tab'); // B
  await tabMenu(win, 2, /^Add to /);                // C
  await tabMenu(win, 3, /^Add to /);                // D
  {
    const s = await strip(win);
    looseWidth = s.tabs[0].w;
    check('the group starts as one run of three: B,C,D',
      names(s) === 'A B C D E F' && JSON.stringify(memberIdx(s)) === '[1,2,3]',
      `${names(s)} members=${JSON.stringify(memberIdx(s))}`);
  }

  // --- pin C, the group's middle member ------------------------------------
  await tabMenu(win, 2, 'Pin tab');
  {
    const s = await strip(win);
    const c = s.tabs[0];
    check('pinning moves the tab to the LEFT END of the strip',
      names(s) === 'C A B D E F', names(s));
    check('a pinned tab loses its title and its close button, keeps its icon',
      c.pinned && !c.hasTitle && !c.hasClose && c.hasIcon, JSON.stringify(c));
    check('a pinned tab is narrower than a titled one', c.w < looseWidth, `${c.w} vs ${looseWidth}`);
    // This six-tab strip is all file tabs, so every icon is the 📁 glyph and
    // this spread is structurally ~0 regardless of whether pinning preserves
    // height — it cannot fail against the KAN-33 regression (a Claude tab's
    // icon is a sized `.tab-status` dot, not a glyph). Run 3 below opens a
    // pinned Claude tab specifically to give this comparison a tab that can
    // actually discriminate.
    check('KAN-33 held: a pinned tab is still exactly as tall as the rest',
      Math.max(...s.tabs.map((t) => t.h)) - Math.min(...s.tabs.map((t) => t.h)) < 0.5,
      JSON.stringify(s.tabs.map((t) => t.h)));
    check('pinning a grouped tab REMOVES it from the group', !c.grouped && s.wrappers === 1,
      `grouped=${c.grouped} wrappers=${s.wrappers}`);
    check("the group's remaining members are still one contiguous run",
      JSON.stringify(memberIdx(s)) === '[2,3]' && consecutive(memberIdx(s)),
      `members=${JSON.stringify(memberIdx(s))} order=${names(s)}`);
    check('pinned-before-unpinned holds', pinnedFirst(s), names(s));
  }

  // --- the menu must not offer grouping to a pinned tab --------------------
  {
    const items = await tabMenuItems(win, 0); // the pinned C
    check('"Add to …" is NOT offered for a pinned tab', !items.some((x) => /^Add to /.test(x)),
      items.join(' | '));
    check('"New group from this tab" is NOT offered for a pinned tab',
      !items.includes('New group from this tab'), items.join(' | '));
    check('"Remove from group" is NOT offered for a pinned tab',
      !items.includes('Remove from group'), items.join(' | '));
    check('"Unpin tab" IS offered, and "Close" still is',
      items.includes('Unpin tab') && items.includes('Close'), items.join(' | '));
    const loose = await tabMenuItems(win, 1); // A, unpinned
    check('an unpinned tab is still offered grouping and "Pin tab"',
      loose.includes('Pin tab') && loose.some((x) => /^Add to /.test(x)), loose.join(' | '));
  }

  // --- a second pinned tab, so the pinned block has an interior ------------
  await tabMenu(win, 5, 'Pin tab'); // F, the last tab
  {
    const s = await strip(win);
    check('a second pin lands at the END of the pinned block, not at index 0',
      names(s) === 'C F A B D E', names(s));
    check('both pinned tabs are icon-only and still pinned-first',
      s.tabs[0].pinned && s.tabs[1].pinned && pinnedFirst(s), names(s));
  }

  // --- drag a PINNED tab as far right as the strip allows ------------------
  await dragTab(win, 0, 5, 'right'); // C, onto the right half of E (the last tab)
  {
    const s = await strip(win);
    check('a pinned tab dragged into the unpinned region stops at the seam — it moved, but stayed pinned',
      names(s) === 'F C A B D E' && s.tabs[1].name === 'C' && s.tabs[1].pinned,
      names(s));
    check('and the drag did not pull it into a group',
      !s.tabs[1].grouped && consecutive(memberIdx(s)),
      `grouped=${s.tabs[1].grouped} members=${JSON.stringify(memberIdx(s))}`);
    check('pinned-before-unpinned still holds after the drag', pinnedFirst(s), names(s));
  }

  // --- drag an UNPINNED tab as far left as the strip allows ----------------
  await dragTab(win, 5, 0, 'left'); // E, onto the left half of F (index 0)
  {
    const s = await strip(win);
    check('an unpinned tab dragged into the pinned region stops at the seam — it moved to index 2, not 0',
      names(s) === 'F C E A B D' && !s.tabs[2].pinned, names(s));
    check('the group survived both drags as one run', consecutive(memberIdx(s)) && s.wrappers === 1,
      `members=${JSON.stringify(memberIdx(s))} wrappers=${s.wrappers}`);
    check('pinned-before-unpinned still holds', pinnedFirst(s), names(s));
  }

  // --- unpin ---------------------------------------------------------------
  await tabMenu(win, 0, 'Unpin tab'); // F
  {
    const s = await strip(win);
    const f = s.tabs[1];
    check('unpinning lands the tab at the head of the UNPINNED region',
      names(s) === 'C F E A B D', names(s));
    check('unpinning restores the title and the close button',
      !f.pinned && f.hasTitle && f.hasClose && f.name === 'F', JSON.stringify(f));
    check('pinned-before-unpinned still holds', pinnedFirst(s), names(s));
  }

  await win.waitForTimeout(1600); // 400ms persist debounce + margin
  await close();
}

// ===========================================================================
// Run 2: same profile, fresh process — does the pin survive?
// ===========================================================================
{
  const { app, win, close } = await launchApp();
  await win.waitForSelector('.tab:not(.add)');
  await win.waitForTimeout(1500);

  const s = await strip(win);
  check('the pinned STATE survived the restart',
    s.tabs[0].pinned && !s.tabs[0].hasTitle && !s.tabs[0].hasClose, JSON.stringify(s.tabs[0]));
  check('the pinned ORDER survived the restart', names(s) === 'C F E A B D', names(s));
  check('exactly one tab came back pinned', s.tabs.filter((t) => t.pinned).length === 1,
    JSON.stringify(s.tabs.map((t) => t.pinned)));
  check('the restored strip still satisfies pinned-before-unpinned', pinnedFirst(s), names(s));
  check('the group came back as one contiguous run beside it',
    s.wrappers === 1 && consecutive(memberIdx(s)) && memberIdx(s).length === 2,
    `members=${JSON.stringify(memberIdx(s))} wrappers=${s.wrappers}`);
  check('the restored pinned tab is not in the group', !s.tabs[0].grouped, `${s.tabs[0].grouped}`);

  // --- KAN-57 INVERTED THIS BLOCK ------------------------------------------
  // It used to read "a pinned tab can still be closed from the context menu",
  // and it passed — that was the defect, written down as the contract. A pin is
  // now a refusal on every route that closes a TAB, so the same four clicks
  // assert the opposite. Inverted rather than deleted (the precedent is KAN-59
  // doing the same to spaces.mjs's Ctrl+1..9 assertion): the route is still worth
  // driving, only the expected answer changed.
  //
  // Why this lives HERE as well as in confirm.mjs §4: this pinned tab came back
  // OFF DISK. confirm.mjs pins one in the session that then tests it, so it can
  // only ever prove the guard holds for a freshly-pinned tab; a `pinned` flag
  // that survives sanitize() but does not reach the menu's `disabled` decision
  // is green there and red here.
  {
    // Soft, unlike the rest of this file: a REGRESSION here makes the later
    // rows impossible (the tab this block is aiming at is already gone), and an
    // escaping Playwright rejection would report one stack trace instead of the
    // three FAILs that name what broke. Every step is still followed by an
    // outcome check, so a click that silently did not happen is a FAIL too.
    const softMenu = async (i, itemText) => {
      await win.locator('.tab:not(.add)').nth(Math.max(0, i))
        .click({ timeout: 3000, button: 'right' }).catch(() => {});
      await win.waitForTimeout(250);
      await win.locator('.ctx-item', { hasText: itemText }).first()
        .click({ timeout: 3000 }).catch(() => {});
      await win.waitForTimeout(450);
      if (await win.locator('.ctx-backdrop').count()) {
        await win.mouse.click(4, 4);
        await win.waitForTimeout(200);
      }
    };
    const menu = await tabMenuEntries(win, 0);
    const closeItem = menu.find((e) => e.label === 'Close');
    check('a RESTORED pinned tab offers Close greyed out, not missing — the refusal explains itself',
      !!closeItem && closeItem.disabled === true,
      JSON.stringify(closeItem ?? menu.map((e) => e.label)));
    await win.locator('.ctx-item', { hasText: /^Close$/ }).first().click({ timeout: 3000 }).catch(() => {});
    await win.waitForTimeout(400);
    await win.mouse.click(4, 4);
    await win.waitForTimeout(200);
    const after = await strip(win);
    check('CLICKING that greyed Close closes nothing — the pinned tab is still there',
      after.tabs.length === s.tabs.length && after.tabs[0].name === 'C' && after.tabs[0].pinned,
      names(after));

    // The native File ▸ Close Tab (Ctrl+W) route: driven from the main process,
    // because a native menu item is not in the DOM.
    await win.locator('.tab:not(.add)').nth(0).click();
    await win.waitForTimeout(300);
    const fired = await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('file:close-tab');
      if (!item) return false;
      item.click();
      return true;
    });
    await win.waitForTimeout(700);
    const afterCtrlW = await strip(win);
    check('Ctrl+W aimed at the restored pinned tab closes NOTHING',
      fired && afterCtrlW.tabs.length === s.tabs.length && afterCtrlW.tabs[0].name === 'C',
      `fired=${fired}, ${names(afterCtrlW)}`);

    // POSITIVE CONTROL. Without it both refusals above are satisfied by a Close
    // that never worked on this build at all.
    await softMenu(0, 'Unpin tab');
    const unpinned = await strip(win);
    check('PRE-STATE for the control: C is unpinned, still open, and among the loose tabs',
      unpinned.tabs.some((t) => t.name === 'C') && !unpinned.tabs.find((t) => t.name === 'C')?.pinned,
      names(unpinned));
    await softMenu(unpinned.tabs.findIndex((t) => t.name === 'C'), /^Close$/);
    const closed = await strip(win);
    check('POSITIVE CONTROL: unpinned, the very same menu row closes it',
      closed.tabs.length === s.tabs.length - 1 && !closed.tabs.some((t) => t.name === 'C'),
      names(closed));
  }

  await close();
}

// ===========================================================================
// Run 3: KAN-33 height parity, specifically for a PINNED Claude terminal tab.
// A fresh profile — this only needs two tabs and must not inherit Run 1/2's
// pinned+grouped state. A Claude tab's only child once pinned is `.tab-icon`
// wrapping the 8px `.tab-status` dot (not a text glyph like 📁/▶), which is
// exactly the case the height-parity check above cannot exercise.
// ===========================================================================
{
  const PROFILE = path.join(os.tmpdir(), 'claude-explorer-pinned-height-harness');
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const { win, close } = await launchApp({ userDataDir: PROFILE });
  await win.waitForSelector('.tab:not(.add)');
  await win.waitForTimeout(500);

  // Tab 1 (already open): pin it as a plain file tab.
  await tabMenu(win, 0, 'Pin tab');

  // Tab 2: a new file tab, converted in place into a Claude terminal, then
  // pinned — same entry-open trick tabvisuals.mjs uses to avoid a real CLI
  // round trip.
  await win.click('.tab.add');
  await win.waitForTimeout(600);
  await win.waitForSelector('.entry-open');
  await win.locator('.entry-open').first().click();
  await win.waitForTimeout(2000);
  await tabMenu(win, 1, 'Pin tab');

  const s = await strip(win);
  check('two pinned tabs: a file tab and a Claude terminal tab', s.tabs.length === 2 && s.tabs.every((t) => t.pinned),
    JSON.stringify(s.tabs));
  const heights = s.tabs.map((t) => t.h);
  check('a pinned Claude terminal tab is exactly as tall as a pinned file tab',
    Math.max(...heights) - Math.min(...heights) < 0.5, JSON.stringify(heights));

  await close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
