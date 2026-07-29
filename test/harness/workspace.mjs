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

  const titles = await win.locator('.tab:not(.add)').allTextContents();
  check('two tabs open before restart', titles.length === 2, titles.join(' | ').replace(/\s+/g, ' '));
  // The debounced save is 400ms; give it room before tearing the app down.
  await win.waitForTimeout(1500);
  await close();
}

// --- run 2: same userData, fresh process ----------------------------------
{
  const { win, close } = await launchApp();
  await win.waitForSelector('.tab:not(.add)');
  await win.waitForTimeout(1200);

  const titles = (await win.locator('.tab:not(.add)').allTextContents())
    .map((t) => t.replace(/\s+/g, ' ').trim());
  check('tabs restored after restart', titles.length === 2, titles.join(' | '));
  check('the folder tab came back by name',
    titles.some((t) => /Claude Explorer/i.test(t)), titles.join(' | '));

  const listed = await win.locator('.entry').count();
  check('the restored tab actually lists its folder', listed > 0, `${listed} entries`);
  await close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
