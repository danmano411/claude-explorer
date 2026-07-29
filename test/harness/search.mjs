// M3 search cases, run against the real window.
//   npm run build && node test/harness/search.mjs
// Searches this repo, so the expected hits are the project's own source.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const { win, close } = await launchApp();
await win.waitForSelector('.entry');

// Point the tab at this repo via the address bar (reachable since KAN-24).
const ab = await win.locator('.address').boundingBox();
await win.mouse.click(ab.x + ab.width - 20, ab.y + ab.height / 2);
await win.locator('.address-input').fill(ROOT);
await win.keyboard.press('Enter');
await win.waitForTimeout(1200);
check('navigated to the repo', (await win.locator('.entry').count()) > 5,
  `${await win.locator('.entry').count()} entries`);

// --- open ---------------------------------------------------------------
await win.locator('.entries').click({ position: { x: 400, y: 10 } });
await win.keyboard.press('Control+f');
await win.waitForTimeout(400);
check('Ctrl+F opens the search overlay', await win.locator('.search-input').isVisible());

// --- instant name filter (no ripgrep) -----------------------------------
await win.keyboard.type('package');
await win.waitForTimeout(500);
const nameRows = await win.locator('.search-row').count();
const firstName = await win.locator('.search-row .search-name').first().textContent();
check('typing matches names instantly', nameRows > 0 && /package/i.test(firstName ?? ''),
  `${nameRows} rows, first "${firstName?.trim()}"`);

// The list behind must be untouched — that is what makes it an overlay.
check('file list is not replaced', (await win.locator('.entry').count()) > 5);

// --- deep content search via ripgrep ------------------------------------
for (let i = 0; i < 'package'.length; i++) await win.keyboard.press('Backspace');
await win.keyboard.type('resolveRg');
await win.waitForTimeout(300);
await win.keyboard.press('Enter');
await win.waitForTimeout(6000);

const rows = await win.locator('.search-row').count();
const withLines = await win.locator('.search-line').count();
check('content search returns hits from inside files', rows > 0, `${rows} rows`);
check('content hits carry line numbers', withLines > 0, `${withLines} rows with :line`);

const preview = await win.locator('.search-preview').first().textContent();
check('content hits show the matching line', /resolveRg/i.test(preview ?? ''),
  `"${preview?.trim().slice(0, 60)}"`);

const status = await win.locator('.search-status').textContent();
check('status is not the missing-binary state', !/binary missing/.test(status ?? ''),
  `status "${status?.trim()}"`);

await win.screenshot({ path: path.join(ROOT, 'test/harness/search-shot.png') });

// --- keyboard + close ----------------------------------------------------
await win.keyboard.press('ArrowDown');
await win.waitForTimeout(200);
check('arrow keys move the highlight', (await win.locator('.search-row.active').count()) === 1);

await win.keyboard.press('Escape');
await win.waitForTimeout(300);
check('Escape closes the overlay', (await win.locator('.search-input').count()) === 0);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));

await close();
process.exit(failed.length ? 1 : 0);
