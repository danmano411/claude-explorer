// KAN-58: Ctrl+V pastes TWICE in every terminal, and right-click pastes nothing.
//   npm run build && node test/harness/paste.mjs
//
// WHAT IS INSTRUMENTED, AND WHY IT IS THE BYTES AND NOT THE UI
//
// An extra `ipcMain.on('pty:write')` listener in the REAL main process, recording
// every (id, data) the renderer sends, in order. `ipcMain.on` is additive, so the
// app's own handler still runs — this observes exactly what `PtyManager.write`
// receives, which is exactly what it hands to node-pty and therefore to ConPTY.
//
// That seam is the right one for this bug specifically. Both paste paths — our
// Ctrl+V arm and xterm's own native `paste` DOM listener — converge on
// `term.paste()` -> `onData` -> `window.api.ptyWrite`. They are indistinguishable
// upstream of it and indistinguishable downstream of it; the ONE place their
// count differs is the message stream, and a doubled message there IS the bug:
// the child process really is handed the text twice. Bracketing is applied
// inside `term.paste`, so the wrapper shows up here too, per run — which is how
// "one bracket around doubled text" (harmless) is told apart from "two complete
// bracketed runs" (the actual defect).
//
// Screen text is deliberately NOT the primary instrument. A terminal echoes what
// it is sent, so pasted text is on screen once per paste whether or not the shell
// ever ran it, and ConPTY repaints its whole buffer on resize. §2 is the one
// screen assertion, and it is built to dodge both traps: the clipboard carries a
// trailing newline so a doubled paste is a doubled EXECUTION, and the marker it
// counts is assembled by the SHELL from fragments (`"CE-"+"ECHO-"+$PID`) so the
// echoed command line cannot match the regex that counts the output lines.
//
// Every assertion is filtered by the ptyId of the terminal it is about, and reads
// only the slice of the log recorded since that section started.
//
// RED-FIRST. The defect is live on `main`, so every assertion here was run
// against the unfixed build — the Ctrl+V arm's `preventDefault` removed and the
// `contextmenu` listener removed — before being kept. 20 of the 23 went red:
// 2-vs-1 payloads on every Ctrl+V path (and 2-vs-1 shell executions in §2),
// 0-vs-1 on both right-click paths. Four earlier assertions were DELETED at that
// point rather than kept, because they stayed green: "no ESC[200~ reaches an
// unbracketed pty" is true of a doubled paste too. The three that remain green on
// the unfixed build are labelled REGRESSION GUARD where they stand (§0, §6, §7).
//
// KAN-59 / KAN-60 (§10-§15) reuse the same seam for the same reason: both
// tickets are claims about WHICH BYTES A KEYSTROKE PUTS ON THE WIRE, and the
// screen cannot tell them apart (ESC in PSReadLine reverts the line invisibly;
// ESC+"v" in Claude Code produces "[Image #1]" only once Claude is far enough up
// to have a prompt). Same red-first discipline: `git checkout <fix>~1 -- src/`,
// rebuild, run — 14 of the 29 assertions added with the fix went red on the
// unfixed build (41/55). The other 15 are labelled REGRESSION GUARD where they
// stand, and none of them is the only thing holding a claim up: the shell/image
// no-op is paired with §14's Claude/image, "text sends no ESC v" with "an image
// does", and "Ctrl+1/2/9 send nothing" with the six digits that used to.
//
// The 30th, "an image AND text pastes the TEXT", is red against the FIX's first
// pass rather than against main: pre-KAN-60 there was no image branch, so it was
// green there by construction. It is in §14 because that first pass asked
// `hasImage` before reading the text, and every Excel/Word/PowerPoint copy puts
// a bitmap on the clipboard next to the text — an ordinary text paste silently
// became an image paste. Each of the five src edits this file covers has since
// been broken on its own and the assertion that caught it recorded where it
// stands.
//
// The KAN-59 sections also carry the one measurement the whole ticket rests on:
// Ctrl+[ must STILL send ESC, because "Ctrl+3 no longer sends ESC" was only an
// acceptable trade on the grounds that ESC is still typable. If §10's Ctrl+[
// check ever goes red, the KAN-59 decision is void, not merely regressed.
//
// One thing measured here that no comment in src/ predicts: leaving a space
// HIDES the pane, so the xterm in it blurs and — with focus reporting on, which
// Claude Code and this PowerShell both turn on — reports the blur as ESC[O. §11
// calibrates that against a mouse-driven switch before any assertion filters it
// out, because "the pty received a byte" and "the pty received the KEY's byte"
// are not the same claim and only one of them is KAN-59's.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
// A skip is a FAILURE here, not a shrug. Both skips below fire when the harness
// cannot establish its own precondition, and a silent one used to shrink the
// total — `20/20 passed`, exit 0, three Claude-tab assertions quietly gone.
const skip = (name, why) => {
  results.push({ name, pass: false });
  console.log(`  SKIP  ${name}  — ${why} (counted as a FAILURE: the harness could not set itself up)`);
};

// Throwaway profile, pid-suffixed: the app restores the previous workspace, and
// the single-instance lock is keyed on userData — two concurrent harness runs
// sharing one would silently forward into each other's window.
const PROFILE = path.join(os.tmpdir(), `claude-explorer-paste-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

// Per-run tokens. A marker left over from an earlier run must never be able to
// make a broken paste look like a working one.
const RUN = process.pid;
const VIS = '.pane:not([hidden]) ';
const ESC = '\x1b';
const BRA_ON = `${ESC}[200~`;
const BRA_OFF = `${ESC}[201~`;

const { app, win, close } = await launchApp({ userDataDir: PROFILE });
win.on('pageerror', (e) => console.log('  [pageerror]', e.message));

await app.evaluate(({ ipcMain }) => {
  globalThis.__ceWrites = [];
  ipcMain.on('pty:write', (_e, id, data) => globalThis.__ceWrites.push({ id, data }));
});

const allWrites = () => app.evaluate(() => globalThis.__ceWrites);
/** A cursor into the log, so a section only sees its own traffic. */
const mark = async () => (await allWrites()).length;
/** Everything ONE pty was sent since `from`. */
const sentTo = async (ptyId, from) => (await allWrites()).slice(from).filter((m) => m.id === ptyId);

/** The ptyId of the terminal the user can see (Terminal.tsx's data-pty seam). */
const visiblePty = () => win.evaluate(() =>
  [...document.querySelectorAll('[data-pty]')].find((el) => !el.closest('.pane[hidden]'))?.dataset.pty);

const setClip = (t) => app.evaluate(({ clipboard }, t) => clipboard.writeText(t), t);
const screen = () => win.$eval(`${VIS}.xterm-rows`, (el) => el.textContent);

// --- KAN-60: the clipboard, which this machine does not own exclusively ------
// A 1x1 PNG is enough: the renderer only ever asks "is there a bitmap", never
// for the pixels, and Claude Code reads the Windows clipboard itself.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const setClipImage = () => app.evaluate(({ clipboard, nativeImage }, d) => {
  clipboard.clear();
  clipboard.writeImage(nativeImage.createFromDataURL(d));
  return !clipboard.readImage().isEmpty();
}, PNG);
const clipHasImage = () => app.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty());
/** An image AND text at once — what Excel/Word/PowerPoint actually put there. */
const setClipBoth = (t) => app.evaluate(({ clipboard, nativeImage }, d) => {
  clipboard.clear();
  clipboard.write({ text: d.t, image: nativeImage.createFromDataURL(d.p) });
  return clipboard.readText() === d.t && !clipboard.readImage().isEmpty();
}, { t, p: PNG });
const clipIsBoth = (t) => app.evaluate(({ clipboard }, t) =>
  clipboard.readText() === t && !clipboard.readImage().isEmpty(), t);
/**
 * Run `act` with an image on the clipboard, and prove the clipboard held that
 * image on BOTH sides of it. Other processes on this machine write the clipboard
 * whenever they feel like it — two runs of the original KAN-60 experiment were
 * invalidated exactly this way — and a measurement taken across a clipboard that
 * moved is not a measurement of anything. Retries, then gives up loudly.
 *
 * `set` / `still` are overridable for the image-AND-text case, which has to
 * prove BOTH flavours were still there — a text paste that measures green
 * because the bitmap fell off the clipboard proves nothing.
 */
async function withImageClipboard(label, act, tries = 3, set = setClipImage, still = clipHasImage) {
  for (let i = 0; i < tries; i++) {
    if (!(await set())) { await win.waitForTimeout(500); continue; }
    const out = await act();
    if (await still()) return { ok: true, out };
    console.log(`  (clipboard moved under "${label}" — another process won the race; retry ${i + 1}/${tries})`);
    await win.waitForTimeout(600);
  }
  return { ok: false };
}

// --- the keydown observer, for the `preventDefault` half of KAN-59 ----------
// Reads `defaultPrevented` in a DEFERRED task, i.e. after every other listener
// has run, rather than relying on being registered last: App re-registers its
// window handler whenever `spaces` changes, so a probe cannot own the order.
// Capture phase so no stopPropagation upstream can hide a press from it.
await win.evaluate(() => {
  globalThis.__ceKeys = [];
  window.addEventListener('keydown', (e) => {
    setTimeout(() => globalThis.__ceKeys.push({ key: e.key, prevented: e.defaultPrevented }), 0);
  }, true);
});
const keyMark = async () => (await win.evaluate(() => globalThis.__ceKeys)).length;
const keysSince = async (from) => (await win.evaluate(() => globalThis.__ceKeys)).slice(from);

// --- spaces, for KAN-59's other half ---------------------------------------
// Lifted from spaces.mjs rather than reinvented: same selectors, same waits.
const spaceName = () => win.locator('.spacemenu-name').textContent().then((t) => t.trim());
const openSpaceMenu = async () => {
  await win.click('.spacemenu-btn');
  await win.waitForSelector('.spacemenu-dropdown');
  await win.waitForTimeout(150);
};
async function createSpace(name) {
  await openSpaceMenu();
  await win.locator('.spacemenu-item', { hasText: 'New empty space' }).click();
  await win.waitForSelector('.spacemenu-rename');
  await win.locator('.spacemenu-rename').fill(name);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(600);
}
async function switchSpaceViaMenu(name) {
  await openSpaceMenu();
  await win.locator('.spacemenu-item-name', { hasText: name }).first().click();
  await win.waitForTimeout(600);
}

/** Focus the terminal AND drop any selection (xterm's Ctrl+C copies instead of
 *  sending ^C when there is one, and right-click paste is a no-op with one). */
async function focusTerm() {
  await win.locator(`${VIS}.xterm-screen`).click();
  await win.waitForTimeout(150);
}
/** PSReadLine cancels the line on ^C — leaves a clean prompt between sections. */
async function clearLine() {
  await focusTerm();
  await win.keyboard.press('Control+c');
  await win.waitForTimeout(400);
}

// JSON.stringify leaves DEL literal, which prints as nothing at all — and DEL is
// exactly what Ctrl+8 used to send, so a failure detail read `1 pty:write — ""`.
const printable = (s) => JSON.stringify(s).replace(/\\u001b/g, 'ESC').replace(/\x7f/g, 'DEL');

/**
 * What a pty was sent, minus the focus reports.
 *
 * A terminal running with DECSET 1004 on — Claude Code turns it on, and so does
 * whatever is driving this PowerShell — reports focus changes as ESC[I / ESC[O.
 * Switching space HIDES a pane, so the xterm in it blurs and reports the blur:
 * that byte is a consequence of the pane going away, not of the keystroke that
 * sent it away, and a switch made with the mouse produces it identically (§11
 * asserts exactly that before anything relies on this filter).
 *
 * Only used where a space actually changes. Where nothing switches, the
 * assertions stay on the strict `sent.length === 0`.
 */
const nonFocus = (sent) => sent.map((m) => m.data).join('').replace(/\x1b\[[IO]/g, '');

/**
 * The shape every paste path has to produce: ONE ipc message, carrying the
 * clipboard exactly once, wrapped in exactly one bracket run when the pty has
 * bracketed paste enabled and none when it has not.
 *
 * The count and the content are separate claims on purpose: the count says the
 * paste happened once, the exact-bytes comparison says nothing was mangled on
 * the way — a single write carrying the text twice would satisfy the first alone.
 *
 * The bracket TALLY is only asserted when the pty asked for bracketed paste. In
 * unbracketed mode "zero ESC[200~ reach the pty" is true whether or not the
 * paste doubles, so it cannot go red and was deleted after the revert run proved
 * exactly that; the exact-bytes comparison already rejects a stray bracket there.
 */
function checkOnePaste(label, sent, clipboard, { bracketed }) {
  const joined = sent.map((m) => m.data).join('');
  const body = clipboard.replace(/\r?\n/g, '\r'); // xterm normalises newlines to CR
  const want = bracketed ? BRA_ON + body + BRA_OFF : body;
  check(`${label}: the pty is written to exactly once`,
    sent.length === 1, `${sent.length} pty:write — ${sent.map((m) => printable(m.data)).join(' + ')}`);
  check(`${label}: and it receives the clipboard exactly once, ${bracketed ? 'in one bracketed run' : 'unbracketed'}`,
    joined === want, `got ${printable(joined)}, want ${printable(want)}`);
  if (!bracketed) return;
  const opens = joined.split(BRA_ON).length - 1;
  check(`${label}: exactly one ESC[200~..ESC[201~ run reaches the pty`,
    opens === 1 && opens === joined.split(BRA_OFF).length - 1,
    `${opens} ESC[200~, ${joined.split(BRA_OFF).length - 1} ESC[201~`);
}

async function tabMenu(i, itemText) {
  await win.locator('.tab:not(.add)').nth(i).click({ button: 'right' });
  await win.waitForTimeout(250);
  await win.locator('.ctx-item', { hasText: itemText }).first().click();
  await win.waitForTimeout(600);
}

// ===========================================================================
console.log('\n0. a plain shell terminal');
// ===========================================================================
await win.waitForSelector('.entry');
await win.waitForTimeout(400);
await tabMenu(0, 'Open Terminal');
await win.waitForSelector(`${VIS}.xterm`, { timeout: 20_000 });
await win.waitForTimeout(2500);
const shellPty = await visiblePty();
check('a shell terminal is up and has a ptyId', !!shellPty, `pty ${shellPty}`);

// ===========================================================================
console.log('\n1. Ctrl+V in a shell tab');
// ===========================================================================
{
  const CLIP = `CE-CTRLV-${RUN}`;
  await setClip(CLIP);
  await focusTerm();
  const from = await mark();
  await win.keyboard.press('Control+v');
  await win.waitForTimeout(700);
  checkOnePaste('Ctrl+V, shell tab', await sentTo(shellPty, from), CLIP, { bracketed: false });
}

// ===========================================================================
console.log('\n2. and it is executed once, not twice — the reported symptom');
// ===========================================================================
{
  // The clipboard ends in a newline, so each paste run also SUBMITS: a doubled
  // paste is a doubled execution, which is what the user actually reported.
  // The marker is built by the shell out of fragments, so the echoed command
  // line on screen — which is there either way — cannot match the counter.
  await clearLine();
  await setClip(`Write-Host ("CE-" + "ECHO-" + $PID)\n`);
  await focusTerm();
  const from = await mark();
  await win.keyboard.press('Control+v');
  await win.waitForTimeout(3000);
  const sent = await sentTo(shellPty, from);
  const runs = [...(await screen()).matchAll(/CE-ECHO-\d+/g)].map((m) => m[0]);
  check('one Ctrl+V of a command runs the shell command exactly once',
    runs.length === 1, `${runs.length} shell-generated output lines: ${runs.join(', ') || '(none)'}`);
  check('and the pty was written to exactly once to do it',
    sent.length === 1, `${sent.length} pty:write — ${sent.map((m) => printable(m.data)).join(' + ')}`);
}

// ===========================================================================
console.log('\n3. Ctrl+Shift+V');
// ===========================================================================
{
  // Chromium's default for this one is paste-as-plain-text, a different editing
  // command reaching the same native paste event — so it doubles on the unfixed
  // build for the same reason and needs its own measurement.
  const CLIP = `CE-CTRLSHIFTV-${RUN}`;
  await clearLine();
  await setClip(CLIP);
  await focusTerm();
  const from = await mark();
  await win.keyboard.press('Control+Shift+v');
  await win.waitForTimeout(700);
  checkOnePaste('Ctrl+Shift+V, shell tab', await sentTo(shellPty, from), CLIP, { bracketed: false });
}

// ===========================================================================
console.log('\n4. a multi-line clipboard keeps its line structure');
// ===========================================================================
{
  const CLIP = `CE-L1-${RUN}\nCE-L2-${RUN}\nCE-L3-${RUN}`;
  await clearLine();
  await setClip(CLIP);
  await focusTerm();
  const from = await mark();
  await win.keyboard.press('Control+v');
  await win.waitForTimeout(900);
  const sent = await sentTo(shellPty, from);
  // CR, not LF: xterm's paste path normalises newlines to CR because that is the
  // byte a terminal line ends with. Three lines must still be three lines.
  checkOnePaste('multi-line Ctrl+V', sent, CLIP, { bracketed: false });
  const joined = sent.map((m) => m.data).join('');
  const seps = joined.split('\r').length - 1;
  check('multi-line Ctrl+V: both separators survive, and neither line is duplicated',
    seps === 2 && [1, 2, 3].every((n) => joined.split(`CE-L${n}-${RUN}`).length === 2),
    `${seps} separators, lines seen ${[1, 2, 3].map((n) => joined.split(`CE-L${n}-${RUN}`).length - 1).join('/')}`);
}

// ===========================================================================
console.log('\n5. right-click pastes');
// ===========================================================================
{
  const CLIP = `CE-RIGHTCLICK-${RUN}`;
  await clearLine();
  await setClip(CLIP);
  await focusTerm();                                   // also drops any selection
  const from = await mark();
  await win.locator(`${VIS}.xterm-screen`).click({ button: 'right' });
  await win.waitForTimeout(700);
  checkOnePaste('right-click, no selection', await sentTo(shellPty, from), CLIP, { bracketed: false });
}

// ===========================================================================
console.log('\n6. right-click on a selection is a no-op, deliberately');
// ===========================================================================
{
  // xterm's own contextmenu handler has just put the selection in the hidden
  // helper textarea and selected it, which is what makes Edit > Copy work on a
  // terminal at all. Pasting would throw that away. Documented in Terminal.tsx.
  //
  // REGRESSION GUARD, not a discriminator: green on the unfixed build too, where
  // right-click sends nothing under any circumstances. It is kept because it is
  // the only thing pinning the deliberate exception — it goes red the moment
  // right-click is "simplified" into pasting unconditionally.
  await clearLine();
  await setClip(`CE-NOPASTE-${RUN}`);
  const box = await win.locator(`${VIS}.xterm-screen`).boundingBox();
  await win.mouse.move(box.x + 8, box.y + 8);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width * 0.6, box.y + 30, { steps: 8 });
  await win.mouse.up();
  await win.waitForTimeout(300);
  // xterm draws its selection as rects in .xterm-selection — an observable that
  // does not depend on the DOM selection model xterm does not use.
  const selected = await win.$$eval(`${VIS}.xterm-selection div`, (els) => els.length);
  if (!selected) {
    skip('right-click with a selection sends nothing', 'could not establish a selection');
  } else {
    const from = await mark();
    await win.locator(`${VIS}.xterm-screen`).click({ button: 'right' });
    await win.waitForTimeout(700);
    const sent = await sentTo(shellPty, from);
    check('right-click with a selection sends nothing to the pty',
      sent.length === 0, `${sent.length} pty:write — ${sent.map((m) => printable(m.data)).join(' + ')}`);
  }
}

// ===========================================================================
console.log('\n7. Ctrl+C still reaches the shell as a control character');
// ===========================================================================
{
  // The paste arm must not have eaten the terminal's own key handling. This one
  // is a REGRESSION GUARD, not a discriminator: it is green on the unfixed build
  // too. It exists because the obvious wrong fix — cancelling every Ctrl+key — is
  // silent, and ^C is the key a terminal cannot lose.
  await focusTerm();                                   // click clears the selection
  const from = await mark();
  await win.keyboard.press('Control+c');
  await win.waitForTimeout(500);
  const sent = await sentTo(shellPty, from);
  check('Ctrl+C sends exactly the 0x03 control character to the pty',
    sent.length === 1 && sent[0].data === '\x03',
    `${sent.length} pty:write — ${sent.map((m) => printable(m.data)).join(' + ')}`);
}

// ===========================================================================
console.log('\n8. Ctrl/Shift+Enter insert a newline; plain Enter still submits');
// ===========================================================================
{
  // The OTHER arm in attachCustomKeyEventHandler, and it was shipping untested:
  // removing its preventDefault leaves the harness at 23/23 while putting "\n"
  // THEN "\r" on the wire — every multi-line prompt submitted half-written. The
  // bytes are the whole claim, so assert the bytes; a screen check cannot tell a
  // newline that submitted from one that did not.
  for (const [combo, want, what] of [
    ['Enter', '\r', 'submits'],
    ['Shift+Enter', '\n', 'inserts a newline'],
    ['Control+Enter', '\n', 'inserts a newline'],
  ]) {
    await clearLine();
    const from = await mark();
    await win.keyboard.press(combo);
    await win.waitForTimeout(500);
    const sent = await sentTo(shellPty, from);
    check(`${combo} ${what} — exactly ${printable(want)} on the wire`,
      sent.length === 1 && sent[0].data === want,
      `${sent.length} pty:write — ${sent.map((m) => printable(m.data)).join(' + ')}`);
  }
}

// ===========================================================================
console.log('\n9. bracketed paste: exactly one ESC[200~..ESC[201~ run');
// ===========================================================================
{
  // The mode is set by driving the app's real `pty:data` broadcast — the same
  // channel and the same bytes a bracketed-paste app sends. xterm's parser cannot
  // tell the difference, and unlike typing a DECSET command at PSReadLine it
  // cannot be undone by the line editor between arming and pasting.
  // §10 pastes into Claude Code, which enables the mode itself.
  const CLIP = `CE-BRACKET-${RUN}`;
  await clearLine();
  await app.evaluate(({ BrowserWindow }, id) =>
    BrowserWindow.getAllWindows()[0].webContents.send('pty:data', id, '\x1b[?2004h'), shellPty);
  await win.waitForTimeout(400);
  await setClip(CLIP);
  await focusTerm();
  {
    const from = await mark();
    await win.keyboard.press('Control+v');
    await win.waitForTimeout(700);
    checkOnePaste('Ctrl+V, bracketed', await sentTo(shellPty, from), CLIP, { bracketed: true });
  }
  {
    // Right-click goes through term.paste too, so it must bracket identically —
    // the thing that would break if it were ever "simplified" to a raw ptyWrite.
    await focusTerm();
    const from = await mark();
    await win.locator(`${VIS}.xterm-screen`).click({ button: 'right' });
    await win.waitForTimeout(700);
    checkOnePaste('right-click, bracketed', await sentTo(shellPty, from), CLIP, { bracketed: true });
  }
}

// ===========================================================================
console.log('\n10. KAN-59: what a Ctrl+digit puts on the wire (still ONE space)');
// ===========================================================================
{
  // There is exactly one space at this point, so App declines every one of these
  // presses — which makes this section double as the "Ctrl+N with fewer than N
  // spaces" case, and keeps the shell's pane visible throughout. §11 does the
  // same digits with somewhere to switch TO.
  //
  // The bytes the unfixed build sends, read out of
  // node_modules/@xterm/xterm/lib/xterm.js.map (common/input/Keyboard.ts, the
  // `default:` arm, `ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey`):
  // keyCode 51..55 -> String.fromCharCode(kc - 51 + 27), 56 -> DEL, 219 -> ESC,
  // 65..90 -> kc - 64. keyCodes 49/50/57 (Ctrl+1/2/9) match nothing there and
  // already sent nothing — those three are guards, not discriminators, and are
  // labelled as such in their own assertion text so nobody counts them twice.
  const XTERM_SENT = { 1: '', 2: '', 3: '\x1b', 4: '\x1c', 5: '\x1d', 6: '\x1e', 7: '\x1f', 8: '\x7f', 9: '' };
  await clearLine();

  // FIRST, because the whole KAN-59 trade depends on it. Ctrl+3's ESC was given
  // up on the grounds that ESC is still typable two other ways; Ctrl+[ is one of
  // them, and it comes out of the SAME table entry family that Ctrl+3 was taken
  // from, so a careless "suppress ctrl-modified keys" fix takes both. Asserting
  // the BYTE and not the screen: PSReadLine's response to ESC is to revert the
  // line, which is invisible on an empty prompt.
  {
    const from = await mark();
    await win.keyboard.press('Control+[');
    await win.waitForTimeout(400);
    const sent = await sentTo(shellPty, from);
    check('Ctrl+[ STILL sends ESC to the pty — the mitigation KAN-59 rests on',
      sent.length === 1 && sent[0].data === '\x1b',
      `${sent.length} pty:write — ${sent.map((m) => printable(m.data)).join(' + ')}`);
  }

  for (const d of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const was = XTERM_SENT[d];
    const from = await mark();
    await win.keyboard.press(`Control+${d}`);
    await win.waitForTimeout(350);
    const sent = await sentTo(shellPty, from);
    check(`Ctrl+${d} puts NOTHING on the wire${was ? '' : '  [REGRESSION GUARD: xterm never sent a byte for this one]'}`,
      sent.length === 0,
      `${sent.length} pty:write — ${sent.map((m) => printable(m.data)).join(' + ')}` +
      (was ? `; the unfixed build sends ${printable(was)}` : ''));
  }

  // REGRESSION GUARDS, all five: green on the unfixed build too. They exist
  // because the wrong fix for KAN-59 is broad — "swallow ctrl-modified keys" —
  // and it is silent. Ctrl+C has its own section (§7); these are the rest of the
  // row a terminal cannot lose. Chosen for having no destructive PSReadLine
  // binding, so the section leaves a clean prompt behind.
  for (const [letter, want] of [['a', '\x01'], ['e', '\x05'], ['k', '\x0b'], ['u', '\x15'], ['w', '\x17']]) {
    const from = await mark();
    await win.keyboard.press(`Control+${letter}`);
    await win.waitForTimeout(350);
    const sent = await sentTo(shellPty, from);
    check(`Ctrl+${letter} still reaches the pty as ${printable(want)}  [REGRESSION GUARD]`,
      sent.length === 1 && sent[0].data === want,
      `${sent.length} pty:write — ${sent.map((m) => printable(m.data)).join(' + ')}`);
  }
}

// ===========================================================================
console.log('\n11. KAN-59: over a terminal, the space switches AND no byte escapes');
// ===========================================================================
{
  // The half-right implementations this section exists to reject, each one
  // MEASURED by making that edit alone and re-running:
  //   - App.tsx's guard relaxed, Terminal.tsx untouched: the shell gets Ctrl+3's
  //     ESC and the space does NOT switch. xterm's keydown listener is on the
  //     helper textarea (target phase), App's is on window (bubble), and xterm
  //     finishes the six digits that produce a control code in
  //     `cancel(event, true)` — preventDefault AND stopPropagation — so the
  //     press never reaches App. (Ctrl+1/2/9 produce no key, so xterm does not
  //     cancel and they DO switch; that asymmetry is what makes a half-fix look
  //     like it works if you only try one digit.)
  //   - Terminal.tsx's arm added, App.tsx untouched: nothing reaches the pty and
  //     nothing switches — the shortcut is still dead.
  // One press, both claims, so neither can be satisfied alone.
  await createSpace('Beta');
  await createSpace('Gamma');            // three spaces: Ctrl+3 now has a target
  await switchSpaceViaMenu('Space');
  await focusTerm();

  {
    // CALIBRATION, and it must come first. Leaving a space hides the pane, the
    // xterm in it blurs, and a terminal in focus-reporting mode answers with
    // ESC[O — so a pty that "received a byte" after Ctrl+3 has not necessarily
    // received the KEY's byte. This does the same switch with the MOUSE, where no
    // keystroke exists to blame, and pins that what comes back is focus reports
    // and nothing else. It is what licenses `nonFocus()` below; if this ever goes
    // red, the filter is hiding something and the assertions using it are void.
    const from = await mark();
    await switchSpaceViaMenu('Gamma');
    await switchSpaceViaMenu('Space');
    await focusTerm();
    await win.waitForTimeout(400);
    const sent = await sentTo(shellPty, from);
    check('a space switch made with the MOUSE already sends the terminal a focus report, and only that',
      sent.length > 0 && nonFocus(sent) === '',
      `${sent.length} pty:write — ${printable(sent.map((m) => m.data).join(''))}`);
  }

  {
    const from = await mark();
    const kfrom = await keyMark();
    await win.keyboard.press('Control+3');
    await win.waitForTimeout(800);
    const sent = await sentTo(shellPty, from);
    const keys = await keysSince(kfrom);
    check('Ctrl+3 with a SHELL terminal focused switches to the third space',
      (await spaceName()) === 'Gamma', await spaceName());
    check('and the pty it was typed into got no KEY byte — no ESC, only the hidden pane\'s focus report',
      nonFocus(sent) === '',
      `${sent.length} pty:write — ${printable(sent.map((m) => m.data).join(''))}; the unfixed build adds ${printable('\x1b')}`);
    // The positive control for the probe below — it is what proves the probe can
    // observe a `true` at all, which is the only thing that makes "not
    // preventDefault-ed" mean anything. Honest about what it is: green on the
    // unfixed build too, but for a different reason (there, xterm's own
    // `cancel(e, true)` runs after it handles Ctrl+3 into an ESC). On this build
    // xterm returns false before that line, so App is the only thing left that
    // can have cancelled it.
    check('and the press was preventDefault-ed, because the app acted on it',
      keys.some((k) => k.key === '3' && k.prevented), JSON.stringify(keys));
  }

  {
    // Fewer than N spaces. The byte is suppressed ANYWAY — Terminal.tsx's arm is
    // unconditional, deliberately, so the terminal's behaviour does not depend on
    // how many spaces happen to exist — while App declines and leaves the event
    // uncancelled. Both halves go red on the unfixed build (which sends FS and
    // cancels the event as it does so), and the second half goes red again the
    // day someone hoists App's `preventDefault` above its `if (!target) return`.
    await switchSpaceViaMenu('Space');
    await focusTerm();
    const from = await mark();
    const kfrom = await keyMark();
    await win.keyboard.press('Control+4');   // there is no fourth space
    await win.waitForTimeout(700);
    const sent = await sentTo(shellPty, from);
    const keys = await keysSince(kfrom);
    check('Ctrl+4 with only three spaces changes nothing',
      (await spaceName()) === 'Space', await spaceName());
    check('and still puts nothing on the wire — suppression does not depend on the space count',
      sent.length === 0,
      `${sent.length} pty:write — ${sent.map((m) => printable(m.data)).join(' + ')}; the unfixed build sends ${printable('\x1c')}`);
    check('and it is NOT preventDefault-ed: the handler that declines does not cancel',
      keys.some((k) => k.key === '4') && !keys.some((k) => k.key === '4' && k.prevented), JSON.stringify(keys));
  }
}

// ===========================================================================
console.log('\n12. KAN-60: an image on the clipboard is a NO-OP in a shell tab');
// ===========================================================================
{
  // REGRESSION GUARD, paired with §14: green on the unfixed build too, which has
  // no image branch at all. It is what pins the `kind !== 'shell'` gate — in a
  // shell, ESC+"v" is PSReadLine's RevertLine followed by a literal "v", so
  // sending it there would eat the user's half-typed command line. Falling
  // through to the text path with an image-only clipboard means readText() is
  // empty and nothing is sent, which is the honest answer.
  await clearLine();
  const r = await withImageClipboard('shell Ctrl+V', async () => {
    await focusTerm();
    const from = await mark();
    await win.keyboard.press('Control+v');
    await win.waitForTimeout(800);
    return sentTo(shellPty, from);
  });
  if (!r.ok) skip('Ctrl+V with an image, shell tab, sends nothing', 'the clipboard was taken by another process on every attempt');
  else check('Ctrl+V with an image on the clipboard sends NOTHING to a shell — no ESC v  [REGRESSION GUARD]',
    r.out.length === 0, `${r.out.length} pty:write — ${r.out.map((m) => printable(m.data)).join(' + ')}`);
}

// ===========================================================================
console.log('\n13. Ctrl+V in a Claude tab');
// ===========================================================================
let claudePty = null;
{
  // The first consumer of this app, and the one that really turns bracketed paste
  // on. No prompt is ever submitted, so this costs a CLI start and no tokens.
  const CLAUDE_DIR = path.join(os.homedir(), 'claudetest');
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  await win.click('.tab.add');
  await win.waitForTimeout(800);
  await win.waitForSelector(`${VIS}.entry`);
  const row = win.locator(`${VIS}.entry`, { hasText: 'claudetest' }).first();
  if (!(await row.count())) {
    skip('Ctrl+V in a Claude tab', 'no ~/claudetest row in the home listing');
  } else {
    await row.locator('.entry-open').click();          // orange arrow: Claude, in place
    await win.waitForSelector(`${VIS}.xterm`, { timeout: 30_000 });
    await win.waitForTimeout(15_000);
    claudePty = await visiblePty();
    const CLIP = `CE-CLAUDE-${RUN}`;
    await setClip(CLIP);
    // Text on the clipboard means NO image on it — writeText replaces the whole
    // clipboard. Asserted, not assumed: without this the "no ESC v" check below
    // could be green because the image branch was never reachable at all.
    const hadImage = await clipHasImage();
    await focusTerm();
    const from = await mark();
    await win.keyboard.press('Control+v');
    await win.waitForTimeout(1200);
    const sent = await sentTo(claudePty, from);
    const joined = sent.map((m) => m.data).join('');
    const opens = joined.split(BRA_ON).length - 1;
    // Claude Code owns whether the mode is on, so this asserts the invariant that
    // holds either way rather than pinning a mode this harness does not control:
    // one message, the clipboard once, and never a second bracket run.
    check('Ctrl+V in a Claude tab writes to the pty exactly once',
      sent.length === 1, `${sent.length} pty:write — ${sent.map((m) => printable(m.data)).join(' + ')}`);
    check('Ctrl+V in a Claude tab delivers the clipboard exactly once',
      joined.split(CLIP).length - 1 === 1, `clipboard seen ${joined.split(CLIP).length - 1}x in ${printable(joined)}`);
    check('Ctrl+V in a Claude tab produces at most one ESC[200~..ESC[201~ run',
      opens <= 1 && opens === joined.split(BRA_OFF).length - 1,
      `${opens} ESC[200~ (bracketed mode is Claude Code's call, not this harness's)`);
    // KAN-60's other half. §14 proves an image DOES produce ESC v; on its own
    // that is satisfied by a build which sends ESC v unconditionally, which would
    // corrupt every ordinary text paste into Claude. The pair is the claim.
    check('KAN-60: text on the clipboard takes the TEXT path — no ESC v is sent',
      !hadImage && !joined.includes(`${ESC}v`),
      hadImage ? 'an image was on the clipboard too — precondition not established'
        : `sent ${printable(joined)}`);
  }
}

// ===========================================================================
console.log('\n14. KAN-60: an image on the clipboard sends Claude Code its own paste key');
// ===========================================================================
{
  // The mechanism, end to end: Claude Code reads the Windows clipboard itself,
  // and its Windows binding for chat:imagePaste is alt+v — ESC then "v" on the
  // wire. So the assertion is the two bytes, exactly, unbracketed: term.paste
  // would wrap them and Claude would see literal text instead of a keystroke.
  //
  // Screen text is deliberately not the instrument. "[Image #1]" appears only
  // once Claude Code has a prompt up and is not something this harness controls
  // the timing of, whereas the bytes are the whole of what the renderer promises.
  if (!claudePty) skip('KAN-60: an image sends ESC v to a Claude pty', 'no Claude tab was opened');
  else {
    const r = await withImageClipboard('Claude Ctrl+V', async () => {
      await focusTerm();
      const from = await mark();
      await win.keyboard.press('Control+v');
      await win.waitForTimeout(1200);
      return sentTo(claudePty, from);
    });
    if (!r.ok) skip('KAN-60: an image sends ESC v to a Claude pty', 'the clipboard was taken by another process on every attempt');
    else check('KAN-60: with an image on the clipboard, Ctrl+V sends exactly ESC v and nothing else',
      r.out.length === 1 && r.out[0].data === `${ESC}v`,
      `${r.out.length} pty:write — ${r.out.map((m) => printable(m.data)).join(' + ')}`);

    // ...and the other order, which is the common one on Windows. "There is an
    // image on the clipboard" is NOT "the user wanted to paste an image": Excel,
    // Word and PowerPoint all put a bitmap of the selection on the clipboard
    // ALONGSIDE its text, so a bare `hasImage` branch turns an ordinary text
    // paste into an image paste and drops the text on the floor with no way to
    // tell. Text therefore wins when both are present — which is also exactly
    // the pre-KAN-60 behaviour, so KAN-60 adds a path and regresses none.
    // Nothing is lost for the mixed case either: Alt+V reaches Claude Code as
    // ESC v through xterm's own alt handling, with no help from this file.
    //
    // Measured red on the build that shipped this ticket's first pass: it sent
    // "ESCv" and the text never arrived.
    const MIX = `CE-MIXED-${RUN}`;
    const m = await withImageClipboard('Claude image+text Ctrl+V', async () => {
      await focusTerm();
      const from = await mark();
      await win.keyboard.press('Control+v');
      await win.waitForTimeout(1200);
      return sentTo(claudePty, from);
    }, 3, () => setClipBoth(MIX), () => clipIsBoth(MIX));
    if (!m.ok) skip('KAN-60: an image AND text pastes the text', 'the clipboard was taken by another process on every attempt');
    else {
      const joined = m.out.map((x) => x.data).join('');
      check('KAN-60: an image AND text on the clipboard pastes the TEXT — the image branch does not eat it',
        joined.includes(MIX) && !joined.includes(`${ESC}v`),
        `${m.out.length} pty:write — ${printable(joined)}`);
    }
  }
}

// ===========================================================================
console.log('\n15. KAN-59 in a Claude tab: the space switches, Claude gets nothing');
// ===========================================================================
{
  // The tab type the whole feature exists for, and the one where a stray ESC is
  // least harmless: in Claude Code ESC interrupts / clears the prompt, so
  // "switches the space AND sends ESC" is not a cosmetic half-fix here.
  if (!claudePty) skip('KAN-59: Ctrl+3 over a Claude tab switches space and sends nothing', 'no Claude tab was opened');
  else {
    await focusTerm();
    {
      const from = await mark();
      await win.keyboard.press('Control+3');
      await win.waitForTimeout(800);
      const sent = await sentTo(claudePty, from);
      check('Ctrl+3 with a CLAUDE terminal focused switches to the third space',
        (await spaceName()) === 'Gamma', await spaceName());
      check('and Claude\'s pty got no KEY byte — no ESC to clear its prompt',
        nonFocus(sent) === '',
        `${sent.length} pty:write — ${printable(sent.map((m) => m.data).join(''))}; the unfixed build adds ${printable('\x1b')}`);
    }
    await switchSpaceViaMenu('Space');
    await focusTerm();                                  // the Claude tab again
    {
      const from = await mark();
      await win.keyboard.press('Control+2');
      await win.waitForTimeout(800);
      const sent = await sentTo(claudePty, from);
      check('Ctrl+2 over a Claude tab switches too — the app half works for every digit',
        (await spaceName()) === 'Beta', await spaceName());
      check('and still no key byte on Claude\'s wire  [REGRESSION GUARD: xterm sent nothing for Ctrl+2 already]',
        nonFocus(sent) === '', `${sent.length} pty:write — ${printable(sent.map((m) => m.data).join(''))}`);
    }
  }
}

await close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log('  -', f.name);
}
process.exit(failed.length ? 1 : 0);
