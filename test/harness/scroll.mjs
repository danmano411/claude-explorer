// KAN-23 — scrolling test cases, run against the real app.
//
//   npm run build && node test/harness/scroll.mjs
//   node test/harness/scroll.mjs --claude    also spawns a real Claude session
//
// The --claude case costs tokens and takes ~40s, so it is opt-in.
// ponytail: prints PASS/FAIL rather than using a test runner — these are slow
// integration checks against a live window, not unit tests. `npm test` stays fast.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp } from './app.mjs';

// The --claude case needs a folder visible in the default (home) listing.
const CLAUDE_DIR = path.join(os.homedir(), 'claudetest');
if (process.argv.includes('--claude')) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CLAUDE_DIR, 'notes.txt'), 'hello\n');
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const { win, close } = await launchApp();
await win.waitForSelector('.entry');

const wheelOver = async (selector, dy) => {
  const b = await win.locator(selector).boundingBox();
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await win.mouse.wheel(0, dy);
  await win.waitForTimeout(350);
};
// Terminals live in .pane wrappers only since the KAN-23 fix; stay tolerant of
// the old DOM so this suite can still run (and fail loudly) against a revert.
let VIS = '';
const listTop = () => win.$eval('.entries', (el) => el.scrollTop);
const resetList = () => win.$eval('.entries', (el) => { el.scrollTop = 0; });

// ---------------------------------------------------------------- file list
console.log('\nFile list');

const max = await win.$eval('.entries', (el) => el.scrollHeight - el.clientHeight);
check('file list overflows (precondition)', max > 150, `${max}px scrollable`);

await resetList();
await wheelOver('.entries', 100);
check('wheel scrolls the file list', (await listTop()) === 100, `scrollTop=${await listTop()}`);

await wheelOver('.entries', -100);
check('wheel scrolls back up', (await listTop()) === 0);

// Scroll position must belong to the tab, not to the recycled DOM node.
await resetList();
await wheelOver('.entries', 150);
await win.click('.tab.add');                       // new file tab, switches to it
await win.waitForTimeout(500);
const leaked = await listTop();
check('new file tab starts at the top', leaked === 0,
  leaked === 0 ? '' : `scrollTop=${leaked} — inherited from the other tab`);

await win.locator('.tab:not(.add)').first().click();
await win.waitForTimeout(400);
await wheelOver('.entries', 100);
check('wheel still works after a tab switch', (await listTop()) > 0);

// --------------------------------------------------------------- address bar
console.log('\nAddress bar');
const ab = await win.locator('.address').boundingBox();
await win.mouse.click(ab.x + ab.width - 20, ab.y + ab.height / 2);
await win.waitForTimeout(300);
const editable = await win.locator('.address-input').count();
check('clicking the empty address area opens the path input', editable === 1,
  editable ? '' : '.breadcrumb fills .address, so e.target === e.currentTarget never holds');
if (editable) await win.keyboard.press('Escape');

// ------------------------------------------------------------ shell terminal
console.log('\nShell terminal');
await win.locator('.tab:not(.add)').first().click({ button: 'right' });
await win.getByText('Open Terminal').click();
await win.waitForSelector(VIS + '.xterm', { timeout: 20_000 });
await win.waitForTimeout(4000);
VIS = (await win.locator('.pane').count()) ? '.pane:not([hidden]) ' : '';
const termTab = (await win.locator('.tab:not(.add)').count()) - 1;

await win.locator(VIS + '.xterm-screen').click();
await win.keyboard.type('1..300 | % { "line $_" }');
await win.keyboard.press('Enter');
await win.waitForTimeout(3500);

// xterm v6 draws its own scrollbar; a slider shorter than its track means
// there is real scrollback. .xterm-viewport no longer scrolls natively.
const slider = () => win.evaluate(() => {
  const t = (document.querySelector('.pane:not([hidden]) .scrollbar.vertical') ?? document.querySelector('.scrollbar.vertical'));
  const s = (document.querySelector('.pane:not([hidden]) .scrollbar.vertical .slider') ?? document.querySelector('.scrollbar.vertical .slider'));
  if (!t || !s) return { track: 0, slider: 0 };
  return {
    track: Math.round(t.getBoundingClientRect().height),
    slider: Math.round(s.getBoundingClientRect().height),
  };
});
const s1 = await slider();
check('300 lines of output create scrollback', s1.slider < s1.track, `slider ${s1.slider}/${s1.track}`);

const topRow = () => win.$eval(VIS + '.xterm-rows', (el) => el.children[0]?.textContent?.trim() ?? '');
const before = await topRow();
await wheelOver(VIS + '.xterm-screen', -400);
check('wheel scrolls terminal scrollback', (await topRow()) !== before,
  `"${before}" -> "${await topRow()}"`);

// The root cause: App.tsx renders only the active tab, and Terminal.tsx disposes
// the xterm on unmount — so a tab switch destroys the terminal and every piece of
// state it holds (scrollback, alt-screen mode, application-cursor mode).
await win.evaluate(() => { (document.querySelector('.pane:not([hidden]) .xterm') ?? document.querySelector('.xterm')).dataset.probe = 'original'; });
await win.locator('.tab:not(.add)').first().click();
await win.waitForTimeout(600);
await win.locator('.tab:not(.add)').nth(termTab).click();
await win.waitForSelector(VIS + '.xterm');
await win.waitForTimeout(1500);

const survived = await win.$eval(VIS + '.xterm', (el) => el.dataset.probe === 'original');
check('terminal survives a tab switch (not disposed)', survived,
  survived ? '' : 'xterm was destroyed and rebuilt — all terminal state lost');

const s2 = await slider();
check('scrollback survives a tab switch', s2.slider < s2.track, `slider ${s2.slider}/${s2.track}`);

// ------------------------------------------------------------------- Claude
if (process.argv.includes('--claude')) {
  console.log('\nClaude session (real)');
  await win.locator('.tab:not(.add)').first().click();
  await win.waitForSelector('.entry');
  const row = win.locator('.entry', { hasText: 'claudetest' });
  if (await row.count()) {
    await row.locator('.entry-open').click();
    await win.waitForSelector(VIS + '.xterm', { timeout: 20_000 });
    await win.waitForTimeout(12_000);
    if ((await win.$eval(VIS + '.xterm-rows', (el) => el.textContent)).toLowerCase().includes('trust')) {
      await win.locator(VIS + '.xterm-screen').click();
      await win.keyboard.press('Enter');
      await win.waitForTimeout(6000);
    }
    // Give it a transcript long enough that there is something to scroll —
    // otherwise "the rows didn't change" proves nothing either way.
    await win.locator(VIS + '.xterm-screen').click();
    await win.keyboard.type('Write the numbers 1 to 60 in words, one per line, nothing else.');
    await win.waitForTimeout(400);
    await win.keyboard.press('Enter');
    await win.waitForTimeout(35_000);           // let it finish; idle = clean signal

    const rowsNow = () => win.$eval(VIS + '.xterm-rows', (el) => el.textContent);
    const scrolls = async () => {
      const pre = await rowsNow();
      await wheelOver(VIS + '.xterm-screen', -400);
      await win.waitForTimeout(700);
      return pre !== (await rowsNow());
    };

    // Control: it must scroll BEFORE the tab switch, or the test below is void.
    const controlOk = await scrolls();
    check('CONTROL: wheel scrolls Claude before any tab switch', controlOk,
      controlOk ? '' : 'no scrollable transcript — the case below is inconclusive');

    await win.evaluate(() => { (document.querySelector('.pane:not([hidden]) .xterm') ?? document.querySelector('.xterm')).dataset.probe = 'claude'; });
    await win.click('.tab.add');
    await win.waitForTimeout(1200);
    await win.locator('.tab:not(.add)').first().click();
    await win.waitForSelector(VIS + '.xterm');
    await win.waitForTimeout(2000);
    const alive = await win.$eval(VIS + '.xterm', (el) => el.dataset.probe === 'claude');
    check('Claude terminal survives a tab switch', alive,
      alive ? '' : 'rebuilt xterm never saw Claude\'s mode sequences — wheel reaches nothing');

    if (controlOk) {
      const after = await scrolls();
      check('wheel still scrolls Claude after a tab switch', after,
        after ? '' : 'wheel reached nothing — the reported bug');
    }
  } else {
    console.log('  SKIP  no ~/claudetest folder');
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));

await close();
process.exit(failed.length ? 1 : 0);
