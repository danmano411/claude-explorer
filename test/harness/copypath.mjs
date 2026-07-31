// KAN-62: Copying a file in the file pane should ALSO put its absolute path
// on the clipboard as text, alongside whatever the pane's own in-app Cut/Copy
// already did (which never touched the OS clipboard at all — see below).
//   npm run build && node test/harness/copypath.mjs
//
// WHAT WAS MEASURED BEFORE WRITING ANY CODE, so §5 and §7/§8's red-first
// claims below make sense: grepping src/ and package.json for
// clipboard.write*/FileNameW/HDROP/Set-Clipboard found NOTHING outside
// preload's clipboardReadText/clipboardHasImage, both read-only. The file
// pane's Copy/Cut is `app.clipboard` (appstate.tsx) — pure React state read
// only by this pane's OWN Paste (fs copy/move over IPC). So "paste a
// Claude-Explorer copy into real Explorer" was ALREADY a no-op before this
// ticket: there was no CF_HDROP to preserve, and the regression this ticket
// warns about (a text flavour changing how Explorer reads a paste) cannot
// occur because Explorer never read anything from a Claude-Explorer Copy in
// the first place. §5 is the closest in-repo proof of that available without
// automating real explorer.exe: clipboard.writeText replaces the WHOLE
// clipboard with exactly one format, so there is no format for Explorer (or
// anything else) to newly misinterpret.
//
// §7-9 are the expensive ones — a real Claude session, content-level per
// KAN-60's own precedent (ask the model, don't just read the composer).
// Minutes, not seconds; budget for it.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { launchApp } from './app.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const skip = (name, why) => {
  results.push({ name, pass: false });
  console.log(`  SKIP  ${name}  — ${why} (counted as a FAILURE: the harness could not set itself up)`);
};
/** A MEASUREMENT, not a pass/fail claim — §9 exists to observe and report an
 *  UNMEASURED behaviour (multi-path bracketed paste), not to assert one. */
const note = (msg) => console.log(`  (measured) ${msg}`);

// Throwaway profile, pid-suffixed — see CLAUDE.md's testing notes on why.
const PROFILE = path.join(os.tmpdir(), `claude-explorer-copypath-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

const RUN = process.pid;
const VIS = '.pane:not([hidden]) ';

// --- a tiny PNG encoder, stdlib only (zlib.deflateSync + zlib.crc32) -------
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
/** A solid-color WxH RGB PNG — enough for the model to name the color back,
 *  same trick KAN-60's own measurement used (a magenta-bordered file). */
function solidPng(w, h, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB, no interlace
  const row = Buffer.alloc(1 + w * 3); // leading filter-type-0 byte per scanline
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[1 + x * 3 + 1] = g; row[1 + x * 3 + 2] = b; }
  const raw = Buffer.concat(Array(h).fill(row));
  return Buffer.concat([
    sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const CLAUDE_DIR = path.join(os.homedir(), 'claudetest');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

const MAGENTA = `kan62-magenta-${RUN}.png`;
const CYAN = `kan62-cyan-${RUN}.png`;
const NOTE = `kan62-note-${RUN}.txt`;
const magentaPath = path.join(CLAUDE_DIR, MAGENTA);
const cyanPath = path.join(CLAUDE_DIR, CYAN);
const notePath = path.join(CLAUDE_DIR, NOTE);
fs.writeFileSync(magentaPath, solidPng(64, 64, [255, 0, 255]));
fs.writeFileSync(cyanPath, solidPng(64, 64, [0, 255, 255]));
fs.writeFileSync(notePath, `KAN-62 non-image fixture ${RUN}\n`);
const cleanupFixtures = () => {
  for (const p of [magentaPath, cyanPath, notePath]) fs.rmSync(p, { force: true });
};

// Drive-letter case ('C:' vs 'c:') is not a claim this ticket makes, so
// comparisons are case-insensitive; everything else about the path must match.
const norm = (p) => (p ?? '').toLowerCase().replace(/\//g, '\\');

const { app, win, close } = await launchApp({ userDataDir: PROFILE });
win.on('pageerror', (e) => console.log('  [pageerror]', e.message));

const clipText = () => app.evaluate(({ clipboard }) => clipboard.readText());
const clipFormats = () => app.evaluate(({ clipboard }) => clipboard.availableFormats());
const clipClear = () => app.evaluate(({ clipboard }) => clipboard.clear());

/** Same address-bar edit a user would use — lifted from autolink.mjs / mcp.mjs,
 *  not reinvented. Enter unmounts the input (NavBar.tsx), so focus never gets
 *  stuck in a typing target that would swallow a later Ctrl+C/Ctrl+V. */
async function navigateTab(i, folder) {
  await win.locator('.tab:not(.add)').nth(i).click();
  await win.waitForTimeout(150);
  await win.locator(`${VIS}.address`).click();
  await win.waitForTimeout(100);
  await win.locator(`${VIS}.address-input`).fill(folder);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(500);
}

const entryRow = (name) => win.locator(`${VIS}.entry`, { hasText: name }).first();
const selectEntry = async (name) => { await entryRow(name).click(); await win.waitForTimeout(150); };
const ctrlClickEntry = async (name) => { await entryRow(name).click({ modifiers: ['Control'] }); await win.waitForTimeout(150); };
async function menuAction(name, label) {
  await entryRow(name).click({ button: 'right' });
  await win.waitForTimeout(250);
  await win.locator('.ctx-item', { hasText: label }).first().click();
  await win.waitForTimeout(200);
}

try {
  // ===========================================================================
  console.log('\n0. a Files tab pointed at ~/claudetest, with three fresh fixtures');
  // ===========================================================================
  await win.waitForSelector('.tab:not(.add)');
  await navigateTab(0, CLAUDE_DIR);
  await win.waitForSelector(`${VIS}.entry`, { timeout: 10_000 });
  for (const name of [MAGENTA, CYAN, NOTE]) {
    check(`fixture visible in the pane: ${name}`, (await entryRow(name).count()) > 0);
  }

  // ===========================================================================
  console.log('\n1. right-click Copy puts the absolute path on the OS clipboard as text');
  // ===========================================================================
  await clipClear();
  await menuAction(MAGENTA, 'Copy');
  const t1 = await clipText();
  check("Copy (context menu): OS clipboard text is the fixture's absolute path",
    norm(t1) === norm(magentaPath), `got ${JSON.stringify(t1)}, want ${JSON.stringify(magentaPath)}`);

  // ===========================================================================
  console.log('\n2. Ctrl+C does the same');
  // ===========================================================================
  await clipClear();
  await selectEntry(CYAN);
  await win.keyboard.press('Control+c');
  await win.waitForTimeout(200);
  const t2 = await clipText();
  check("Ctrl+C: OS clipboard text is the fixture's absolute path",
    norm(t2) === norm(cyanPath), `got ${JSON.stringify(t2)}, want ${JSON.stringify(cyanPath)}`);

  // ===========================================================================
  console.log('\n3. Cut (context menu) writes the path too, not just Copy');
  // ===========================================================================
  await clipClear();
  await menuAction(NOTE, 'Cut');
  const t3 = await clipText();
  check("Cut (context menu): OS clipboard text is the fixture's absolute path",
    norm(t3) === norm(notePath), `got ${JSON.stringify(t3)}, want ${JSON.stringify(notePath)}`);
  // Cut only ARMS the pane's own in-app Paste — nothing moves until something
  // pastes into a folder, which nothing here does. note.txt is untouched.

  // ===========================================================================
  console.log('\n4. multi-select Copy: one absolute path per line, in list order');
  // ===========================================================================
  const labels = await win.$$eval(`${VIS}.entry .entry-label`, (els) => els.map((e) => e.textContent || ''));
  const domOrder = [MAGENTA, CYAN].sort(
    (a, b) => labels.findIndex((t) => t.includes(a)) - labels.findIndex((t) => t.includes(b)));
  await clipClear();
  await selectEntry(domOrder[0]);
  await ctrlClickEntry(domOrder[1]);
  await win.keyboard.press('Control+c');
  await win.waitForTimeout(200);
  const t4 = await clipText();
  const want4 = [path.join(CLAUDE_DIR, domOrder[0]), path.join(CLAUDE_DIR, domOrder[1])].join('\n');
  check('multi-select Ctrl+C: one absolute path per line, in the list\'s own order',
    norm(t4) === norm(want4), `got ${JSON.stringify(t4)}, want ${JSON.stringify(want4)}`);

  // ===========================================================================
  console.log('\n5. the ONLY thing Copy adds to the OS clipboard is a text format');
  // ===========================================================================
  // Not a red-provable regression check — nothing wrote ANYTHING to the OS
  // clipboard on Copy before this ticket (see the file header), so there is no
  // "before" behaviour to diff against. This documents the actual formats
  // clipboard.writeText produced, which is the property that would matter if
  // Explorer (or anything else) ever tried to read this clipboard.
  const formats = await clipFormats();
  const looksLikeFileDrop = formats.some((f) => /file|hdrop|drop/i.test(f));
  note(`clipboard.availableFormats() after Copy: ${JSON.stringify(formats)}`);
  check('Copy never adds a format that looks like a file-drop payload',
    !looksLikeFileDrop, JSON.stringify(formats));

  // ===========================================================================
  console.log('\n6. [REGRESSION GUARD] the pane\'s own in-app Paste is unaffected');
  // ===========================================================================
  // Green on the unfixed build too — Copy/Cut called app.setClipboard directly
  // there, so this in-app behaviour cannot have changed. Kept anyway: it is
  // what would catch a `setClip` that intercepted the call instead of
  // forwarding it (e.g. wrote text but dropped app.setClipboard entirely).
  const subdir = path.join(CLAUDE_DIR, `kan62-paste-${RUN}`);
  fs.mkdirSync(subdir, { recursive: true });
  await menuAction(NOTE, 'Copy');
  await navigateTab(0, subdir);
  await win.waitForSelector(`${VIS}.entries`, { timeout: 10_000 });
  await win.keyboard.press('Control+v');
  await win.waitForTimeout(1200);
  const pastedInApp = fs.existsSync(path.join(subdir, NOTE));
  check("[REGRESSION GUARD] the pane's own Paste still copies the file",
    pastedInApp, `${path.join(subdir, NOTE)} exists: ${pastedInApp}`);
  fs.rmSync(subdir, { recursive: true, force: true });
  await navigateTab(0, CLAUDE_DIR);

  // ===========================================================================
  console.log('\n7-9. a real Claude session — content-level per KAN-60\'s own precedent');
  // ===========================================================================
  await win.click('.tab.add');
  await win.waitForTimeout(800);
  await win.waitForSelector(`${VIS}.entry`, { timeout: 15_000 });
  const claudeRow = win.locator(`${VIS}.entry`, { hasText: 'claudetest' }).first();
  if (!(await claudeRow.count())) {
    skip('§7-9: real Claude session tests', 'no ~/claudetest row in the home listing');
  } else {
    await claudeRow.locator('.entry-open').click(); // orange arrow: Claude, in place
    await win.waitForSelector(`${VIS}.xterm`, { timeout: 30_000 });
    await win.waitForTimeout(12_000);
    if ((await win.$eval(`${VIS}.xterm-rows`, (el) => el.textContent)).toLowerCase().includes('trust')) {
      await win.locator(`${VIS}.xterm-screen`).click();
      await win.keyboard.press('Enter');
      await win.waitForTimeout(6000);
    }
    const claudeTabIndex = (await win.locator('.tab:not(.add)').count()) - 1;

    // --- §7: copy a .png in the file pane, paste into the Claude tab -------
    await navigateTab(0, CLAUDE_DIR); // tab 0 is still the Files tab
    await clipClear();
    await selectEntry(MAGENTA);
    await win.keyboard.press('Control+c');
    await win.waitForTimeout(200);

    await win.locator('.tab:not(.add)').nth(claudeTabIndex).click();
    await win.waitForTimeout(300);
    await win.locator(`${VIS}.xterm-screen`).click();
    await win.keyboard.press('Control+v');
    await win.waitForTimeout(1500);
    const afterPaste = await win.$eval(`${VIS}.xterm-rows`, (el) => el.textContent);
    check('§7: pasting a copied .png attaches it — "[Image #1]" appears in the composer',
      /\[Image #1\]/.test(afterPaste), `screen: ${JSON.stringify(afterPaste).slice(-400)}`);

    await win.keyboard.type('In one word and nothing else, what color is the image?');
    await win.waitForTimeout(400);
    await win.keyboard.press('Enter');
    await win.waitForTimeout(30_000);
    const answerScreen = await win.$eval(`${VIS}.xterm-rows`, (el) => el.textContent);
    check('§7 CONTENT LEVEL: the model actually read the pasted image and answers "magenta"',
      /magenta/i.test(answerScreen), `screen: ${JSON.stringify(answerScreen).slice(-500)}`);

    // --- §8: copy a NON-image file, paste into the Claude tab --------------
    await win.locator('.tab:not(.add)').nth(0).click();
    await win.waitForTimeout(300);
    await clipClear();
    await selectEntry(NOTE);
    await win.keyboard.press('Control+c');
    await win.waitForTimeout(200);

    await win.locator('.tab:not(.add)').nth(claudeTabIndex).click();
    await win.waitForTimeout(300);
    await win.locator(`${VIS}.xterm-screen`).click();
    const beforeText = await win.$eval(`${VIS}.xterm-rows`, (el) => el.textContent);
    await win.keyboard.press('Control+v');
    await win.waitForTimeout(1200);
    const afterText = await win.$eval(`${VIS}.xterm-rows`, (el) => el.textContent);
    check('§8: pasting a copied non-image file puts its path in as literal TEXT (newly appeared)',
      afterText.includes(NOTE) && !beforeText.includes(NOTE),
      `before: ${JSON.stringify(beforeText).slice(-200)}  after: ${JSON.stringify(afterText).slice(-300)}`);
    // NOT `!/\[Image #\d+\]/.test(afterText)` — §7's own [Image #1] tag is
    // still sitting in the scrollback `.xterm-rows` returns in full, so that
    // check is true on both sides and passes whether or not THIS paste added
    // one. Count instead: a new attach would raise the tally, this paste must not.
    const beforeImgTags = (beforeText.match(/\[Image #\d+\]/g) || []).length;
    const afterImgTags = (afterText.match(/\[Image #\d+\]/g) || []).length;
    check('§8: ...and NOT as an image attach — genuinely useful, not a failure',
      afterImgTags === beforeImgTags, `before had ${beforeImgTags} tag(s), after has ${afterImgTags}`);
    await win.keyboard.press('Escape'); // clears the composer without submitting
    await win.waitForTimeout(500);

    // --- §9: MEASUREMENT ONLY — a two-path bracketed paste, unmeasured until now
    await win.locator('.tab:not(.add)').nth(0).click();
    await win.waitForTimeout(300);
    await clipClear();
    await selectEntry(domOrder[0]);
    await ctrlClickEntry(domOrder[1]);
    await win.keyboard.press('Control+c');
    await win.waitForTimeout(200);

    await win.locator('.tab:not(.add)').nth(claudeTabIndex).click();
    await win.waitForTimeout(300);
    await win.locator(`${VIS}.xterm-screen`).click();
    await win.keyboard.press('Control+v');
    await win.waitForTimeout(1500);
    const multiScreen = await win.$eval(`${VIS}.xterm-rows`, (el) => el.textContent);
    const tagCount = (multiScreen.match(/\[Image #\d+\]/g) || []).length;
    note(`two-path bracketed paste (${domOrder.join(', ')}) — composer reads: ${JSON.stringify(multiScreen).slice(-400)}`);
    note(`${tagCount} "[Image #N]" tag(s) found for the 2-path paste (this is what was UNMEASURED before)`);
    await win.keyboard.press('Escape');
  }
} finally {
  cleanupFixtures();
  await close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log('  -', f.name);
}
process.exit(failed.length ? 1 : 0);
