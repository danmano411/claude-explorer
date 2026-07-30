// KAN-46: split-view real-geometry harness.
//   node test/harness/splitgrid.mjs            (no npm run build needed)
//   node test/harness/splitgrid.mjs --show     leave the window open to look at it
//
// This is the GEOMETRY harness: it drives splitgrid.ts + SplitDividers directly,
// over layouts the app's own split/close actions cannot always produce, in a
// bare Electron BrowserWindow bundled with esbuild — the same Chromium that
// ships the app, so CSS Grid, ResizeObserver and pointer capture all behave
// exactly as they will in production.
//
// test/harness/splitview.mjs is the other half: the same claims against the REAL
// app, with a live terminal in a pane. Keep both — this one can pose layouts the
// app cannot reach, and that one can prove things about a running pty.
//
// splitgrid.entry.tsx reproduces App.tsx's real DOM shape — one flat container,
// every tab mounted once forever as an absolutely positioned `.pane` sibling —
// so what is measured here is the production structure, not a friendlier one.
//
// Everything asserted here is measured with getBoundingClientRect() against a
// fixed 800x600 stage. No assertion inspects React internals.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import pw from 'playwright-core';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOW = process.argv.includes('--show');

// Unique per run: several app instances may be up across worktrees and KAN-38's
// single-instance lock is keyed on userData, so a shared profile hangs.
const TMP = path.join(os.tmpdir(), `claude-explorer-splitgrid-${process.pid}`);
const PROFILE = path.join(TMP, 'profile');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

const STAGE_W = 800;
const STAGE_H = 600;
const EPS = 0.6;  // sub-pixel: Chromium rounds fr tracks to device pixels
const SEAM = 1;   // splitgrid.ts SEAM_PX — the grid gap that paints the seam

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ---------------------------------------------------------------- bundle -----
await build({
  entryPoints: [path.join(root, 'test/harness/splitgrid.entry.tsx')],
  bundle: true,
  outfile: path.join(TMP, 'bundle.js'),
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  absWorkingDir: root,
  logLevel: 'warning',
});

fs.writeFileSync(path.join(TMP, 'index.html'), `<!doctype html>
<meta charset="utf-8"><title>split view harness</title>
<link rel="stylesheet" href="./bundle.css">
<div id="root"></div>
<script src="./bundle.js"></script>
`);

fs.writeFileSync(path.join(TMP, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 1000, height: 800, show: true });
  w.loadFile(path.join(__dirname, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
`);

// ---------------------------------------------------------------- launch -----
const app = await pw._electron.launch({
  executablePath: require('electron'),
  args: [`--user-data-dir=${PROFILE}`, path.join(TMP, 'main.cjs')],
  cwd: root,
  timeout: 30_000,
});
const win = await app.firstWindow({ timeout: 30_000 });
await win.waitForSelector('.pane:not([hidden])', { timeout: 15_000 });

const setLayout = async (name) => {
  await win.evaluate((n) => window.__setLayout(n), name);
  await win.waitForTimeout(120);
};

/** Pane + stand-in geometry, relative to the stage's own top-left. */
const geometry = () => win.evaluate(() => {
  const el = document.getElementById('stage');
  const stage = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const tracks = (v) => (!v || v === 'none' ? 1 : v.trim().split(/\s+/).length);
  const rel = (r) => ({
    left: r.left - stage.left, top: r.top - stage.top,
    right: r.right - stage.left, bottom: r.bottom - stage.top,
    width: r.width, height: r.height,
  });
  return {
    stage: { width: stage.width, height: stage.height },
    cols: tracks(cs.gridTemplateColumns), rows: tracks(cs.gridTemplateRows),
    display: cs.display,
    panes: [...document.querySelectorAll('.pane:not([hidden])')].map((p) => ({
      id: p.dataset.pane,
      focused: p.classList.contains('pane-focused'),
      ...rel(p.getBoundingClientRect()),
      // The stand-in is height:100% of the pane — a percentage that only
      // resolves if the pane got a DEFINITE box from the grid. This is exactly
      // Terminal.tsx's precondition.
      stand: rel(document.querySelector(`[data-stand="${p.dataset.pane}"]`).getBoundingClientRect()),
    })),
    dividers: [...document.querySelectorAll('.split-divider')].map((d) => ({
      id: d.dataset.divider, ...rel(d.getBoundingClientRect()),
    })),
  };
});

/**
 * No overlaps anywhere, and no hole wider than the 1px seam.
 *
 * Sampled rather than computed from areas, because a spanning cell reclaims the
 * gutters it crosses and no closed-form area identity survives that. Inflating
 * every pane by exactly one seam and demanding total coverage is precisely the
 * claim "these rectangles tile the stage, with gaps of at most SEAM": too big a
 * gap leaves an uncovered sample, and an overlap is caught on the raw rects.
 */
function tiling(g) {
  let overlap = 0;
  for (let i = 0; i < g.panes.length; i++)
    for (let j = i + 1; j < g.panes.length; j++) {
      const a = g.panes[i], b = g.panes[j];
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > EPS && h > EPS) overlap += w * h;
    }
  const pad = SEAM + EPS;
  let uncovered = 0, samples = 0;
  for (let x = 0.5; x < g.stage.width; x += 4)
    for (let y = 0.5; y < g.stage.height; y += 4) {
      samples++;
      if (!g.panes.some((p) => x >= p.left - pad && x <= p.right + pad
        && y >= p.top - pad && y <= p.bottom + pad)) uncovered++;
    }
  const union = {
    left: Math.min(...g.panes.map((p) => p.left)), top: Math.min(...g.panes.map((p) => p.top)),
    right: Math.max(...g.panes.map((p) => p.right)), bottom: Math.max(...g.panes.map((p) => p.bottom)),
  };
  return {
    overlap, uncovered, samples, union,
    coversStage: Math.abs(union.left) < EPS && Math.abs(union.top) < EPS
      && Math.abs(union.right - g.stage.width) < EPS && Math.abs(union.bottom - g.stage.height) < EPS,
    exact: uncovered === 0 && overlap < 1,
  };
}

/**
 * `along` is the grab point as a fraction of the handle's LONG axis. It
 * defaults to 0.25, not 0.5, because in an even 2x2 the col handle's midpoint is
 * exactly where the row handle crosses it — and the row handle is stacked on
 * top there, so a centre grab picks up the wrong divider. That is real,
 * deliberate behaviour (see the intersection check below); grabbing off-centre
 * is what a user does anyway. An earlier version of this harness grabbed the
 * centre and reported a silent no-op as a resize-notification failure.
 */
const grabPoint = async (dividerId, along = 0.25) => {
  const box = await win.locator(`[data-divider="${dividerId}"]`).boundingBox();
  const long = box.width > box.height;
  return {
    x: box.x + (long ? box.width * along : box.width / 2),
    y: box.y + (long ? box.height / 2 : box.height * along),
  };
};

const dragTo = async (dividerId, dx, dy, mid, along = 0.25) => {
  const { x, y } = await grabPoint(dividerId, along);
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x + dx, y + dy, { steps: 8 });
  await win.waitForTimeout(60);
  const during = mid ? await geometry() : null;
  await win.mouse.up();
  await win.waitForTimeout(120);
  return { during, after: await geometry() };
};

// ============================================================================
// 1. Tiling at 1x2, 2x1, 2x2, 3x3 (+ a spanned layout), and the null path.
// ============================================================================
console.log('\n--- tiling ---');
for (const [name, expected, seams] of [
  ['1x1', 1, 0], ['1x2', 2, 1], ['2x1', 2, 1], ['2x2', 4, 2], ['3x3', 9, 4], ['span', 3, 2],
]) {
  await setLayout(name);
  const g = await geometry();
  const t = tiling(g);
  console.log(`  ${name}: stage=${g.stage.width}x${g.stage.height} tracks=${g.cols}x${g.rows} panes=` +
    g.panes.map((p) => `${p.id}[${p.left.toFixed(1)},${p.top.toFixed(1)} ${p.width.toFixed(1)}x${p.height.toFixed(1)}]`).join(' '));
  check(`${name}: one pane per cell, and no pane for a tab not in the layout`,
    g.panes.length === expected, `${g.panes.length} of ${expected}`);
  check(`${name}: panes do not overlap`, t.overlap < 1, `overlap=${t.overlap.toFixed(2)}px2`);
  check(`${name}: panes tile the stage with no hole wider than the ${SEAM}px seam`,
    t.uncovered === 0, `${t.uncovered}/${t.samples} sample points uncovered`);
  check(`${name}: the tiling fills the stage exactly`, t.coversStage, JSON.stringify(t.union));
  check(`${name}: every pane gave its 100%-height child a real box (Terminal's precondition)`,
    g.panes.every((p) => Math.abs(p.stand.width - p.width) < EPS && Math.abs(p.stand.height - p.height) < EPS),
    g.panes.map((p) => `${p.id}:${p.stand.width.toFixed(1)}x${p.stand.height.toFixed(1)}`).join(' '));
  check(`${name}: exposes exactly ${seams} draggable seam(s)`, g.dividers.length === seams,
    g.dividers.map((d) => d.id).join(',') || '(none)');
}

// The classic single-pane path: no grid at all, one full-bleed pane, no handles.
await setLayout('null');
{
  const g = await geometry();
  console.log(`  null: display=${g.display} panes=${g.panes.length} dividers=${g.dividers.length}`);
  check('layout null leaves the container a plain block — no grid, no special case',
    g.display !== 'grid', g.display);
  check('layout null shows exactly one pane, filling the container',
    g.panes.length === 1 && Math.abs(g.panes[0].width - STAGE_W) < EPS
    && Math.abs(g.panes[0].height - STAGE_H) < EPS,
    JSON.stringify(g.panes.map((p) => [p.id, p.width, p.height])));
  check('layout null has no draggable handles', g.dividers.length === 0);
}

// ============================================================================
// 2. Every pane is focusable, and focus survives a click on pane CONTENT.
// ============================================================================
console.log('\n--- focus ---');
await setLayout('3x3');
{
  let allFocusable = true;
  const clay = [];
  for (const p of (await geometry()).panes) {
    // Click the stand-in, not the pane wrapper: focus must work through
    // content, which is what onPointerDownCapture is for.
    await win.locator(`[data-stand="${p.id}"]`).click({ position: { x: 10, y: 10 } });
    await win.waitForTimeout(60);
    const state = await win.evaluate(() => {
      const f = [...document.querySelectorAll('.pane.pane-focused:not([hidden])')];
      return {
        ids: f.map((e) => e.dataset.pane),
        ring: f[0] ? getComputedStyle(f[0]).boxShadow : null,
        clayVar: getComputedStyle(document.documentElement).getPropertyValue('--clay').trim(),
      };
    });
    if (state.ids.length !== 1 || state.ids[0] !== p.id) { allFocusable = false; console.log(`    ${p.id} -> ${JSON.stringify(state.ids)}`); }
    clay.push(state);
  }
  check('clicking each of the 9 panes\' content focuses exactly that pane', allFocusable);
  const last = clay[clay.length - 1];
  // --clay is #C15F3C light / #D2795A dark; the ring must be the token, not a literal.
  const rgb = last.clayVar.startsWith('#')
    ? `rgb(${[1, 3, 5].map((i) => parseInt(last.clayVar.slice(i, i + 2), 16)).join(', ')})`
    : last.clayVar;
  check('the focus ring is painted in --clay', last.ring?.includes(rgb), `${last.ring} vs --clay=${last.clayVar} (${rgb})`);
  check('the focus ring is inset, so focusing does not resize the pane\'s content box',
    last.ring?.includes('inset'), last.ring);
}

// ============================================================================
// 3. A divider drag moves its two neighbours and NOTHING else.
// ============================================================================
console.log('\n--- divider drag: locality ---');
await setLayout('3x3');
{
  const before = await geometry();
  const { during, after } = await dragTo('col0-0', 120, 0, true);
  const w = (g, id) => g.panes.find((p) => p.id === id).width;
  const h = (g, id) => g.panes.find((p) => p.id === id).height;
  console.log('  before:', 'abc'.split('').map((i) => `${i}=${w(before, i).toFixed(1)}`).join(' '));
  console.log('  during:', 'abc'.split('').map((i) => `${i}=${w(during, i).toFixed(1)}`).join(' '));
  console.log('  after :', 'abc'.split('').map((i) => `${i}=${w(after, i).toFixed(1)}`).join(' '));

  check('the drag is continuous: geometry already moved before pointerup',
    Math.abs(w(during, 'a') - w(before, 'a') - 120) < 2, `during a=${w(during, 'a').toFixed(1)} before=${w(before, 'a').toFixed(1)}`);
  check('column 0 grew by exactly the drag distance', Math.abs(w(after, 'a') - w(before, 'a') - 120) < 2,
    `${w(before, 'a').toFixed(1)} -> ${w(after, 'a').toFixed(1)}`);
  check('column 1 shrank by exactly the same amount', Math.abs(w(after, 'b') - w(before, 'b') + 120) < 2,
    `${w(before, 'b').toFixed(1)} -> ${w(after, 'b').toFixed(1)}`);
  check('column 2 — not a neighbour of this seam — did not move at all',
    Math.abs(w(after, 'c') - w(before, 'c')) < EPS, `${w(before, 'c').toFixed(1)} -> ${w(after, 'c').toFixed(1)}`);
  check('no row height changed (a column drag is one-axis)',
    'adg'.split('').every((i) => Math.abs(h(after, i) - h(before, i)) < EPS),
    'adg'.split('').map((i) => `${i}:${h(before, i).toFixed(1)}->${h(after, i).toFixed(1)}`).join(' '));
  check('still an exact tiling after the drag', tiling(after).exact && tiling(after).coversStage);
  check('the divider handle followed the seam it was dragged to',
    Math.abs(after.dividers.find((d) => d.id === 'col0-0').left + 4.5 - w(after, 'a')) < 3,
    JSON.stringify(after.dividers.find((d) => d.id === 'col0-0')));

  const reported = await win.evaluate(() => window.__lastResize);
  console.log('  onResize reported:', JSON.stringify(reported));
  check('onResize reported fractions that sum to the track count on both axes',
    Math.abs(reported.cols.reduce((a, b) => a + b, 0) - 3) < 1e-6
    && Math.abs(reported.rows.reduce((a, b) => a + b, 0) - 3) < 1e-6, JSON.stringify(reported));
}

// ============================================================================
// 4. Row drag, on the other axis.
// ============================================================================
console.log('\n--- divider drag: row axis ---');
await setLayout('1x2');
{
  const before = await geometry();
  const { after } = await dragTo('row0-0', 0, -90, false);
  const h = (g, id) => g.panes.find((p) => p.id === id).height;
  console.log(`  a: ${h(before, 'a').toFixed(1)} -> ${h(after, 'a').toFixed(1)}   b: ${h(before, 'b').toFixed(1)} -> ${h(after, 'b').toFixed(1)}`);
  check('row 0 shrank by the drag distance', Math.abs(h(after, 'a') - h(before, 'a') + 90) < 2);
  check('row 1 absorbed it', Math.abs(h(after, 'b') - h(before, 'b') - 90) < 2);
  check('the 1x2 grid still tiles exactly', tiling(after).exact && tiling(after).coversStage);
}

// ============================================================================
// 5. The clamp: a pane cannot be dragged to zero.
// ============================================================================
console.log('\n--- clamp ---');
await setLayout('2x1');
{
  // 500px overshoots the ~320px of slack the 80px floor leaves, while keeping
  // the pointer inside the 1000px window.
  const { after } = await dragTo('col0-0', 500, 0, false);
  const b = after.panes.find((p) => p.id === 'b');
  console.log(`  right pane after a 500px drag on an ${STAGE_W}px stage: ${b.width.toFixed(1)}px`);
  check('the far pane stops at MIN_PANE_PX (80) instead of collapsing to zero',
    Math.abs(b.width - 80) < 2, `width=${b.width.toFixed(1)}`);
  check('the seam is still grabbable, so the drag is reversible',
    (await win.locator('[data-divider="col0-0"]').boundingBox()).width > 4);
}

// ============================================================================
// 5b. Where a col and a row handle cross, exactly one wins, deterministically,
//     and the cursor says which. ponytail: a corner grab resizing BOTH axes at
//     once is the nicer behaviour and is not built — the ceiling is a 9x9px
//     square per intersection where the row handle wins. Upgrade path: carry an
//     array of active drags in `drag.current` and let a corner handle push two.
// ============================================================================
console.log('\n--- handle intersection ---');
await setLayout('2x2');
{
  const before = await geometry();
  const at = await win.evaluate(() => {
    const c = document.querySelector('[data-divider="col0-0"]').getBoundingClientRect();
    const r = document.querySelector('[data-divider="row0-0"]').getBoundingClientRect();
    const x = c.left + c.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, id: hit?.dataset?.divider, cursor: getComputedStyle(hit).cursor };
  });
  console.log(`  crossing at (${at.x.toFixed(1)},${at.y.toFixed(1)}) resolves to ${at.id} with cursor ${at.cursor}`);
  check('a grab at the crossing resolves to exactly one handle, deterministically',
    at.id === 'row0-0', `got ${at.id}`);
  check('and the cursor promises the axis that will actually move', at.cursor === 'row-resize', at.cursor);
  const { after } = await dragTo('row0-0', 0, -70, false, 0.5); // 0.5 == the crossing
  const h = (g, id) => g.panes.find((p) => p.id === id).height;
  check('dragging vertically from the crossing resizes rows, as the cursor promised',
    Math.abs(h(after, 'a') - h(before, 'a') + 70) < 2, `${h(before, 'a').toFixed(1)} -> ${h(after, 'a').toFixed(1)}`);
}

// ============================================================================
// 5c. Spanned layouts: no phantom handle inside a pane, and the real seams work.
//     The defect: seams used to be emitted per grid LINE, so the col0|col1 line
//     — which runs down the middle of `a` — got a full-height 9px band that
//     changed nothing when dragged, yet persisted lopsided fractions and sat at
//     z-index 2 over a live terminal.
// ============================================================================
console.log('\n--- spanned layout: seams ---');
await setLayout('span');
{
  const g = await geometry();
  const a = g.panes.find((p) => p.id === 'a');
  console.log('  dividers:', g.dividers.map((d) =>
    `${d.id}[${d.left.toFixed(1)},${d.top.toFixed(1)} ${d.width.toFixed(1)}x${d.height.toFixed(1)}]`).join(' '));
  check('the line buried inside the spanning pane gets NO handle',
    !g.dividers.some((d) => d.id === 'col0-0'), g.dividers.map((d) => d.id).join(','));
  // The handle is 9px of grab centred on the seam, so its 4px overhang lands on
  // the panes either side by design. The claim is about the SEAM itself: the
  // line the handle represents must not pass through any pane's interior.
  const through = g.dividers.filter((d) => {
    const vertical = d.height > d.width;
    const c = vertical ? (d.left + d.right) / 2 : (d.top + d.bottom) / 2;
    return g.panes.some((p) => vertical
      ? c > p.left + SEAM && c < p.right - SEAM && d.bottom > p.top && d.top < p.bottom
      : c > p.top + SEAM && c < p.bottom - SEAM && d.right > p.left && d.left < p.right);
  });
  check('no seam passes through the interior of any pane',
    through.length === 0, through.map((d) => d.id).join(','));
  // The b|c seam is a boundary only over column 2, so its handle must stop there.
  const row = g.dividers.find((d) => d.id.startsWith('row'));
  check('the b|c row seam is clamped to column 2, not run across the whole grid',
    row && Math.abs(row.left - a.right - SEAM) < 2 && Math.abs(row.right - g.stage.width) < 2,
    JSON.stringify(row));

  const beforeW = a.width;
  const { after } = await dragTo('col1-0', -100, 0, false);
  const a2 = after.panes.find((p) => p.id === 'a');
  const b2 = after.panes.find((p) => p.id === 'b');
  console.log(`  a: ${beforeW.toFixed(1)} -> ${a2.width.toFixed(1)}   b: ${b2.width.toFixed(1)}`);
  check('dragging the real seam of a spanned layout resizes the span',
    Math.abs(a2.width - beforeW + 100) < 3, `${beforeW.toFixed(1)} -> ${a2.width.toFixed(1)}`);
  check('the spanned layout still tiles exactly after the drag',
    tiling(after).exact && tiling(after).coversStage,
    `overlap=${tiling(after).overlap.toFixed(2)} uncovered=${tiling(after).uncovered}`);
}

// ============================================================================
// 6. Pane-size notification — the hard requirement. Terminal.tsx's own
//    ResizeObserver is the ONLY mechanism; there is no second observer.
// ============================================================================
console.log('\n--- pane resize notification ---');
await setLayout('2x2');
await win.waitForTimeout(150);
{
  const reset = () => win.evaluate(() => {
    for (const k of Object.keys(window.__roFires)) window.__roFires[k] = 0;
  });

  // (a) during a divider drag
  await reset();
  const preDrag = await geometry();
  const { after: postDrag } = await dragTo('col0-0', 100, 0, false);
  const dw = (g, id) => g.panes.find((p) => p.id === id).width;
  console.log(`  (drag really moved geometry: a ${dw(preDrag, 'a').toFixed(1)} -> ${dw(postDrag, 'a').toFixed(1)})`);
  const drag = await win.evaluate(() => ({ ...window.__roFires }));
  console.log('  drag -> stand-in ResizeObserver fires:', JSON.stringify(drag));
  check('the pane content\'s own ResizeObserver fired for every pane the drag resized',
    ['a', 'b', 'c', 'd'].every((k) => drag[k] > 0), JSON.stringify(drag));
  check('it fired MORE THAN ONCE per pane — i.e. continuously, not just on pointerup',
    ['a', 'b', 'c', 'd'].every((k) => drag[k] > 1), JSON.stringify(drag));
  // This number is the whole argument for the one-line rAF coalesce in
  // Terminal.tsx: every fire is a ptyResize IPC and a conpty resize.
  console.log(`  >> Terminal.tsx would send ${Math.max(...Object.values(drag))} ptyResize IPCs per pane for ONE drag`);
  check('the last observed size matches the pane\'s real box',
    await win.evaluate(() => ['a', 'b', 'c', 'd'].every((k) => {
      const p = document.querySelector(`.pane[data-pane="${k}"]`).getBoundingClientRect();
      const s = document.querySelector(`[data-stand="${k}"]`).getBoundingClientRect();
      return Math.abs(s.width - p.width) < 1.5 && Math.abs(s.height - p.height) < 1.5;
    })));

  // (b) when a SIBLING pane opens — nothing to do with this pane's own props
  await reset();
  await setLayout('3x3');
  await win.waitForTimeout(150);
  const opened = await win.evaluate(() => ({ ...window.__roFires }));
  console.log('  sibling opened (2x2 -> 3x3) -> RO fires:', JSON.stringify(opened));
  check('the pre-existing panes were notified when new siblings opened',
    ['a', 'b', 'c', 'd'].every((k) => opened[k] > 0), JSON.stringify(opened));

  // (c) when a sibling closes
  await reset();
  await setLayout('2x2');
  await win.waitForTimeout(150);
  const closed = await win.evaluate(() => ({ ...window.__roFires }));
  check('the survivors were notified when siblings closed (3x3 -> 2x2)',
    ['a', 'b', 'c', 'd'].every((k) => closed[k] > 0), JSON.stringify(closed));
}

// ============================================================================
// 7. Panes must not re-mount. A re-mount destroys an xterm buffer (KAN-23).
//    This is the assertion the inverted design exists for: because split view
//    computes styles for App's own flat pane list instead of owning panes, the
//    layout -> null -> layout transition cannot touch a single node.
// ============================================================================
console.log('\n--- re-mount detector ---');
{
  const total = await win.evaluate(() => window.__mounts);
  console.log('  mounts across the whole run:', JSON.stringify(total));
  check('every pane mounted exactly ONCE across the entire run (7 layouts, 6 drags, 9 focus clicks)',
    'abcdefghi'.split('').every((k) => total[k] === 1),
    'abcdefghi'.split('').map((k) => `${k}:${total[k]}`).join(' '));

  await setLayout('2x2');
  await win.waitForTimeout(150);
  const seq = await win.evaluate(async () => {
    const base = { ...window.__mounts };
    const node = () => document.querySelector('.pane[data-pane="a"] .stand');
    const first = node();
    const wait = () => new Promise((r) => setTimeout(r, 150));
    window.__setLayout('3x3'); await wait();     // four siblings open
    window.__set({ focused: 'i' }); await wait();
    window.__setLayout('null'); await wait();    // <- the transition finding 1 was about
    window.__setLayout('3x3'); await wait();
    window.__setLayout('2x2'); await wait();
    const delta = {};
    for (const k of Object.keys(window.__mounts)) delta[k] = window.__mounts[k] - (base[k] ?? 0);
    return { delta, sameNode: first === node() };
  });
  console.log('  additional mounts over 2x2 -> 3x3 -> focus -> null -> 3x3 -> 2x2:', JSON.stringify(seq.delta));
  check('opening and closing sibling panes re-mounted NOTHING',
    Object.values(seq.delta).every((v) => v === 0), JSON.stringify(seq.delta));
  check('collapsing to the classic single-pane path (layout null) and back re-mounted NOTHING',
    Object.values(seq.delta).every((v) => v === 0));
  check('a focus change re-mounts nothing', Object.values(seq.delta).every((v) => v === 0));
  check('pane a is still the exact same DOM node it started as', seq.sameNode);

  // The case an index key or a re-parenting render path would break: same tabs,
  // same rectangles, `cells` in a different order — exactly what
  // gridlayout.place() returns after touching one tab.
  await setLayout('2x2');
  await win.waitForTimeout(150);
  const reorder = await win.evaluate(async () => {
    const nodes = () => [...document.querySelectorAll('.pane:not([hidden])')].map((p) => p.dataset.pane);
    const node = (id) => document.querySelector(`.pane[data-pane="${id}"]`);
    const base = { ...window.__mounts };
    const beforeOrder = nodes();
    const beforeNodes = beforeOrder.map(node);
    const rect = (id) => { const r = node(id).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    const beforeRects = Object.fromEntries(beforeOrder.map((id) => [id, rect(id)]));
    window.__set({ layout: window.__layouts['2x2reordered'] });
    await new Promise((r) => setTimeout(r, 150));
    return {
      remounted: Object.keys(window.__mounts).filter((k) => window.__mounts[k] !== (base[k] ?? 0)),
      sameNodes: beforeOrder.every((id, i) => node(id) === beforeNodes[i]),
      sameDomOrder: nodes().join('') === beforeOrder.join(''),
      movedRects: beforeOrder.filter((id) => rect(id).some((v, i) => Math.abs(v - beforeRects[id][i]) > 0.5)),
    };
  });
  console.log('  cells reordered (same tabs, same rectangles):', JSON.stringify(reorder));
  check('reordering layout.cells re-mounts nothing', reorder.remounted.length === 0, reorder.remounted.join(','));
  check('reordering layout.cells does not move a single pane in the DOM',
    reorder.sameNodes && reorder.sameDomOrder, JSON.stringify(reorder));
  check('and every pane is still in the same place on screen', reorder.movedRects.length === 0,
    reorder.movedRects.join(','));
}

// ============================================================================
// 8. Drag hygiene: no write for a click that moved nothing, exact
//    reversibility (the accumulation guard), and keyboard resize.
// ============================================================================
console.log('\n--- drag hygiene ---');
await setLayout('2x2');
await win.waitForTimeout(150);
{
  // (a) a stationary click on a handle must not persist anything. Every
  //     onResize is a workspace.json write.
  await win.evaluate(() => { window.__resizeCalls = 0; });
  const { x, y } = await grabPoint('col0-0');
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.up();
  await win.waitForTimeout(120);
  const clicks = await win.evaluate(() => window.__resizeCalls);
  console.log(`  onResize calls after a stationary click: ${clicks}`);
  check('a click that moved nothing does not fire onResize (no workspace.json write)', clicks === 0, `${clicks}`);

  // (b) the delta is measured from the pointerdown SNAPSHOT, not accumulated
  //     per pointermove. Out past the clamp and back to the origin inside one
  //     drag must land exactly where it started; an accumulating handler drifts
  //     by everything the clamp swallowed.
  const before = await geometry();
  const w = (g, id) => g.panes.find((p) => p.id === id).width;
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x + 600, y, { steps: 8 });   // hard into the clamp
  await win.waitForTimeout(40);
  const pinned = await geometry();
  await win.mouse.move(x - 600, y, { steps: 8 });   // hard into the other clamp
  await win.waitForTimeout(40);
  await win.mouse.move(x, y, { steps: 8 });         // back to the origin
  await win.waitForTimeout(40);
  await win.mouse.up();
  await win.waitForTimeout(120);
  const after = await geometry();
  console.log(`  a: ${w(before, 'a').toFixed(1)} -> clamped ${w(pinned, 'a').toFixed(1)} -> back ${w(after, 'a').toFixed(1)}`);
  check('the drag really hit the clamp on the way out',
    Math.abs(w(pinned, 'b') - 80) < 2, `b=${w(pinned, 'b').toFixed(1)}`);
  check('returning to the origin mid-drag restores the exact starting size',
    Math.abs(w(after, 'a') - w(before, 'a')) < EPS,
    `${w(before, 'a').toFixed(1)} -> ${w(after, 'a').toFixed(1)}`);

  // (c) a pane closing MID-DRAG. A pty exiting is asynchronous and real, and it
  //     re-shapes the grid under the pointer. Anything written after that would
  //     be a template for a grid that no longer exists — the wrong number of
  //     tracks, and fractions persisted for an axis that changed length.
  await setLayout('3x3');
  await win.waitForTimeout(150);
  await win.evaluate(() => { window.__resizeCalls = 0; window.__lastResize = null; });
  {
    const g = await grabPoint('col0-0');
    await win.mouse.move(g.x, g.y);
    await win.mouse.down();
    await win.mouse.move(g.x + 60, g.y, { steps: 4 });
    await win.evaluate(() => window.__setLayout('2x1')); // 3 cols -> 2, mid-drag
    await win.waitForTimeout(120);
    await win.mouse.move(g.x + 200, g.y, { steps: 6 });
    await win.waitForTimeout(60);
    await win.mouse.up();
    await win.waitForTimeout(150);
    const end = await geometry();
    const reported = await win.evaluate(() => window.__lastResize);
    console.log(`  layout changed mid-drag: tracks=${end.cols}x${end.rows} onResize=${JSON.stringify(reported)}`);
    check('a layout change mid-drag never persists fractions for the old track count',
      reported === null || reported.cols.length === end.cols, JSON.stringify(reported));
    check('and the grid the drag was abandoned on is still an exact tiling',
      tiling(end).exact && tiling(end).coversStage,
      `overlap=${tiling(end).overlap.toFixed(2)} uncovered=${tiling(end).uncovered}`);
  }

  // (d) keyboard resize — the handles are focusable separators.
  await setLayout('2x2');
  await win.waitForTimeout(150);
  const kb0 = await geometry();
  const role = await win.evaluate(() => {
    const d = document.querySelector('[data-divider="col0-0"]');
    return { role: d.getAttribute('role'), orient: d.getAttribute('aria-orientation'), tab: d.tabIndex };
  });
  check('a handle is an ARIA separator, focusable, with its orientation declared',
    role.role === 'separator' && role.orient === 'vertical' && role.tab === 0, JSON.stringify(role));
  await win.locator('[data-divider="col0-0"]').focus();
  await win.keyboard.press('ArrowRight');
  await win.keyboard.press('ArrowRight');
  await win.waitForTimeout(120);
  const kb1 = await geometry();
  console.log(`  two ArrowRight presses: a ${w(kb0, 'a').toFixed(1)} -> ${w(kb1, 'a').toFixed(1)}`);
  check('arrow keys resize the seam without a mouse',
    Math.abs(w(kb1, 'a') - w(kb0, 'a') - 32) < 2, `+${(w(kb1, 'a') - w(kb0, 'a')).toFixed(1)}px`);
}

if (SHOW) {
  console.log('\n--show: window left open, ctrl-c to exit');
  await new Promise(() => {});
}
await win.close().catch(() => {});
await new Promise((r) => {
  const proc = app.process();
  const t = setTimeout(() => { proc.kill(); r(); }, 5_000);
  proc.once('exit', () => { clearTimeout(t); r(); });
});
fs.rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
