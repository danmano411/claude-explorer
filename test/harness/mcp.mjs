// KAN-40: the in-process MCP server, end to end, against the real app.
//   npm run build && node test/harness/mcp.mjs
//
// The claim is "a Claude Code running in one of our tabs can ask us what tabs
// are open, and nobody else can". Both halves need a real app: the token exists
// only in main's memory, the port only for this run, and the only thing that is
// ever handed the token is a pty this app spawned.
//
// WHAT DRIVES WHAT, AND WHY
//
//   - The HTTP surface (401s, bind address, teardown) is driven with raw
//     node:http, not fetch. `Host` is a forbidden header for fetch, so undici
//     silently drops an override — the first version of the wildcard-bind probe
//     "passed" that way while proving nothing. Raw http also lets us dial a
//     LAN address the server must not be on.
//   - The one thing raw http CANNOT do is the positive case: the token is never
//     written down, so a client outside this app has no way to obtain it. That
//     is the design, so the positive control is a REAL Claude Code in a REAL
//     tab (section 4). Without it the 401 block would be worthless — a server
//     that 401s everything, or that never started, passes every negative on its
//     own. Sections 3 and 4 are one assertion split in two.
//   - Section 5 asks the SAME question of a `claude -p` started outside the
//     app. Same prompt, opposite answer: that pair is what makes "only our tabs
//     can see it" a measurement rather than a claim.
//
// THE MARKER, AND WHY IT IS NEVER TYPED
//   A terminal echoes what you type, so anything in the prompt is on screen
//   before Claude has done anything. The witness here is instead a folder whose
//   name carries a random suffix, opened as a tab AFTER the Claude session was
//   already running and one second before it is asked. It cannot be echoed (we
//   never type it), cannot be guessed (random), and cannot come from any disk
//   snapshot taken when the session started (it did not exist yet).
//
// RED-FIRST — each was run against a mutated out/main/index.js, then restored:
//   - the auth gate short-circuited (`if (false && !isAuthorized(…))`) → all 7
//     of section 3 go red: 200 for every rejected credential, a 194-byte
//     protocol body on the refusal that should have been empty, and 406 instead
//     of 401 on the ordering probe — which is the transport answering, i.e.
//     precisely the "a bad credential reached SDK code" that check exists for.
//     Sections 1, 2, 4 and 5 stay green, which is the point: the positive
//     control cannot tell you whether the door is locked.
//   - `listen(0, '127.0.0.1')` → `listen(0, '0.0.0.0')` → both measurements in
//     section 2 go red: netstat reports `0.0.0.0:<port>`, and the LAN dial gets
//     a real 401 back instead of ECONNREFUSED. EVERY other section stays green,
//     including the whole of 3, 4 and 5 — loopback still works, so a wildcard
//     bind is invisible to every functional test in this file. That is why the
//     netstat read and the LAN dial are here and not folded into the others.
//   - section 6 measured nothing at all until it was rewritten: it waited for
//     the process to EXIT and then probed the port, and the OS reclaims a port
//     on exit whether or not stopMcpServer() ever ran. Deleting the call from
//     will-quit left the whole block green. It now probes DURING the window
//     will-quit holds open for the trash flush — see the comment there.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { launchApp } from './app.mjs';

// An EXPLICIT throwaway profile, pid-suffixed. The whole of section 1 greps this
// directory, so it must not be the developer's real one; and the single-instance
// lock is keyed on userData, so two concurrent runs (this repo is worked on from
// several worktrees at once) must not share it — the loser would silently
// forward into the winner's window instead of failing.
const PROFILE = path.join(os.tmpdir(), `claude-explorer-mcp-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

// A scratch tree with exactly one child, so the file row we click is unambiguous
// without assuming anything about the checkout or about %TEMP%'s contents.
const WORK = path.join(os.tmpdir(), `ce-mcp-${process.pid}`);
fs.rmSync(WORK, { recursive: true, force: true });
const CLAUDE_DIR = path.join(WORK, `ce-claude-${process.pid}`);
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

// The witness. Random suffix, so no model can produce this string without
// having actually read our tab list — and deliberately OUTSIDE the folder the
// Claude session runs in, so it cannot be reached by looking at the filesystem
// either. The only route to it is list_tabs.
const MARKER = `ce-live-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
const MARKER_ROOT = path.join(os.tmpdir(), `ce-mcp-mark-${process.pid}`);
const MARKER_DIR = path.join(MARKER_ROOT, MARKER);
fs.rmSync(MARKER_ROOT, { recursive: true, force: true });
fs.mkdirSync(MARKER_DIR, { recursive: true });

// A folder with no Claude config of any kind, for the outside-the-app session.
const OUTSIDE_DIR = path.join(WORK, 'outside');
fs.mkdirSync(OUTSIDE_DIR, { recursive: true });

// One prompt, asked in both places. It names the tool and never names MARKER.
const PROMPT = 'Use the list_tabs tool now and reply with only the tab titles it '
  + 'returned, comma separated. If you do not have that tool, reply with only NOTOOL';

const VIS = '.pane:not([hidden]) ';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// --- probes -----------------------------------------------------------------

/** One raw HTTP request. Never throws: a transport failure is `{ error }`, which
 *  is itself an expected answer in sections 2 and 6. */
function probe({ host = '127.0.0.1', port, headers = {}, body = null, timeout = 8_000 }) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: '/mcp', method: 'POST', headers, timeout },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      },
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    if (body) req.write(body);
    req.end();
  });
}

const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'kan40-harness', version: '0' },
  },
});
const MCP_HEADERS = (auth) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(auth === undefined ? {} : { authorization: auth }),
});

/** One raw TCP connect, no HTTP. 'open' when something is still listening,
 *  otherwise the errno — ECONNREFUSED the moment the listening socket is gone,
 *  whether that was stopMcpServer() or the process exiting. Section 6 tells
 *  those two apart by asking whether the process is still alive. */
function connectProbe(port, timeout = 2_000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => done('open'));
    s.once('timeout', () => done('timeout'));
    s.once('error', (e) => done(e.code || 'error'));
  });
}

/** The local addresses netstat reports as LISTENING on `port`. */
function listeners(port) {
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  return out.split(/\r?\n/)
    .filter((l) => /LISTENING/i.test(l))
    .map((l) => l.trim().split(/\s+/)[1] ?? '')
    .filter((a) => a.endsWith(`:${port}`));
}

/** The first non-internal IPv4 this machine has — the address a LAN peer would
 *  dial. Section 2 is meaningless without one. */
const lanAddr = Object.values(os.networkInterfaces()).flat()
  .find((n) => n && n.family === 'IPv4' && !n.internal)?.address ?? null;

/** Every 64-hex run under `dir`, i.e. anything shaped like the token. Binary
 *  blobs (Electron's caches) are skipped — a random 32 bytes matches by chance
 *  and the token is only ever written as text if it is written at all. */
function hexHits(dir) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let text;
      try { text = fs.readFileSync(p, 'latin1'); } catch { continue; }
      if (/[\x00-\x08]/.test(text)) continue; // binary: 32 random bytes match by chance
      const m = text.match(/[0-9a-f]{64}/);
      if (m) hits.push(`${path.relative(dir, p)}:${m[0].slice(0, 12)}…`);
    }
  };
  walk(dir);
  return hits;
}

const paneText = (win) => win.$eval(VIS + '.xterm-rows', (el) => el.textContent).catch(() => '');

/** Point the visible files tab at a folder. */
async function goTo(win, dir) {
  await win.locator('.address').click();
  await win.waitForTimeout(200);
  await win.locator('.address-input').fill(dir);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1_200);
}

/**
 * Send a carriage return to the visible terminal's pty — the same byte, down the
 * same channel, that xterm's own `onData` sends for the Enter key (Terminal.tsx:
 * `term.onData((d) => window.api.ptyWrite(ptyId, d))`). The ptyId comes off
 * `data-pty`, the attribute Terminal.tsx already publishes as a test seam.
 *
 * `keyboard.press('Enter')` is what a user does and it usually works, but it
 * depends on the xterm helper textarea holding focus at that instant, and a run
 * that has just switched tabs sometimes loses that race — the typed question
 * then sits unsent in the prompt box for the whole timeout. This harness is not
 * the one that tests keyboard handling (termsize/filemenu are), so it submits
 * where nothing can drop it.
 */
const submit = async (win) => {
  const ptyId = await win.$eval(VIS + '[data-pty]', (el) => el.dataset.pty).catch(() => null);
  if (ptyId) await win.evaluate((id) => window.api.ptyWrite(id, '\r'), ptyId);
  return ptyId;
};

/**
 * Poll the visible terminal until `pred(text)`. Returns the last text either
 * way, so a timeout reports as a FAIL with the pane contents rather than
 * throwing.
 *
 * `nudge` answers the two modal prompts that sit on the critical path — "do you
 * trust this folder" at startup, and "do you want to proceed" before an MCP tool
 * that has not been pre-approved. A CR takes the highlighted first option of
 * each. It fires ONLY on those strings: an earlier version sent a CR every few
 * polls and the blind ones landed as empty submits mid-turn.
 */
const MODAL = /Do you want to proceed|1\. Yes, I trust this folder/i;

async function waitPane(win, pred, ms, nudge = false) {
  const t0 = Date.now();
  for (;;) {
    const text = await paneText(win);
    if (pred(text)) return text;
    if (Date.now() - t0 > ms) return text;
    if (nudge && MODAL.test(text)) await submit(win);
    await win.waitForTimeout(1_500);
  }
}

/**
 * Type a question into the visible Claude session and get it SENT.
 *
 * The retry is the point. A CR that lands too soon after a burst of typed
 * characters is dropped by Claude Code's input — measured, intermittently, with
 * an 800 ms gap: the question then sits unsent in the prompt box for the whole
 * timeout and the run fails as "no answer" when nothing was ever asked. So keep
 * sending CR until the box is observably empty.
 *
 * "Empty" is read off the LAST `❯` on screen, which is the input box — the
 * submitted question stays on screen above it, so a plain substring search over
 * the pane cannot tell the two apart. Whitespace is stripped because xterm's
 * textContent joins wrapped rows with padding, which splits words.
 */
async function ask(win, prompt) {
  const needle = prompt.slice(-24).replace(/\s+/g, '');
  const stillInBox = async () => {
    const t = await paneText(win);
    return t.slice(t.lastIndexOf('❯')).replace(/\s+/g, '').includes(needle);
  };
  await win.locator(VIS + '.xterm-screen').click();
  await win.keyboard.type(prompt);
  await win.waitForTimeout(800);
  let ptyId = null;
  for (let i = 0; i < 12; i++) {
    ptyId = await submit(win);
    await win.waitForTimeout(2_500);
    if (!(await stillInBox())) return ptyId;
  }
  return null; // never sent — the caller's assertion reports it
}

// Claude Code's own strings, and the only honest readiness signal: the banner is
// only painted once the session is up, and the trust prompt is a modal that
// swallows everything typed at it (typing a sentence into it exits the session).
const TRUST = /1\. Yes, I trust this folder/i;
const READY = /Tips for getting started|Welcome back/i;

const config = () => {
  const p = path.join(PROFILE, 'mcp-agent-control.json');
  return { p, raw: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '' };
};

// === run 1 ==================================================================
const { app, win, close } = await launchApp({ userDataDir: PROFILE });

let PORT = 0;

// --- 1. the config file: a URL, and no secret -------------------------------
console.log('\n1 — mcp-agent-control.json');
{
  const { p, raw } = config();
  let cfg = null;
  try { cfg = JSON.parse(raw); } catch { /* reported below */ }
  const srv = cfg?.mcpServers?.explorer ?? null;
  check('the app wrote an http server config for Claude Code', srv?.type === 'http',
    raw ? `${p} — ${raw.length} bytes` : `${p} is absent`);

  const url = srv?.url ?? '';
  const m = /^http:\/\/127\.0\.0\.1:(\d+)\/mcp$/.exec(url);
  PORT = m ? Number(m[1]) : 0;
  check('its url is loopback, on an ephemeral port, at /mcp', !!m && PORT > 1024, url);

  // The whole point of the design: Claude Code expands this per invocation from
  // the pty environment, so the real token never lands on disk.
  check('the Authorization header is the LITERAL ${CLAUDE_EXPLORER_MCP_TOKEN}',
    srv?.headers?.Authorization === 'Bearer ${CLAUDE_EXPLORER_MCP_TOKEN}',
    JSON.stringify(srv?.headers ?? null));

  // Prove the scanner can see a token before believing it when it says there is
  // none — "grep found nothing" is the single easiest assertion to fake.
  const planted = path.join(PROFILE, 'planted-token.probe');
  fs.writeFileSync(planted, `Bearer ${'a1b2c3d4'.repeat(8)}\n`);
  const withPlant = hexHits(PROFILE);
  fs.rmSync(planted, { force: true });
  check('the token scanner finds a planted 64-hex token under userData',
    withPlant.some((h) => h.startsWith('planted-token.probe')),
    `${withPlant.length} hits: ${withPlant.join(', ') || 'none'}`);

  const hits = hexHits(PROFILE);
  check('and with it removed, NOTHING under userData looks like the token',
    hits.length === 0, hits.join(', ') || `clean (${PROFILE})`);
}

// --- 2. bound to loopback only ----------------------------------------------
console.log('\n2 — bind address');
{
  // A control server on the wildcard, so every probe below is calibrated against
  // a listener that IS on the LAN. Without it, "netstat shows no 0.0.0.0" and
  // "the LAN dial failed" both pass on a machine with no network at all.
  const ctrl = http.createServer((_q, r) => r.writeHead(204).end());
  await new Promise((r) => ctrl.listen(0, '0.0.0.0', r));
  const cport = ctrl.address().port;

  check('a non-loopback IPv4 exists to dial from', !!lanAddr, String(lanAddr));

  const ctrlLines = listeners(cport);
  check('control: netstat reports a wildcard bind as 0.0.0.0',
    ctrlLines.some((a) => a.startsWith('0.0.0.0:')), ctrlLines.join(', ') || 'nothing');
  const ctrlLan = await probe({ host: lanAddr ?? '127.0.0.1', port: cport, timeout: 4_000 });
  check('control: the wildcard server answers on the LAN address',
    ctrlLan.status === 204, JSON.stringify(ctrlLan));
  ctrl.close();

  // The measurement.
  const lines = listeners(PORT);
  check('the MCP port is LISTENING on 127.0.0.1 and nothing else',
    lines.length > 0 && lines.every((a) => a === `127.0.0.1:${PORT}`),
    lines.join(', ') || `nothing listening on ${PORT}`);

  const lan = await probe({ host: lanAddr ?? '127.0.0.1', port: PORT, timeout: 4_000 });
  check('dialling it on the LAN address gets no HTTP response at all',
    !!lan.error, lan.error ? `${lanAddr}:${PORT} -> ${lan.error}` : JSON.stringify(lan));
}

// --- 3. fail closed ---------------------------------------------------------
console.log('\n3 — the bearer, and what a bad one reaches');
{
  const cases = [
    ['no Authorization header at all', undefined],
    // The measured failure mode: an unset ${CLAUDE_EXPLORER_MCP_TOKEN} is passed
    // through as the literal, silently, and Claude Code exits 0 either way. This
    // is the request the server exists to refuse.
    ['the unexpanded literal ${CLAUDE_EXPLORER_MCP_TOKEN}', 'Bearer ${CLAUDE_EXPLORER_MCP_TOKEN}'],
    ['a wrong token of exactly the right shape', `Bearer ${'0123456789abcdef'.repeat(4)}`],
    ['an empty bearer', 'Bearer '],
    ['a different scheme', 'Basic YWRtaW46YWRtaW4='],
  ];
  for (const [name, auth] of cases) {
    const r = await probe({ port: PORT, headers: MCP_HEADERS(auth), body: INIT });
    check(`401 for ${name}`, r.status === 401, JSON.stringify(r.error ?? r.status));
  }

  // Reached no tool code: an MCP server that had handled this would answer
  // serverInfo/protocolVersion and mint a session id.
  const r = await probe({ port: PORT, headers: MCP_HEADERS('Bearer nope'), body: INIT });
  check('the refusal carries no protocol payload and no session id',
    r.body === '' && !r.headers?.['mcp-session-id'],
    `${r.body?.length ?? '?'} bytes, session ${r.headers?.['mcp-session-id'] ?? 'none'}`);

  // Ordering: this Accept is one the transport itself rejects with 406. If the
  // bearer were checked inside or after the transport, this would be a 406 —
  // i.e. a rejected credential would have run SDK code.
  const early = await probe({
    port: PORT,
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer nope' },
    body: INIT,
  });
  check('a bad token wins over the transport\'s own 406 — auth runs first',
    early.status === 401, JSON.stringify(early.error ?? early.status));
}

// --- 4. a real Claude, in a real tab ----------------------------------------
console.log('\n4 — list_tabs from a Claude session running in a tab');
{
  await goTo(win, WORK);
  const rows = win.locator('.entry', { hasText: path.basename(CLAUDE_DIR) });
  const nrows = await rows.count();
  check('the scratch folder is visible to launch from', nrows === 1,
    `${nrows} rows for ${path.basename(CLAUDE_DIR)}`);

  await rows.first().locator('.entry-open').click(); // orange arrow: Claude, in place
  await win.waitForSelector(VIS + '.xterm', { timeout: 25_000 });
  const claudeTab = win.locator('.tab', { hasText: path.basename(CLAUDE_DIR) }).first();
  const mounted = await win.locator(VIS + '.xterm').count();
  check('the tab became a live Claude terminal', mounted === 1, `${mounted} xterm`);

  // First run in a folder asks whether to trust it. Answer it BEFORE typing
  // anything: the prompt is modal, and a sentence typed at it ends the session.
  await waitPane(win, (t) => TRUST.test(t) || READY.test(t), 60_000);
  const booted = await waitPane(win, (t) => READY.test(t), 90_000, true);
  check('the session finished starting up', READY.test(booted),
    booted.trim().slice(-120).replace(/\s+/g, ' '));
  await win.waitForTimeout(3_000);

  // THE marker: a tab that did not exist when this session started, opened
  // about a second before it is asked. Nothing on disk and no snapshot taken
  // when the session launched can contain it.
  await win.locator('.tab.add').click();
  await win.waitForTimeout(600);
  await goTo(win, MARKER_DIR);
  const strip = await win.locator('.tab:not(.add)').allTextContents();
  check('a new tab was opened AFTER the session started, a second before the ask',
    strip.some((t) => t.includes(MARKER)), `${strip.length} tabs`);

  await claudeTab.click();
  await win.waitForTimeout(500);
  const ptyId = await ask(win, PROMPT);
  check('the question was actually SENT to that tab\'s pty', !!ptyId,
    ptyId ?? 'still sitting in the prompt box after 12 tries');

  // MARKER and nothing else. The obvious second condition — stop early if the
  // answer is NOTOOL — is exactly the echo trap: NOTOOL is IN the prompt, so it
  // is on screen the instant the question is typed, and a predicate that accepts
  // it returns before the model has done anything at all. (It did: this file
  // reported "marker absent" four runs running while the session was still
  // thinking, because the wait was never waiting.) A missing tool now shows up
  // as the timeout it is; §5 is where NOTOOL can be read, because `claude -p`
  // writes to stdout and stdout does not echo the prompt.
  //
  // Generous, because this is a real model turn at whatever effort level the
  // developer's Claude Code is set to, and an xhigh Opus turn is minutes.
  const text = await waitPane(win, (t) => t.includes(MARKER), 300_000, true);
  check('the session answered with the LIVE tab list, including that tab',
    text.includes(MARKER), text.includes(MARKER) ? MARKER : 'marker absent after 300s');
  if (!text.includes(MARKER)) {
    const dump = path.join(os.tmpdir(), `mcp-pane-${process.pid}.txt`);
    fs.writeFileSync(dump, text);
    console.log(`  (pane text written to ${dump})`);
  }
}

// --- 5. the same question, asked from outside the app -----------------------
console.log('\n5 — the same prompt, from a Claude started outside the app');
{
  check('this process — outside the app — holds no token',
    !process.env.CLAUDE_EXPLORER_MCP_TOKEN, String(process.env.CLAUDE_EXPLORER_MCP_TOKEN));

  const out = await new Promise((resolve) => {
    const child = spawn(`claude -p "${PROMPT}"`, {
      cwd: OUTSIDE_DIR, shell: true, env: process.env,
    });
    let text = '';
    child.stdout.on('data', (c) => { text += c; });
    child.stderr.on('data', (c) => { text += c; });
    const t = setTimeout(() => { child.kill(); resolve(text + '\n[TIMEOUT]'); }, 150_000);
    child.once('exit', () => { clearTimeout(t); resolve(text); });
  });

  check('it cannot see our tabs — the marker is absent from its answer',
    !out.includes(MARKER), out.trim().slice(0, 200).replace(/\s+/g, ' '));
  check('and it says so: no list_tabs tool in that session',
    /NOTOOL|no( such)? tool|not have|don't have|not available/i.test(out),
    out.trim().slice(0, 200).replace(/\s+/g, ' '));
}

// --- 6. teardown ------------------------------------------------------------
//
// WHY THIS IS NOT "quit, then probe the port". That version could not fail: the
// OS reclaims a listening port when the process exits, so `after quit the port
// refuses connections` and `netstat shows nothing` were both green with
// stopMcpServer() deleted from will-quit outright. Measured, not argued.
//
// The two worlds differ in exactly one place: the window will-quit holds open
// while it flushes staged deletes to the Recycle Bin. stopMcpServer() runs at
// the TOP of that handler, so with it the port is refused for the whole window;
// without it the port keeps answering until the process is gone. So stage real
// deletes to make that window long enough to sample, then measure HOW EARLY in
// it the refusal lands.
//
// Note what is NOT the oracle: "was the process still alive when the port went
// away". The child 'exit' event lags the real teardown, so the mutant's port
// also goes quiet slightly before exit — 164 ms in one run, 950 ms in another —
// and a naive alive-at-refusal check passed it. What separates the two by an
// order of magnitude is HOW EARLY the refusal lands, measured from the quit
// request; stopMcpServer() runs before the flush, the process dies after it:
//   deleted:  refused 1472 / 2511 / 2581 / 2909 ms in, after 46-86 answered probes
//   present:  refused   44 /   64 /   68 /   79 ms in, on the 2nd or 3rd probe
console.log('\n6 — the listener dies with the app');
{
  const before = await probe({ port: PORT, headers: MCP_HEADERS(), body: INIT, timeout: 4_000 });
  check('the server is still up immediately before quit', before.status === 401,
    JSON.stringify(before.error ?? before.status));

  // One shell.trashItem per item at quit, which is what buys the window. These
  // are one-byte files under %TEMP% and they end up in the Recycle Bin, which
  // is where a real quit-flush puts them.
  const PAD = path.join(WORK, 'flushpad');
  fs.mkdirSync(PAD, { recursive: true });
  const pad = Array.from({ length: 35 }, (_, i) => {
    const p = path.join(PAD, `pad-${i}.txt`);
    fs.writeFileSync(p, 'x');
    return p;
  });
  const staged = await win.evaluate(async (paths) => {
    const r = await window.api.fsDelete(paths);
    return r.ok ? r.value.length : `${r.code}: ${r.reason}`;
  }, pad);
  check('deletes are staged, so will-quit has a flush window to measure in',
    staged === pad.length, `${staged} of ${pad.length}`);

  const proc = app.process();
  let exitedAt = 0;
  proc.once('exit', () => { exitedAt = Date.now(); });

  const t0 = Date.now();
  const quitting = close(); // deliberately NOT awaited — the window IS the test
  let refusedAt = 0;
  let samples = 0;
  while (!exitedAt && Date.now() - t0 < 20_000) {
    const r = await connectProbe(PORT);
    samples++;
    if (r !== 'open') { if (!exitedAt) refusedAt = Date.now(); break; }
    await new Promise((r2) => setTimeout(r2, 25)); // don't spam the socket table
  }
  await quitting;
  const shutdownMs = (exitedAt || Date.now()) - t0;

  const lead = refusedAt ? (exitedAt || Date.now()) - refusedAt : 0;
  check('the listener stopped accepting at the TOP of will-quit, not when the process died',
    refusedAt > 0 && refusedAt - t0 <= 750,
    refusedAt
      ? `refused ${refusedAt - t0}ms in (sample ${samples}), ${lead}ms before exit, ${shutdownMs}ms shutdown`
      : `answered ${samples} time(s) for the whole ${shutdownMs}ms shutdown`);

  // The calibration for the check above, and the reason it cannot quietly rot:
  // the lead is measured against the flush window, so if the window ever
  // collapses the check above is an artefact rather than a measurement. Fail
  // loudly instead — a faster Recycle Bin means `pad` needs more entries.
  check('the shutdown window was long enough to sample', shutdownMs >= 1_500 && samples > 0,
    `${shutdownMs}ms, ${samples} sample(s)`);

  // The scan again, now that quit has written everything it is going to write.
  const hits = hexHits(PROFILE);
  check('nothing token-shaped was left on disk by the shutdown',
    hits.length === 0, hits.join(', ') || 'clean');
}

// === run 2: a second run of the same profile ================================
console.log('\n7 — a second run picks a different port');
{
  const { close: close2 } = await launchApp({ userDataDir: PROFILE });
  const { raw } = config();
  const srv = JSON.parse(raw).mcpServers.explorer;
  const port2 = Number(/:(\d+)\//.exec(srv.url)[1]);

  // Sequential runs, not concurrent: two live servers could not share a port
  // anyway, so a concurrent comparison would be true by construction.
  check('the port is ephemeral — a new run got a different one', port2 !== PORT,
    `${PORT} -> ${port2}`);
  check('still 127.0.0.1, still not configurable anywhere',
    srv.url.startsWith('http://127.0.0.1:') && srv.headers.Authorization
      === 'Bearer ${CLAUDE_EXPLORER_MCP_TOKEN}', srv.url);
  const lines = listeners(port2);
  check('and the new port is loopback-only too',
    lines.length > 0 && lines.every((a) => a === `127.0.0.1:${port2}`),
    lines.join(', ') || `nothing listening on ${port2}`);

  await close2();
}

// === run 3: the kill switch (KAN-42) ========================================
//
// THE TWO WITNESSES, AND WHY NEITHER IS TYPED
//
//   - `/mcp` is Claude Code's own server list, and it needs no model turn — it
//     paints in a second, which is why it is here and not a prompt. The witness
//     is the row `explorer · ✔ connected`, which we never type and which cannot
//     be painted unless THIS session was handed --mcp-config AND a token the
//     server accepts (a wrong token renders as failed, not connected). The
//     developer's own global servers show up in the same list, which is what
//     makes "explorer is absent" a reading of our injection and not of whether
//     the panel opened at all.
//   - The token itself is read out of the session's ENVIRONMENT by a `!` bash
//     command, whose output — `TOK:<8 hex>` or `TOK:undefined` — is generated by
//     the child, not typed. The echo of the command line contains `TOK'+':'`,
//     which matches neither predicate; that is deliberate, and it is why the
//     string is assembled with `+` instead of written out.
//
// RED-FIRST, against the UNMODIFIED build (the whole of this section was run on
// a stash of the src/ changes, harness only):
//   - 8: settingsGet has no agentControl, and the modal has no such checkbox →
//     3 red.
//   - 9: unchecking a checkbox that does not exist changes nothing, so the
//     listener stays up, settings.json gets no agentControl key, and the fresh
//     Claude tab still lists `explorer · ✔ connected` with the token in its env
//     → 5 red.
//   - 10 is the calibration for 9 — a control, and it passes unmodified BY
//     DESIGN (an app that never stops the server always re-lists it). What it is
//     a measurement of is the likeliest wrong implementation, "read the setting
//     at startup only": with the toggle-off path left in and the toggle-on path
//     deleted, 10 goes red — no listener on the rewritten port, and the new tab
//     shows no explorer row — while every other section stays green.
const PROFILE3 = path.join(os.tmpdir(), `claude-explorer-mcp3-${process.pid}`);
fs.rmSync(PROFILE3, { recursive: true, force: true });
fs.mkdirSync(PROFILE3, { recursive: true });

// A settings.json written BEFORE agentControl existed. Non-default values, so a
// save that rewrites the file has something to lose.
const LEGACY = { ideCommand: 'subl', mode: 'developer', groupWithSource: false };
const SETTINGS3 = path.join(PROFILE3, 'settings.json');
fs.writeFileSync(SETTINGS3, JSON.stringify(LEGACY, null, 2));
const onDisk = () => { try { return JSON.parse(fs.readFileSync(SETTINGS3, 'utf8')); } catch { return null; } };

// `!` is Claude Code's own bash mode: the command runs in a child of the pty,
// with the pty's environment, and needs no model turn and no approval. The
// answer is assembled by the child — `TOK:<SET64>` or `TOK:<UNSET>` — and
// neither string can be produced by the echo of the command line, which reads
// `'TOK'+':<'+…`. Report the LENGTH rather than a prefix: it distinguishes a
// whole token from a fragment, and it keeps the secret off the screen.
const ENV_PROBE = '!node -e "const t=process.env.CLAUDE_EXPLORER_MCP_TOKEN;'
  + ` console.log('TOK'+':<'+(t?'SET'+t.length:'UNSET')+'>')"`;
const flat = (t) => t.replace(/\s+/g, '');

{
  const { app: app3, win: win3, close: close3 } = await launchApp({ userDataDir: PROFILE3 });

  const cfg3 = () => {
    const p = path.join(PROFILE3, 'mcp-agent-control.json');
    try { return JSON.parse(fs.readFileSync(p, 'utf8')).mcpServers.explorer; } catch { return null; }
  };
  const portOf = (srv) => Number(/:(\d+)\//.exec(srv?.url ?? '')?.[1] ?? 0);
  // Every port this app run has ever announced to Claude Code. Section 9 kills
  // the switch and then asks whether ANY of them is still accepting — checking
  // only the newest would miss a listener that was leaked and then orphaned.
  const seenPorts = new Set();

  /** Open the Settings modal the way Preferences… (Ctrl+,) does. */
  const openSettings = async () => {
    await app3.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'open-settings');
    });
    await win3.waitForSelector('.modal', { timeout: 5_000 });
  };
  const toggle = () => win3.locator('input[data-setting="agentControl"]');
  // Every one of these swallows its own failure: against a build with no such
  // checkbox the assertion must report, not abort the run before section 10.
  const toggleState = () => toggle().isChecked({ timeout: 4_000 }).catch(() => null);
  const setToggle = async (on) => {
    await (on ? toggle().check({ timeout: 4_000 }) : toggle().uncheck({ timeout: 4_000 }))
      .catch(() => {});
    // The modal closes only after settingsSet RESOLVES, and settingsSet resolves
    // only after main has finished starting or stopping the listener — so this
    // is the synchronisation point, not a sleep.
    await win3.locator('.modal-actions .primary').click();
    await win3.waitForSelector('.modal', { state: 'detached', timeout: 10_000 }).catch(() => {});
    await win3.waitForTimeout(200);
  };

  /** A brand new Claude tab in the already-trusted scratch folder. Returns the
   *  pane text once the session is up. */
  const freshClaudeTab = async () => {
    await win3.locator('.tab.add').click();
    await win3.waitForTimeout(600);
    await goTo(win3, WORK);
    await win3.locator('.entry', { hasText: path.basename(CLAUDE_DIR) })
      .first().locator('.entry-open').click();
    await win3.waitForSelector(VIS + '.xterm', { timeout: 25_000 });
    await waitPane(win3, (t) => TRUST.test(t) || READY.test(t), 60_000);
    return waitPane(win3, (t) => READY.test(t), 120_000, true);
  };

  /** Type into the visible session, send it, and wait for `pred` on the
   *  whitespace-stripped pane. Returns the stripped text either way. */
  const runIn = async (line, pred, ms) => {
    await win3.locator(VIS + '.xterm-screen').click();
    await win3.keyboard.type(line);
    await win3.waitForTimeout(1_200);
    await submit(win3);
    // The submitted line is still on screen for a beat, and so is whatever
    // popup it was typed into — poll straight away and you read the OLD frame.
    await win3.waitForTimeout(1_500);
    return flat(await waitPane(win3, (t) => pred(flat(t)), ms, true));
  };

  const HAS_EXPLORER = /explorer·✔connected/;
  // NOT "Manage MCP servers": that string is the slash-command autocomplete's
  // one-line description of /mcp, so it is on screen the moment `/mcp` is typed
  // and a predicate built on it returns before the command has run — measured,
  // and it took the two probes after it down with it. The docs link is painted
  // by the panel itself and appears nowhere else.
  //
  // ponytail: this is Claude Code's UI, so it is a string in someone else's
  // product. If a future version drops the link, this reports as "panel never
  // opened" — loudly, which is the failure mode to want.
  const PANEL = /code\.claude\.com\/docs\/en\/mcp/;
  const excerpt = (t) => t.slice(Math.max(0, t.search(/MCPservers?|explorer·/)))
    .slice(0, 200) || 'nothing on screen';

  /** Open /mcp, read the server list, and close it again. Escape is confirmed,
   *  not assumed: a panel still up would swallow the next probe's keystrokes. */
  const mcpPanel = async () => {
    const panel = await runIn('/mcp', (t) => PANEL.test(t), 60_000);
    await win3.keyboard.press('Escape');
    await waitPane(win3, (t) => !PANEL.test(flat(t)), 15_000);
    await win3.waitForTimeout(800);
    return panel;
  };

  /** What the session's own environment says about the token. */
  const TOK = /TOK:<(SET\d+|UNSET)>/;
  const envToken = async () => {
    const out = await runIn(ENV_PROBE, (t) => TOK.test(t), 90_000);
    return TOK.exec(out)?.[1] ?? null;
  };

  // --- 8. an existing settings.json with no agentControl key ----------------
  console.log('\n8 — a settings.json written before this setting existed');
  {
    const s = await win3.evaluate(() => window.api.settingsGet());
    check('the missing key reads as true, and the rest of the file survives it',
      s.agentControl === true && s.ideCommand === 'subl' && s.groupWithSource === false,
      JSON.stringify(s));

    const p = portOf(cfg3());
    const lines = listeners(p);
    check('so the server came up on that profile', p > 1024 && lines.length > 0,
      lines.join(', ') || `nothing listening on ${p}`);

    await openSettings();
    check('the Settings modal has an agent-control toggle, and it is on',
      (await toggleState()) === true, String(await toggleState()));

    // A save that does NOT change agentControl still runs the whole lifecycle,
    // so startMcpServer() is called with a listener already bound — and it has
    // to be a no-op. A second listen() binds a second port while the first
    // socket stays bound with nothing holding its handle, and stopMcpServer()
    // closes only the newest: the leak would go on serving all four tools, on
    // the same token, straight through the kill switch. Nowhere else in this
    // file saves with the switch already on, so this is the only exercise that
    // line gets. The two assertions are the cause and the property: the port
    // must not move, and (in 9) nothing we ever announced may survive the kill.
    const beforeSave = portOf(cfg3());
    seenPorts.add(beforeSave);
    await setToggle(true);
    const afterSave = portOf(cfg3());
    seenPorts.add(afterSave);
    check('a save that leaves the switch on does not bind a second listener',
      afterSave === beforeSave && listeners(afterSave).length > 0,
      `${beforeSave} -> ${afterSave}`);
  }

  // --- 9. off: the listener dies, and the next session gets nothing ---------
  console.log('\n9 — switched off');
  let port3 = 0;
  {
    port3 = portOf(cfg3());
    seenPorts.add(port3);
    const alive = await connectProbe(port3);
    check('control: the port is open with the toggle still on', alive === 'open', alive);

    // 8's last act was a save, which closed the modal.
    await openSettings();
    await setToggle(false);

    // The app is still running — this is the one place the "no listener" claim
    // can be made without the OS reclaiming the port for us at exit.
    const after = await connectProbe(port3);
    const running = app3.process().exitCode === null;
    check('saving killed the listener immediately, with the app still running',
      after !== 'open' && running, `${after}, exitCode ${app3.process().exitCode}`);
    const lines = listeners(port3);
    check('and netstat agrees nothing is listening there any more',
      lines.length === 0, lines.join(', ') || 'nothing');

    // The property, not the port: one surviving socket anywhere is the whole
    // switch defeated, and the config file only ever names the newest.
    const strays = [];
    for (const p of seenPorts) if ((await connectProbe(p)) === 'open') strays.push(p);
    check('and no port this app run ever announced is still accepting',
      strays.length === 0, strays.join(', ') || `none of ${[...seenPorts].join(', ')}`);

    const disk = onDisk();
    check('settings.json gained agentControl:false and lost nothing',
      disk?.agentControl === false && disk?.ideCommand === 'subl'
        && disk?.mode === 'developer' && disk?.groupWithSource === false,
      JSON.stringify(disk));

    const booted = await freshClaudeTab();
    check('a fresh Claude session started with the switch off', READY.test(booted),
      booted.trim().slice(-100).replace(/\s+/g, ' '));

    const panel = await mcpPanel();
    check('that session does not list our server under /mcp',
      PANEL.test(panel) && !/explorer·/.test(panel), excerpt(panel));

    const tok = await envToken();
    check('and CLAUDE_EXPLORER_MCP_TOKEN is absent from that pty\'s environment',
      tok === 'UNSET', tok ?? 'the probe never printed');
  }

  // --- 10. back on, without restarting the app ------------------------------
  console.log('\n10 — switched back on, same app run');
  {
    await openSettings();
    check('the reopened modal shows the persisted (off) state',
      (await toggleState()) === false, String(await toggleState()));
    await setToggle(true);

    const srv = cfg3();
    const port4 = portOf(srv);
    const lines = listeners(port4);
    check('the config file names a port that is listening again, loopback only',
      port4 > 1024 && lines.length > 0 && lines.every((a) => a === `127.0.0.1:${port4}`),
      lines.join(', ') || `nothing listening on ${port4} (was ${port3})`);

    // Identity: something answering on that port is not enough — it has to be
    // OUR server, which is the thing that 401s a bad bearer before any protocol.
    const r = await probe({ port: port4, headers: MCP_HEADERS('Bearer nope'), body: INIT });
    check('and it is our server: 401 with no protocol payload', r.status === 401 && r.body === '',
      JSON.stringify(r.error ?? [r.status, r.body?.length]));

    const booted = await freshClaudeTab();
    check('a fresh Claude session started with the switch back on', READY.test(booted),
      booted.trim().slice(-100).replace(/\s+/g, ' '));

    const panel = await mcpPanel();
    check('THAT session lists our server — the switch is not read at startup only',
      HAS_EXPLORER.test(panel), excerpt(panel));

    const tok = await envToken();
    // 64 = randomBytes(32).toString('hex') in mcp.ts. A fragment or a leftover
    // literal would not be that length.
    check('control: the env probe CAN see a token — a whole one, here',
      tok === 'SET64', tok ?? 'the probe never printed');

    await close3();
  }
}

// The Claude process may still hold CLAUDE_DIR as its cwd for a moment after the
// window closed; a leftover temp folder is not worth failing a run over.
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* %TEMP% */ }
try { fs.rmSync(MARKER_ROOT, { recursive: true, force: true }); } catch { /* %TEMP% */ }

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
