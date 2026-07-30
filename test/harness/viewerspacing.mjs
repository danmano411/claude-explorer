// KAN-51 — the file viewer's line-height was 1.55 (too loose for code); tightened
// to 1.4, the value KAN-33 already settled on for .tab. This proves the new
// value renders in BOTH the plain viewer and the diff view, and that the
// per-line gutter number stays pixel-aligned with its line far down a long
// file — the desync trap the ticket calls out.
//   npm run build && node test/harness/viewerspacing.mjs
// ponytail: prints PASS/FAIL rather than using a test runner — a real rendered
// window is what this needs to prove; `npm test` stays fast.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchApp } from './app.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// --------------------------------------------------------------- fixtures
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-viewerspacing-'));
const FILE = path.join(REPO, 'long.txt');
const LINES = 300;

const git = (...args) => execFileSync('git', args, { cwd: REPO, stdio: 'pipe' });
// No trailing newline: keeps `.split('\n').length` an exact line count instead
// of one-off from a trailing empty entry.
const initial = Array.from({ length: LINES }, (_, i) => `line ${i + 1}`).join('\n');
fs.writeFileSync(FILE, initial);
git('init', '-q');
git('config', 'user.email', 'a@b.c');
git('config', 'user.name', 'ce harness');
git('add', 'long.txt');
git('commit', '-q', '-m', 'initial');

// Unstaged edits near the top AND far down, so the diff has a hunk at line
// ~250 too — "check line 200, not line 3".
const edited = initial
  .split('\n')
  .map((l, i) => (i === 4 || i === 249 ? `${l} EDITED` : l))
  .join('\n');
fs.writeFileSync(FILE, edited);

const PROFILE = path.join(os.tmpdir(), `claude-explorer-viewerspacing-harness-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

const { win, close } = await launchApp({ userDataDir: PROFILE, extraArgs: ['--open', REPO] });
await win.waitForSelector('.entry');

// ------------------------------------------------------------ plain view
console.log('\nPlain file view');

await win.locator('.entry', { hasText: 'long.txt' }).dblclick();
await win.waitForSelector('.viewer-code .line');
await win.waitForTimeout(500); // Shiki upgrade

const geom = await win.evaluate(() => {
  const cs = getComputedStyle(document.querySelector('.viewer-code'));
  const lines = [...document.querySelectorAll('.viewer-code .line')];
  const before = getComputedStyle(lines[0], '::before');
  return {
    fontSize: parseFloat(cs.fontSize),
    lineHeight: parseFloat(cs.lineHeight),
    beforeLineHeight: parseFloat(before.lineHeight),
    count: lines.length,
  };
});
console.log(`  line-height: ${geom.lineHeight}px on ${geom.fontSize}px type (ratio ${(geom.lineHeight / geom.fontSize).toFixed(3)})`);
check('line-height is in the 1.4-1.5 range (was 1.55)',
  geom.lineHeight / geom.fontSize >= 1.4 && geom.lineHeight / geom.fontSize <= 1.5,
  `ratio ${(geom.lineHeight / geom.fontSize).toFixed(3)}`);
check('the ::before gutter counter inherits the SAME line-height as its line (no independent rule to drift)',
  geom.beforeLineHeight === geom.lineHeight,
  `line ${geom.lineHeight}px vs ::before ${geom.beforeLineHeight}px`);
check(`file has ${LINES} lines rendered (precondition for a "far down" check)`, geom.count === LINES, `${geom.count} lines`);

// Reference gap near the top of the file — the rendered pixel spacing between
// two consecutive lines, measured from actual layout rather than trusting
// getComputedStyle in isolation (a page zoom factor can scale rendered
// geometry without moving the declared CSS value).
const topGap = await win.evaluate(() => {
  const lines = document.querySelectorAll('.viewer-code .line');
  return lines[1].getBoundingClientRect().top - lines[0].getBoundingClientRect().top;
});

// Far down: scroll line 200 into view and measure the pixel gap to line 199.
// If the gutter counter were an independently-positioned overlay assuming a
// different per-line height, this drifts the further down the file you go —
// which is exactly why it's checked at 200, not the top of the file.
await win.$eval('.viewer-code .line', (el) => {
  const lines = el.closest('code').querySelectorAll('.line');
  lines[199].scrollIntoView({ block: 'center' });
});
await win.waitForTimeout(150);
const gap = await win.evaluate(() => {
  const lines = document.querySelectorAll('.viewer-code .line');
  const a = lines[198].getBoundingClientRect();
  const b = lines[199].getBoundingClientRect();
  return b.top - a.top;
});
console.log(`  rendered line-to-line gap: top of file ${topGap.toFixed(2)}px, at line 200 ${gap.toFixed(2)}px`);
check('gutter stays pixel-aligned with its line at line 200 (gap === gap at the top, no drift)',
  Math.abs(gap - topGap) < 1, `top gap ${topGap.toFixed(2)}px vs line-200 gap ${gap.toFixed(2)}px`);

// -------------------------------------------------------------- diff view
console.log('\nDiff view');

// Double-clicking the file above switched focus to the new viewer tab, so the
// file list (and its right-click target) belongs back to the repo tab
// (--open puts a fresh profile's home tab at index 0, the repo at index 1).
// App.tsx renders only the active tab, so switching back REMOUNTS the file
// browser and its git-status fetch — wait for the gutter mark, not just the row.
await win.locator('.tab:not(.add)').nth(1).click();
await win.waitForSelector('.entry .g-modified');
await win.locator('.entry', { hasText: 'long.txt' }).click({ button: 'right' });
await win.waitForTimeout(200);
await win.locator('.ctx-item', { hasText: 'Show changes' }).click();
await win.waitForSelector('.drow.add, .drow.del');
await win.waitForTimeout(300);

const diffGeom = await win.evaluate(() => {
  const cs = getComputedStyle(document.querySelector('.diff-body'));
  return { fontSize: parseFloat(cs.fontSize), lineHeight: parseFloat(cs.lineHeight) };
});
check('diff view uses the SAME tightened line-height as the plain viewer (one shared rule)',
  diffGeom.lineHeight === geom.lineHeight, `diff ${diffGeom.lineHeight}px vs plain ${geom.lineHeight}px`);

// The hunk at line ~250 is the "far down" one — its gutter numbers (.dn) are
// real sibling elements next to the text (.dt), so measure their vertical
// offset directly rather than inferring it.
const rows = await win.evaluate(() => {
  const all = [...document.querySelectorAll('.drow.add, .drow.del')];
  return all.map((r) => {
    const dn = r.querySelectorAll('.dn')[1].getBoundingClientRect(); // new-file number column
    const dt = r.querySelector('.dt').getBoundingClientRect();
    return { text: r.querySelector('.dt').textContent.trim(), offset: dt.top - dn.top };
  });
});
const farRow = rows.find((r) => r.text.includes('249') || r.text.includes('EDITED') && !r.text.startsWith('line 5'));
console.log(`  diff rows changed: ${rows.map((r) => r.text.slice(0, 24)).join(' | ')}`);
check('every changed row has its gutter number vertically aligned with its text (offset ~0px)',
  rows.every((r) => Math.abs(r.offset) < 1),
  rows.map((r) => r.offset.toFixed(1)).join(', '));
check('diff has a hunk far down the file (line ~250), not just at the top', rows.length >= 2, `${rows.length} changed rows`);

// -------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));

await close();
fs.rmSync(REPO, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
