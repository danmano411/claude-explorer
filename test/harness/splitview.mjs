// KAN-46 integration: split view wired into the REAL app.
//   npm run build && node test/harness/splitview.mjs
//   node test/harness/splitview.mjs --show    leave the last window open to look at it
//
// test/harness/splitgrid.mjs proves the geometry module in a bare window. This
// one proves the thing that module could not: that App.tsx's flat, always-mounted
// pane list survives being turned into a CSS Grid — with a live terminal in it.
//
// Load-bearing claims:
//
//   (a) A TERMINAL WITH REAL OUTPUT SURVIVES a split, a divider drag and a pane
//       close, buffer intact and still accepting input. Proved with the same
//       three instruments spaces.mjs uses — a marker printed before, a DOM probe
//       planted on the .xterm element, and a fresh command answered after — plus
//       a mount counter. If a pane is ever re-parented, the xterm is disposed and
//       rebuilt (KAN-23: a rebuilt instance never sees the alt-screen sequences
//       it missed, so the TUI stops scrolling and the scrollback is gone), and
//       the probe is the only one of these that catches it: ConPTY repaints its
//       whole screen buffer on the resize a remount triggers, so the text comes
//       back without any of it having survived. Verified by inverting it — see
//       the note on the probe check.
//   (b) PANES TILE EXACTLY at 1x2, 2x2 and 3x3: measured rectangles, no gap and
//       no overlap beyond the 1px seam, and every pane's inner element gets a
//       real box (Terminal.tsx refuses to fit into a zero-height parent).
//   (c) The layout AND the dragged fractions survive a restart.
//   (d) `layout: null` is today's behaviour: `.content` is not a grid, there are
//       no dividers, no focus ring, and exactly one visible pane.
//   (e) KAN-56 DIRECT MANIPULATION (run 4): a tab dragged off the strip onto a
//       pane's edge quarter splits that pane on that axis and lands in the new
//       cell; onto its centre it replaces the occupant; a pane Alt+dragged onto
//       another swaps them, and onto an edge moves it with the grid still
//       tiling exactly. Ctrl+Shift+G's picker applies an MxN arrangement in
//       strip order, refuses every pick that cannot tile exactly, and Escapes
//       with no state change. THE SAME LIVE TERMINAL, with the scrollback it
//       printed before any of this, survives every one of those gestures.
//
// HOW THE DRAGS ARE DRIVEN, because HTML5 DnD and pointer DnD are not the same
// problem and this harness uses both:
//
//   * A PANE drag is Alt + primary button on pointer events, so Playwright's
//     real mouse drives it end to end and the DOM is readable THROUGHOUT — the
//     mid-drag `.drop-indicator` readings come from a real drag in flight.
//   * A TAB drag off the strip is HTML5 DnD. Playwright's real mouse does
//     perform it — verified: the drop lands and the layout changes — but on
//     Windows the renderer is inside Chromium's drag loop while it is in
//     flight, so an `evaluate()` sampled mid-drag reports the PRE-drag DOM. So:
//     every tab drag whose OUTCOME is under test uses the real mouse (the whole
//     native path, dragstart through drop), and the two assertions that must
//     observe the drag BEFORE release — the indicator, and the abort — dispatch
//     DragEvents with a shared DataTransfer instead. Those still run the real
//     handlers: `dragstart` is fired on the real `.tab`, so TabBar populates the
//     DataTransfer itself, and `dragover`/`drop` are fired on
//     `elementFromPoint`, so App's capture-phase handlers face the same target
//     and the same propagation the native path gives them.
//
// Every drag assertion states the PRE-state as well, so a drag that silently
// did nothing fails instead of passing.
//
// A plain PowerShell tab, not Claude: the claim is about xterm/pty lifetime,
// which is the same machinery either way, and this costs no tokens and no
// ~2-minute CLI startup (test/harness/resume.mjs pays that).
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const SHOW = process.argv.includes('--show');
const EPS = 1.5; // sub-pixel: Chromium rounds fr tracks to device pixels

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const clean = (t) => t.replace(/[\u{1F4C1}▶×]/gu, '').replace(/\s+/g, ' ').trim();
const titles = (win) => win.locator('.tab:not(.add)').allTextContents().then((ts) => ts.map(clean));

/** Terminal text, from the pane holding the shell — NOT scoped to ":not([hidden])",
 *  because half the point is reading a pane while something else has focus. */
const termText = (win) => win.$eval('.pane .xterm-rows', (el) => el.textContent);

async function tabMenu(win, i, itemText) {
  await win.locator('.tab:not(.add)').nth(i).click({ button: 'right' });
  await win.waitForTimeout(250);
  await win.locator('.ctx-item', { hasText: itemText }).first().click();
  await win.waitForTimeout(600);
}

/** The labels the tab context menu is offering for tab `i`. */
async function tabMenuItems(win, i) {
  await win.locator('.tab:not(.add)').nth(i).click({ button: 'right' });
  await win.waitForTimeout(250);
  const items = (await win.locator('.ctx-item').allTextContents()).map((t) => t.trim());
  // The menu closes on a backdrop click, not on Escape (ContextMenu.tsx).
  await win.locator('.ctx-backdrop').click({ position: { x: 4, y: 4 } });
  await win.waitForTimeout(200);
  return items;
}

/**
 * Split the FOCUSED pane, using whichever strip tab still has no pane of its
 * own. Which tab that is depends on the history (`+` retargets the focused pane
 * rather than opening one), so hard-coding an index makes the harness a puzzle;
 * "offers Split right" IS "has no pane", which is the menu rule under test.
 */
async function splitFocused(win, itemText) {
  const n = (await titles(win)).length;
  for (let i = 0; i < n; i++) {
    if (!(await tabMenuItems(win, i)).includes(itemText)) continue;
    await tabMenu(win, i, itemText);
    await win.waitForTimeout(700);
    return true;
  }
  return false;
}

async function runInTerminal(win, line) {
  await win.locator('.pane .xterm-screen').first().click();
  await win.waitForTimeout(200);
  await win.keyboard.type(line);
  await win.waitForTimeout(200);
  await win.keyboard.press('Enter');
}

/**
 * Measured geometry of the content region, relative to its own top-left. Every
 * number here comes from getBoundingClientRect() — nothing inspects React.
 */
const geometry = (win) => win.evaluate(() => {
  const el = document.querySelector('.content');
  const box = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const tracks = (v) => (!v || v === 'none' ? 1 : v.trim().split(/\s+/).length);
  const rel = (r) => ({
    left: r.left - box.left, top: r.top - box.top,
    right: r.right - box.left, bottom: r.bottom - box.top,
    width: r.width, height: r.height,
  });
  return {
    content: { width: box.width, height: box.height },
    display: cs.display,
    cols: tracks(cs.gridTemplateColumns),
    rows: tracks(cs.gridTemplateRows),
    colTemplate: cs.gridTemplateColumns,
    dividers: document.querySelectorAll('.split-divider').length,
    focusRings: document.querySelectorAll('.pane-focused').length,
    xterms: document.querySelectorAll('.xterm').length,
    panes: [...document.querySelectorAll('.pane:not([hidden])')].map((p) => ({
      id: p.dataset.pane,
      focused: p.classList.contains('pane-focused'),
      ...rel(p.getBoundingClientRect()),
      // The inner element is height:100% of the pane — a percentage that only
      // resolves if the pane got a DEFINITE box out of the grid. That is exactly
      // Terminal.tsx's precondition for fit(): it bails on a zero clientHeight.
      inner: rel((p.firstElementChild ?? p).getBoundingClientRect()),
    })),
  };
});

/**
 * Tiling: every visible pane covers its share of the content box with no gap
 * and no overlap. Checked as an AREA sum plus a pairwise overlap test rather
 * than by reconstructing the grid — that way the assertion cannot agree with
 * the implementation by sharing its arithmetic.
 */
function tilingProblems(g) {
  const bad = [];
  const seam = 1;
  const area = g.panes.reduce((n, p) => n + p.width * p.height, 0);
  const expect = g.content.width * g.content.height;
  // The seams belong to no pane: (cols-1) vertical + (rows-1) horizontal gutters.
  const gutter = (g.cols - 1) * seam * g.content.height
    + (g.rows - 1) * seam * g.content.width
    - (g.cols - 1) * (g.rows - 1) * seam * seam;
  if (Math.abs(area - (expect - gutter)) > expect * 0.01) {
    bad.push(`area ${Math.round(area)} vs ${Math.round(expect - gutter)}`);
  }
  for (let i = 0; i < g.panes.length; i++) {
    for (let j = i + 1; j < g.panes.length; j++) {
      const a = g.panes[i]; const b = g.panes[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > EPS && oy > EPS) bad.push(`${a.id}/${b.id} overlap ${ox.toFixed(1)}x${oy.toFixed(1)}`);
    }
  }
  for (const p of g.panes) {
    if (p.width < 2 || p.height < 2) bad.push(`${p.id} collapsed ${p.width}x${p.height}`);
    if (Math.abs(p.inner.height - p.height) > EPS || Math.abs(p.inner.width - p.width) > EPS) {
      bad.push(`${p.id} inner ${p.inner.width.toFixed(1)}x${p.inner.height.toFixed(1)} != pane`);
    }
  }
  return bad;
}

/** Drag the nth divider by (dx, dy). Real pointer events, real pointer capture. */
async function dragDivider(win, n, dx, dy) {
  const d = win.locator('.split-divider').nth(n);
  const b = await d.boundingBox();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  await win.mouse.move(cx, cy);
  await win.mouse.down();
  // Several moves, not one: this is what makes the ResizeObserver fire
  // repeatedly, which is the flood Terminal.tsx's rAF coalesce exists for.
  for (let i = 1; i <= 6; i++) {
    await win.mouse.move(cx + (dx * i) / 6, cy + (dy * i) / 6);
    await win.waitForTimeout(40);
  }
  await win.mouse.up();
  await win.waitForTimeout(500);
}

// --- KAN-56 helpers --------------------------------------------------------

/** Strip order, by tab id. `data-slide` is the id TabBar already puts on every
 *  tab button (the `+` button has none), so no new hook was needed. */
const stripIds = (win) => win.$$eval('.tab[data-slide]', (els) => els.map((e) => e.dataset.slide));

/** id -> [left, top, width, height], whole pixels, relative to `.content`. The
 *  unit of "nothing changed": comparing this map catches a swap, a move and a
 *  reflow, and cannot be satisfied by a same-shaped grid with the panes
 *  shuffled the way a bare cols/rows count can. */
const rects = (g) => Object.fromEntries(g.panes.map((p) => [
  p.id, [Math.round(p.left), Math.round(p.top), Math.round(p.width), Math.round(p.height)],
]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const paneBox = (win, tabId) => win.locator(`[data-pane="${tabId}"]`).boundingBox();

/**
 * A client point inside `b` that `dropZone` resolves to `side` (or the centre).
 *
 * 12% in, floored at 24px: comfortably under EDGE_FRACTION (0.25) so the side
 * is unambiguous, and comfortably outside the 12px seam grab band that sits on
 * every pane boundary — a point that lands in a seam would be testing the seam
 * zone instead of the edge zone.
 */
function edgePoint(b, side) {
  const ix = Math.max(24, b.width * 0.12);
  const iy = Math.max(24, b.height * 0.12);
  if (side === 'left') return { x: b.x + ix, y: b.y + b.height / 2 };
  if (side === 'right') return { x: b.x + b.width - ix, y: b.y + b.height / 2 };
  if (side === 'top') return { x: b.x + b.width / 2, y: b.y + iy };
  if (side === 'bottom') return { x: b.x + b.width / 2, y: b.y + b.height - iy };
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Drag tab `tabId` off the strip to a client point — REAL mouse, so this is
 *  the whole native HTML5 path: Chromium starts the drag, TabBar's onDragStart
 *  fills the DataTransfer, App's capture handlers take the drop. */
async function dragTabTo(win, tabId, pt) {
  const t = await win.locator(`.tab[data-slide="${tabId}"]`).boundingBox();
  await win.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await win.mouse.down();
  await win.mouse.move(t.x + t.width / 2 + 24, t.y + t.height / 2 + 10); // clear the press threshold
  await win.waitForTimeout(150);
  await win.mouse.move(pt.x, pt.y, { steps: 8 });
  await win.waitForTimeout(250);
  await win.mouse.up();
  await win.waitForTimeout(800);
}

/** Alt+drag a PANE by its body. Pointer events, so the indicator is readable
 *  while the drag is still in flight — returned, because "the target rect was
 *  shown before release" is only provable from mid-drag. */
async function dragPaneTo(win, tabId, pt) {
  const b = await paneBox(win, tabId);
  await win.keyboard.down('Alt');
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await win.mouse.down();
  await win.mouse.move(b.x + b.width / 2 + 12, b.y + b.height / 2 + 8); // past PANE_DRAG_PX
  await win.waitForTimeout(150);
  await win.mouse.move(pt.x, pt.y, { steps: 8 });
  await win.waitForTimeout(250);
  const mid = await indicator(win);
  await win.mouse.up();
  await win.keyboard.up('Alt');
  await win.waitForTimeout(800);
  return mid;
}

/** What `.drop-indicator` is showing right now, container-relative. */
const indicator = (win) => win.evaluate(() => {
  const el = document.querySelector('.drop-indicator');
  const c = document.querySelector('.content').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return {
    zone: el.dataset.zone,
    shown: getComputedStyle(el).display !== 'none',
    rect: [r.left - c.left, r.top - c.top, r.width, r.height].map(Math.round),
  };
});

/**
 * A tab drag driven by dispatched DragEvents sharing one DataTransfer — the
 * only way to READ the DOM mid-drag (see the header note). `drop: false` ends
 * the drag outside `.content`, which must leave everything as it was.
 */
const syntheticTabDrag = (win, tabId, pt, drop) => win.evaluate(({ tabId, x, y, drop }) => {
  const dt = new DataTransfer();
  const src = document.querySelector(`.tab[data-slide="${tabId}"]`);
  const fire = (type, target, more = {}) => target.dispatchEvent(new DragEvent(type, {
    bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...more,
  }));
  fire('dragstart', src, { clientX: 0, clientY: 0 });
  const types = [...dt.types];
  // The real element under the pointer, so App's capture handler competes with
  // whatever FileBrowser row or xterm node is actually there.
  const at = document.elementFromPoint(x, y);
  fire('dragenter', at, { clientX: x, clientY: y });
  fire('dragover', at, { clientX: x, clientY: y });
  const el = document.querySelector('.drop-indicator');
  const c = document.querySelector('.content').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const mid = {
    zone: el.dataset.zone,
    shown: getComputedStyle(el).display !== 'none',
    rect: [r.left - c.left, r.top - c.top, r.width, r.height].map(Math.round),
    target: at?.className ?? null,
    types,
  };
  if (drop) fire('drop', at, { clientX: x, clientY: y });
  else fire('dragleave', at, { clientX: 4, clientY: 4, relatedTarget: document.querySelector('.tabbar') });
  fire('dragend', src, { clientX: x, clientY: y });
  return mid;
}, { tabId, x: pt.x, y: pt.y, drop });

const PROFILE = path.join(os.tmpdir(), `claude-explorer-splitview-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

// Concatenated by PowerShell, never typed whole: the terminal echoes what you
// type, so a command containing the literal marker puts it on screen whether or
// not the shell ever ran. `Write-Host ('CE-MARK-'+$t)` echoes as the source, so
// a search for the joined string can only match OUTPUT. (Same trap spaces.mjs
// and resume.mjs document.)
const TAG = Date.now().toString().slice(-6);
const MARKER = `CE-MARK-${TAG}`;
const ALIVE = `CE-ALIVE-${TAG}`;
const emit = (prefix) => `Write-Host ('${prefix}-'+$t)`;

// ===========================================================================
// Run 1 — (d) the untouched single-pane path, then (a) and (b).
// ===========================================================================
{
  const { win, close } = await launchApp({ userDataDir: PROFILE });
  await win.waitForSelector('.entry');
  await win.waitForTimeout(600);

  // --- (d) layout: null is exactly what it always was ----------------------
  {
    const g = await geometry(win);
    check('layout:null — .content is NOT a grid', g.display !== 'grid', g.display);
    check('layout:null — no dividers and no focus ring',
      g.dividers === 0 && g.focusRings === 0, `${g.dividers} dividers, ${g.focusRings} rings`);
    check('layout:null — exactly one visible pane, filling the content box',
      g.panes.length === 1
        && Math.abs(g.panes[0].width - g.content.width) < EPS
        && Math.abs(g.panes[0].height - g.content.height) < EPS,
      `${g.panes.length} panes, ${JSON.stringify(g.content)}`);
    const items = await tabMenuItems(win, 0);
    check('layout:null — the single pane\'s own tab offers no split (it would be a no-op)',
      !items.includes('Split right') && !items.includes('Close pane'), items.join(' | '));
  }

  // Two tabs: a files tab (restored) and a real PowerShell.
  await tabMenu(win, 0, 'Open Terminal');
  await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 20_000 });
  await win.waitForTimeout(1500);
  check('a terminal tab is open beside the files tab',
    (await titles(win)).length === 2, (await titles(win)).join(' | '));

  await runInTerminal(win, `$t='${TAG}'; ${emit('CE-MARK')}`);
  await win.waitForTimeout(1500);
  check('the shell printed a marker before anything was split',
    (await termText(win)).includes(MARKER));

  // Plant a probe on the xterm element. Terminal.tsx builds it inside an effect
  // and disposes it on unmount, so this attribute surviving means the very same
  // instance — and therefore the very same scrollback buffer — is still there.
  await win.evaluate(() => {
    document.querySelector('.pane .xterm').dataset.ceProbe = 'run1';
    // Mount counter for the same claim, from the other direction.
    window.__paneNodes = [...document.querySelectorAll('.pane')].map((p) => p.dataset.pane);
  });

  const paneOfTerminal = await win.evaluate(() =>
    document.querySelector('.pane .xterm').closest('.pane').dataset.pane);

  // --- (b) 1x2 -------------------------------------------------------------
  // Split from the FILES tab's menu while the terminal has focus: the focused
  // pane is split and the files tab lands in the half that appears.
  await tabMenu(win, 0, 'Split right');
  await win.waitForTimeout(900);
  {
    const g = await geometry(win);
    check('split right — .content became a 2-column grid with 2 visible panes',
      g.display === 'grid' && g.cols === 2 && g.rows === 1 && g.panes.length === 2,
      `${g.display} ${g.cols}x${g.rows}, ${g.panes.length} panes`);
    check('split right — the panes tile the content box exactly (1x2)',
      tilingProblems(g).length === 0, tilingProblems(g).join('; '));
    check('split right — one divider, on the seam',
      g.dividers === 1, String(g.dividers));
    check('split right — the pane that took focus wears the clay ring, and only it',
      g.focusRings === 1 && g.panes.filter((p) => p.focused).length === 1,
      `${g.focusRings} rings`);
    check('split right — the terminal is STILL MOUNTED and now sharing the screen',
      g.xterms === 1 && g.panes.some((p) => p.id === paneOfTerminal),
      `${g.xterms} xterms, panes ${g.panes.map((p) => p.id).join(',')}`);
  }

  // (a) — the buffer, across the split.
  {
    const probe = await win.evaluate(() =>
      document.querySelector('.pane .xterm')?.dataset.ceProbe ?? null);
    check('SPLIT DID NOT RE-PARENT THE TERMINAL — same xterm instance (KAN-23)',
      probe === 'run1', String(probe));
    check('and its scrollback is intact across the split', (await termText(win)).includes(MARKER));
  }

  // --- the divider drag ----------------------------------------------------
  const before = await geometry(win);
  await dragDivider(win, 0, -150, 0);
  const dragged = await geometry(win);
  {
    const moved = Math.abs(dragged.panes[0].width - before.panes[0].width);
    check('dragging the divider actually resized the panes',
      moved > 80, `${before.panes[0].width.toFixed(0)} -> ${dragged.panes[0].width.toFixed(0)}`);
    check('and they still tile exactly after the drag',
      tilingProblems(dragged).length === 0, tilingProblems(dragged).join('; '));
    const probe = await win.evaluate(() =>
      document.querySelector('.pane .xterm')?.dataset.ceProbe ?? null);
    check('DRAG DID NOT RE-PARENT THE TERMINAL — same xterm instance',
      probe === 'run1', String(probe));
    check('and its scrollback survived the drag', (await termText(win)).includes(MARKER));
  }

  // The refit claim: the terminal re-fitted to its new, narrower box. xterm
  // writes the measured column count onto its own screen element.
  {
    const cols = await win.evaluate(() => {
      const rows = document.querySelector('.pane .xterm-rows');
      return rows ? getComputedStyle(rows).width : null;
    });
    const paneW = dragged.panes.find((p) => p.id === paneOfTerminal)?.width ?? 0;
    const rowsW = parseFloat(cols ?? '0');
    check('the terminal re-fitted to the resized pane (its rows are no wider than the pane)',
      rowsW > 0 && rowsW <= paneW + EPS, `rows ${rowsW.toFixed(0)}px in a ${paneW.toFixed(0)}px pane`);
  }

  // Still ALIVE, not merely still on screen.
  await runInTerminal(win, `$t='${TAG}'; ${emit('CE-ALIVE')}`);
  await win.waitForTimeout(2000);
  check('the shell still answers a new command after the split and the drag',
    (await termText(win)).includes(ALIVE));

  // --- (b) 2x2 and 3x3 -----------------------------------------------------
  // More tabs, more panes. Each Split acts on the focused pane, so focus is
  // steered by clicking the pane we want to cut.
  for (let i = 0; i < 3; i++) { await win.click('.tab.add'); await win.waitForTimeout(600); }
  check('four tabs on the strip, and the strip is still ONE strip',
    (await titles(win)).length === 5
      && (await win.evaluate(() => document.querySelectorAll('.tabbar').length)) === 1,
    (await titles(win)).join(' | '));

  // Focus the left pane, split it down; then focus the right pane, split down.
  await win.locator('.pane:not([hidden])').first().click({ position: { x: 20, y: 20 } });
  await win.waitForTimeout(300);
  check('split down is offered', await splitFocused(win, 'Split down'));
  {
    const g = await geometry(win);
    check('split down — three panes, still tiling exactly',
      g.panes.length === 3 && tilingProblems(g).length === 0,
      `${g.panes.length} panes; ${tilingProblems(g).join('; ')}`);
  }
  await win.locator('.pane:not([hidden])').nth(1).click({ position: { x: 20, y: 20 } });
  await win.waitForTimeout(300);
  await splitFocused(win, 'Split down');
  {
    const g = await geometry(win);
    check('four panes tile the content box exactly, with no gap and no overlap',
      g.panes.length === 4 && tilingProblems(g).length === 0,
      `${g.cols}x${g.rows}, ${g.panes.length} panes; ${tilingProblems(g).join('; ')}`);
    check('every pane got a definite box, so a terminal in any of them can fit()',
      g.panes.every((p) => p.inner.height > 2 && p.inner.width > 2),
      g.panes.map((p) => `${p.id}:${p.inner.width.toFixed(0)}x${p.inner.height.toFixed(0)}`).join(' '));
  }

  await win.locator('.pane:not([hidden])').nth(2).click({ position: { x: 20, y: 20 } });
  await win.waitForTimeout(300);
  await splitFocused(win, 'Split right');
  {
    const g = await geometry(win);
    check('a five-pane grid (3 columns) still tiles exactly',
      g.panes.length === 5 && g.cols === 3 && tilingProblems(g).length === 0,
      `${g.cols}x${g.rows}, ${g.panes.length} panes; ${tilingProblems(g).join('; ')}`);
  }

  // --- one tab per pane: a strip click retargets the FOCUSED pane -----------
  {
    const focusedBefore = (await geometry(win)).panes.find((p) => p.focused).id;
    await win.click('.tab.add'); // a sixth tab, with nowhere of its own to go
    await win.waitForTimeout(900);
    const g = await geometry(win);
    check('a new tab does NOT open a sixth pane — it takes over the focused one',
      g.panes.length === 5, `${g.panes.length} panes`);
    check('and the pane it took over is the one that had focus',
      !g.panes.some((p) => p.id === focusedBefore) && g.panes.filter((p) => p.focused).length === 1,
      `${focusedBefore} evicted: ${!g.panes.some((p) => p.id === focusedBefore)}`);
    check('the evicted tab is still on the strip — a space member with no cell is fine',
      (await titles(win)).length === 6, (await titles(win)).join(' | '));
  }

  // --- closing a pane ------------------------------------------------------
  {
    // Six tabs, five panes, so exactly one tab has no pane. Read every menu
    // FIRST (closing one changes the others), then close a pane that is not the
    // terminal's — the terminal has to survive to prove the KAN-23 claim below.
    const strip = await titles(win);
    const termIdx = strip.indexOf('Terminal');
    const menus = [];
    for (let i = 0; i < strip.length; i++) menus.push(await tabMenuItems(win, i));
    const withPane = menus.map((m, i) => (m.includes('Close pane') ? i : -1)).filter((i) => i >= 0);
    check('"Close pane" is offered by exactly the tabs that HAVE a pane',
      withPane.length === 5 && withPane.length === strip.length - 1 && withPane.includes(termIdx),
      `tabs with a pane: ${withPane.join(',')} of ${strip.length}`);
    const victim = withPane.find((i) => i !== termIdx);
    await tabMenu(win, victim, 'Close pane');
    const g = await geometry(win);
    check('closing a pane reflows the rest — they tile exactly again, no hole',
      g.panes.length === 4 && tilingProblems(g).length === 0,
      `${g.cols}x${g.rows}, ${g.panes.length} panes; ${tilingProblems(g).join('; ')}`);
    check('the closed pane\'s TAB is still on the strip — a pane is placement, not the tab',
      (await titles(win)).length === 6, (await titles(win)).join(' | '));
  }

  // (a) — the buffer, across a sibling pane opening and closing.
  {
    const probe = await win.evaluate(() =>
      document.querySelector('.pane .xterm')?.dataset.ceProbe ?? null);
    // INVERTED ONCE, DELIBERATELY: making App render `<Terminal>` inside a
    // per-cell wrapper instead of placing the existing flat `.pane` — i.e.
    // re-parenting — turns this probe to `null` while every text assertion
    // above still passes, because ConPTY repaints the whole screen buffer on
    // the resize a remount triggers. This line is the only one that catches it.
    check('PANES OPENING AND CLOSING NEVER RE-PARENTED THE TERMINAL (KAN-23)',
      probe === 'run1', String(probe));
    check('and the scrollback from before the very first split is STILL there',
      (await termText(win)).includes(MARKER) && (await termText(win)).includes(ALIVE));
  }

  // --- leave a dragged, uneven layout for the restart check ----------------
  await win.waitForTimeout(400);
  const before2 = await geometry(win);
  await dragDivider(win, 0, -140, 0);
  const afterDrag = await geometry(win);
  {
    const was = Object.fromEntries(before2.panes.map((p) => [p.id, p.width]));
    const moved = afterDrag.panes.filter((p) => Math.abs(p.width - (was[p.id] ?? 0)) > 60);
    check('the pre-restart drag moved a seam (so the restart has something to prove)',
      moved.length >= 2, `${moved.length} panes changed width by >60px`);
  }

  // Compared BY PANE ID, so the restart has to put each tab back in its own
  // rectangle — a check that a same-shaped grid with the panes shuffled would
  // fail. Rounded to whole pixels: fr tracks land on device pixels.
  const expectRestore = {
    cols: afterDrag.cols,
    rows: afterDrag.rows,
    content: afterDrag.content,
    template: afterDrag.colTemplate,
    panes: Object.fromEntries(afterDrag.panes.map((p) => [
      p.id, [Math.round(p.left), Math.round(p.top), Math.round(p.width), Math.round(p.height)],
    ])),
  };
  fs.writeFileSync(path.join(PROFILE, 'expect.json'), JSON.stringify(expectRestore));

  await win.waitForTimeout(1600); // 400ms persist debounce + margin
  await close();
}

// ===========================================================================
// Run 2 — (c) same profile, fresh process: layout AND fractions came back.
// ===========================================================================
{
  const expected = JSON.parse(fs.readFileSync(path.join(PROFILE, 'expect.json'), 'utf8'));
  const { win, close } = await launchApp({ userDataDir: PROFILE });
  await win.waitForSelector('.tab:not(.add)');
  await win.waitForTimeout(2500);

  const g = await geometry(win);
  const want = expected.panes;
  check('the split layout survived the restart — same grid, same pane count',
    g.cols === expected.cols && g.rows === expected.rows
      && g.panes.length === Object.keys(want).length,
    `${g.cols}x${g.rows} ${g.panes.length} panes, wanted ${expected.cols}x${expected.rows} ${Object.keys(want).length}`);
  check('and it still tiles exactly', tilingProblems(g).length === 0, tilingProblems(g).join('; '));

  // Every terminal in the split had to be respawned to fill its pane; if one
  // did not, its cell is reserved and empty and the tiling check above fails.
  check('every restored pane is on screen, none left as an empty grid cell',
    g.panes.every((p) => p.inner.width > 2 && p.inner.height > 2),
    g.panes.map((p) => `${p.id.slice(0, 4)}:${p.inner.width.toFixed(0)}x${p.inner.height.toFixed(0)}`).join(' '));

  const off = g.panes
    .map((p) => {
      const w = want[p.id];
      if (!w) return `${p.id.slice(0, 4)} is not a pane it was`;
      const now = [p.left, p.top, p.width, p.height];
      return now.some((v, i) => Math.abs(v - w[i]) > 3) ? `${p.id.slice(0, 4)} ${now.map(Math.round)} vs ${w}` : null;
    })
    .filter(Boolean);
  check('THE DRAGGED FRACTIONS SURVIVED TOO — every pane came back in its own rectangle',
    off.length === 0, off.join('; '));
  check('and the restored template is the dragged one, not an even split',
    !/^(\S+)( \1)+$/.test(g.colTemplate.trim()), g.colTemplate);

  await close();
}

// ===========================================================================
// Run 3 — (b) the exact grids the requirement names: 1x2, 2x2, 3x3.
//
// Seeded through a real workspace.json rather than clicked into existence,
// because the split ACTIONS cannot produce every one of them: splitting a pane
// that spans two rows costs a third row rather than cutting its neighbours in
// half (see gridlayout.split). A layout is persisted state, so a hand-written
// one is a case the app genuinely has to render — and it is the only way to
// measure a true NxN in the real app rather than in a stand-in window.
// ===========================================================================
for (const [cols, rows] of [[2, 1], [2, 2], [3, 3]]) {
  const profile = path.join(os.tmpdir(), `claude-explorer-splitview-${cols}x${rows}-${process.pid}`);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });

  const home = os.homedir();
  const tabs = [];
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = `t-${c}-${r}`;
      tabs.push({ id, view: 'files', cwd: home, title: `${c},${r}` });
      cells.push({ tabId: id, col: c, row: r, colSpan: 1, rowSpan: 1 });
    }
  }
  fs.writeFileSync(path.join(profile, 'workspace.json'), JSON.stringify({
    version: 1,
    groups: [],
    tabs,
    spaces: [{
      id: 'space-seed', name: 'Space',
      tabIds: tabs.map((t) => t.id),
      layout: { cols, rows, cells },
      activeTabId: tabs[0].id,
    }],
    activeSpaceId: 'space-seed',
  }, null, 2));

  const { win, close } = await launchApp({ userDataDir: profile });
  await win.waitForSelector('.pane:not([hidden])');
  await win.waitForTimeout(1800);

  const g = await geometry(win);
  const bad = tilingProblems(g);
  check(`${cols}x${rows} — ${cols * rows} panes tile the content box exactly, no gap, no overlap`,
    g.cols === cols && g.rows === rows && g.panes.length === cols * rows && bad.length === 0,
    `${g.cols}x${g.rows}, ${g.panes.length} panes; ${bad.join('; ')}`);
  // One handle per interior grid line: in a grid of 1x1 cells every interior
  // line is a boundary along its whole length, so it is one contiguous run and
  // splitgrid.dividers() emits a single full-length handle for it.
  check(`${cols}x${rows} — ${(cols - 1) + (rows - 1)} draggable seams, one per interior grid line`,
    g.dividers === (cols - 1) + (rows - 1), `${g.dividers} handles`);
  check(`${cols}x${rows} — exactly one pane wears the focus ring`,
    g.focusRings === 1, String(g.focusRings));

  if (SHOW && cols === 3) { await win.waitForTimeout(600_000); }
  await close();
}

// ===========================================================================
// Run 4 — (e) KAN-56 direct manipulation, with a live terminal in the grid.
//
// One window, one shell, one uninterrupted scrollback: every gesture is applied
// to the SAME session, so the survival probe at the end is a claim about all of
// them and not about whichever one happened to run last.
// ===========================================================================
{
  const PROFILE4 = path.join(os.tmpdir(), `claude-explorer-directmanip-${process.pid}`);
  fs.rmSync(PROFILE4, { recursive: true, force: true });
  const LIVE = `CE-LIVE2-${TAG}`;

  const { win, close } = await launchApp({ userDataDir: PROFILE4 });
  await win.waitForSelector('.entry');
  await win.waitForTimeout(600);

  await tabMenu(win, 0, 'Open Terminal');
  await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 20_000 });
  await win.waitForTimeout(1500);
  await runInTerminal(win, `$t='${TAG}'; ${emit('CE-MARK')}`);
  await win.waitForTimeout(1500);
  check('dm: the shell printed a marker before any direct manipulation',
    (await termText(win)).includes(MARKER));
  await win.evaluate(() => { document.querySelector('.xterm').dataset.ceProbe = 'run4'; });

  // Five tabs while `layout` is still null, so every one of them exists before
  // the first pane does — `.tab.add` only retargets the focused pane once a
  // split is up, and that would evict panes this run is about to place.
  for (let i = 0; i < 3; i++) { await win.click('.tab.add'); await win.waitForTimeout(500); }

  const ids = await stripIds(win);
  const termId = await win.evaluate(() =>
    document.querySelector('.xterm').closest('.pane').dataset.pane);
  const homeId = await win.evaluate(() =>
    document.querySelector('.pane:not([hidden])').dataset.pane);
  const spare = ids.filter((id) => id !== termId && id !== homeId);
  check('dm: five tabs, no grid yet — one visible pane and the terminal parked off screen',
    ids.length === 5 && spare.length === 3 && (await geometry(win)).display !== 'grid',
    `${ids.length} tabs, display ${(await geometry(win)).display}`);

  // --- 1. a tab dropped on an EDGE QUARTER splits that pane -----------------
  {
    const g0 = await geometry(win);
    const pre = g0.panes.length === 1 && g0.display !== 'grid'
      && !g0.panes.some((p) => p.id === termId);
    await dragTabTo(win, termId, edgePoint(await paneBox(win, homeId), 'right'));
    const g = await geometry(win);
    const home = g.panes.find((p) => p.id === homeId);
    const term = g.panes.find((p) => p.id === termId);
    check('dm: RIGHT quarter — a tab dragged onto the only pane creates the first split',
      pre && g.display === 'grid' && g.cols === 2 && g.rows === 1 && g.panes.length === 2,
      `pre-state ok: ${pre}; now ${g.display} ${g.cols}x${g.rows}, ${g.panes.length} panes`);
    check('dm: RIGHT quarter — the dropped tab landed in the NEW cell, on the right',
      !!term && !!home && term.left > home.left + EPS && Math.abs(term.left - home.right) <= 2
        && tilingProblems(g).length === 0,
      `${home ? `home@${Math.round(home.left)}` : 'no home'} ${term ? `term@${Math.round(term.left)}` : 'no term'}; ${tilingProblems(g).join('; ')}`);
  }

  // --- 2. the indicator paints the target rect BEFORE release ---------------
  // Dispatched events, not the real mouse: see the header. The rect it must
  // paint is the half of the target pane the drop would take — not the whole
  // pane, which is what a centre drop paints, so the two cannot be confused.
  {
    const g = await geometry(win);
    const box = g.panes.find((p) => p.id === homeId);
    const before = await indicator(win);
    const mid = await syntheticTabDrag(win, spare[0], edgePoint(await paneBox(win, homeId), 'right'), false);
    const after = await indicator(win);
    check('dm: nothing is painted until a drag is over the pane area',
      !before.shown && before.zone === '', `${before.zone}/${before.shown}`);
    check('dm: mid-drag the indicator names the zone it would drop into',
      mid.shown && mid.zone === `edge:${homeId}:right`, `${mid.zone} (over ${mid.target})`);
    check('dm: and paints the rectangle that pane would give up — its right half',
      Math.abs(mid.rect[0] - (box.left + box.width / 2)) <= 2
        && Math.abs(mid.rect[2] - box.width / 2) <= 2
        && Math.abs(mid.rect[3] - box.height) <= 2,
      `${mid.rect} vs half of ${[box.left, box.top, box.width, box.height].map(Math.round)}`);
    check('dm: the drag carried the strip payload, so this exercised the real handlers',
      mid.types.includes('application/x-ce-tab'), mid.types.join(','));
    check('dm: a drag that ends outside .content leaves the layout and the indicator alone',
      !after.shown && after.zone === '' && same(rects(await geometry(win)), rects(g)),
      `${after.zone}/${after.shown}`);
  }

  // --- 3. the other three quarters, and a CENTRE replace --------------------
  {
    const pre = (await geometry(win)).panes.map((p) => p.id);
    await dragTabTo(win, spare[0], edgePoint(await paneBox(win, homeId), 'left'));
    const g = await geometry(win);
    const home = g.panes.find((p) => p.id === homeId);
    const dropped = g.panes.find((p) => p.id === spare[0]);
    check('dm: LEFT quarter — the new cell is left of the pane that was split',
      !pre.includes(spare[0]) && !!dropped && dropped.right <= home.left + 2
        && g.cols === 3 && tilingProblems(g).length === 0,
      `pre had ${pre.length} panes; ${g.cols}x${g.rows}; ${tilingProblems(g).join('; ')}`);
  }
  {
    const g0 = await geometry(win);
    const target = g0.panes.find((p) => p.id === homeId);
    await dragTabTo(win, spare[1], edgePoint(await paneBox(win, homeId), 'centre'));
    const g = await geometry(win);
    const taken = g.panes.find((p) => p.id === spare[1]);
    check('dm: CENTRE — the drop REPLACES the occupant, in exactly its rectangle',
      !g0.panes.some((p) => p.id === spare[1]) && !!taken
        && same([taken.left, taken.top, taken.width, taken.height].map(Math.round),
          [target.left, target.top, target.width, target.height].map(Math.round))
        && g.panes.length === g0.panes.length && !g.panes.some((p) => p.id === homeId),
      `${g.panes.length} panes, displaced ${homeId.slice(0, 4)} gone: ${!g.panes.some((p) => p.id === homeId)}`);
    // Both halves, or this passes against a drag that never happened: the tab
    // must have LOST its pane and KEPT its slot, which is the whole distinction.
    check('dm: CENTRE — the displaced tab lost its pane but kept its slot on the strip',
      !g.panes.some((p) => p.id === homeId) && (await stripIds(win)).length === 5
        && (await stripIds(win)).includes(homeId));
  }
  {
    const g0 = await geometry(win);
    const target = g0.panes.find((p) => p.id === spare[1]);
    await dragTabTo(win, spare[2], edgePoint(await paneBox(win, spare[1]), 'bottom'));
    const g = await geometry(win);
    const dropped = g.panes.find((p) => p.id === spare[2]);
    const now = g.panes.find((p) => p.id === spare[1]);
    check('dm: BOTTOM quarter — the split is on the ROW axis and the new cell is below',
      !g0.panes.some((p) => p.id === spare[2]) && !!dropped && dropped.top >= now.bottom - 2
        && Math.abs(now.height - target.height / 2) < target.height / 4
        && g.rows === 2 && tilingProblems(g).length === 0,
      `${g.cols}x${g.rows}; ${tilingProblems(g).join('; ')}`);
  }
  {
    const g0 = await geometry(win);
    await dragTabTo(win, homeId, edgePoint(await paneBox(win, termId), 'top'));
    const g = await geometry(win);
    const dropped = g.panes.find((p) => p.id === homeId);
    const term = g.panes.find((p) => p.id === termId);
    check('dm: TOP quarter — the new cell is above the pane that was split',
      !g0.panes.some((p) => p.id === homeId) && !!dropped && dropped.bottom <= term.top + 2
        && Math.abs(dropped.left - term.left) <= 2 && g.panes.length === 5,
      `${g.cols}x${g.rows}, ${g.panes.length} panes`);
    check('dm: five panes placed by drag alone still tile the content box exactly',
      g.panes.length === 5 && tilingProblems(g).length === 0,
      `${g.panes.length} panes; ${tilingProblems(g).join('; ')}`);
    // The pane area governs the drop, not the strip: TabBar's own reorder DnD
    // uses the same TAB_MIME payload, so a drop that leaked back to it would
    // shuffle the strip instead of (or as well as) placing a pane.
    check('dm: none of those drops reordered the tab strip',
      g.panes.length === 5 && same(await stripIds(win), ids),
      (await stripIds(win)).map((s) => s.slice(0, 4)).join(','));
  }

  // --- 4. Alt+dragging a PANE: swap, then move --------------------------------
  {
    const g0 = await geometry(win);
    const a = g0.panes.find((p) => p.id === spare[0]); // a full-height column
    const b = g0.panes.find((p) => p.id === homeId);   // the small cell placed last
    const mid = await dragPaneTo(win, a.id, edgePoint(await paneBox(win, b.id), 'centre'));
    const g = await geometry(win);
    const r0 = rects(g0); const r1 = rects(g);
    const others = Object.keys(r0).filter((k) => k !== a.id && k !== b.id);
    check('dm: a pane drag paints the whole target pane, so a swap cannot look like a split',
      mid.shown && mid.zone === `centre:${b.id}`, mid.zone);
    // ONE assertion, not two: "every other pane is untouched" is true of a drag
    // that never happened, so on its own it could never go red.
    check('dm: SWAP — Alt+dragging pane A onto pane B exchanges their rectangles and touches nothing else',
      same(r1[a.id], r0[b.id]) && same(r1[b.id], r0[a.id]) && !same(r0[a.id], r0[b.id])
        && others.every((k) => same(r0[k], r1[k])) && tilingProblems(g).length === 0,
      `${a.id.slice(0, 4)} ${r0[a.id]} -> ${r1[a.id]}; ${tilingProblems(g).join('; ')}`);
  }
  {
    const g0 = await geometry(win);
    // Move the SMALLEST cell onto the right edge of the tallest one: its old
    // rectangle has to be absorbed and the grid re-tiled, which is the claim.
    const mover = g0.panes.reduce((m, p) => (p.width * p.height < m.width * m.height ? p : m));
    const host = g0.panes.reduce((m, p) => (p.id !== mover.id && p.height > m.height ? p : m),
      g0.panes.find((p) => p.id !== mover.id));
    await dragPaneTo(win, mover.id, edgePoint(await paneBox(win, host.id), 'right'));
    const g = await geometry(win);
    const moved = g.panes.find((p) => p.id === mover.id);
    const anchor = g.panes.find((p) => p.id === host.id);
    // One assertion again: "it still tiles" is true of a grid nobody touched.
    // The hole the move left has to be gone, and a leftover empty rectangle
    // shows up as a shortfall in the AREA sum, which is what tilingProblems
    // measures. ponytail: that is the only OBSERVABLE form of "compact ran" —
    // `absorb` hands a vacated rectangle to a neighbour before `compact` ever
    // sees it, so a track count never actually drops. Assert on the rect map,
    // never on gridTemplateColumns, for anything that vacates.
    check('dm: MOVE — Alt+dragging a pane to an edge re-places it there and leaves no hole',
      !!moved && !!anchor && Math.abs(moved.left - anchor.right) <= 2
        && moved.bottom > anchor.top && moved.top < anchor.bottom
        && !same(rects(g0)[mover.id], rects(g)[mover.id])
        && g.panes.length === 5 && tilingProblems(g).length === 0,
      `${mover.id.slice(0, 4)} ${rects(g0)[mover.id]} -> ${rects(g)[mover.id]}; ${g.cols}x${g.rows}; ${tilingProblems(g).join('; ')}`);
  }

  // --- 5. the Ctrl+Shift+G arrangement picker --------------------------------
  // Four panes, because that is the count whose valid picks are interesting:
  // 2x2, 4x1, 1x4 and 3x2 tile exactly, and 3x3 / 2x1 cannot.
  {
    const strip = await titles(win);
    const menus = [];
    for (let i = 0; i < strip.length; i++) menus.push(await tabMenuItems(win, i));
    const victim = menus.findIndex((m, i) => m.includes('Close pane') && strip[i] !== 'Terminal');
    await tabMenu(win, victim, 'Close pane');
    const g = await geometry(win);
    check('dm: closed one pane to set up the picker — four left, still tiling exactly',
      g.panes.length === 4 && tilingProblems(g).length === 0,
      `${g.panes.length} panes; ${tilingProblems(g).join('; ')}`);
  }

  {
    // Focus the terminal first: Ctrl+Shift+G has to be taken by the app and NOT
    // reach the shell as a ^G, which is the whole reason it is a capture-phase
    // listener at window rather than a preventDefault.
    await win.locator(`[data-pane="${termId}"] .xterm-screen`).click();
    await win.waitForTimeout(300);
    const textBefore = await termText(win);
    await win.keyboard.press('Control+Shift+G');
    await win.waitForTimeout(400);
    check('dm: Ctrl+Shift+G opens the picker',
      await win.locator('.gridpick').isVisible());
    check('dm: and it did not reach the focused shell as a ^G',
      (await termText(win)) === textBefore);

    const disabled = (c, r) =>
      win.locator(`.gridpick-cell[data-cell="${c},${r}"]`).getAttribute('aria-disabled');
    check('dm: 3x3 is REFUSED with four panes — it would leave a whole row empty',
      (await disabled(2, 2)) === 'true', String(await disabled(2, 2)));
    check('dm: a grid SMALLER than the pane count is refused too (2x1 cannot hold four)',
      (await disabled(1, 0)) === 'true', String(await disabled(1, 0)));
    check('dm: 3x2 IS offered — it is the pick that tiles four panes exactly',
      (await disabled(2, 1)) !== 'true', String(await disabled(2, 1)));

    // A refused pick must be inert, not merely ugly.
    const g0 = await geometry(win);
    // `force`, because the refused cell carries aria-disabled and Playwright's
    // actionability check would wait it out forever — the point of the
    // assertion is that a real click on it does nothing.
    await win.locator('.gridpick-cell[data-cell="1,0"]').click({ force: true });
    await win.waitForTimeout(500);
    check('dm: clicking a refused cell changes nothing and leaves the picker open',
      same(rects(await geometry(win)), rects(g0))
        && (await geometry(win)).colTemplate === g0.colTemplate
        && await win.locator('.gridpick').isVisible());

    // Escape: arrow around first, so there IS a highlighted pick to discard.
    await win.keyboard.press('ArrowRight');
    await win.keyboard.press('ArrowDown');
    await win.waitForTimeout(200);
    await win.keyboard.press('Escape');
    await win.waitForTimeout(400);
    check('dm: Escape closes the picker',
      (await win.locator('.gridpick').count()) === 0);
    check('dm: and cancels with NO state change — same rectangles, same track template',
      same(rects(await geometry(win)), rects(g0))
        && (await geometry(win)).colTemplate === g0.colTemplate,
      (await geometry(win)).colTemplate);
  }

  {
    const placed = (await geometry(win)).panes.map((p) => p.id);
    const wanted = (await stripIds(win)).filter((id) => placed.includes(id));
    await win.keyboard.press('Control+Shift+G');
    await win.waitForTimeout(400);
    await win.click('.gridpick-cell[data-cell="2,1"]');
    await win.waitForTimeout(800);
    const g = await geometry(win);
    check('dm: picking 3x2 reflows the four panes into a 3-column, 2-row grid, no overlap',
      g.cols === 3 && g.rows === 2 && g.panes.length === 4 && tilingProblems(g).length === 0
        && (await win.locator('.gridpick').count()) === 0,
      `${g.cols}x${g.rows}, ${g.panes.length} panes; ${tilingProblems(g).join('; ')}`);
    // Reading order, from the measured rectangles — nothing here asks the model
    // what order it used.
    const visual = g.panes.slice()
      .sort((a, b) => (Math.round(a.top / 8) - Math.round(b.top / 8)) || (a.left - b.left))
      .map((p) => p.id);
    check('dm: and it laid them out in STRIP order, reading left-to-right, top-to-bottom',
      same(visual, wanted),
      `${visual.map((s) => s.slice(0, 4)).join(',')} vs strip ${wanted.map((s) => s.slice(0, 4)).join(',')}`);
  }

  // --- 6. the terminal, after every one of those gestures --------------------
  {
    const probe = await win.evaluate(() =>
      document.querySelector('.xterm')?.dataset.ceProbe ?? null);
    // The ONLY instrument that catches a re-parent: ConPTY repaints its whole
    // screen buffer on the resize a remount triggers, so the two text checks
    // below still pass against a terminal that was destroyed and rebuilt.
    check('DIRECT MANIPULATION NEVER RE-PARENTED THE TERMINAL — same xterm instance (KAN-23)',
      probe === 'run4', String(probe));
    check('dm: and the scrollback from before the first drag is still there',
      (await termText(win)).includes(MARKER));
    await runInTerminal(win, `$t='${TAG}'; ${emit('CE-LIVE2')}`);
    await win.waitForTimeout(2200);
    check('dm: the shell still answers a new command after every drag, swap and reflow',
      (await termText(win)).includes(LIVE));
  }

  if (SHOW) await win.waitForTimeout(600_000);
  await close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
