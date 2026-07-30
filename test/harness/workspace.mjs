// M5: does the tab set survive a restart?
//   npm run build && node test/harness/workspace.mjs
// Launches the app twice against the same userData, so it exercises the real
// workspace.json round trip rather than a mocked store.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const clean = (t) => t.replace(/\s+/g, ' ').trim();
const titlesOf = (win) =>
  win.locator('.tab:not(.add)').allTextContents().then((ts) => ts.map(clean));
const activeTitle = (win) => win.locator('.tab.active').first().textContent().then(clean);

let activeBefore; // KAN-43: which tab had focus when run 1 was torn down

// --- run 1: create a second tab pointed somewhere identifiable -------------
{
  const { win, close } = await launchApp();
  await win.waitForSelector('.entry');
  await win.click('.tab.add');
  await win.waitForTimeout(600);

  const ab = await win.locator('.address').boundingBox();
  await win.mouse.click(ab.x + ab.width - 20, ab.y + ab.height / 2);
  await win.locator('.address-input').fill(ROOT);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1200);

  const titles = await titlesOf(win);
  check('two tabs open before restart', titles.length === 2, titles.join(' | '));

  // The restore-the-active-tab assertion below is only meaningful if the focused
  // tab is NOT index 0 — landing on index 0 is exactly the old behaviour.
  activeBefore = await activeTitle(win);
  check('the second tab is the focused one before restart',
    activeBefore === titles[1] && activeBefore !== titles[0],
    `active "${activeBefore}" of ${titles.join(' | ')}`);

  // The debounced save is 400ms; give it room before tearing the app down.
  await win.waitForTimeout(1500);
  await close();
}

// --- run 2: same userData, fresh process ----------------------------------
{
  const { win, close } = await launchApp();
  await win.waitForSelector('.tab:not(.add)');
  await win.waitForTimeout(1200);

  const titles = await titlesOf(win);
  check('tabs restored after restart', titles.length === 2, titles.join(' | '));
  check('the folder tab came back by name',
    titles.some((t) => /Claude Explorer/i.test(t)), titles.join(' | '));

  // KAN-43: restore used to hardcode `selectTab(restored[0].id)`, so every
  // restart threw away which tab you were on. Equality against run 1's recorded
  // active title — not "it's a files view" — because tab 1 is a files view too.
  const act = await activeTitle(win);
  check('the tab that had focus before the restart has it again (not tab 1)',
    act === activeBefore && act !== titles[0],
    `active "${act}", was "${activeBefore}", tab 1 is "${titles[0]}"`);

  const listed = await win.locator('.entry').count();
  check('the restored tab actually lists its folder', listed > 0, `${listed} entries`);
  await close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
