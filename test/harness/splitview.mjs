// KAN-46 / KAN-56 integration: split view wired into the REAL app.
//   npm run build && node test/harness/splitview.mjs
//   node test/harness/splitview.mjs --show    leave the last window open to look at it
//
// test/harness/splitgrid.mjs proves the geometry module in a bare window. This
// one proves the things that module could not: that App.tsx's flat,
// always-mounted pane list survives being turned into a CSS Grid *with per-pane
// tab strips* — and that a live terminal survives being moved from one pane to
// another, which is the gesture KAN-56 exists for and the one most likely to
// re-parent an xterm.
//
// THE MODEL THIS HARNESS IS WRITTEN AGAINST (KAN-56). A pane is not "a tab": it
// is a window-like region owning an ORDERED SET of tabs and its own strip,
// showing that set's active tab. So the DOM contract is:
//
//   .content                            the one flat container, a CSS Grid when split
//     .pane[data-pane=<tabId>]          a tab's body. `top: 30px` while split, so it
//                                       starts BELOW its own strip.
//     .paneslot[data-cell="<col>,<row>"] one per CELL, same grid-area, holding only
//                                       that pane's strip. Carries `.pane-focused`.
//       .tabbar.panestrip[data-panestrip=<cell>]
//     .split-divider[data-divider=…]    seam handles
//     .drop-indicator[data-zone]        where a drop would land
//   .tabbar.spacebar                    the top bar WHILE SPLIT: chrome only, no tabs
//
// Load-bearing claims:
//
//   (a) A TERMINAL WITH REAL OUTPUT SURVIVES a split, a divider drag, a pane
//       close and — the new one — BEING DRAGGED FROM ONE PANE'S STRIP INTO
//       ANOTHER, which lands it in a different grid area. Proved with the same
//       three instruments spaces.mjs uses: a marker printed before, a DOM probe
//       planted on the .xterm ELEMENT, and a fresh command answered after. If a
//       pane is ever re-parented the xterm is disposed and rebuilt (KAN-23: a
//       rebuilt instance never sees the alt-screen sequences it missed, so the
//       TUI stops scrolling and the scrollback is gone), and the PROBE is the
//       only one of the three that catches it — ConPTY repaints its whole screen
//       buffer on the resize a remount triggers, so the text comes back without
//       any of it having survived.
//   (b) PANES TILE EXACTLY at 1x2, 2x2 and 3x3: measured rectangles, no gap and
//       no overlap beyond the 1px seam. Measured on the CELLS (`.paneslot`),
//       because a cell is now strip + body; each body is then checked to be its
//       cell minus exactly one strip height, which is the only place the two
//       copies of STRIP_PX (`splitgrid.ts` and `--panestrip-h`) can be caught
//       drifting apart.
//   (c) The layout, the PER-PANE TAB SETS, the PER-PANE ACTIVE TAB and the
//       dragged fractions all survive a restart.
//   (d) `layout: null` is today's behaviour, byte for byte: `.content` is not a
//       grid, there are no slots, strips, dividers or focus ring, exactly one
//       visible pane, and the ONE top strip carries every tab and the `+`.
//   (e) A LEGACY 0.7.0 workspace.json — cells written as `{ tabId, … }` — still
//       opens as a split, with the tabs that had no cell adopted rather than
//       stranded. (The unit-level migration lives in test/workspace.test.ts;
//       this is the end-to-end half: a real file, read by the real main process,
//       rendered by the real renderer.)
//   (f) DIRECT MANIPULATION: a tab dropped on a pane's EDGE QUARTER splits that
//       pane on that axis; on its CENTRE or on its STRIP it JOINS that pane's tab
//       set; a pane dragged onto another SWAPS them. Ctrl+Shift+G's picker
//       arranges the panes MxN in strip order, refuses the picks that cannot
//       tile, merges into a smaller grid, and Escapes with no state change.
//
// HOW THE DRAGS ARE DRIVEN, because HTML5 DnD and pointer DnD are not the same
// problem and this harness uses both:
//
//   * A PANE drag is pointer events — a press on the strip's own BACKGROUND (the
//     title-bar grab) or Alt + primary on the pane body — so Playwright's real
//     mouse drives it end to end and the DOM is readable THROUGHOUT. The
//     mid-drag `.drop-indicator` readings come from a real drag in flight.
//   * A TAB drag off a strip is HTML5 DnD. Playwright's real mouse does perform
//     it — verified: the drop lands and the layout changes — but on Windows the
//     renderer is inside Chromium's drag loop while it is in flight, so an
//     `evaluate()` sampled mid-drag reports the PRE-drag DOM. So: every tab drag
//     whose OUTCOME is under test uses the real mouse (the whole native path,
//     dragstart through drop), and the two assertions that must observe the drag
//     BEFORE release — the indicator, and the abort — dispatch DragEvents with a
//     shared DataTransfer instead. Those still run the real handlers:
//     `dragstart` is fired on the real `.tab`, so TabBar populates the
//     DataTransfer itself, and `dragover`/`drop` are fired on
//     `elementFromPoint`, so App's capture-phase handlers face the same target
//     and the same propagation the native path gives them.
//
// EVERY DRAG ASSERTION STATES THE PRE-STATE AS WELL, so a drag that silently did
// nothing fails instead of passing. That is the likeliest false positive in this
// whole feature: "the tab is in pane B" is satisfied by a tab that was already
// there, so each one also asserts it was NOT there (and was somewhere else)
// beforehand.
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

/**
 * Measured geometry of the content region, relative to its own top-left. Every
 * number here comes from getBoundingClientRect() — nothing inspects React.
 *
 * `cells` is the KAN-56 unit: one `.paneslot` per cell, carrying that pane's
 * strip, its tab ids in strip order, and which of them is active. `panes` stays
 * the tab BODIES, which are a different rectangle now (the cell minus its strip)
 * and are what a terminal actually has to fit into.
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
  const ids = (root) => [...root.querySelectorAll('.tab[data-slide]')].map((t) => t.dataset.slide);
  const top = document.querySelector('.tabbar:not(.panestrip)');
  return {
    content: { width: box.width, height: box.height },
    display: cs.display,
    cols: tracks(cs.gridTemplateColumns),
    rows: tracks(cs.gridTemplateRows),
    colTemplate: cs.gridTemplateColumns,
    dividers: document.querySelectorAll('.split-divider').length,
    focusRings: document.querySelectorAll('.pane-focused').length,
    slots: document.querySelectorAll('.paneslot').length,
    strips: document.querySelectorAll('.panestrip').length,
    xterms: document.querySelectorAll('.xterm').length,
    // The top bar. While split it is `.tabbar.spacebar` with chrome only.
    topTabs: top ? ids(top) : null,
    topAdd: !!top?.querySelector('.tab.add'),
    cells: [...document.querySelectorAll('.paneslot')].map((s) => ({
      key: s.dataset.cell,
      focused: s.classList.contains('pane-focused'),
      tabs: ids(s),
      active: s.querySelector('.tab.active[data-slide]')?.dataset.slide ?? null,
      stripH: s.querySelector('.panestrip').getBoundingClientRect().height,
      ...rel(s.getBoundingClientRect()),
    })),
    panes: [...document.querySelectorAll('.pane:not([hidden])')].map((p) => ({
      id: p.dataset.pane,
      ...rel(p.getBoundingClientRect()),
      // The inner element is height:100% of the pane — a percentage that only
      // resolves if the pane got a DEFINITE box out of the grid. That is exactly
      // Terminal.tsx's precondition for fit(): it bails on a zero clientHeight.
      inner: rel((p.firstElementChild ?? p).getBoundingClientRect()),
    })),
  };
});

/** The boxes that must tile the container: the CELLS when split, the single
 *  pane when not. */
const tiles = (g) => (g.cells.length
  ? g.cells.map((c) => ({ id: c.key, ...c }))
  : g.panes);

/**
 * Tiling: every cell covers its share of the content box with no gap and no
 * overlap. Checked as an AREA sum plus a pairwise overlap test rather than by
 * reconstructing the grid — that way the assertion cannot agree with the
 * implementation by sharing its arithmetic.
 *
 * Then the KAN-56 half: each cell's ACTIVE tab must have a body that is exactly
 * that cell minus ONE strip height. That is the only assertion that can catch
 * `STRIP_PX` (splitgrid.ts, used to build the pane's inline style) drifting
 * from `--panestrip-h` (index.css, which sizes the strip element) — the two are
 * deliberately duplicated and marked `ponytail:` in the source.
 */
function tilingProblems(g) {
  const bad = [];
  const seam = 1;
  const boxes = tiles(g);
  const area = boxes.reduce((n, p) => n + p.width * p.height, 0);
  const expect = g.content.width * g.content.height;
  // The seams belong to no pane: (cols-1) vertical + (rows-1) horizontal gutters.
  const gutter = (g.cols - 1) * seam * g.content.height
    + (g.rows - 1) * seam * g.content.width
    - (g.cols - 1) * (g.rows - 1) * seam * seam;
  if (Math.abs(area - (expect - gutter)) > expect * 0.01) {
    bad.push(`area ${Math.round(area)} vs ${Math.round(expect - gutter)}`);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]; const b = boxes[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > EPS && oy > EPS) bad.push(`${a.id}/${b.id} overlap ${ox.toFixed(1)}x${oy.toFixed(1)}`);
    }
  }
  for (const p of boxes) {
    if (p.width < 2 || p.height < 2) bad.push(`${p.id} collapsed ${p.width}x${p.height}`);
  }
  for (const c of g.cells) {
    const body = g.panes.find((p) => p.id === c.active);
    if (!body) { bad.push(`cell ${c.key} shows nothing`); continue; }
    if (Math.abs(body.left - c.left) > EPS || Math.abs(body.width - c.width) > EPS
      || Math.abs(body.top - (c.top + c.stripH)) > EPS
      || Math.abs(body.height - (c.height - c.stripH)) > EPS) {
      bad.push(`cell ${c.key} body ${[body.left, body.top, body.width, body.height].map(Math.round)}`
        + ` != cell ${[c.left, c.top, c.width, c.height].map(Math.round)} minus ${Math.round(c.stripH)}px strip`);
    }
  }
  for (const p of g.panes) {
    if (Math.abs(p.inner.height - p.height) > EPS || Math.abs(p.inner.width - p.width) > EPS) {
      bad.push(`${p.id} inner ${p.inner.width.toFixed(1)}x${p.inner.height.toFixed(1)} != pane`);
    }
  }
  return bad;
}

// --- reading the model off the DOM -----------------------------------------

/** The cell holding `tabId`, or null. Exactly one, by the model's invariant —
 *  which `paneOwnership` below is what actually checks. */
const cellWith = (g, tabId) => g.cells.find((c) => c.tabs.includes(tabId)) ?? null;

/** Every tab id on any strip, in reading order of the cells. */
const allStripIds = (g) => (g.cells.length
  ? [...g.cells].sort((a, b) => a.top - b.top || a.left - b.left).flatMap((c) => c.tabs)
  : (g.topTabs ?? []));

/**
 * "A tab is in EXACTLY ONE cell" — the invariant the whole model rests on, as
 * a list of violations. A tab in NO cell is unreachable (it renders nowhere and
 * no strip lists it); a tab in TWO would give one terminal two hosts.
 */
function paneOwnership(g, expectIds) {
  const bad = [];
  const seen = new Map();
  for (const c of g.cells) for (const id of c.tabs) seen.set(id, (seen.get(id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) bad.push(`${id.slice(0, 4)} in ${n} panes`);
  for (const id of expectIds) if (!seen.has(id)) bad.push(`${id.slice(0, 4)} in no pane`);
  for (const id of seen.keys()) if (!expectIds.includes(id)) bad.push(`${id.slice(0, 4)} is not a member`);
  for (const c of g.cells) if (!c.tabs.length) bad.push(`cell ${c.key} is empty`);
  return bad;
}

/**
 * A layout's SHAPE, keyed by pane IDENTITY rather than by grid anchor — the unit
 * of "nothing changed".
 *
 * Keyed by the pane's tab set, deliberately: a cell's key IS its anchor, so a
 * swap exchanges two panes' rectangles AND their keys, and a key->rect map comes
 * back identical from a swap that really happened. Keying by content cannot be
 * fooled that way, and is stable across a strip reorder because the set is
 * sorted.
 */
const shape = (g) => Object.fromEntries((g.cells.length ? g.cells : g.panes).map((b) => [
  b.tabs ? [...b.tabs].sort().join('|') : b.id,
  [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Per-cell tab sets and active tab, keyed by pane identity — what a restart has
 *  to reproduce. */
const tabSets = (g) => Object.fromEntries(g.cells.map((c) => [
  [...c.tabs].sort().join('|'), { order: c.tabs.join(','), active: c.active },
]));

// --- driving the app --------------------------------------------------------

async function menuOn(win, tabId, itemText) {
  await win.locator(`.tab[data-slide="${tabId}"]`).click({ button: 'right' });
  await win.waitForTimeout(250);
  await win.locator('.ctx-item', { hasText: itemText }).first().click();
  await win.waitForTimeout(700);
}

/** The labels the tab context menu is offering for `tabId`. */
async function menuItemsOn(win, tabId) {
  await win.locator(`.tab[data-slide="${tabId}"]`).click({ button: 'right' });
  await win.waitForTimeout(250);
  const items = (await win.locator('.ctx-item').allTextContents()).map((t) => t.trim());
  // The menu closes on a backdrop click, not on Escape (ContextMenu.tsx).
  await win.locator('.ctx-backdrop').click({ position: { x: 4, y: 4 } });
  await win.waitForTimeout(200);
  return items;
}

/** Terminal text from ONE tab's pane — scoped by id, because a split routinely
 *  has two live shells on screen and `.pane .xterm-rows` would read whichever
 *  is first in the DOM. NOT scoped to `:not([hidden])`: half the point is
 *  reading a pane while something else has focus. */
const termText = (win, tabId) =>
  win.$eval(`[data-pane="${tabId}"] .xterm-rows`, (el) => el.textContent);

/** The DOM probe planted on an xterm ELEMENT. `null` means the element the
 *  attribute was set on is gone — i.e. Terminal.tsx unmounted and rebuilt it. */
const probeOf = (win, tabId) => win.evaluate(
  (id) => document.querySelector(`[data-pane="${id}"] .xterm`)?.dataset.ceProbe ?? null, tabId,
);

async function runInTerminal(win, tabId, line) {
  await win.locator(`[data-pane="${tabId}"] .xterm-screen`).click();
  await win.waitForTimeout(200);
  await win.keyboard.type(line);
  await win.waitForTimeout(200);
  await win.keyboard.press('Enter');
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

/** Drag tab `tabId` off its strip to a client point — REAL mouse, so this is
 *  the whole native HTML5 path: Chromium starts the drag, TabBar's onDragStart
 *  fills the DataTransfer, and either App's capture handlers or the destination
 *  strip's own handlers take the drop. */
async function dragTabTo(win, tabId, pt) {
  const t = await win.locator(`.tab[data-slide="${tabId}"]`).boundingBox();
  await win.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await win.mouse.down();
  await win.mouse.move(t.x + t.width / 2 + 24, t.y + t.height / 2 + 10); // clear the press threshold
  await win.waitForTimeout(150);
  await win.mouse.move(pt.x, pt.y, { steps: 8 });
  await win.waitForTimeout(250);
  await win.mouse.up();
  await win.waitForTimeout(900);
}

/**
 * A point on a pane strip's own BACKGROUND — the title-bar grab.
 *
 * TabBar arms the pane drag only when `e.target === e.currentTarget`, so this
 * also reports whether the point really hits the strip itself (`ok`); a strip
 * too full of tabs to have any background left has no grab area at all, which
 * is documented behaviour, not a bug.
 */
const stripGrab = (win, cell) => win.evaluate((key) => {
  const strip = document.querySelector(`.paneslot[data-cell="${key}"] .panestrip`);
  if (!strip) return null;
  const r = strip.getBoundingClientRect();
  const plus = strip.querySelector('.tab.add').getBoundingClientRect();
  const x = (plus.right + r.right) / 2;
  const y = r.top + r.height / 2;
  return { x, y, ok: document.elementFromPoint(x, y) === strip };
}, cell);

/** Drag a whole PANE to a client point, by whichever grab `how` names. Pointer
 *  events either way, so the indicator is readable while the drag is still in
 *  flight — returned, because "the target rect was shown before release" is
 *  only provable from mid-drag. */
async function dragPane(win, from, pt) {
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move(from.x + 12, from.y + 8); // past PANE_DRAG_PX
  await win.waitForTimeout(150);
  await win.mouse.move(pt.x, pt.y, { steps: 8 });
  await win.waitForTimeout(250);
  const mid = await indicator(win);
  await win.mouse.up();
  await win.waitForTimeout(900);
  return mid;
}

/** Alt + the pane BODY — the second entry, for a strip that is scrolled or
 *  covered. */
async function dragPaneByBody(win, tabId, pt) {
  const b = await paneBox(win, tabId);
  await win.keyboard.down('Alt');
  const mid = await dragPane(win, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, pt);
  await win.keyboard.up('Alt');
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
const MOVED = `CE-MOVED-${TAG}`;
const ALIVE = `CE-ALIVE-${TAG}`;
const emit = (prefix) => `Write-Host ('${prefix}-'+$t)`;
const say = (prefix) => `$t='${TAG}'; ${emit(prefix)}`;

// ===========================================================================
// Run 1 — (d) the untouched single-pane path, then (a), (b) and the KAN-56
// per-pane strips, all against ONE live shell.
// ===========================================================================
{
  const { win, close } = await launchApp({ userDataDir: PROFILE });
  await win.waitForSelector('.entry');
  await win.waitForTimeout(600);

  // --- (d) layout: null is exactly what it always was ----------------------
  {
    const g = await geometry(win);
    check('layout:null — .content is NOT a grid', g.display !== 'grid', g.display);
    check('layout:null — no pane slots, no pane strips, no dividers, no focus ring',
      g.slots === 0 && g.strips === 0 && g.dividers === 0 && g.focusRings === 0,
      `${g.slots} slots, ${g.strips} strips, ${g.dividers} dividers, ${g.focusRings} rings`);
    check('layout:null — exactly one visible pane, filling the content box',
      g.panes.length === 1
        && Math.abs(g.panes[0].width - g.content.width) < EPS
        && Math.abs(g.panes[0].height - g.content.height) < EPS,
      `${g.panes.length} panes, ${JSON.stringify(g.content)}`);
    check('layout:null — the ONE top strip carries every tab and the `+`',
      g.topTabs?.length === 1 && g.topAdd, `${g.topTabs?.length} tabs, add: ${g.topAdd}`);
    const items = await menuItemsOn(win, g.topTabs[0]);
    check('layout:null — a lone tab offers no split and no "Close pane"',
      !items.includes('Split right') && !items.includes('Close pane'), items.join(' | '));
  }

  // Two tabs: a files tab (restored) and a real PowerShell.
  const filesId = (await geometry(win)).topTabs[0];
  await menuOn(win, filesId, 'Open Terminal');
  await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 20_000 });
  await win.waitForTimeout(1500);
  const termId = (await geometry(win)).topTabs.find((id) => id !== filesId);
  check('a terminal tab is open beside the files tab',
    (await geometry(win)).topTabs.length === 2 && !!termId);

  await runInTerminal(win, termId, say('CE-MARK'));
  await win.waitForTimeout(1500);
  check('the shell printed a marker before anything was split',
    (await termText(win, termId)).includes(MARKER));

  // Plant a probe on the xterm ELEMENT. Terminal.tsx builds it inside an effect
  // and disposes it on unmount, so this attribute surviving means the very same
  // instance — and therefore the very same scrollback buffer — is still there.
  await win.evaluate((id) => {
    document.querySelector(`[data-pane="${id}"] .xterm`).dataset.ceProbe = 'run1';
  }, termId);

  // --- (b) the first split, and (KAN-56) the per-pane strips ---------------
  // "Split right" MOVES the files tab out of the one implicit pane into a new
  // one on the right, leaving the terminal in the original.
  await menuOn(win, filesId, 'Split right');
  await win.waitForTimeout(900);
  {
    const g = await geometry(win);
    check('split right — .content became a 2-column grid with two cells',
      g.display === 'grid' && g.cols === 2 && g.rows === 1 && g.cells.length === 2,
      `${g.display} ${g.cols}x${g.rows}, ${g.cells.length} cells`);
    check('split right — the cells tile the content box exactly (1x2)',
      tilingProblems(g).length === 0, tilingProblems(g).join('; '));
    check('split right — one divider, on the seam', g.dividers === 1, String(g.dividers));
    check('split right — exactly one pane wears the clay ring, and it is a .paneslot',
      g.focusRings === 1 && g.cells.filter((c) => c.focused).length === 1,
      `${g.focusRings} rings`);
    check('split right — the terminal is STILL MOUNTED and now sharing the screen',
      g.xterms === 1 && !!cellWith(g, termId), `${g.xterms} xterms`);

    // THE HEADLINE STRUCTURE: a pane owns its own tabs and draws its own strip.
    const ct = cellWith(g, termId);
    const cf = cellWith(g, filesId);
    check('EVERY PANE HAS ITS OWN STRIP, listing exactly its own tabs',
      g.strips === 2 && !!ct && !!cf && ct.key !== cf.key
        && same(ct.tabs, [termId]) && same(cf.tabs, [filesId]),
      `${g.strips} strips: ${g.cells.map((c) => `${c.key}=[${c.tabs.length}]`).join(' ')}`);
    check('and every tab is in EXACTLY ONE pane (a tab in none is unreachable)',
      paneOwnership(g, [filesId, termId]).length === 0,
      paneOwnership(g, [filesId, termId]).join('; '));
    check('while split the TOP bar keeps its chrome and lists NO tabs',
      g.topTabs?.length === 0 && !g.topAdd, `${g.topTabs?.length} tabs, add: ${g.topAdd}`);
    check('the pane on the right is the one the split moved the tab into',
      cf.left > ct.left + EPS, `files@${Math.round(cf.left)} term@${Math.round(ct.left)}`);
  }

  // (a) — the buffer, across the split.
  check('SPLIT DID NOT RE-PARENT THE TERMINAL — same xterm instance (KAN-23)',
    (await probeOf(win, termId)) === 'run1', String(await probeOf(win, termId)));
  check('and the text it printed before the split is back on screen (a repaint, not proof of survival)',
    (await termText(win, termId)).includes(MARKER));

  // --- a per-pane `+` opens into THAT pane ---------------------------------
  let extraId;
  {
    const g0 = await geometry(win);
    const target = cellWith(g0, termId);   // the pane WITHOUT focus right now
    const other = g0.cells.find((c) => c.key !== target.key);
    await win.locator(`.paneslot[data-cell="${target.key}"] .tab.add`).click();
    await win.waitForTimeout(1000);
    const g = await geometry(win);
    const now = g.cells.find((c) => c.key === target.key);
    const rest = g.cells.find((c) => c.key === other.key);
    extraId = now?.tabs.find((id) => !target.tabs.includes(id));
    check("a pane's own `+` opens the new tab INTO THAT PANE, and focuses it",
      target.tabs.length === 1 && !target.focused
        && !!now && now.tabs.length === 2 && !!extraId
        && now.active === extraId && now.focused
        && g.cells.length === 2,
      `${target.key}: ${target.tabs.length} -> ${now?.tabs.length}, active ${now?.active === extraId}`);
    check('and the OTHER pane is untouched — the `+` is per pane, not global',
      same(rest?.tabs, other.tabs), `${other.tabs.length} -> ${rest?.tabs.length}`);
  }

  // --- a tab opened FROM a tab joins THAT tab's pane (auto-link placement) --
  let shellId;
  {
    const g0 = await geometry(win);
    const host = cellWith(g0, filesId);        // NOT the focused pane
    await menuOn(win, filesId, 'Open Terminal');
    await win.waitForSelector(`.paneslot[data-cell="${host.key}"] .tab[data-slide]:nth-of-type(2)`, { timeout: 20_000 }).catch(() => {});
    await win.waitForTimeout(1800);
    const g = await geometry(win);
    const now = g.cells.find((c) => c.key === host.key);
    shellId = now?.tabs.find((id) => !host.tabs.includes(id));
    check("a tab opened FROM another tab joins THAT tab's pane, not the focused one",
      !host.focused && host.tabs.length === 1 && !!shellId
        && now.tabs.length === 2 && g.cells.length === 2,
      `${host.key}: [${host.tabs.length}] -> [${now?.tabs.length}]`);
  }

  // =========================================================================
  // THE HEADLINE GESTURE: drag the live terminal's tab from pane A's strip into
  // pane B's, and prove the xterm was never rebuilt.
  //
  // The destination point is the LEFT end of B's strip, left of the first tab's
  // centre, so the insert index is 0 — which also proves TabBar's adopt index is
  // measured rather than appended.
  // =========================================================================
  {
    // Show the terminal in its own pane first, so its body has a rectangle to
    // compare against afterwards (the `+` above left a sibling tab showing).
    await win.locator(`.tab[data-slide="${termId}"]`).click();
    await win.waitForTimeout(600);
    const g0 = await geometry(win);
    const from = cellWith(g0, termId);
    const to = g0.cells.find((c) => c.key !== from.key);
    const paneBefore = g0.panes.find((p) => p.id === termId);
    const dst = await win.locator(`.paneslot[data-cell="${to.key}"] .panestrip`).boundingBox();
    const firstTab = await win.locator(`.paneslot[data-cell="${to.key}"] .tab[data-slide]`).first().boundingBox();

    await dragTabTo(win, termId, { x: firstTab.x + 3, y: dst.y + dst.height / 2 });
    const g = await geometry(win);
    const nowFrom = g.cells.find((c) => c.key === from.key);
    const nowTo = g.cells.find((c) => c.key === to.key);
    const paneAfter = g.panes.find((p) => p.id === termId);

    // PRE and POST in one assertion: "the terminal is in pane B" is satisfied by
    // a drag that never happened if it was already there, so the pre-state is
    // part of the claim.
    check('CROSS-PANE STRIP DROP — the tab left pane A and joined pane B',
      from.tabs.includes(termId) && !to.tabs.includes(termId)
        && !!nowTo && nowTo.tabs.includes(termId)
        && !!nowFrom && !nowFrom.tabs.includes(termId),
      `${from.key}[${from.tabs.length}->${nowFrom?.tabs.length}] `
      + `${to.key}[${to.tabs.length}->${nowTo?.tabs.length}]`);
    check('and it landed at the insert index the pointer named (index 0, not appended)',
      nowTo?.tabs[0] === termId, nowTo?.tabs.map((s) => s.slice(0, 4)).join(','));
    check('the destination pane now SHOWS it, and pane A still has a tab of its own',
      nowTo?.active === termId && nowFrom?.tabs.length >= 1 && !!nowFrom?.active,
      `${nowTo?.active === termId}, A has ${nowFrom?.tabs.length}`);
    // A STRIP drop must beat the edge quarter it sits inside: had the drop
    // reached the pane area, `dropZone` would have returned `edge:…:top` and the
    // grid would have grown a third cell.
    // Includes "the tab really moved", deliberately: `the grid still has two
    // cells` is also true of a drop that never happened, and an assertion that
    // a no-op satisfies can never go red.
    check('the strip beat the edge quarter under it — the drop JOINED, it did not split',
      nowTo?.tabs.includes(termId) && g.cells.length === 2 && g.cols === 2 && g.rows === 1,
      `${g.cols}x${g.rows}, ${g.cells.length} cells`);
    check('every tab is still in exactly one pane after the move',
      paneOwnership(g, [filesId, termId, extraId, shellId]).length === 0,
      paneOwnership(g, [filesId, termId, extraId, shellId]).join('; '));
    check("the terminal's pane element really moved to the other cell's rectangle",
      !!paneAfter && Math.abs(paneAfter.left - paneBefore.left) > 50
        && Math.abs(paneAfter.left - nowTo.left) < EPS,
      `${Math.round(paneBefore.left)} -> ${Math.round(paneAfter?.left)}`);
    check('the panes still tile exactly after the cross-pane move',
      tilingProblems(g).length === 0, tilingProblems(g).join('; '));

    // THE claim. ConPTY repaints its whole screen buffer on the resize a remount
    // triggers, so the text checks below pass against a terminal that was
    // destroyed and rebuilt; only the element probe catches that.
    check('THE MOVE DID NOT RE-PARENT THE TERMINAL — same xterm instance (KAN-23)',
      (await probeOf(win, termId)) === 'run1', String(await probeOf(win, termId)));
    check('and the text it printed before the move is back on screen (a repaint, not proof of survival)',
      (await termText(win, termId)).includes(MARKER));
    await runInTerminal(win, termId, say('CE-MOVED'));
    await win.waitForTimeout(2200);
    check('THE TERMINAL IS STILL RUNNING — the same shell answers a new command in its new pane',
      (await termText(win, termId)).includes(MOVED));
  }

  // --- closing the last tab in a pane closes the pane, and leaves no hole ---
  {
    // Three panes first, so the closure has a hole to fail to fill: with two,
    // the layout would legitimately collapse to `layout: null` instead.
    const g0 = await geometry(win);
    const donor = g0.cells.find((c) => c.tabs.length >= 2 && c.tabs.some((id) => id !== termId));
    const victim = donor.tabs.find((id) => id !== termId);
    await menuOn(win, victim, 'Split down');
    await win.waitForTimeout(900);
    const g1 = await geometry(win);
    check('a third pane, split out of a two-tab strip, still tiles exactly',
      g1.cells.length === 3 && tilingProblems(g1).length === 0,
      `${g1.cols}x${g1.rows}, ${g1.cells.length} cells; ${tilingProblems(g1).join('; ')}`);

    const lone = cellWith(g1, victim);
    check('the pane the split created holds exactly the tab that was split out',
      same(lone.tabs, [victim]), lone.tabs.map((s) => s.slice(0, 4)).join(','));

    // Close it from its own strip's ×.
    await win.locator(`.paneslot[data-cell="${lone.key}"] .tab[data-slide="${victim}"] .close`).click();
    await win.waitForTimeout(900);
    const g2 = await geometry(win);
    check("CLOSING A PANE'S LAST TAB closes the pane, and the rest tile with no hole",
      g1.cells.length === 3 && g2.cells.length === 2 && tilingProblems(g2).length === 0,
      `${g1.cells.length} -> ${g2.cells.length} cells; ${tilingProblems(g2).join('; ')}`);
    check('and the tab it closed is gone from every strip',
      !allStripIds(g2).includes(victim) && allStripIds(g1).includes(victim));
    check('nothing else was closed — the survivors are exactly the other tabs',
      same([...allStripIds(g2)].sort(), [filesId, termId, extraId, shellId].filter((id) => id !== victim).sort()),
      allStripIds(g2).map((s) => s.slice(0, 4)).join(','));
  }

  // --- the divider drag ----------------------------------------------------
  {
    const before = await geometry(win);
    await dragDivider(win, 0, -150, 0);
    const dragged = await geometry(win);
    const was = shape(before);
    const now = shape(dragged);
    const moved = Object.keys(was).filter((k) => now[k] && Math.abs(now[k][2] - was[k][2]) > 80);
    check('dragging the divider actually resized the panes',
      moved.length >= 1, `${moved.length} panes changed width by >80px`);
    check('and they still tile exactly after the drag',
      tilingProblems(dragged).length === 0, tilingProblems(dragged).join('; '));
    check('DRAG DID NOT RE-PARENT THE TERMINAL — same xterm instance',
      (await probeOf(win, termId)) === 'run1', String(await probeOf(win, termId)));
    check('and the text from before the drag is back on screen (a repaint, not proof of survival)',
      (await termText(win, termId)).includes(MARKER));

    // The refit claim: the terminal re-fitted to its new box. xterm writes the
    // measured column count onto its own screen element.
    const rowsW = await win.evaluate((id) => {
      const rows = document.querySelector(`[data-pane="${id}"] .xterm-rows`);
      return rows ? parseFloat(getComputedStyle(rows).width) : 0;
    }, termId);
    const paneW = dragged.panes.find((p) => p.id === termId)?.width ?? 0;
    check('the terminal re-fitted to the resized pane (its rows are no wider than the pane)',
      rowsW > 0 && rowsW <= paneW + EPS, `rows ${rowsW.toFixed(0)}px in a ${paneW.toFixed(0)}px pane`);
  }

  await runInTerminal(win, termId, say('CE-ALIVE'));
  await win.waitForTimeout(2200);
  check('the shell still answers a new command after the split, the move and the drag',
    (await termText(win, termId)).includes(ALIVE));

  // --- freeze the state the restart has to reproduce ------------------------
  {
    const g = await geometry(win);
    check('the pre-restart drag left an UNEVEN grid (so the restart has something to prove)',
      !/^(\S+)( \1)+$/.test(g.colTemplate.trim()), g.colTemplate);
    fs.writeFileSync(path.join(PROFILE, 'expect.json'), JSON.stringify({
      cols: g.cols, rows: g.rows, content: g.content, template: g.colTemplate,
      shape: shape(g), sets: tabSets(g), rings: g.focusRings,
    }));
  }

  await win.waitForTimeout(1600); // 400ms persist debounce + margin
  await close();
}

// ===========================================================================
// Run 2 — (c) same profile, fresh process: layout, per-pane tab sets, per-pane
// active tab AND fractions all came back.
// ===========================================================================
{
  const expected = JSON.parse(fs.readFileSync(path.join(PROFILE, 'expect.json'), 'utf8'));
  const { win, close } = await launchApp({ userDataDir: PROFILE });
  await win.waitForSelector('.paneslot');
  await win.waitForTimeout(2500);

  const g = await geometry(win);
  check('the split layout survived the restart — same grid, same cell count',
    g.cols === expected.cols && g.rows === expected.rows
      && g.cells.length === Object.keys(expected.shape).length,
    `${g.cols}x${g.rows} ${g.cells.length} cells, wanted ${expected.cols}x${expected.rows} ${Object.keys(expected.shape).length}`);
  check('and it still tiles exactly', tilingProblems(g).length === 0, tilingProblems(g).join('; '));

  // Every terminal in the split had to be respawned to fill its pane; if one
  // did not, its cell shows nothing and the tiling check above says so.
  check('every restored pane is on screen, none left as an empty grid cell',
    g.panes.every((p) => p.inner.width > 2 && p.inner.height > 2),
    g.panes.map((p) => `${p.id.slice(0, 4)}:${p.inner.width.toFixed(0)}x${p.inner.height.toFixed(0)}`).join(' '));

  // Keyed by the pane's TAB SET, so this cannot be satisfied by a same-shaped
  // grid with the panes shuffled — which a bare cols/rows count would accept.
  const now = shape(g);
  const off = Object.entries(expected.shape)
    .map(([k, w]) => {
      const r = now[k];
      if (!r) return `pane [${k.split('|').map((s) => s.slice(0, 4)).join(',')}] is not a pane any more`;
      return r.some((v, i) => Math.abs(v - w[i]) > 3) ? `${k.slice(0, 4)} ${r} vs ${w}` : null;
    })
    .filter(Boolean);
  check('THE DRAGGED FRACTIONS SURVIVED — every pane came back in its own rectangle',
    off.length === 0, off.join('; '));
  check('and the restored template is the dragged one, not an even split',
    !/^(\S+)( \1)+$/.test(g.colTemplate.trim()), g.colTemplate);

  const sets = tabSets(g);
  const setsOff = Object.entries(expected.sets)
    .map(([k, w]) => {
      const r = sets[k];
      if (!r) return `pane [${k.split('|').map((s) => s.slice(0, 4)).join(',')}] lost its tab set`;
      if (r.order !== w.order) return `strip order ${r.order.slice(0, 20)} vs ${w.order.slice(0, 20)}`;
      return null;
    })
    .filter(Boolean);
  check('PER-PANE TAB SETS survived the restart — each pane got its own tabs back, in order',
    Object.keys(sets).length === Object.keys(expected.sets).length && setsOff.length === 0,
    setsOff.join('; '));
  const activeOff = Object.entries(expected.sets)
    .filter(([k, w]) => sets[k] && sets[k].active !== w.active)
    .map(([k]) => k.slice(0, 4));
  check('PER-PANE ACTIVE TAB survived too — each pane is showing what it was showing',
    activeOff.length === 0, activeOff.join(','));
  check('and exactly one pane wears the focus ring after the restart',
    g.focusRings === 1, String(g.focusRings));

  await close();
}

// ===========================================================================
// Run 3 — (b) the exact grids the requirement names, and (e) the 0.7.0 file.
//
// Seeded through a real workspace.json rather than clicked into existence,
// because the split ACTIONS cannot produce every one of them: splitting a pane
// that spans two rows costs a third row rather than cutting its neighbours in
// half (see gridlayout.splitCell). A layout is persisted state, so a
// hand-written one is a case the app genuinely has to render — and it is the
// only way to measure a true NxN in the real app rather than in a stand-in
// window.
// ===========================================================================
const seed = (name, doc) => {
  const profile = path.join(os.tmpdir(), `claude-explorer-splitview-${name}-${process.pid}`);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'workspace.json'), JSON.stringify(doc, null, 2));
  return profile;
};

for (const [cols, rows] of [[2, 1], [2, 2], [3, 3]]) {
  const home = os.homedir();
  const tabs = [];
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = `t-${c}-${r}`;
      tabs.push({ id, view: 'files', cwd: home, title: `${c},${r}` });
      cells.push({ tabIds: [id], activeTabId: id, col: c, row: r, colSpan: 1, rowSpan: 1 });
    }
  }
  const profile = seed(`${cols}x${rows}`, {
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
  });

  const { win, close } = await launchApp({ userDataDir: profile });
  await win.waitForSelector('.paneslot');
  await win.waitForTimeout(1800);

  const g = await geometry(win);
  const bad = tilingProblems(g);
  check(`${cols}x${rows} — ${cols * rows} panes tile the content box exactly, no gap, no overlap`,
    g.cols === cols && g.rows === rows && g.cells.length === cols * rows && bad.length === 0,
    `${g.cols}x${g.rows}, ${g.cells.length} cells; ${bad.join('; ')}`);
  // One handle per interior grid line: in a grid of 1x1 cells every interior
  // line is a boundary along its whole length, so it is one contiguous run and
  // splitgrid.dividers() emits a single full-length handle for it.
  check(`${cols}x${rows} — ${(cols - 1) + (rows - 1)} draggable seams, one per interior grid line`,
    g.dividers === (cols - 1) + (rows - 1), `${g.dividers} handles`);
  check(`${cols}x${rows} — every pane draws its own strip, and exactly one wears the ring`,
    g.strips === cols * rows && g.focusRings === 1 && g.topTabs?.length === 0,
    `${g.strips} strips, ${g.focusRings} rings, ${g.topTabs?.length} top tabs`);

  if (SHOW && cols === 3) { await win.waitForTimeout(600_000); }
  await close();
}

// --- (e) a LITERAL 0.7.0 workspace.json ------------------------------------
// Shipped 0.7.0 wrote cells as `{ tabId, col, row, colSpan, rowSpan }` — no
// `tabIds`, no `activeTabId` — and its spaces routinely held far more tabs than
// cells, because a member with no cell was a legal (if unreachable) state then.
// Read against the KAN-56 shape without a migration, `tabIds.includes(c.tabId)`
// is `includes(undefined)` for every cell, every cell is dropped, and the split
// of every existing user silently collapses to `layout: null`. This is the
// end-to-end half of that guard.
{
  const home = os.homedir();
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const profile = seed('legacy070', {
    version: 1,
    groups: [],
    tabs: ids.map((id) => ({ id, view: 'files', cwd: home, title: id.toUpperCase() })),
    spaces: [{
      id: 'space-070', name: 'Space',
      tabIds: ids,
      activeTabId: 'a',
      layout: {
        cols: 2,
        rows: 1,
        cells: [
          { tabId: 'a', col: 0, row: 0, colSpan: 1, rowSpan: 1 },
          { tabId: 'b', col: 1, row: 0, colSpan: 1, rowSpan: 1 },
        ],
      },
    }],
    activeSpaceId: 'space-070',
  });

  const { win, close } = await launchApp({ userDataDir: profile });
  await win.waitForSelector('.pane:not([hidden])');
  await win.waitForTimeout(1800);

  const g = await geometry(win);
  check('0.7.0 file — the split SURVIVED the upgrade (without a migration it collapses to layout:null)',
    g.display === 'grid' && g.cells.length === 2 && g.cols === 2 && g.rows === 1,
    `${g.display} ${g.cols}x${g.rows}, ${g.cells.length} cells`);
  const ca = cellWith(g, 'a');
  const cb = cellWith(g, 'b');
  check('0.7.0 file — the tabs that had no cell were ADOPTED, not stranded off screen',
    !!ca && !!cb && same(ca.tabs, ['a', 'c', 'd', 'e', 'f']) && same(cb.tabs, ['b']),
    `${ca?.tabs.join(',')} | ${cb?.tabs.join(',')}`);
  check('0.7.0 file — every tab is reachable from exactly one strip, and the grid tiles',
    paneOwnership(g, ids).length === 0 && tilingProblems(g).length === 0,
    `${paneOwnership(g, ids).join('; ')} ${tilingProblems(g).join('; ')}`);

  await close();
}

// ===========================================================================
// Run 4 — (f) direct manipulation, with a live terminal in the grid.
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

  let homeId = (await geometry(win)).topTabs[0];
  await menuOn(win, homeId, 'Open Terminal');
  await win.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 20_000 });
  await win.waitForTimeout(1500);
  const termId = (await geometry(win)).topTabs.find((id) => id !== homeId);
  await runInTerminal(win, termId, say('CE-MARK'));
  await win.waitForTimeout(1500);
  check('dm: the shell printed a marker before any direct manipulation',
    (await termText(win, termId)).includes(MARKER));
  await win.evaluate((id) => {
    document.querySelector(`[data-pane="${id}"] .xterm`).dataset.ceProbe = 'run4';
  }, termId);

  // Five tabs while `layout` is still null, so every one of them exists before
  // the first pane does.
  for (let i = 0; i < 3; i++) { await win.click('.tab.add'); await win.waitForTimeout(500); }

  // The pane to aim at is whichever tab is SHOWING — with no layout only the
  // active tab has a `.pane` element at all, and `+` focuses what it opens.
  const g5 = await geometry(win);
  const ids = g5.topTabs;
  homeId = g5.panes[0].id;
  const spare = ids.filter((id) => id !== termId && id !== homeId);
  check('dm: five tabs on one strip, no grid yet',
    ids.length === 5 && spare.length === 3 && g5.display !== 'grid');

  // --- 1. a tab dropped on an EDGE QUARTER splits that pane -----------------
  {
    const g0 = await geometry(win);
    const pre = g0.panes.length === 1 && g0.display !== 'grid' && g0.cells.length === 0;
    await dragTabTo(win, termId, edgePoint(await paneBox(win, homeId), 'right'));
    const g = await geometry(win);
    const home = cellWith(g, homeId);
    const term = cellWith(g, termId);
    check('dm: RIGHT quarter — a tab dragged onto the only pane creates the first split',
      pre && g.display === 'grid' && g.cols === 2 && g.rows === 1 && g.cells.length === 2,
      `pre-state ok: ${pre}; now ${g.display} ${g.cols}x${g.rows}, ${g.cells.length} cells`);
    check('dm: RIGHT quarter — the dropped tab landed ALONE in the NEW cell, on the right',
      !!term && !!home && same(term.tabs, [termId])
        && term.left > home.left + EPS && Math.abs(term.left - home.right) <= 2
        && tilingProblems(g).length === 0,
      `${term?.tabs.length} tabs in the new cell; ${tilingProblems(g).join('; ')}`);
    check('dm: and the pane it was cut out of kept every other tab',
      same(home?.tabs, ids.filter((id) => id !== termId)),
      home?.tabs.map((s) => s.slice(0, 4)).join(','));
  }

  // --- 2. the indicator paints the target rect BEFORE release ---------------
  // Dispatched events, not the real mouse: see the header. The rect it must
  // paint is the half of the target pane the drop would take — not the whole
  // pane, which is what a centre drop paints, so the two cannot be confused.
  {
    const g = await geometry(win);
    const home = cellWith(g, homeId);
    const body = g.panes.find((p) => p.id === home.active);
    const before = await indicator(win);
    const mid = await syntheticTabDrag(win, spare[0], edgePoint(await paneBox(win, home.active), 'right'), false);
    const after = await indicator(win);
    check('dm: nothing is painted until a drag is over the pane area',
      !before.shown && before.zone === '', `${before.zone}/${before.shown}`);
    check('dm: mid-drag the indicator names the zone it would drop into',
      mid.shown && mid.zone === `edge:${home.key}:right`, `${mid.zone} (over ${mid.target})`);
    check('dm: and paints the rectangle that pane would give up — its right half',
      Math.abs(mid.rect[0] - (body.left + body.width / 2)) <= 2
        && Math.abs(mid.rect[2] - body.width / 2) <= 2
        && Math.abs(mid.rect[3] - body.height) <= 2,
      `${mid.rect} vs half of ${[body.left, body.top, body.width, body.height].map(Math.round)}`);
    check('dm: the drag carried the strip payload, so this exercised the real handlers',
      mid.types.includes('application/x-ce-tab'), mid.types.join(','));
    check('dm: a drag that ends outside .content leaves the layout and the indicator alone',
      !after.shown && after.zone === ''
        && same(shape(await geometry(win)), shape(g))
        && same(tabSets(await geometry(win)), tabSets(g)),
      `${after.zone}/${after.shown}`);
  }

  // --- 3. the other quarters, and a CENTRE join -----------------------------
  {
    const g0 = await geometry(win);
    const home = cellWith(g0, homeId);
    await dragTabTo(win, spare[0], edgePoint(await paneBox(win, home.active), 'left'));
    const g = await geometry(win);
    const dropped = cellWith(g, spare[0]);
    const nowHome = cellWith(g, homeId);
    check('dm: LEFT quarter — the new cell is left of the pane that was split',
      home.tabs.includes(spare[0]) && !!dropped && same(dropped.tabs, [spare[0]])
        && dropped.right <= nowHome.left + 2 && g.cols === 3 && tilingProblems(g).length === 0,
      `${g.cols}x${g.rows}; ${tilingProblems(g).join('; ')}`);
  }
  {
    // CENTRE now JOINS the target pane's tab set (KAN-56) rather than replacing
    // its occupant — a pane is a window, and dropping a tab on a window adds it.
    const g0 = await geometry(win);
    const target = cellWith(g0, termId);          // the lone-tab pane on the right
    const mover = cellWith(g0, spare[0]);          // the lone-tab pane on the left
    await dragTabTo(win, spare[0], edgePoint(await paneBox(win, target.active), 'centre'));
    const g = await geometry(win);
    const now = cellWith(g, spare[0]);
    check('dm: CENTRE — the drop JOINS that pane\'s tab set and makes it the shown tab',
      same(target.tabs, [termId]) && !!now && same(now.tabs, [termId, spare[0]])
        && now.active === spare[0],
      `${target.tabs.length} -> ${now?.tabs.length}, shows ${now?.active === spare[0]}`);
    check('dm: CENTRE — the pane the tab CAME from was its last tab, so that pane closed',
      g0.cells.length === 3 && g.cells.length === 2 && !g.cells.some((c) => c.key === mover.key && c.tabs.includes(spare[0]))
        && tilingProblems(g).length === 0,
      `${g0.cells.length} -> ${g.cells.length} cells; ${tilingProblems(g).join('; ')}`);
    check('dm: and nothing was closed — every tab is still on some strip',
      same([...allStripIds(g)].sort(), [...ids].sort()),
      allStripIds(g).map((s) => s.slice(0, 4)).join(','));
  }
  {
    const g0 = await geometry(win);
    const target = cellWith(g0, homeId);
    await dragTabTo(win, spare[1], edgePoint(await paneBox(win, target.active), 'bottom'));
    const g = await geometry(win);
    const dropped = cellWith(g, spare[1]);
    const now = cellWith(g, homeId);
    check('dm: BOTTOM quarter — the split is on the ROW axis and the new cell is below',
      target.tabs.includes(spare[1]) && !!dropped && same(dropped.tabs, [spare[1]])
        && dropped.top >= now.bottom - 2
        && Math.abs(now.height - target.height / 2) < target.height / 4
        && g.rows === 2 && tilingProblems(g).length === 0,
      `${g.cols}x${g.rows}; ${tilingProblems(g).join('; ')}`);
    // The pane area governs a pane-area drop, not the strip: TabBar's own
    // reorder DnD uses the same TAB_MIME payload, so a drop that leaked back to
    // a strip would shuffle tabs instead of placing a pane.
    check('dm: and the tab really left its old strip (a drag that did nothing would fail here)',
      !now.tabs.includes(spare[1]) && paneOwnership(g, ids).length === 0,
      paneOwnership(g, ids).join('; '));
  }

  // --- 4. dragging a PANE: swap by the strip's title bar, move by Alt+body ---
  {
    const g0 = await geometry(win);
    // Two panes with DIFFERENT rectangles, so a swap is observable.
    const a = g0.cells.reduce((m, c) => (c.width * c.height > m.width * m.height ? c : m));
    const b = g0.cells.reduce((m, c) => (c.key !== a.key && c.width * c.height < m.width * m.height ? c : m),
      g0.cells.find((c) => c.key !== a.key));
    const grab = await stripGrab(win, a.key);
    check('dm: a pane strip has a grabbable background (the title-bar drag)',
      !!grab?.ok, JSON.stringify(grab));
    const mid = await dragPane(win, grab, edgePoint(await paneBox(win, b.active), 'centre'));
    const g = await geometry(win);
    const s0 = shape(g0); const s1 = shape(g);
    const ka = [...a.tabs].sort().join('|');
    const kb = [...b.tabs].sort().join('|');
    const others = Object.keys(s0).filter((k) => k !== ka && k !== kb);
    check('dm: a pane drag paints the WHOLE target pane, so a swap cannot look like a split',
      mid.shown && mid.zone === `centre:${b.key}`, mid.zone);
    // ONE assertion, not two: "every other pane is untouched" is true of a drag
    // that never happened, so on its own it could never go red.
    check('dm: SWAP — dragging pane A by its strip onto pane B exchanges their rectangles and touches nothing else',
      same(s1[ka], s0[kb]) && same(s1[kb], s0[ka]) && !same(s0[ka], s0[kb])
        && others.every((k) => same(s0[k], s1[k])) && tilingProblems(g).length === 0,
      `${s0[ka]} -> ${s1[ka]}; ${tilingProblems(g).join('; ')}`);
    check('dm: and both panes kept their whole tab set through the swap',
      same(tabSets(g), tabSets(g0)),
      Object.keys(tabSets(g)).length + ' sets');
  }
  {
    const g0 = await geometry(win);
    // Move the SMALLEST cell onto the right edge of the tallest one: its old
    // rectangle has to be absorbed and the grid re-tiled, which is the claim.
    const mover = g0.cells.reduce((m, c) => (c.width * c.height < m.width * m.height ? c : m));
    const host = g0.cells.reduce((m, c) => (c.key !== mover.key && c.height > m.height ? c : m),
      g0.cells.find((c) => c.key !== mover.key));
    await dragPaneByBody(win, mover.active, edgePoint(await paneBox(win, host.active), 'right'));
    const g = await geometry(win);
    const km = [...mover.tabs].sort().join('|');
    const moved = g.cells.find((c) => same([...c.tabs].sort().join('|'), km));
    const anchor = g.cells.find((c) => same([...c.tabs].sort().join('|'), [...host.tabs].sort().join('|')));
    // One assertion again: "it still tiles" is true of a grid nobody touched.
    // The hole the move left has to be gone, and a leftover empty rectangle
    // shows up as a shortfall in the AREA sum, which is what tilingProblems
    // measures. ponytail: that is the only OBSERVABLE form of "compact ran" —
    // `absorb` hands a vacated rectangle to a neighbour before `compact` ever
    // sees it, so a track count never actually drops. Assert on the rect map,
    // never on gridTemplateColumns, for anything that vacates.
    check('dm: MOVE — Alt+dragging a pane by its BODY to an edge re-places it there and leaves no hole',
      !!moved && !!anchor && Math.abs(moved.left - anchor.right) <= 2
        && moved.bottom > anchor.top && moved.top < anchor.bottom
        && !same(shape(g0)[km], shape(g)[km])
        && g.cells.length === g0.cells.length && tilingProblems(g).length === 0,
      `${shape(g0)[km]} -> ${shape(g)[km]}; ${g.cols}x${g.rows}; ${tilingProblems(g).join('; ')}`);
  }

  // --- 5. the Ctrl+Shift+G arrangement picker --------------------------------
  {
    // A FOURTH pane, because four is the count whose valid picks are
    // interesting: 2x2, 4x1, 1x4 and 3x2 tile exactly, 3x3 cannot, and 2x1 can
    // only be reached by merging.
    const g0 = await geometry(win);
    const donor = cellWith(g0, spare[2]);
    await dragTabTo(win, spare[2], edgePoint(await paneBox(win, donor.active), 'bottom'));
    const g = await geometry(win);
    check('dm: four panes are up for the picker, still tiling exactly',
      g0.cells.length === 3 && g.cells.length === 4 && tilingProblems(g).length === 0,
      `${g0.cells.length} -> ${g.cells.length} cells; ${tilingProblems(g).join('; ')}`);
  }

  {
    // Focus the terminal first: Ctrl+Shift+G has to be taken by the app and NOT
    // reach the shell as a ^G, which is the whole reason it is a capture-phase
    // listener at window rather than a preventDefault. Its own strip has to
    // SHOW it before it can be clicked — a centre drop earlier made a sibling
    // the pane's active tab.
    await win.locator(`.tab[data-slide="${termId}"]`).click();
    await win.waitForTimeout(500);
    await win.locator(`[data-pane="${termId}"] .xterm-screen`).click();
    await win.waitForTimeout(300);
    const textBefore = await termText(win, termId);
    await win.keyboard.press('Control+Shift+G');
    await win.waitForTimeout(400);
    check('dm: Ctrl+Shift+G opens the picker', await win.locator('.gridpick').isVisible());
    check('dm: and it did not reach the focused shell as a ^G',
      (await termText(win, termId)) === textBefore);

    const disabled = (c, r) =>
      win.locator(`.gridpick-cell[data-cell="${c},${r}"]`).getAttribute('aria-disabled');
    check('dm: 3x3 is REFUSED with four panes — it would leave a whole row empty',
      (await disabled(2, 2)) === 'true', String(await disabled(2, 2)));
    check('dm: 3x2 IS offered — it is a pick that tiles four panes exactly',
      (await disabled(2, 1)) !== 'true', String(await disabled(2, 1)));
    // KAN-56 widened this: a grid SMALLER than the pane count used to be refused
    // outright, and now MERGES panes instead. 2x1 with four panes is the case.
    check('dm: a grid smaller than the pane count is now OFFERED — picking it merges panes',
      (await disabled(1, 0)) !== 'true', String(await disabled(1, 0)));

    // A refused pick must be inert, not merely ugly.
    const g0 = await geometry(win);
    // `force`, because the refused cell carries aria-disabled and Playwright's
    // actionability check would wait it out forever — the point of the
    // assertion is that a real click on it does nothing.
    await win.locator('.gridpick-cell[data-cell="2,2"]').click({ force: true });
    await win.waitForTimeout(500);
    check('dm: clicking a refused cell changes nothing and leaves the picker open',
      same(shape(await geometry(win)), shape(g0))
        && (await geometry(win)).colTemplate === g0.colTemplate
        && await win.locator('.gridpick').isVisible());

    // Escape: arrow around first, so there IS a highlighted pick to discard.
    await win.keyboard.press('ArrowRight');
    await win.keyboard.press('ArrowDown');
    await win.waitForTimeout(200);
    await win.keyboard.press('Escape');
    await win.waitForTimeout(400);
    check('dm: Escape closes the picker', (await win.locator('.gridpick').count()) === 0);
    check('dm: and cancels with NO state change — same rectangles, same tab sets, same template',
      same(shape(await geometry(win)), shape(g0))
        && same(tabSets(await geometry(win)), tabSets(g0))
        && (await geometry(win)).colTemplate === g0.colTemplate,
      (await geometry(win)).colTemplate);
  }

  {
    const g0 = await geometry(win);
    const wanted = allStripIds(g0);
    await win.keyboard.press('Control+Shift+G');
    await win.waitForTimeout(400);
    await win.click('.gridpick-cell[data-cell="2,1"]');
    await win.waitForTimeout(900);
    const g = await geometry(win);
    check('dm: picking 3x2 reflows the four panes into a 3-column, 2-row grid, no overlap',
      g0.cells.length === 4 && g.cols === 3 && g.rows === 2 && g.cells.length === 4
        && tilingProblems(g).length === 0
        && (await win.locator('.gridpick').count()) === 0,
      `${g.cols}x${g.rows}, ${g.cells.length} cells; ${tilingProblems(g).join('; ')}`);
    // Reading order, from the measured rectangles — nothing here asks the model
    // what order it used.
    const visual = g.cells.slice()
      .sort((a, b) => (Math.round(a.top / 8) - Math.round(b.top / 8)) || (a.left - b.left))
      .flatMap((c) => c.tabs);
    check('dm: and it laid them out in STRIP order, reading left-to-right, top-to-bottom',
      same(visual, wanted),
      `${visual.map((s) => s.slice(0, 4)).join(',')} vs ${wanted.map((s) => s.slice(0, 4)).join(',')}`);
  }

  // --- 6. the terminal, after every one of those gestures --------------------
  {
    // The ONLY instrument that catches a re-parent: ConPTY repaints its whole
    // screen buffer on the resize a remount triggers, so the two text checks
    // below still pass against a terminal that was destroyed and rebuilt.
    check('DIRECT MANIPULATION NEVER RE-PARENTED THE TERMINAL — same xterm instance (KAN-23)',
      (await probeOf(win, termId)) === 'run4', String(await probeOf(win, termId)));
    check('dm: and the text from before the first drag is back on screen (a repaint, not proof of survival)',
      (await termText(win, termId)).includes(MARKER));
    await runInTerminal(win, termId, say('CE-LIVE2'));
    await win.waitForTimeout(2200);
    check('dm: the shell still answers a new command after every drag, swap and reflow',
      (await termText(win, termId)).includes(LIVE));
  }

  // --- 7. the picker is also the way BACK to classic tabs ---------------------
  {
    const g0 = await geometry(win);
    const wanted = allStripIds(g0);
    await win.keyboard.press('Control+Shift+G');
    await win.waitForTimeout(400);
    await win.click('.gridpick-cell[data-cell="0,0"]');
    await win.waitForTimeout(900);
    const g = await geometry(win);
    check('dm: picking 1x1 collapses back to layout:null — one strip, one pane, no slots',
      g0.cells.length === 4 && g.display !== 'grid' && g.cells.length === 0
        && g.slots === 0 && g.strips === 0 && g.dividers === 0 && g.panes.length === 1,
      `${g.display}, ${g.cells.length} cells, ${g.panes.length} panes`);
    check('dm: and EVERY tab came back onto the single strip, in the panes\' reading order',
      same(g.topTabs, wanted) && g.topAdd,
      `${g.topTabs?.map((s) => s.slice(0, 4)).join(',')} vs ${wanted.map((s) => s.slice(0, 4)).join(',')}`);
    check('dm: NO PTY DIED in the collapse — the same shell still answers',
      (await probeOf(win, termId)) === 'run4' && (await termText(win, termId)).includes(LIVE));
  }

  if (SHOW) await win.waitForTimeout(600_000);
  await close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
