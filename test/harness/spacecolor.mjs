// KAN-84/85: per-space ambient color — preset swatches, the custom light/dark
// picker, and the chrome-band wash they both render through.
//   npm run build && node test/harness/spacecolor.mjs
//
// This is the one claim vitest/jsdom cannot make: that color-mix() actually
// paints something DIFFERENT, not merely that a --space-color-* custom
// property got set (KAN-84's own testing note calls that out by name — an
// element can carry the property while the wash stays invisible). So every
// check here reads getComputedStyle(...).backgroundColor on the REAL running
// app (a real Chromium, via Playwright/Electron) rather than asserting on
// React state or inline style strings.
//
// Proves against the real running app that:
//   1. an uncolored space's `.tabbar` renders IDENTICALLY to before this
//      feature (no color-mix() artifact, not even "tinted 0%");
//   2. two spaces given two different presets resolve to two DIFFERENT
//      backgroundColors, and switching between them changes what's on screen;
//   3. a preset repaints under dark mode (KAN-84 AC6);
//   4. a custom light/dark pair (KAN-85) resolves to a DIFFERENT color under
//      the two color schemes — the exact assertion KAN-85's ticket calls for,
//      not a self-comparison of the stored value;
//   5. Cancel on the custom picker changes nothing;
//   6. "No color" clears the wash back to the uncolored baseline;
//   7. a colored space survives a restart;
//   8. a corrupt color on disk is coerced away rather than crashing the app
//      or rendering garbage.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const spaceName = (win) => win.locator('.spacemenu-name').textContent().then((t) => t.trim());
const tabbarBg = (win) => win.$eval('.tabbar', (el) => getComputedStyle(el).backgroundColor);
const appColored = (win) => win.$eval('.app', (el) => el.classList.contains('app-colored'));

async function openSpaceMenu(win) {
  await win.click('.spacemenu-btn');
  await win.waitForSelector('.spacemenu-dropdown');
  await win.waitForTimeout(150);
}

async function createSpace(win, name) {
  await openSpaceMenu(win);
  await win.locator('.spacemenu-item', { hasText: 'New empty space' }).click();
  await win.waitForSelector('.spacemenu-rename');
  await win.locator('.spacemenu-rename').fill(name);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(400);
}

async function switchSpace(win, name) {
  await openSpaceMenu(win);
  await win.locator('.spacemenu-item-name', { hasText: name }).first().click();
  await win.waitForTimeout(300);
}

/**
 * Opens the space menu, then hovers and picks from the Color submenu — same
 * technique movespace.mjs's `pickSub` uses for "Move Tab to ▸": the submenu
 * opens on :hover with no state behind it, so hovering the parent row is the
 * whole of "open it", and the nested <ul> is a DOM child of that row, so the
 * pointer travelling onto it never leaves the parent's :hover. `rowText` is
 * matched exactly (`^...$`) so 'Sage' cannot accidentally match a longer row.
 */
async function pickColorRow(win, rowText) {
  await openSpaceMenu(win);
  await win.locator('.ctx-sub', { hasText: 'Color' }).hover();
  await win.waitForTimeout(200);
  await win.locator('.ctx-sub .ctx-menu .ctx-item', { hasText: new RegExp(`^${rowText}$`) })
    .first().click();
  await win.waitForTimeout(300);
}

const pickPreset = (win, presetName) => pickColorRow(win, presetName);
const clearColor = (win) => pickColorRow(win, 'No color');

async function openCustomPicker(win) {
  await openSpaceMenu(win);
  await win.locator('.ctx-sub', { hasText: 'Color' }).hover();
  await win.waitForTimeout(200);
  await win.locator('.ctx-sub .ctx-menu .ctx-item', { hasText: /^Custom…$/ }).first().click();
  await win.waitForSelector('.colorpicker');
  await win.waitForTimeout(150);
}

/** Sets a native `<input type=color>` or `<input type=range>` through React's
 *  own change detection: a plain `el.value = x` is invisible to a controlled
 *  input because React tracks the previous value via the native setter's
 *  descriptor, so this calls that setter explicitly before dispatching
 *  `input` — the same reason TabBar's drag harness dispatches real DOM events
 *  rather than mutating props directly. */
async function setInput(el, value) {
  await el.evaluate((node, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(node, v);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function setCustomColors(win, { lightHex, lightAlpha, darkHex, darkAlpha }) {
  const rows = win.locator('.colorpicker-row');
  const lightRow = rows.nth(0);
  const darkRow = rows.nth(1);
  await setInput(lightRow.locator('input[type="color"]'), lightHex);
  await setInput(lightRow.locator('input[type="range"]'), String(lightAlpha));
  await setInput(darkRow.locator('input[type="color"]'), darkHex);
  await setInput(darkRow.locator('input[type="range"]'), String(darkAlpha));
}

const PROFILE = path.join(os.tmpdir(), `claude-explorer-spacecolor-harness-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

// ===========================================================================
// Run 1 — presets, dark mode, the custom picker, cancel, and clearing.
// ===========================================================================
{
  const { win, close } = await launchApp({ userDataDir: PROFILE });
  await win.waitForSelector('.entry');
  await win.waitForTimeout(500);

  check('starts on the default space, uncolored', (await spaceName(win)) === 'Space' && !(await appColored(win)));
  const BASE = await tabbarBg(win);

  await createSpace(win, 'Beta');
  await createSpace(win, 'Gamma'); // stays uncolored for the whole run — the control
  await switchSpace(win, 'Space');
  check('back on the default space', (await spaceName(win)) === 'Space');

  // --- presets: two spaces, two different colors, two different renders ---
  await pickPreset(win, 'Sage');
  check('picking a preset marks the root .app "colored"', await appColored(win));
  const sageBg = await tabbarBg(win);
  check('a preset color actually repaints the tab strip — NOT just a property being set',
    sageBg !== BASE, `${BASE} -> ${sageBg}`);

  await switchSpace(win, 'Gamma');
  check('an UNCOLORED space is byte-identical to before this feature — no color-mix() artifact',
    !(await appColored(win)) && (await tabbarBg(win)) === BASE, await tabbarBg(win));

  await switchSpace(win, 'Beta');
  await pickPreset(win, 'Sand');
  const sandBg = await tabbarBg(win);
  check('a SECOND space with a DIFFERENT preset resolves to a DIFFERENT backgroundColor than the first',
    sandBg !== sageBg && sandBg !== BASE, `Sage=${sageBg} Sand=${sandBg}`);

  await switchSpace(win, 'Space');
  check('switching back reproduces the exact same rendered color (Sage), not a fresh one',
    (await tabbarBg(win)) === sageBg, `${sageBg} vs ${await tabbarBg(win)}`);

  // --- dark mode: the SAME preset must repaint (KAN-84 AC6) -----------------
  await win.emulateMedia({ colorScheme: 'dark' });
  await win.waitForTimeout(200);
  const sageDarkBg = await tabbarBg(win);
  check('the SAME preset renders a DIFFERENT color under dark mode (it repaints, not frozen)',
    sageDarkBg !== sageBg, `light=${sageBg} dark=${sageDarkBg}`);
  await win.emulateMedia({ colorScheme: 'light' });
  await win.waitForTimeout(200);
  check('and back to light mode restores the original color',
    (await tabbarBg(win)) === sageBg, await tabbarBg(win));

  // --- custom picker (KAN-85): light != dark under the two color schemes ---
  await switchSpace(win, 'Beta'); // currently Sand-colored
  await openCustomPicker(win);
  await setCustomColors(win, { lightHex: '#2244aa', lightAlpha: 0.6, darkHex: '#cc3311', darkAlpha: 0.6 });
  await win.locator('.modal-actions button.primary').click();
  await win.waitForTimeout(300);

  check('applying a custom color marks .app "colored"', await appColored(win));
  const customLightBg = await tabbarBg(win);
  check('the custom LIGHT color actually repaints (differs from the Sand preset it replaced)',
    customLightBg !== sandBg && customLightBg !== BASE, `${sandBg} -> ${customLightBg}`);

  await win.emulateMedia({ colorScheme: 'dark' });
  await win.waitForTimeout(200);
  const customDarkBg = await tabbarBg(win);
  check('THE KAN-85 CLAIM: a custom pair whose two halves differ renders a DIFFERENT resolved color per theme',
    customDarkBg !== customLightBg, `light=${customLightBg} dark=${customDarkBg}`);
  await win.emulateMedia({ colorScheme: 'light' });
  await win.waitForTimeout(200);

  // --- Cancel changes nothing (KAN-85 AC4) ----------------------------------
  await openCustomPicker(win);
  const preRow = win.locator('.colorpicker-row').nth(0);
  await setInput(preRow.locator('input[type="color"]'), '#00ff00');
  await win.locator('.modal-actions button:not(.primary)').click(); // Cancel
  await win.waitForTimeout(250);
  check('Cancel on the custom picker leaves the color exactly as it was',
    (await tabbarBg(win)) === customLightBg, `${customLightBg} vs ${await tabbarBg(win)}`);

  // --- "No color" clears the wash back to baseline --------------------------
  await clearColor(win);
  check('"No color" un-marks .app "colored" and returns the exact uncolored baseline',
    !(await appColored(win)) && (await tabbarBg(win)) === BASE, await tabbarBg(win));

  // Recolor Beta so the restart check below has something to find.
  await pickPreset(win, 'Clay');
  const clayBg = await tabbarBg(win);
  await switchSpace(win, 'Space'); // leave the picker looking at Space's Sage

  await win.waitForTimeout(1200); // 400ms persist debounce + margin
  await close();

  // ===========================================================================
  // Run 2 — same profile, fresh process: did the colors survive?
  // ===========================================================================
  const { win: win2, close: close2 } = await launchApp({ userDataDir: PROFILE });
  await win2.waitForSelector('.tab, .entry');
  await win2.waitForTimeout(1000);

  check('the app remembers which space you were in', (await spaceName(win2)) === 'Space');
  check('and that space\'s preset color survived the restart',
    (await appColored(win2)) && (await tabbarBg(win2)) === sageBg, await tabbarBg(win2));

  await switchSpace(win2, 'Beta');
  check('Beta\'s RECOLORED preset (Clay, applied after the custom color) survived too',
    (await appColored(win2)) && (await tabbarBg(win2)) === clayBg, await tabbarBg(win2));

  await switchSpace(win2, 'Gamma');
  check('Gamma is still uncolored after the restart', !(await appColored(win2)));

  await close2();
}

// ===========================================================================
// Run 3 — a corrupt color on disk must be coerced away, not crash the app or
// paint garbage. Seeded directly (real workspace.json), same technique
// splitview.mjs uses for its literal-file cases.
// ===========================================================================
{
  const profile = path.join(os.tmpdir(), `claude-explorer-spacecolor-corrupt-${process.pid}`);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const home = os.homedir();
  const doc = {
    version: 1,
    groups: [],
    tabs: [{ id: 't1', view: 'files', cwd: home, title: 'home' }],
    spaces: [{ id: 's1', name: 'Space', tabIds: ['t1'], layout: null, color: { light: 'red; } .app { display:none', dark: 42 } }],
    activeSpaceId: 's1',
  };
  fs.writeFileSync(path.join(profile, 'workspace.json'), JSON.stringify(doc, null, 2));

  const { win, close } = await launchApp({ userDataDir: profile });
  await win.waitForSelector('.entry', { timeout: 15_000 });
  await win.waitForTimeout(600);

  check('a corrupt color on disk does not crash the app — it still renders the space',
    (await spaceName(win)) === 'Space');
  check('and the corrupt value is coerced away, not rendered',
    !(await appColored(win)));

  await close();
  fs.rmSync(profile, { recursive: true, force: true });
}

fs.rmSync(PROFILE, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
