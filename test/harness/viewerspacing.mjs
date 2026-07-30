// KAN-51 — the file viewer rendered every line in TWO line boxes, not one.
// `plainHtml()` and Shiki both join `<span class="line">` blocks with '\n'
// inside a `<pre>`; under `white-space: pre` those newline text nodes are
// non-collapsible, so each one lays out an empty anonymous block after its
// line and the pitch comes out at exactly 2x the declared line-height.
//
// The load-bearing assertion here is "measured line-to-line pitch === the
// computed line-height". It is the only check that catches the doubling —
// every ratio- or gap-vs-gap comparison passes happily at 2x, because block
// stacking is uniform whether or not the extra boxes exist.
//   npm run build && node test/harness/viewerspacing.mjs
// ponytail: prints PASS/FAIL rather than using a test runner — a real rendered
// window is what this needs to prove; `npm test` stays fast.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launchApp } from './app.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// --------------------------------------------------------------- fixtures
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-viewerspacing-'));
const FILE = path.join(REPO, 'long.txt');
const LINES = 300;
const LONG_LINE = 100; // 1-based: a 400-char line, must not wrap
const BLANK_LINE = 150; // 1-based: empty, must still occupy one full line box

const git = (...args) => execFileSync('git', args, { cwd: REPO, stdio: 'pipe' });
// No trailing newline: keeps `.split('\n').length` an exact line count instead
// of one-off from a trailing empty entry.
const initial = Array.from({ length: LINES }, (_, i) => {
  if (i + 1 === LONG_LINE) return `line ${i + 1} ` + 'x'.repeat(400);
  if (i + 1 === BLANK_LINE) return '';
  return `line ${i + 1}`;
}).join('\n');
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
console.log(`  computed line-height: ${geom.lineHeight}px on ${geom.fontSize}px type (ratio ${(geom.lineHeight / geom.fontSize).toFixed(3)})`);
check('the ::before gutter counter inherits the SAME line-height as its line (no independent rule to drift)',
  geom.beforeLineHeight === geom.lineHeight,
  `line ${geom.lineHeight}px vs ::before ${geom.beforeLineHeight}px`);
check(`file has ${LINES} lines rendered (precondition for a "far down" check)`, geom.count === LINES, `${geom.count} lines`);

// Measured far down the file, not at the top: scroll line 200 into view and
// take the real pitch between lines 199 and 200.
await win.$eval('.viewer-code .line', (el) => {
  const lines = el.closest('code').querySelectorAll('.line');
  lines[199].scrollIntoView({ block: 'center' });
});
await win.waitForTimeout(150);
const plain = await win.evaluate((blank) => {
  const lines = document.querySelectorAll('.viewer-code .line');
  const code = document.querySelector('.viewer-code code');
  const box = document.querySelector('.viewer-code');
  return {
    pitch: lines[199].getBoundingClientRect().top - lines[198].getBoundingClientRect().top,
    blankHeight: lines[blank - 1].getBoundingClientRect().height,
    longHeight: lines[99].getBoundingClientRect().height,
    codeWidth: code.getBoundingClientRect().width,
    scrollWidth: box.scrollWidth,
    clientWidth: box.clientWidth,
  };
}, BLANK_LINE);
console.log(`  measured pitch at line 200: ${plain.pitch.toFixed(3)}px  (computed line-height ${geom.lineHeight}px)`);

// THE assertion. Each `.line` is a block, and `plainHtml()`/Shiki put a literal
// '\n' text node between them; inside `white-space: pre` that newline is not
// collapsible, so it lays out its own anonymous block and the pitch doubles.
// A ratio check or a gap-vs-gap check cannot see this — only pitch measured
// against the line-height the CSS actually declares.
check('plain view: measured line pitch === the computed line-height (one line box per line, not two)',
  Math.abs(plain.pitch - geom.lineHeight) < 0.5,
  `pitch ${plain.pitch.toFixed(3)}px vs line-height ${geom.lineHeight}px (ratio ${(plain.pitch / geom.lineHeight).toFixed(2)}x)`);

// The ticket in the user's words — "a lot of space from line to line". Stated
// against the font size, so it holds whatever leading the design settles on
// and still fails at the 3.10x main was shipping.
check('rendered line-to-line pitch is a normal code leading (1.3-1.6x the font size)',
  plain.pitch / geom.fontSize >= 1.3 && plain.pitch / geom.fontSize <= 1.6,
  `${(plain.pitch / geom.fontSize).toFixed(2)}x the ${geom.fontSize}px type`);

// The fix relaxes `white-space` on the <code> wrapper, so guard what that
// could plausibly break: indentation/no-wrap on the lines themselves.
check('a 400-char line still does not wrap (indentation + no-wrap survive the white-space change)',
  Math.abs(plain.longHeight - geom.lineHeight) < 0.5,
  `long line ${plain.longHeight.toFixed(2)}px tall vs one line ${geom.lineHeight}px`);
check('a long file still scrolls horizontally',
  plain.scrollWidth > plain.clientWidth,
  `scrollWidth ${plain.scrollWidth}px > clientWidth ${plain.clientWidth}px`);
check('a blank line still occupies exactly one line box (::before counter holds it open)',
  Math.abs(plain.blankHeight - geom.lineHeight) < 0.5,
  `blank line ${plain.blankHeight.toFixed(2)}px vs ${geom.lineHeight}px`);

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

const diff = await win.evaluate(() => {
  const body = document.querySelector('.diff-body');
  const cs = getComputedStyle(body);
  const rows = [...document.querySelectorAll('.diff-rows > .drow')];
  // Two adjacent plain context rows: `.drow.hunk` carries margin-top, and an
  // add/del pair sits across a background change — neither is a clean pitch.
  let pitch = NaN;
  for (let i = 0; i + 1 < rows.length; i++) {
    if (rows[i].className === 'drow ctx' && rows[i + 1].className === 'drow ctx') {
      pitch = rows[i + 1].getBoundingClientRect().top - rows[i].getBoundingClientRect().top;
      break;
    }
  }
  const changed = [...document.querySelectorAll('.drow.add, .drow.del')].map((r) => ({
    text: r.querySelector('.dt').textContent.trim(),
    newNo: parseInt(r.querySelectorAll('.dn')[1].textContent, 10),
    oldNo: parseInt(r.querySelectorAll('.dn')[0].textContent, 10),
  }));
  return { fontSize: parseFloat(cs.fontSize), lineHeight: parseFloat(cs.lineHeight), pitch, changed };
});
console.log(`  diff rows changed: ${diff.changed.map((r) => r.text.slice(0, 24)).join(' | ')}`);
console.log(`  measured pitch: ${diff.pitch.toFixed(3)}px  (computed line-height ${diff.lineHeight}px)`);

check('diff view uses the SAME tightened line-height as the plain viewer (one shared rule)',
  diff.lineHeight === geom.lineHeight, `diff ${diff.lineHeight}px vs plain ${geom.lineHeight}px`);
check('diff view: measured row pitch === the computed line-height',
  Math.abs(diff.pitch - diff.lineHeight) < 0.5,
  `pitch ${diff.pitch.toFixed(3)}px vs line-height ${diff.lineHeight}px (ratio ${(diff.pitch / diff.lineHeight).toFixed(2)}x)`);
// The acceptance criterion the declaration-only check missed: sharing one CSS
// rule is not the same as rendering at one pitch.
check('the two views RENDER at the same pitch, not merely share a declaration',
  Math.abs(diff.pitch - plain.pitch) < 0.5,
  `diff ${diff.pitch.toFixed(3)}px vs plain ${plain.pitch.toFixed(3)}px`);
check('diff has a changed hunk far down the file (a changed row numbered >= 200)',
  diff.changed.some((r) => (r.newNo || r.oldNo) >= 200),
  `changed rows at lines ${diff.changed.map((r) => r.newNo || r.oldNo).join(', ')}`);

// -------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));

await close();
fs.rmSync(REPO, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
