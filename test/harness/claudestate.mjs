// KAN-73: the Claude session-state signal, end to end, against the real app.
//   npm run build && node test/harness/claudestate.mjs
//
// THE CLAIM. A Claude session this app launched tells the app what it is doing,
// and nobody else can. The unit tests (test/claudestate.test.ts) hold the state
// machine and the correlation with captured payloads; what needs a real app is
// the half no fixture can fake — that the settings file we write is one a real
// claude.exe accepts, that its hooks reach a port that is only known at run
// time, and that the bearer they carry is the one main minted.
//
// WHAT IS DELIBERATELY NOT ASSERTED HERE: that `--settings` appears on the
// command line. That is the trap the ticket names — a flag proves nothing about
// whether a state ever arrives — so every assertion below is a TRANSITION
// OBSERVED ON THE CHANNEL, read out of the renderer through the same
// `window.api.onClaudeState` any consumer will use.
//
// THE ECHO TRAP. Nothing here reads the terminal to decide a state; the pane is
// only ever read to know when to act (the trust prompt, the permission dialog).
// The states themselves come off the IPC channel, which a keystroke cannot
// write to.
//
// THE POSITIVE CASE CANNOT BE FORGED FROM OUTSIDE, and that is the design: the
// token exists only in main's memory and in the environment of a pty this app
// spawned. So §2 is negative-only, and §3/§4 — a real Claude in a real tab —
// are what make it mean something. A server that 401s everything, or one that
// never started, passes §2 on its own.
//
// RED-FIRST. Run against a build whose src/main/pty.ts does not push
// `--settings` (i.e. `main`): §1 goes red (no claude-hooks.json is written at
// all), and §3 and §4 go red with zero states recorded — while §2 stays green,
// which is exactly why §2 alone is not enough.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import { launchApp } from './app.mjs';

const PROFILE = path.join(os.tmpdir(), `claude-explorer-cstate-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

// A fresh folder per run: Claude Code has never been trusted here, so the
// permission dialog in §4 is reached from a known starting point rather than
// from whatever the developer has previously approved.
const WORK = path.join(os.tmpdir(), `ce-cstate-${process.pid}`);
const SESSION_DIR = path.join(WORK, `ce-session-${process.pid}`);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(SESSION_DIR, { recursive: true });

const VIS = '.pane:not([hidden]) ';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// --- probes -----------------------------------------------------------------

/** One raw HTTP POST. Never throws — a transport failure is `{ error }`. */
function post(port, headers, body) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/claude-state', method: 'POST', headers, timeout: 8_000 },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.write(body);
    req.end();
  });
}

const paneText = (win) => win.$eval(VIS + '.xterm-rows', (el) => el.textContent).catch(() => '');

async function goTo(win, dir) {
  await win.locator('.address').click();
  await win.waitForTimeout(200);
  await win.locator('.address-input').fill(dir);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1_200);
}

/** The CR xterm's own onData would send. Written straight to the pty, because a
 *  keyboard press depends on the helper textarea holding focus at that instant
 *  and this harness is not the one that tests keyboard handling. */
const submit = async (win) => {
  const ptyId = await win.$eval(VIS + '[data-pty]', (el) => el.dataset.pty).catch(() => null);
  if (ptyId) await win.evaluate((id) => window.api.ptyWrite(id, '\r'), ptyId);
  return ptyId;
};

const MODAL = /1\. Yes, I trust this folder/i;

async function waitPane(win, pred, ms, nudge = false) {
  const t0 = Date.now();
  for (;;) {
    const text = await paneText(win);
    if (pred(text)) return text;
    if (Date.now() - t0 > ms) return text;
    if (nudge && MODAL.test(text)) await submit(win);
    await win.waitForTimeout(1_000);
  }
}

/** Type a question and keep sending CR until the input box is observably empty —
 *  a CR landing too soon after a burst of characters is dropped, and the
 *  question then sits unsent for the whole timeout. */
async function ask(win, prompt) {
  const needle = prompt.slice(-24).replace(/\s+/g, '');
  const stillInBox = async () => {
    const t = await paneText(win);
    return t.slice(t.lastIndexOf('❯')).replace(/\s+/g, '').includes(needle);
  };
  await win.locator(VIS + '.xterm-screen').click();
  await win.keyboard.type(prompt);
  await win.waitForTimeout(800);
  for (let i = 0; i < 12; i++) {
    const ptyId = await submit(win);
    await win.waitForTimeout(2_500);
    if (!(await stillInBox())) return ptyId;
  }
  return null;
}

/** Every (ptyId, state) the renderer has received since the recorder was
 *  installed — read through the SAME preload binding a real consumer uses. */
const states = (win, ptyId) =>
  win.evaluate((id) => (window.__ceStates ?? []).filter((s) => s[0] === id).map((s) => s[1]), ptyId);

/** Poll until `pred` is true of the states seen for `ptyId`. Returns the last
 *  list either way, so a timeout reports as a FAIL with what WAS seen. */
async function waitStates(win, ptyId, pred, ms) {
  const t0 = Date.now();
  for (;;) {
    const seen = await states(win, ptyId);
    if (pred(seen)) return seen;
    if (Date.now() - t0 > ms) return seen;
    await win.waitForTimeout(700);
  }
}

const TRUST = /1\. Yes, I trust this folder/i;
const READY = /Tips for getting started|Welcome back/i;
// Any of Claude Code's permission dialogs — "…proceed?", "…create foo.txt?".
// Not just the Bash wording: `echo` is on Claude Code's own safe-command list
// and is auto-approved, which is why §4 asks for a WRITE instead. (Measured: a
// `Bash(echo …)` question raised no dialog at all and the section could not
// run.)
const PERMISSION = /Do you want to /i;

// === launch =================================================================
const { win, close } = await launchApp({ userDataDir: PROFILE });

// Installed before anything spawns, so no transition can be missed. It survives
// for the life of the page; nothing here navigates.
await win.evaluate(() => {
  window.__ceStates = [];
  window.api.onClaudeState((ptyId, state) => window.__ceStates.push([ptyId, state]));
});

let PORT = 0;

// --- 1. the settings file we hand to claude ---------------------------------
console.log('\n1 — claude-hooks.json');
{
  const p = path.join(PROFILE, 'claude-hooks.json');
  const raw = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  let cfg = null;
  try { cfg = JSON.parse(raw); } catch { /* reported below */ }
  const hook = cfg?.hooks?.Stop?.[0]?.hooks?.[0] ?? null;
  check('the app wrote a --settings file with http hooks', hook?.type === 'http',
    raw ? `${raw.length} bytes` : `${p} is absent`);

  const m = /^http:\/\/127\.0\.0\.1:(\d+)\/claude-state$/.exec(hook?.url ?? '');
  PORT = m ? Number(m[1]) : 0;
  check('its hooks POST to loopback on the ephemeral port', !!m && PORT > 1024, hook?.url ?? '');

  // The same property mcp-agent-control.json has: the file names the variable,
  // Claude Code expands it per invocation, and the real token never lands on
  // disk. A 64-hex run anywhere in this file would be the token itself.
  check('the bearer on disk is the LITERAL variable, not the token',
    /\$\{?CLAUDE_EXPLORER_MCP_TOKEN\}?/.test(hook?.headers?.Authorization ?? '')
      && !/[0-9a-f]{64}/.test(raw),
    hook?.headers?.Authorization ?? '');

  // Verified in the binary: header interpolation happens ONLY for variables
  // named here. Get this wrong and every hook fires, every request is a literal
  // `Bearer ${...}`, the server 401s all of them, and no state ever arrives —
  // with a settings file that looks perfectly correct.
  check('the variable it interpolates is the one it allowlists',
    (hook?.allowedEnvVars ?? []).includes('CLAUDE_EXPLORER_MCP_TOKEN'),
    JSON.stringify(hook?.allowedEnvVars ?? null));

  // Same listener as the MCP tools, so one bearer check covers both.
  const mcpRaw = fs.readFileSync(path.join(PROFILE, 'mcp-agent-control.json'), 'utf8');
  const mcpPort = Number(/127\.0\.0\.1:(\d+)/.exec(mcpRaw)?.[1] ?? 0);
  check('it is the same loopback listener the MCP tools use', PORT === mcpPort && PORT > 0,
    `hooks ${PORT}, mcp ${mcpPort}`);
}

// --- 2. fail-closed: an unauthenticated local process cannot forge a state ---
console.log('\n2 — forging a state without the token');
{
  // A payload that WOULD be acted on if it were authenticated: the session id
  // is the one §3 is about to use, so this is the same request the real hook
  // makes, minus the credential.
  const FORGED = JSON.stringify({
    session_id: '00000000-1111-4111-8111-000000000000',
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
  });
  const cases = [
    ['no Authorization header at all', {}],
    ['a wrong bearer', { authorization: 'Bearer nope' }],
    // The measured silent failure: an unset variable makes Claude Code send the
    // literal. mcpauth.ts must treat it as a credential, not as a token.
    ['the un-expanded literal', { authorization: 'Bearer ${CLAUDE_EXPLORER_MCP_TOKEN}' }],
    ['no scheme', { authorization: '0'.repeat(64) }],
  ];
  const before = await win.evaluate(() => window.__ceStates.length);
  for (const [what, headers] of cases) {
    const r = await post(PORT, { 'content-type': 'application/json', ...headers }, FORGED);
    check(`${what} is refused with 401`, r.status === 401, JSON.stringify(r.error ?? r.status));
  }
  await win.waitForTimeout(500);
  const after = await win.evaluate(() => window.__ceStates.length);
  // The refusal is the point, but the 401 alone would also be satisfied by a
  // server that answered 401 AND acted anyway.
  check('none of them reached the renderer', after === before, `${after - before} events`);
}

// --- 3. a real session: working, then idle ----------------------------------
console.log('\n3 — a real Claude turn, observed on the channel');
let ptyId = null;
{
  await goTo(win, WORK);
  const rows = win.locator('.entry', { hasText: path.basename(SESSION_DIR) });
  await rows.first().locator('.entry-open').click(); // orange arrow: Claude, in place
  await win.waitForSelector(VIS + '.xterm', { timeout: 25_000 });

  await waitPane(win, (t) => TRUST.test(t) || READY.test(t), 60_000);
  const booted = await waitPane(win, (t) => READY.test(t), 120_000, true);
  check('the session finished starting up', READY.test(booted),
    booted.trim().slice(-100).replace(/\s+/g, ' '));

  ptyId = await win.$eval(VIS + '[data-pty]', (el) => el.dataset.pty).catch(() => null);
  check('the tab has a pty to report against', !!ptyId, ptyId ?? 'none');

  // A question with no tool in it, so this section measures the plain
  // prompt -> answer transition and §4 owns the permission one.
  const sent = await ask(win, 'Reply with exactly the word DONE and nothing else.');
  check('the question was actually SENT to that pty', !!sent, sent ?? 'still in the box');

  const working = await waitStates(win, ptyId, (s) => s.includes('working'), 60_000);
  check('the session reported WORKING once the prompt was submitted',
    working.includes('working'), JSON.stringify(working));

  // The transition byte traffic could never produce: the turn ENDING, as
  // distinct from a gap in output. Generous, because this is a real model turn
  // at whatever effort the developer's Claude Code is set to.
  const done = await waitStates(win, ptyId, (s) => s.at(-1) === 'idle', 300_000);
  check('and IDLE when the turn ended', done.at(-1) === 'idle', JSON.stringify(done));

  // Ordering, not just membership: an implementation that emitted both on every
  // event would satisfy the two checks above and tell a consumer nothing.
  check('working came before idle', done.indexOf('working') < done.lastIndexOf('idle'),
    JSON.stringify(done));
}

// --- 4. blocked on a permission prompt --------------------------------------
console.log('\n4 — a permission prompt is a state, not a silence');
{
  const mark = await win.evaluate(() => window.__ceStates.length);
  // A tool call in a folder nothing has approved. To pty traffic this is
  // indistinguishable from §3's thinking — output stops and stays stopped —
  // which is the entire reason this ticket exists.
  const sent = await ask(win, 'Use your Write tool to create kan73probe.txt containing the word probe.');
  check('the tool question was SENT', !!sent, sent ?? 'still in the box');

  const dialog = await waitPane(win, (t) => PERMISSION.test(t), 300_000);
  const asked = PERMISSION.test(dialog);
  check('Claude Code raised a permission dialog to be blocked on', asked,
    asked ? 'dialog on screen' : 'no dialog — nothing to measure, see below');

  if (asked) {
    const blocked = await waitStates(win, ptyId,
      (s) => s.slice(mark).includes('awaiting-input'), 30_000);
    check('the session reported AWAITING-INPUT while the dialog was up',
      blocked.slice(mark).includes('awaiting-input'), JSON.stringify(blocked.slice(mark)));

    // The leave-transition, and the reason PostToolUse is registered at all: an
    // approved session must not sit on "needs you" for the whole duration of a
    // tool the user already said yes to. Nothing fires on the approval itself,
    // and PreToolUse has ALREADY fired by the time the dialog appears — this
    // block is what measured that, and it is why the design's five hooks became
    // six.
    await submit(win); // takes the highlighted "yes"
    const cleared = await waitStates(win, ptyId,
      (s) => s.at(-1) !== 'awaiting-input', 120_000);
    const after = cleared.slice(cleared.lastIndexOf('awaiting-input') + 1);
    check('and left AWAITING-INPUT once the tool was approved',
      cleared.at(-1) !== 'awaiting-input', JSON.stringify(cleared.slice(mark)));
    // WORKING, not merely "not awaiting-input". Reaching `idle` alone would
    // mean the only thing that ever cleared the blocked state was the turn
    // ending — which is what the build without PostToolUse did, and what leaves
    // a long tool call sitting on a false alarm.
    check('by reporting WORKING, not by waiting for the turn to end',
      after[0] === 'working', JSON.stringify(after));
  } else {
    // Not a pass. A tool that was pre-approved in the developer's own settings
    // never raises a dialog, and reporting green for a section that measured
    // nothing is worse than reporting that it could not run.
    check('the blocked state was exercised', false,
      'no permission dialog appeared — check ~/.claude/settings.json for a blanket Bash allow');
  }
}

// === report =================================================================
await close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log(`  FAILED: ${f.name}`);
process.exit(failed.length ? 1 : 0);
