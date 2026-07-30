// KAN-33: tab strip visual fixes.
//   npm run build && node test/harness/tabvisuals.mjs
//
// Proves, against the real running app, that:
//   1. a file tab and a Claude terminal tab render at the SAME height (the
//      reported bug: file tabs were taller than Claude tabs);
//   2. an unfocused tab with a long title truncates its label and keeps its
//      close (x) button fully inside the tab's own box, and that button is
//      actually clickable there (not just geometrically present);
//   3. a FOCUSED tab with a long title expands past the unfocused cap to
//      show more of the name, but is still bounded by the enforced ch
//      ceiling (`.tab.active { max-width: 40ch }`) rather than growing
//      without limit.
//
// Both extra tabs are opened WITHOUT a real Claude CLI round trip where
// avoidable (a plain shell tab is instant); the one Claude tab used for the
// height comparison only needs the pty handle to exist — not a ready
// terminal — so it does not pay the ~seconds-long trust-prompt cost that
// test/harness/resume.mjs incurs.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const PROFILE = path.join(os.tmpdir(), 'claude-explorer-tabvisuals-harness');
fs.rmSync(PROFILE, { recursive: true, force: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const { win, close } = await launchApp({ userDataDir: PROFILE });

// --- tab 1: the home file tab, already open at launch ----------------------
await win.waitForSelector('.tab:not(.add)');
await win.waitForTimeout(500);

// --- tab 2: a NEW file tab, then convert it in place into a Claude terminal
// (the orange arrow / entry-open path), exactly like a user opening Claude
// on a folder. We only need the tab to switch to terminalKind:'claude' —
// not for the CLI to finish starting up — so no long wait here.
await win.click('.tab.add');
await win.waitForTimeout(600);
await win.waitForSelector('.entry-open');
await win.locator('.entry-open').first().click();
await win.waitForTimeout(2000);

// --- tab 3: one more file tab, so tabs 1 and 2 are BOTH unfocused when we
// compare them. Comparing an active tab to an inactive one would confound
// the height measurement with the (deliberate) active-tab border/padding
// difference, not the bug this harness exists to catch.
await win.click('.tab.add');
await win.waitForTimeout(600);

const tabCount = await win.locator('.tab:not(.add)').count();
check('three tabs open (file, claude terminal, file)', tabCount === 3, `${tabCount} tabs`);

// ============================================================================
// 1. Height parity: file tab vs Claude terminal tab, both unfocused.
// ============================================================================
{
  const heights = await win.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tab:not(.add)')];
    return tabs.slice(0, 2).map((t) => ({
      cls: t.className,
      hasStatusDot: !!t.querySelector('.tab-status'),
      height: t.getBoundingClientRect().height,
    }));
  });
  console.log('  tab heights:', JSON.stringify(heights));
  const [fileTab, claudeTab] = heights;
  check('tab 2 is in fact the Claude terminal tab (has the status dot)', claudeTab?.hasStatusDot === true,
    JSON.stringify(claudeTab));
  check('neither compared tab is focused (a fair, apples-to-apples comparison)',
    !fileTab?.cls.includes('active') && !claudeTab?.cls.includes('active'),
    `${fileTab?.cls} / ${claudeTab?.cls}`);
  const diff = fileTab && claudeTab ? Math.abs(fileTab.height - claudeTab.height) : Infinity;
  check('file tab and Claude terminal tab render at the same height', diff < 0.5,
    `file=${fileTab?.height} claude=${claudeTab?.height} diff=${diff}`);
}

// ============================================================================
// 2. Unfocused long title: truncated, close button still inside the tab and
//    clickable.
// ============================================================================
const LONG_TITLE = 'This Is A Deliberately Very Long Folder Name For Truncation Testing';
{
  // Rename tab 1 (still unfocused — tab 3 is active). Right-click → Rename →
  // type → Enter, the same path a user takes from the tab context menu.
  const tab1 = win.locator('.tab:not(.add)').nth(0);
  await tab1.click({ button: 'right' });
  await win.waitForTimeout(200);
  await win.locator('.ctx-item', { hasText: 'Rename' }).click();
  await win.waitForTimeout(150);
  await win.locator('.tab-rename').fill(LONG_TITLE);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(200);

  const measured = await win.evaluate(() => {
    const t = document.querySelectorAll('.tab:not(.add)')[0];
    const title = t.querySelector('.tab-title');
    const closeEl = t.querySelector('.close');
    const tabRect = t.getBoundingClientRect();
    const closeRect = closeEl.getBoundingClientRect();
    return {
      cls: t.className,
      tabRect: { left: tabRect.left, right: tabRect.right, width: tabRect.width },
      closeRect: { left: closeRect.left, right: closeRect.right, width: closeRect.width, height: closeRect.height },
      titleScrollWidth: title.scrollWidth,
      titleClientWidth: title.clientWidth,
      titleText: title.textContent,
    };
  });
  console.log('  unfocused long-title tab:', JSON.stringify(measured));

  check('the rename actually landed (full untruncated string is the real title text)',
    measured.titleText === LONG_TITLE, measured.titleText);
  check('unfocused tab did not grow past the unfocused cap (~220px)', measured.tabRect.width <= 221,
    `width=${measured.tabRect.width}`);
  check('the label is visually truncated (its content is wider than its box)',
    measured.titleScrollWidth > measured.titleClientWidth,
    `scrollWidth=${measured.titleScrollWidth} clientWidth=${measured.titleClientWidth}`);
  const closeInBounds = measured.closeRect.left >= measured.tabRect.left - 0.5
    && measured.closeRect.right <= measured.tabRect.right + 0.5;
  check('the close (x) button is geometrically inside the tab\'s own box', closeInBounds,
    `close=[${measured.closeRect.left},${measured.closeRect.right}] tab=[${measured.tabRect.left},${measured.tabRect.right}]`);
  check('the close button has real, visible size (not collapsed/hidden)',
    measured.closeRect.width > 0 && measured.closeRect.height > 0,
    `${measured.closeRect.width}x${measured.closeRect.height}`);
}

// ============================================================================
// 3. Focused expansion, bounded by the ch ceiling.
// ============================================================================
{
  // Focus tab 1 (still carrying LONG_TITLE, 69 chars — longer than the 40ch
  // ceiling, so it should grow past the unfocused cap but NOT show the full
  // string).
  await win.locator('.tab:not(.add)').nth(0).click();
  await win.waitForTimeout(200);

  const focused = await win.evaluate(() => {
    const t = document.querySelectorAll('.tab:not(.add)')[0];
    const title = t.querySelector('.tab-title');
    const cs = getComputedStyle(t);
    return {
      cls: t.className,
      width: t.getBoundingClientRect().width,
      computedMaxWidthPx: parseFloat(cs.maxWidth),
      titleScrollWidth: title.scrollWidth,
      titleClientWidth: title.clientWidth,
    };
  });
  console.log('  focused long-title tab (69 chars, over the 40ch ceiling):', JSON.stringify(focused));

  check('the tab is actually focused for this measurement', focused.cls.includes('active'), focused.cls);
  check('focused tab grew past the unfocused 220px cap', focused.width > 221, `width=${focused.width}`);
  check('growth is bounded by the enforced ch ceiling, not unlimited',
    focused.width <= focused.computedMaxWidthPx + 0.5,
    `width=${focused.width} ceiling(40ch resolved)=${focused.computedMaxWidthPx}`);
  check('a title longer than the ceiling is STILL truncated even while focused',
    focused.titleScrollWidth > focused.titleClientWidth,
    `scrollWidth=${focused.titleScrollWidth} clientWidth=${focused.titleClientWidth}`);

  // Now a title that fits comfortably under the 40ch ceiling: focusing
  // should show the WHOLE name (the "expand to fit" half of the requirement,
  // as distinct from "expansion is capped").
  const FITS_TITLE = 'Fits Under Ceiling';
  await win.locator('.tab:not(.add)').nth(0).click({ button: 'right' });
  await win.waitForTimeout(200);
  await win.locator('.ctx-item', { hasText: 'Rename' }).click();
  await win.waitForTimeout(150);
  await win.locator('.tab-rename').fill(FITS_TITLE);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(200);

  const fits = await win.evaluate(() => {
    const t = document.querySelectorAll('.tab:not(.add)')[0];
    const title = t.querySelector('.tab-title');
    return {
      cls: t.className,
      titleScrollWidth: title.scrollWidth,
      titleClientWidth: title.clientWidth,
      titleText: title.textContent,
    };
  });
  console.log('  focused short-enough title:', JSON.stringify(fits));
  check('a title that fits under the ceiling is NOT truncated while focused (full name is shown)',
    fits.titleScrollWidth <= fits.titleClientWidth + 0.5,
    `scrollWidth=${fits.titleScrollWidth} clientWidth=${fits.titleClientWidth} text="${fits.titleText}"`);
}

// ============================================================================
// 4. The close button on a truncated tab is not just visible — it is
//    clickable, and clicking it closes exactly that tab.
// ============================================================================
{
  // Put the long title back, defocus tab 1 again (click tab 3), then click
  // tab 1's close button at its own coordinates.
  const tab1 = win.locator('.tab:not(.add)').nth(0);
  await tab1.click({ button: 'right' });
  await win.waitForTimeout(200);
  await win.locator('.ctx-item', { hasText: 'Rename' }).click();
  await win.waitForTimeout(150);
  await win.locator('.tab-rename').fill(LONG_TITLE);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(200);
  await win.locator('.tab:not(.add)').nth(2).click(); // defocus tab 1
  await win.waitForTimeout(200);

  const before = await win.locator('.tab:not(.add)').count();
  const closeBox = await tab1.locator('.close').boundingBox();
  await win.mouse.click(closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2);
  await win.waitForTimeout(300);
  const after = await win.locator('.tab:not(.add)').count();
  check('clicking the close button on a truncated, unfocused tab actually closes it',
    after === before - 1, `before=${before} after=${after}`);
}

await close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
