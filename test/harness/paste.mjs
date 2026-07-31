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

const printable = (s) => JSON.stringify(s).replace(/\\u001b/g, 'ESC');

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
console.log('\n10. Ctrl+V in a Claude tab');
// ===========================================================================
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
    const claudePty = await visiblePty();
    const CLIP = `CE-CLAUDE-${RUN}`;
    await setClip(CLIP);
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
