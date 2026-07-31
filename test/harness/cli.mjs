// KAN-4: does the CLI / Explorer entry point actually work against a real app?
//   npm run build && node test/harness/cli.mjs
//
// The claim is "a second launch is not a second app — it hands its path to the
// one already running", and the only honest proof is two real electron
// processes and a tab strip that grows in the first one. So this launches
// instance 1 under Playwright and then spawns the SECOND instance as a raw
// child process.
//
// Not Playwright for the second launch, deliberately: _electron.launch() waits
// for a window, and the whole point is that the loser never gets one. Using it
// would report the correct behaviour as a 30 s timeout.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { launchApp } from './app.mjs';

const require = createRequire(import.meta.url);
const ELECTRON = require('electron'); // outside Electron this export IS the exe path
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'out/main/index.js');

// An EXPLICIT throwaway profile, not app.mjs's per-process default: the single
// instance lock is keyed on userData, so the raw children below must be handed
// the very same --user-data-dir string as instance 1 or they would each become
// a primary instance and nothing would be forwarded anywhere.
// Suffixed with the pid: this repo is worked on in several git worktrees at
// once, and a fixed name means two concurrent runs share a profile — which,
// because the lock is keyed on userData, makes the second run's app silently
// forward into the FIRST run's window instead of failing. Symptom is a handful
// of "the argv tab is the focused one" failures against a workspace holding
// tabs nobody in this run opened.
const PROFILE = path.join(os.tmpdir(), `claude-explorer-cli-harness-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

// The app titles a folder tab with its basename, and this harness opens ROOT.
// Hardcoding 'Claude Explorer' assumed the checkout is always named that; from
// a worktree it is not, and every title assertion fails for a reason that has
// nothing to do with the CLI.
const ROOT_TAB = path.basename(ROOT);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/**
 * Launch a second instance the way Explorer's context menu would, and wait for
 * it to die. Resolves the exit code, or null if it was still alive after 6 s —
 * which is what "it became a second app instead of forwarding" looks like.
 */
function fireSecondInstance(...args) {
  return spawn(ELECTRON, [`--user-data-dir=${PROFILE}`, ENTRY, ...args], {
    cwd: ROOT, stdio: 'ignore',
  });
}

function secondInstance(...args) {
  const child = fireSecondInstance(...args);
  return new Promise((resolve) => {
    const t = setTimeout(() => { child.kill(); resolve(null); }, 6_000);
    child.once('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

// A tab's textContent is "📁 src×" — the view icon, the title, and the close
// glyph. Strip the chrome so the assertions can be exact equality on the title
// rather than a substring match that would also accept the wrong tab.
const clean = (t) => t.replace(/[\u{1F4C1}▶×]/gu, '').replace(/\s+/g, ' ').trim();
const titles = (win) => win.locator('.tab:not(.add)').allTextContents().then((ts) => ts.map(clean));
const activeTitle = (win) =>
  win.locator('.tab.active').first().textContent().then(clean);

let beforeRestart; // instance 1's tab titles, for the restore-race check

// --- instance 1: cold start straight onto a path ---------------------------
console.log(`\ninstance 1 — cold start with --open ${ROOT}`);
{
  const { win, close } = await launchApp({ userDataDir: PROFILE, extraArgs: ['--open', ROOT] });
  await win.waitForSelector('.tab:not(.add)');
  await win.waitForTimeout(2_000); // restore + the gated argv tab behind it

  // 1. cold start lands on the path. Fresh profile, so: the home tab plus ours.
  let ts = await titles(win);
  let act = await activeTitle(win);
  const entries = await win.locator('.entry').count();
  check('cold start opened a tab on the argv path and focused it',
    ts.length === 2 && ts[1] === ROOT_TAB && act === ROOT_TAB && entries > 5,
    `${ts.join(' | ')} — active "${act}", ${entries} entries`);

  // 2. a second launch does not become a second app.
  const before = ts.length;
  const code = await secondInstance('--open', path.join(ROOT, 'src'));
  check('the second launch exited instead of opening its own window', code === 0,
    code === null ? 'still running after 6s — it became a second app' : `exit ${code}`);
  await win.waitForTimeout(1_500);

  // 3. ...because its path was forwarded into this window.
  ts = await titles(win);
  check('the forwarded path arrived as a new tab here',
    ts.length === before + 1 && ts[ts.length - 1] === 'src',
    `${ts.join(' | ')}`);

  // 4. --new-session STAGES a session. It does not spawn one.
  //    This is the C13 regression test: if someone "improves" --new-session into
  //    a spawn, (b) and (c) both fail. An unauthenticated OS caller must not be
  //    able to start an agent with the user's own Claude Code permissions.
  const panesBefore = await win.locator('.pane').count();   // terminal panes only
  const xtermBefore = await win.locator('.xterm').count();
  const nsCode = await secondInstance('--new-session', ROOT);
  check('--new-session: the launching process exited', nsCode === 0,
    nsCode === null ? 'still running after 6s' : `exit ${nsCode}`);
  await win.waitForTimeout(1_500);

  ts = await titles(win);
  act = await activeTitle(win);
  check('--new-session (a) added one focused tab on the folder',
    ts.length === before + 2 && ts[ts.length - 1] === ROOT_TAB
      && act === ROOT_TAB,
    `${ts.join(' | ')} — active "${act}"`);

  // A FileBrowser is only mounted while the active tab is a files view, so
  // .entry rows on screen prove it is one — and .entry-open is the existing
  // one-click launch affordance the staging design hands the user. Bound to
  // ROOT specifically, not just "some files view": the previously active tab
  // (checked in step 3) is ALSO a files view full of .entry rows and
  // .entry-open arrows — it's `src`, which has no package.json — so if
  // --new-session were a total no-op this check would still pass without the
  // package.json witness. package.json lives at ROOT but not under ROOT/src.
  const rows = await win.locator('.entry').count();
  const arrows = await win.locator('.entry-open').count();
  const onRoot = await win.locator('.entry-label', { hasText: 'package.json' }).count();
  check('--new-session (b) the visible pane is a files view of ROOT (not the still-active src tab), with its launch arrows',
    rows > 5 && arrows > 0 && onRoot > 0,
    `${rows} entries, ${arrows} launch arrows, package.json present: ${onRoot > 0}`);

  const panesAfter = await win.locator('.pane').count();
  const xtermAfter = await win.locator('.xterm').count();
  check('--new-session (c) NO terminal appeared — nothing was spawned',
    panesAfter === panesBefore && xtermAfter === xtermBefore && xtermAfter === 0,
    `panes ${panesBefore}->${panesAfter}, terminals ${xtermBefore}->${xtermAfter}`);

  // The independent witness for (c): claudeSpawn()'s first act is
  // recentsAdd(cwd), so a reintroduced spawn leaves a fingerprint on disk even
  // if the UI assertions above were somehow satisfied another way.
  // Parse, do not substring-match the raw text: recents.json is JSON, so a
  // Windows path is stored with DOUBLED backslashes and `text.includes(ROOT)`
  // can never match. That assertion passed under a deliberately reintroduced
  // spawn — i.e. it was worthless — which is why this one reads the entries.
  let recents = [];
  try { recents = JSON.parse(fs.readFileSync(path.join(PROFILE, 'recents.json'), 'utf8')); }
  catch { /* absent is the expected state */ }
  const recorded = recents.some((r) => r?.path?.toLowerCase() === ROOT.toLowerCase());
  check('--new-session (c2) no Claude session was recorded in Recents', !recorded,
    recorded ? 'recents.json gained the folder — something called claudeSpawn'
      : `${recents.length} unrelated entries`);

  // 5. a bad path is a no-op: no tab, no dialog, and the caller still exits 0.
  const beforeBad = (await titles(win)).length;
  const badCode = await secondInstance('--open', 'C:\\definitely\\not\\here');
  await win.waitForTimeout(1_500);
  const afterBad = (await titles(win)).length;
  check('an unreachable path opens no tab and still exits 0',
    badCode === 0 && afterBad === beforeBad, `exit ${badCode}, ${beforeBad} -> ${afterBad} tabs`);

  // 6. KAN-65 — the DoS. `--open \\10.255.255.n\s` makes the app canonicalize
  //    AND stat a path whose SMB host never answers: ~21 s per syscall (21,056
  //    ms measured), negative-cached per host so a different n stalls fresh
  //    every time. Spelt synchronously in main that was ~42 s of pinned process
  //    per launch — no IPC, no pty:data forwarding, no menu, no paint — from an
  //    unauthenticated one-line loop, because anyone who can start a process as
  //    this user can send that.
  //
  //    The probe is a REAL filesystem round-trip — fs:list, i.e. a readdir plus
  //    a stat per row, in main — and NOT an event-loop ping. That distinction is
  //    the whole reason the fix serialises as well as awaits: `await` moves the
  //    stall off the event loop but not off libuv's four-thread pool, so timers
  //    keep firing and a ping reports a perfectly healthy app while every fs
  //    call in it is parked for 20 s.
  //
  //    Timed HERE, not inside the renderer with performance.now(). Playwright
  //    reaches the page through the browser process's CDP endpoint, so a frozen
  //    main blocks the evaluate itself: the in-page clock never starts and
  //    honestly reports 20 ms for a call the harness waited 20.8 SECONDS for.
  //    That spelling passed against the frozen build. Wall clock around the
  //    whole round trip is the only number that cannot be fooled that way, and
  //    the race is what stops a truly wedged main from hanging the harness (the
  //    evaluate is left to settle on its own — hence the bare catch).
  const probe = async () => {
    const t = Date.now();
    const p = win.evaluate((dir) => window.api.fsList(dir).then(() => true, () => true), ROOT);
    p.catch(() => {});
    const ok = await Promise.race([p, new Promise((r) => setTimeout(() => r(false), 40_000))]);
    return [Date.now() - t, ok === true];
  };

  const [idleMs] = await probe();
  // Four, not one: four is what it takes to hold every libuv worker, and it is
  // one line of shell. Distinct hosts because Windows negative-caches per host
  // — measured here, realpathSync.native on a cold \\10.255.255.n\s is 21,033
  // ms and on a warm one is 0 ms, so reusing a host would make the flood free
  // after the first launch.
  const floodAt = Date.now();
  const flood = [21, 22, 23, 24].map((n) =>
    fireSecondInstance('--open', `\\\\10.255.255.${n}\\s`));
  // A child exits only after requestSingleInstanceLock has handed its payload to
  // the primary's message loop, so "it exited 0" is the witness that main really
  // was asked to resolve a dead host — without it a probe that merely ran before
  // the children got going would pass against the very build this exists to
  // fail. Against the frozen build they cannot exit (their SendMessage is
  // waiting on a message loop that is inside realpathSync), which is the same
  // symptom seen from the other end.
  const exits = Promise.all(flood.map((c) => new Promise((r) => {
    const t = setTimeout(() => r(false), 45_000);
    c.once('exit', (code) => { clearTimeout(t); r(code === 0); });
  })));

  // Sampled across the whole resolution window rather than once: the launches
  // are handled one at a time, and the worst sample is the one that counts.
  let floodMs = 0;
  let floodOk = true;
  while (Date.now() - floodAt < 30_000) {
    const [ms, ok] = await probe();
    floodMs = Math.max(floodMs, ms);
    if (!ok) { floodOk = false; break; }
    await win.waitForTimeout(250);
  }
  const forwarded = (await exits).filter(Boolean).length;
  check('the window still serves a real filesystem request while four unreachable UNC --opens resolve',
    floodOk && floodMs < 3_000 && forwarded === flood.length,
    `folder listing: ${idleMs}ms idle -> worst ${floodMs}ms under the flood`
      + `${floodOk ? '' : ' (never completed)'}; ${forwarded}/${flood.length} launches forwarded and exited 0`);
  for (const c of flood) c.kill();

  beforeRestart = await titles(win);
  await win.waitForTimeout(1_500); // the debounced workspace save is 400ms
  await close();
}

// --- instance 2: the restore race ------------------------------------------
// App.tsx's restore ends in a *replacing* setTabs(restored). An argv tab that
// landed before it resolved used to be silently destroyed; the renderer now
// holds it behind a gate and appends it as restore's last act. This is that
// regression test, and it is the reason the argv tab is APPENDED and not
// substituted for the workspace.
console.log('\ninstance 2 — relaunch with --open, expect restore + one appended tab');
{
  const { win, close } = await launchApp({ userDataDir: PROFILE, extraArgs: ['--open', ROOT] });
  await win.waitForSelector('.tab:not(.add)');
  await win.waitForTimeout(2_500);

  const ts = await titles(win);
  check('the argv tab did not clobber the restored workspace',
    ts.length === beforeRestart.length + 1,
    `${beforeRestart.length} restored + 1 expected, got ${ts.length}: ${ts.join(' | ')}`);
  const kept = beforeRestart.every((t) => ts.includes(t));
  check('every previously-open tab is still present', kept,
    kept ? '' : `missing: ${beforeRestart.filter((t) => !ts.includes(t)).join(', ')}`);
  // NOT `act === 'Claude Explorer'`: this run's titles have THREE tabs sharing
  // that name (home's folder name can coincide, plus the earlier --new-session
  // tab, plus this argv tab), so a title-string match would pass even if the
  // persisted (restored) tab kept focus instead of the argv one — exactly the
  // regression this check exists to catch. Assert the active tab's INDEX is
  // last instead, which is unambiguous regardless of duplicate titles.
  const activeIndex = await win.locator('.tab:not(.add)')
    .evaluateAll((els) => els.findIndex((e) => e.classList.contains('active')));
  check('and the argv tab is the focused one',
    ts[ts.length - 1] === ROOT_TAB && activeIndex === ts.length - 1,
    `last "${ts[ts.length - 1]}", active index ${activeIndex} of ${ts.length}`);

  await close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
