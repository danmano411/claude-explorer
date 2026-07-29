// M5: does a Claude conversation actually come back after a restart?
//   npm run build && node test/harness/resume.mjs
//
// This one costs tokens and takes ~2 minutes, because there is no honest way to
// fake it. The claim is "your session is still there when you reopen the app",
// and the only proof is a real CLI writing a real transcript, the app closing,
// and the same words being on screen afterwards.
//
// It checks three separate things, in the order they can break:
//   1. we NAME the session (--session-id) instead of guessing it afterwards, so
//      the id we persisted is the id on disk;
//   2. the tab set survives with that id attached;
//   3. reopening it re-attaches to the conversation, not to a fresh prompt.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const CLAUDE_DIR = path.join(os.homedir(), 'claudetest');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

// A throwaway profile, wiped before run 1 and shared by both runs. Without this
// the app restores whatever tabs the real profile has, previous runs of this
// harness pile up their own claudetest tabs, and the assertions below measure a
// stale one — which is exactly what happened the first time this was written.
const PROFILE = path.join(os.tmpdir(), 'claude-explorer-resume-harness');
fs.rmSync(PROFILE, { recursive: true, force: true });

// Distinct per run: a marker left over from a previous run would make a broken
// resume look like a working one.
const MARKER = `RESUME-OK-${Date.now().toString().slice(-6)}`;
const VIS = '.pane:not([hidden]) ';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const slugFor = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const sessionFile = (id) =>
  path.join(os.homedir(), '.claude', 'projects', slugFor(CLAUDE_DIR), `${id}.jsonl`);

let persisted; // the workspace.json written by run 1

// --- run 1: start a real conversation, then quit ---------------------------
console.log(`\nrun 1 — start a Claude session in ${CLAUDE_DIR}`);
{
  const { app, win, close } = await launchApp({ userDataDir: PROFILE });
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));

  // A new tab always opens at home. Do not assume the app *started* at home —
  // it now restores the previous workspace, so tab 1 is wherever you left it.
  await win.waitForSelector('.tab:not(.add)');
  await win.click('.tab.add');
  await win.waitForTimeout(800);
  await win.waitForSelector(VIS + '.entry, .entry');

  const row = win.locator('.entry', { hasText: 'claudetest' }).first();
  if (!(await row.count())) {
    console.log('  SKIP  no ~/claudetest folder visible in the home listing');
    process.exit(0);
  }
  await row.locator('.entry-open').click();       // orange arrow: Claude, in place
  await win.waitForSelector(VIS + '.xterm', { timeout: 20_000 });
  await win.waitForTimeout(12_000);

  // First run in a folder asks whether to trust it.
  if ((await win.$eval(VIS + '.xterm-rows', (el) => el.textContent)).toLowerCase().includes('trust')) {
    await win.locator(VIS + '.xterm-screen').click();
    await win.keyboard.press('Enter');
    await win.waitForTimeout(6000);
  }

  await win.locator(VIS + '.xterm-screen').click();
  await win.keyboard.type(`Reply with exactly this and nothing else: ${MARKER}`);
  await win.waitForTimeout(400);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(30_000);

  // Deliberately NOT "is the marker on screen" — the prompt we just typed
  // contains the marker, so that assertion passes whether or not Claude ever
  // answered. It did exactly that on the first run of this harness and hid the
  // real failure. The transcript on disk is the only honest witness.
  const rows = await win.$eval(VIS + '.xterm-rows', (el) => el.textContent);
  const warned = /transcript saving is off/i.test(rows);
  check('run 1: transcript saving is ON for the spawned session', !warned,
    warned ? 'inherited a Claude Code child-session marker — nothing will persist' : '');

  await win.waitForTimeout(1500);                 // the debounced save is 400ms
  const wsPath = path.join(userData, 'workspace.json');
  persisted = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
  await close();
}

// The tab strip renders workspace.tabs in order, so this index is also the
// position to click in run 2. Never `.first()` — the workspace legitimately
// contains other tabs from earlier sessions.
const termIndex = persisted.tabs.findIndex((t) => t.view === 'terminal');
const term = persisted.tabs[termIndex];
check('the terminal tab was persisted', !!term,
  term ? `${term.title} (${term.terminalKind})` : `tabs: ${persisted.tabs.map((t) => t.view).join(',')}`);
check('it carries a session id to resume', !!term?.resumeSessionId, term?.resumeSessionId ?? 'absent');
check('no dead pty handle was persisted', !term || term.ptyId === undefined);

// The load-bearing one. If --session-id were ignored, claude would have written
// a transcript under an id of its own choosing and this file would not exist —
// which is exactly the bug that "read back the newest jsonl" would have hidden.
const onDisk = term?.resumeSessionId ? fs.existsSync(sessionFile(term.resumeSessionId)) : false;
check('the transcript is under the id WE assigned', onDisk,
  onDisk ? path.basename(sessionFile(term.resumeSessionId)) : 'claude chose its own id');
const persistedTurn = onDisk
  && fs.readFileSync(sessionFile(term.resumeSessionId), 'utf8').includes(MARKER);
check('and that transcript contains the turn we just had', persistedTurn);

// --- run 2: same userData, fresh process ----------------------------------
console.log('\nrun 2 — reopen and expect the conversation back');
{
  const { win, close } = await launchApp({ userDataDir: PROFILE });
  await win.waitForSelector('.tab:not(.add)');
  await win.waitForTimeout(1500);

  const titles = (await win.locator('.tab:not(.add)').allTextContents())
    .map((t) => t.replace(/\s+/g, ' ').trim());
  check('the terminal tab is back in the strip', titles.length === persisted.tabs.length,
    `${titles.length} of ${persisted.tabs.length}: ${titles.join(' | ')}`);

  // Restored terminals are spawned on first activation, so until this click the
  // pane holds no process at all — that absence is the state machine.
  const before = await win.locator('.xterm').count();
  await win.locator('.tab:not(.add)').nth(termIndex).click();
  check('nothing spawned before the tab was opened', before === 0, `${before} live terminals`);
  await win.waitForSelector(VIS + '.xterm', { timeout: 25_000 });
  await win.waitForTimeout(20_000);

  const rows = await win.$eval(VIS + '.xterm-rows', (el) => el.textContent);
  const resumed = rows.includes(MARKER);
  check('the conversation resumed with its history', resumed,
    resumed ? MARKER : 'fresh prompt — history did not come back');
  // Dump beside the throwaway profile, not into the repo — a failure artifact
  // should not show up as an untracked file someone has to notice and delete.
  if (!resumed) {
    const dump = path.join(os.tmpdir(), 'resume-run2.txt');
    fs.writeFileSync(dump, rows);
    console.log(`  (pane text written to ${dump})`);
  }

  await close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
