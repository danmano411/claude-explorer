// KAN-74 (activity dot) + KAN-76 (cross-space needs-input markers), against
// the real running app.
//   npm run build && node test/harness/dotmarkers.mjs
//   npm run build && node test/harness/dotmarkers.mjs --skip-markers   (cheap subset, for a baseline run)
//
// THE CLAIM, per ticket: "switching tabs or spaces must not change any dot",
// proved by literally switching away from a real Claude session and back and
// watching its dot the whole time — not by inspecting the implementation.
// §1-§3 read the DOM a real consumer would (`.tab-status`'s class). §4, once
// the Claude tab is backgrounded, instead reads `CH.claudeState` through the
// same `window.__ceStates` recorder claudestate.mjs installs — NOT because
// this is a DOM-state test in disguise, but because a diagnostic run proved
// `.xterm-rows`'s text freezes solid the instant its pane goes `hidden` and
// does not move again until it is shown (see the note above `statesFor`),
// so pane text is the wrong instrument once backgrounded. `.tab-status`,
// `.tab.needs-input` and `.spacemenu-flag` are unaffected — they are driven
// by the same React state as `claude:state` itself, not by xterm's renderer —
// and stay DOM reads throughout.
//
// WHY THE FLICKER NEEDS A REAL PTY AND NOT A MOCK. The mechanism (identified
// by reading Terminal.tsx, not assumed): `.pane[hidden] { display:none }`
// collapses a backgrounded Claude tab's box to 0x0, and showing it again is a
// genuine ResizeObserver-firing resize. Terminal.tsx's `resize()` has already
// been `told` once (every pty gets its first size synchronously at spawn), so
// EVERY later resize — including one caused by nothing but a tab becoming
// visible again, with no size actually changing — unconditionally calls
// `ptyResize` after ~120-250ms. ConPTY answers ANY resize, same size or not,
// by re-emitting its whole screen buffer (documented in Terminal.tsx's own
// KAN-50 comment), so a `pty:data` burst reliably lands 120-250ms after every
// tab-switch-back, driven purely by layout, never by Claude. The pre-KAN-74
// dot read that burst as "running". This harness switches away and back with
// NO keystroke and NO real Claude activity in between and watches for
// exactly that burst moving the dot.
//
// RED-FIRST. Run with `--skip-markers` against a build of `main`
// (fd1e7a3, i.e. feat/kan-73-state-signal — the base this branch stacks on,
// which is what has to compile for this file to even import the right
// contract): §1 (dormant tab) and §3 (switch flicker) go red because
// TabBar.tsx:425's `?? 'running'` default and the PtyStatus-driven dot are
// both still there. §4 (KAN-76 markers) is skipped on that run rather than
// paying for a real permission prompt against a build that cannot have the
// feature at all — `SpaceMenuProps` has no `needsInput` there and
// `.spacemenu-flag` does not exist in index.css, so its absence is
// structural, not a timing race worth an expensive proof.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const SKIP_MARKERS = process.argv.includes('--skip-markers');

const PROFILE = path.join(os.tmpdir(), `claude-explorer-dotmarkers-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

const WORK = path.join(os.tmpdir(), `ce-dotmarkers-${process.pid}`);
const SESSION_DIR = path.join(WORK, `ce-session-${process.pid}`);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(SESSION_DIR, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// --- navigation / spawn helpers (same idiom as claudestate.mjs) ------------

async function goTo(win, dir) {
  await win.locator('.address').click();
  await win.waitForTimeout(200);
  await win.locator('.address-input').fill(dir);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1_200);
}

const TRUST = /1\. Yes, I trust this folder/i;
const READY = /Tips for getting started|Welcome back/i;

/** The Claude tab's own dot. `.tab-status` is unique in this app's markup —
 *  only a Claude terminal tab renders one — so this stays valid whether or
 *  not that tab is currently active, and whether or not it has spawned yet
 *  (an unspawned Claude tab still renders the bare, classless dot). */
const dotClass = (win) => win.locator('.tab-status').getAttribute('class').catch(() => null);
const dotTab = (win) => win.locator('.tab:has(.tab-status)');

/** Text of a SPECIFIC pty's pane, regardless of whether its tab/space is
 *  currently on screen — xterm keeps writing into its row divs even while an
 *  ancestor `.pane` is `hidden` (display:none only skips paint, not the
 *  write), which is exactly how a background space's blocked session can be
 *  read at all without switching to it (see spaces.mjs's `termText`). */
const paneTextFor = (win, ptyId) =>
  win.$eval(`[data-pty="${ptyId}"] .xterm-rows`, (el) => el.textContent).catch(() => '');

async function waitPaneFor(win, ptyId, pred, ms) {
  const t0 = Date.now();
  for (;;) {
    const text = await paneTextFor(win, ptyId);
    if (pred(text)) return text;
    if (Date.now() - t0 > ms) return text;
    await win.waitForTimeout(1_000);
  }
}

/**
 * MEASURED, NOT ASSUMED — the reason §4 does not read pane text once the
 * Claude tab is backgrounded: `.xterm-rows`'s textContent FREEZES SOLID the
 * instant its `.pane` ancestor goes `hidden` (a diagnostic run confirmed the
 * exact byte length stops changing across 8+ seconds of real Claude output),
 * and does not move again until the pane is shown — xterm's own DOM renderer
 * evidently skips updating rows for a container with no layout box, on top of
 * (and separate from) the ConPTY-repaint-on-resize mechanism §3 is about.
 * `CH.claudeState` has no such gap: the same diagnostic run showed
 * working/working/working/idle arrive right on time while the pane sat
 * frozen. So §4 reads THIS, exactly like claudestate.mjs's own `__ceStates`
 * recorder, rather than scraping a view that cannot be trusted while hidden.
 */
const statesFor = (win, ptyId) =>
  win.evaluate((id) => (window.__ceStates ?? []).filter((s) => s[0] === id).map((s) => s[1]), ptyId);

async function waitStates(win, ptyId, pred, ms) {
  const t0 = Date.now();
  for (;;) {
    const seen = await statesFor(win, ptyId);
    if (pred(seen)) return seen;
    if (Date.now() - t0 > ms) return seen;
    await win.waitForTimeout(1_000);
  }
}

const submitTo = (win, ptyId) => win.evaluate((id) => window.api.ptyWrite(id, '\r'), ptyId);

/** Poll a class-returning getter until it reports the SAME value twice in a
 *  row 300ms apart, or give up after `ms`. Used to find a resting point
 *  before measuring whether something LATER disturbs it — never used to
 *  decide the actual pass/fail, only to know when it is safe to start
 *  watching. */
async function settle(getter, ms) {
  const t0 = Date.now();
  let last = await getter();
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const cur = await getter();
    if (cur === last) return cur;
    last = cur;
    if (Date.now() - t0 > ms) return cur;
  }
}

/** Poll `getter()` until `pred` is true, or give up after `ms` and return
 *  whatever it last read. Used to wait out unrelated boot-time chatter (a
 *  blinking cursor at the idle prompt is itself `pty:data`, same as any other
 *  byte, and can keep unmodified code's dot on 'running' for a few seconds
 *  after the welcome screen paints) before §2 tries to isolate typing as the
 *  cause of a change — measuring "did it move" against a baseline that is
 *  already moving on its own proves nothing about typing specifically. */
async function waitUntil(getter, pred, ms) {
  const t0 = Date.now();
  for (;;) {
    const cur = await getter();
    if (pred(cur)) return cur;
    if (Date.now() - t0 > ms) return cur;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Every distinct value `getter()` reports over a `ms` window, sampled every
 *  100ms. The core instrument of this file: "did anything move, even
 *  briefly" is a set-size question, not a before/after equality one — a
 *  flicker that lands and reverts inside the window must still be caught. */
async function sampleDistinct(getter, ms) {
  const seen = new Set();
  const t0 = Date.now();
  for (;;) {
    seen.add(await getter());
    if (Date.now() - t0 > ms) return [...seen];
    await new Promise((r) => setTimeout(r, 100));
  }
}

// === launch =================================================================

let ptyId = null; // re-captured after restart; a pty handle does not survive one

// --- run 1: open a Claude tab (untrusted), leave a FILE tab focused, quit --
{
  const { win, close } = await launchApp({ userDataDir: PROFILE });
  await win.waitForSelector('.entry');
  await goTo(win, WORK);
  const row = win.locator('.entry', { hasText: path.basename(SESSION_DIR) });
  await row.first().locator('.entry-open').click();
  await win.waitForSelector('[data-pty]', { timeout: 25_000 });
  check('the Claude tab has a pty handle before quitting', true);

  // A second, FILE tab — and leave IT focused. This is the load-bearing
  // setup for §1: the Claude tab restores with a persisted record but no
  // ptyId, and is not the active tab either, so nothing auto-spawns it.
  await win.click('.tab.add');
  await win.waitForTimeout(600);
  const twoTabs = await win.locator('.tab:not(.add)').count();
  check('a second (file) tab is open and focused, Claude tab is not', twoTabs === 2, `${twoTabs} tabs`);

  await win.waitForTimeout(1_500); // the debounced workspace save (400ms) plus margin
  await close();
}

// --- run 2: relaunch, same profile ------------------------------------------
const { win, close } = await launchApp({ userDataDir: PROFILE });
// Installed before anything spawns, same idiom as claudestate.mjs — this is
// what §4 reads instead of pane text once the Claude tab is backgrounded (see
// the note above `statesFor` below for why pane text cannot be trusted there).
await win.evaluate(() => {
  window.__ceStates = [];
  window.api.onClaudeState((id, state) => window.__ceStates.push([id, state]));
});
await win.waitForSelector('.tab:not(.add)');
await win.waitForTimeout(800);

// ============================================================================
// §1 — KAN-74 acceptance #1/#5: a restored, never-activated Claude tab reads
// as dormant, never a guessed 'running'/'working'. Checked BEFORE the tab is
// ever clicked.
// ============================================================================
{
  const tab = dotTab(win);
  const tabCls = await tab.getAttribute('class');
  check('the Claude tab is present but NOT active after restart',
    !!tabCls && !tabCls.includes('active'), tabCls ?? '(not found)');

  const cls = await dotClass(win);
  // The bug this proves: TabBar.tsx:425's `status.get(t.ptyId!) ?? 'running'`
  // renders `tab-status running` for a tab with NO pty at all. The fix has no
  // state-suffixed class here because `claudeState.get(undefined)` is never
  // consulted — `t.ptyId` is checked first.
  check('its dot has NO running/working class — dormant, not a guessed state',
    !!cls && !/\brunning\b|\bworking\b/.test(cls), cls ?? '(none)');
}

// Activate it now, for real, for §2/§3.
await dotTab(win).click();
await win.waitForSelector('[data-pty]', { timeout: 25_000 });
ptyId = await win.$eval('[data-pty]', (el) => el.dataset.pty);
check('re-activation gave the Claude tab a fresh pty', !!ptyId, ptyId ?? 'none');

await waitPaneFor(win, ptyId, (t) => TRUST.test(t), 30_000);
// Answer the trust dialog now (not just in §4): it does not echo arbitrary
// keystrokes — it only recognises 1/2/Enter/Esc — so a byte typed while it is
// still up would not exercise §2 at all (measured: a stray key there produces
// no output on unmodified code either, which is a false pass, not a real
// one). Past it, the idle "❯" prompt DOES echo whatever is typed.
await submitTo(win, ptyId);
await waitPaneFor(win, ptyId, (t) => READY.test(t), 60_000);
// Let the dot come to rest before either §2 or §3 tries to disturb it. A
// blinking cursor at the idle prompt is ITSELF `pty:data`, so unmodified code
// can sit on 'running' for several seconds after the welcome screen paints —
// waiting for two equal 300ms-apart reads alone can catch it mid-blink and
// call that "resting". Wait out that window explicitly (up to 15s) rather
// than accept the first stable-looking read, so §2's "before" is a value
// typing could ACTUALLY move away from.
const resting = await waitUntil(() => dotClass(win), (c) => c !== 'tab-status running', 15_000);
check('the dot reached a resting class before being tested', !!resting, resting ?? '(none)');

// ============================================================================
// §2 — KAN-74 acceptance #2: typing does not move the dot. Written straight
// to the pty (not through keyboard/focus) — this is not the terminal-echo
// trap the project's testing notes warn about (nothing here asserts on PANE
// TEXT), it is just the more direct way to deliver a keystroke. Sent at the
// idle "❯" prompt (past the trust dialog), which is the one place it is
// guaranteed to be echoed rather than silently dropped.
// ============================================================================
{
  const before = await dotClass(win);
  await win.evaluate((id) => window.api.ptyWrite(id, 'x'), ptyId);
  const seen = await sampleDistinct(() => dotClass(win), 1_000);
  check('typing a keystroke never changes the dot\'s class, at any sampled instant',
    seen.length === 1 && seen[0] === before, `before="${before}" seen=${JSON.stringify(seen)}`);
}

// ============================================================================
// §3 — THE FLICKER. KAN-74 acceptance #3: switching tabs must not change any
// dot. Switch away (hides the Claude tab, collapsing its box) and back (the
// resize that unconditionally schedules a ptyResize ~120-250ms later) with NO
// input in between, and watch the WHOLE window for any transient class.
// ============================================================================
{
  // The class right before we touch anything — the Claude tab is still active.
  const before = await settle(() => dotClass(win), 2_000);

  // Switch away: a fresh, blank tab (cheap, no pty of its own) becomes active,
  // which is what collapses the Claude tab's `.pane` to `display:none`.
  await win.click('.tab.add');
  await win.waitForTimeout(1_000); // idle, no keystroke, no real Claude activity

  // ...then back — the critical hidden -> visible transition that, on
  // unmodified code, unconditionally schedules a resize-driven ptyResize.
  await dotTab(win).click();

  const seen = await sampleDistinct(() => dotClass(win), 1_000);
  check('switching away and back never changes the dot\'s class, at any sampled instant',
    seen.length === 1 && seen[0] === before,
    `before="${before}" seen=${JSON.stringify(seen)} (a second distinct value here IS the reported flicker)`);
}

// ============================================================================
// §4 — KAN-76: the cross-space marker, driven by a REAL permission prompt.
// Expensive (a real model turn deciding to use a tool), so skippable for a
// baseline run where the feature cannot exist at all regardless.
// ============================================================================
if (SKIP_MARKERS) {
  console.log('\n§4 skipped (--skip-markers)');
} else {
  console.log('\n§4 — cross-space "needs you" marker');

  const openSpaceMenu = async () => {
    await win.click('.spacemenu-btn');
    await win.waitForSelector('.spacemenu-dropdown');
    await win.waitForTimeout(150);
  };
  const homeName = await win.locator('.spacemenu-name').textContent();

  // Already trusted and booted before §2/§3 ran (needed there too, so it
  // happens once, above) — just confirm it is still the idle "❯" prompt a
  // real tool call needs.
  const booted = await paneTextFor(win, ptyId);
  check('the session is booted and idle (needed for a real tool call)', READY.test(booted),
    booted.trim().slice(-100).replace(/\s+/g, ' '));

  // A second space, and switch INTO it — the Claude tab's home space becomes
  // the background one this whole section is about.
  await openSpaceMenu();
  await win.locator('.spacemenu-item', { hasText: 'New empty space' }).click();
  await win.waitForSelector('.spacemenu-rename');
  await win.locator('.spacemenu-rename').fill('Other');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(500);
  const activeName = await win.locator('.spacemenu-name').textContent();
  check('a second space exists and is now active', activeName === 'Other', activeName);

  check('no chip marker before anything is blocked',
    (await win.locator('.spacemenu-btn .spacemenu-flag').count()) === 0);

  // Up to two real attempts: the model does not always choose a path that
  // needs approval (claudestate.mjs's own §4 documents the same possibility).
  // Each attempt is a fresh, unambiguous request for a write the folder has
  // not pre-approved, sent straight to the pty (no keyboard/focus — the pane
  // is backgrounded) and confirmed submitted via the FIRST 'working' state
  // that follows it, since pane text can no longer say so (see `statesFor`).
  const PROMPTS = [
    'Use your Write tool to create kan74probe.txt containing the word probe.',
    'Use your Write tool to create kan74probe2.txt containing the word probe.',
  ];
  let asked = false;
  let sentAny = false;
  for (const prompt of PROMPTS) {
    const before = (await statesFor(win, ptyId)).length;
    await win.evaluate(([id, p]) => window.api.ptyWrite(id, p), [ptyId, prompt]);
    await win.waitForTimeout(800);
    await submitTo(win, ptyId);
    let afterSubmit = await waitStates(win, ptyId, (s) => s.length > before, 15_000);
    if (afterSubmit.length === before) {
      await submitTo(win, ptyId); // a stray CR sometimes lands before the prompt finished landing
      afterSubmit = await waitStates(win, ptyId, (s) => s.length > before, 15_000);
    }
    if (afterSubmit.length > before) sentAny = true;
    const seen = await waitStates(win, ptyId, (s) => s.includes('awaiting-input') || s.at(-1) === 'idle', 180_000);
    if (seen.includes('awaiting-input')) { asked = true; break; }
  }
  check('the tool-use prompt was submitted to the (backgrounded) Claude tab', sentAny);
  check('a real permission-blocked state was reached while that space was in the background', asked,
    asked ? 'awaiting-input recorded' : 'both attempts completed without ever needing approval — nothing measured, see note above');

  if (asked) {
    // THE ACTUAL REPORTED SCENARIO: the marker on the RIGHT space, while a
    // DIFFERENT space is active — not merely "a CSS class exists somewhere".
    check('the space CHIP is marked while "Other" (not the blocked session\'s space) is active',
      (await win.locator('.spacemenu-btn .spacemenu-flag').count()) > 0);

    await openSpaceMenu();
    // Scoped by CONTAINING a `.spacemenu-item-name` with this text, not by
    // `hasText` on `.spacemenu-item` directly — the bottom action rows ("New
    // empty space" et al.) share the `.spacemenu-item` class and, since
    // `hasText` is a case-insensitive substring match, "New empty space"
    // would otherwise satisfy `hasText: homeName` whenever the default space
    // name ("Space") is still in play.
    const rows = win.locator('.spacemenu-item');
    const homeRow = rows.filter({ has: win.locator('.spacemenu-item-name', { hasText: homeName }) });
    const otherRow = rows.filter({ has: win.locator('.spacemenu-item-name', { hasText: 'Other' }) });
    check('the BLOCKED space\'s dropdown row is marked',
      (await homeRow.locator('.spacemenu-flag').count()) > 0);
    check('the ACTIVE space\'s own row is NOT marked (its tab already shows this directly)',
      (await otherRow.locator('.spacemenu-flag').count()) === 0);
    // Visiting the blocked tab's own space: the TAB-level marker, and that
    // looking at it does not clear anything. The dropdown is still open from
    // the row checks just above — switch straight from the home row rather
    // than closing and reopening.
    await homeRow.first().click();
    await win.waitForTimeout(300);
    check('the tab itself carries a marker distinct from the dot (KAN-76 #1)',
      (await win.locator('.tab.needs-input').count()) > 0);
    check('and the dot is specifically awaiting-input, not just "working"',
      /\bawaiting-input\b/.test(await dotClass(win)), await dotClass(win));

    // Back to "Other" — focus alone must not have cleared it.
    await openSpaceMenu();
    await win.locator('.spacemenu-item-name', { hasText: 'Other' }).first().click();
    await win.waitForTimeout(300);
    check('merely having VISITED the blocked tab did not clear the chip marker',
      (await win.locator('.spacemenu-btn .spacemenu-flag').count()) > 0);

    // Approve, and prove the marker clears WITHOUT ever visiting again —
    // "Other" stays active for the rest of this section.
    await submitTo(win, ptyId);
    const t0 = Date.now();
    let cleared = false;
    while (Date.now() - t0 < 120_000) {
      if ((await win.locator('.spacemenu-btn .spacemenu-flag').count()) === 0) { cleared = true; break; }
      await win.waitForTimeout(1_000);
    }
    check('the marker clears once the session leaves awaiting-input — with nobody visiting', cleared);
  } else {
    check('the marker-appears / marker-clears scenario was exercised', false,
      'no permission dialog appeared — nothing measured, see note above');
  }
}

// === report =================================================================
await close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log(`  FAILED: ${f.name}`);
process.exit(failed.length ? 1 : 0);
