// KAN-41: close_tab, open_viewer_tab and open_claude_session, end to end against
// the real app and the real MCP server.
//   npm run build && node test/harness/mcptools.mjs
//   node test/harness/mcptools.mjs --fast     (skips §9/§10 — no real Claude)
//
// HOW THIS TALKS TO THE SERVER, AND WHY IT CAN AT ALL
//
// The tools are driven with raw node:http against the port the app bound, not
// through a model turn: three of the four claims below are about what does NOT
// happen (no pty, no token, no ninth session), and a model answering in prose is
// the weakest possible witness for an absence. But the bearer token exists only
// in main's memory and reaches exactly one place — the environment of a Claude
// Code this app spawned — so a client outside the app cannot obtain it. That is
// the KAN-40 design and it is not being worked around here.
//
// So this harness BECOMES that one place. It puts a `claude.cmd` of its own at
// the front of PATH before launching the app, so `resolveClaude()` finds it and
// every session the app starts runs it. The shim writes its own argv, its cwd
// and its whole environment to a file, and then either blocks (a stand-in
// session, for everything that only needs a live pty) or execs the real Claude
// Code (§9/§10, which need real transcripts). That single mechanism gives three
// things at once:
//
//   - the token, from the environment of a USER-launched session, which is the
//     only session type that is supposed to receive one;
//   - the exact argv and environment of an AGENT-spawned session, which is the
//     no-recursion observable the design named (§6) — a direct read of what the
//     child was handed, not a question asked of a model about what it can see;
//   - a per-invocation record of every time claude was executed at all, which is
//     how "nothing spawned" is measured in §4. A tab that never appeared and an
//     .xterm that never mounted are both downstream of the renderer; a dump file
//     that was never written means the CLI was never run.
//
// RED-FIRST — every headline claim was run against a mutated build and then
// restored. Counts are measured, not predicted:
//
//   A. spawnguard's `request`, `token === undefined ? mint(path) : redeem(…)`,
//      changed to spawn BEFORE minting (i.e. "ask afterwards") → §4 goes 4 red:
//      a dump appears for a call that was only supposed to ask, a terminal tab
//      is in list_tabs, an .xterm mounts, and the pending-ask probe sees the
//      second spawn too. The reply shape stays needsConfirm and the prompt still
//      names the folder — which is exactly why §4 does not assert the shape
//      alone. 46/50 in --fast.
//   B. pty.ts's `const agentControl = opts.agentSpawned ? null : mcp` changed to
//      `: mcp` → §6 goes 3 red: the agent-spawned child's argv carries
//      --mcp-config and the config path, and its environment carries the live
//      bearer token. §4, §5, §7 and §8 stay GREEN, because a child that can
//      reach the server still spawns, still counts and still closes — nothing
//      else in this file can see the difference. 47/50 in --fast.
//   C. tabs.ts's `fromPersisted` losing `agentSpawned` → §10's last worker check
//      goes red on its own (62/63): all three restored sessions come back with
//      --mcp-config and the token, i.e. quitting the app promotes every worker.
//      Its CONTROL — the user's own restored tab — stays green, which is what
//      stops that check passing merely because the server failed to start.
//
// TRAPS THIS FILE IS BUILT AROUND
//   - Nothing here hardcodes the checkout's name or location; every path is
//     built under %TEMP% with a pid suffix, and the profile is a throwaway one
//     (the single-instance lock is keyed on userData, and this repo runs from
//     several worktrees at once).
//   - Tab survival is probed as an .xterm ELEMENT count, never as pane text:
//     ConPTY repaints its whole screen buffer on resize, so text proves nothing.
//   - The marker in §9 is never read off the screen in the run that types it —
//     a terminal echoes what you type. The witness is the transcript on disk,
//     and only after a RESTART (§10), where nothing has been typed, is the pane
//     allowed to be the oracle.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { launchApp } from './app.mjs';

const FAST = process.argv.includes('--fast');

const TMP = path.join(os.tmpdir(), `ce-k41-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
const SHIM = path.join(TMP, 'shim');
const DUMP = path.join(TMP, 'dump');
const WORK = path.join(TMP, 'work');
const PROFILE = path.join(TMP, 'profile');
for (const d of [SHIM, DUMP, WORK, PROFILE]) fs.mkdirSync(d, { recursive: true });

/**
 * KAN-64. Pre-write a profile's settings.json so an app run starts with a known
 * free allowance. Every section from §0 to §8 was written against KAN-41, where
 * open_claude_session asked EVERY time — which is exactly what an allowance of
 * 0 means, so setting it here keeps all of them measuring the confirmation path
 * they were built for. That is not a workaround: "0 = ask every time = today's
 * shipped behaviour, and it must stay reachable" is one of this ticket's
 * acceptance criteria, and the fifty-odd checks below ARE that proof, run end
 * to end against the real server.
 */
const allowanceProfile = (dir, agentFreeSessions) =>
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ agentFreeSessions }, null, 2));
allowanceProfile(PROFILE, 0);

// realpath.native, because main canonicalizes every caller-supplied path that
// way (policy.ts) — comparing a reply's `path` to a raw %TEMP% string would
// compare two spellings of the same folder.
const real = (p) => fs.realpathSync.native(p);
const mkdir = (p) => { fs.mkdirSync(p, { recursive: true }); return real(p); };

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// --- the shim ---------------------------------------------------------------
//
// One file, two behaviours, chosen by the CWD it is launched in: a folder
// holding `.ce-real` gets the real Claude Code, anything else gets a process
// that blocks forever. That is what lets §1-§8 create and destroy sessions for
// free while §9/§10 still measure real transcripts, in ONE app run with ONE
// harvested token.
//
// The env dump is `set`, i.e. the WHOLE environment — so §6 can assert the
// token appears nowhere, rather than that two known variable names are absent.
// `%CD%` is recorded so a dump identifies its own session with no reliance on
// the order files happen to be written in.
const CLAUDE_REAL = (() => {
  const exts = ['.exe', '.cmd', '.bat', ''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  for (const d of dirs) {
    if (!d) continue;
    for (const e of exts) {
      const full = path.join(d, `claude${e}`);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
})();

// The dump is named after %2 — the session UUID, which is always the value of
// the --session-id / --resume flag the app builds — and NOT after %RANDOM%
// alone. cmd seeds %RANDOM% from the clock at process start, so three sessions
// opened in the same second draw the SAME sequence and silently overwrite each
// other's dump. That cost a run: §9 reported one of three fan-out sessions as
// never launched, while the app had launched it correctly.
fs.writeFileSync(path.join(SHIM, 'claude.cmd'), [
  '@echo off',
  'set "D=%CE_DUMP%\\d-%2-%RANDOM%%RANDOM%.txt"',
  '>"%D%" echo ARGV %*',
  '>>"%D%" echo CWD %CD%',
  '>>"%D%" set',
  'if exist ".ce-real" goto real',
  'pause >nul',
  'exit /b 0',
  ':real',
  'call "%CE_REAL_CLAUDE%" %*',
  '',
].join('\r\n'));

process.env.CE_DUMP = DUMP;
process.env.CE_REAL_CLAUDE = CLAUDE_REAL ?? 'claude';
process.env.PATH = `${SHIM}${path.delimiter}${process.env.PATH}`;

const dumps = () => fs.readdirSync(DUMP);
const dumpBody = (f) => (f ? fs.readFileSync(path.join(DUMP, f), 'latin1') : '');
const dumpArgv = (f) => (/^ARGV (.*)$/m.exec(dumpBody(f))?.[1] ?? '').trim();
const dumpCwd = (f) => (/^CWD (.*)$/m.exec(dumpBody(f))?.[1] ?? '').trim();

/** Every dump written for `cwd`, newest last. A restart writes a second one for
 *  the same folder, which is precisely what §10 reads. */
const dumpsFor = (cwd) => dumps()
  .filter((f) => dumpCwd(f).toLowerCase() === cwd.toLowerCase())
  .sort((a, b) => fs.statSync(path.join(DUMP, a)).mtimeMs - fs.statSync(path.join(DUMP, b)).mtimeMs);

async function waitFor(pred, ms, step = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}

// --- scratch trees ----------------------------------------------------------

// The folder the token is harvested from: a USER-launched session, no .ce-real,
// so it is a stand-in that costs nothing and stays alive for the whole run.
const HARVEST = mkdir(path.join(WORK, 'harvest'));
const LOOSE_DIR = mkdir(path.join(WORK, 'loose'));

// A real repo with a real working-tree change, built here rather than borrowed
// from the checkout: whether the checkout is dirty is not this file's business,
// and its name and location may not be assumed.
const REPO = mkdir(path.join(WORK, 'repo'));
const git = (...a) => execFileSync('git', a, { cwd: REPO, stdio: 'pipe', encoding: 'utf8' });
git('init', '-q');
const TRACKED = path.join(REPO, 'tracked.txt');
fs.writeFileSync(TRACKED, 'one\ntwo\nthree\n');
git('add', 'tracked.txt');
git('-c', 'user.email=h@example.com', '-c', 'user.name=h', 'commit', '-qm', 'base');
fs.writeFileSync(TRACKED, 'one\nTWO CHANGED\nthree\nfour\n'); // +2 / -1

// §3's refusal has to be git's own, so the loose file must really be outside any
// repo. %TEMP% normally is; say so loudly rather than quietly measuring nothing.
const LOOSE = path.join(LOOSE_DIR, 'loose.txt');
fs.writeFileSync(LOOSE, 'not in a repo\n');
try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: LOOSE_DIR, stdio: 'pipe' });
  console.log('ABORT: the scratch folder is inside a git repo, so §3 cannot see a refusal');
  process.exit(2);
} catch { /* the expected case: not a repo */ }

const CAP_DIRS = Array.from({ length: 8 }, (_, i) => mkdir(path.join(WORK, `cap-${i}`)));
// §7's ninth session gets its own folder rather than borrowing a FANOUT one:
// those hold `.ce-real` outside --fast, and starting a REAL Claude Code there
// would pollute the transcripts §9 goes on to measure.
const NINTH_DIR = mkdir(path.join(WORK, 'ninth'));
// Three DIFFERENTLY named folders, so §9's "titled with the folder basename" is
// three distinct strings and cannot pass by coincidence.
const FANOUT = ['alpha', 'bravo', 'charlie'].map((n) => mkdir(path.join(WORK, `fan-${n}`)));
if (!FAST) for (const d of FANOUT) fs.writeFileSync(path.join(d, '.ce-real'), '');
const MARK = FANOUT.map((_, i) => `K41-FANOUT-${process.pid}-${i}`);

const slugFor = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const transcript = (cwd, id) =>
  path.join(os.homedir(), '.claude', 'projects', slugFor(cwd), `${id}.jsonl`);

// --- MCP over raw HTTP ------------------------------------------------------

let PORT = 0;
let TOKEN = '';
let rpcId = 0;

/** One JSON-RPC request. The transport answers as SSE (enableJsonResponse is
 *  off), so the body is `event: message` / `data: <json>` frames. Never throws:
 *  a transport failure comes back as `{ transport }`, which is itself a failing
 *  assertion rather than a crashed harness. */
function rpc(body, { auth = `Bearer ${TOKEN}`, timeout = 70_000 } = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', timeout,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: auth,
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve({ transport: `HTTP ${res.statusCode}` }); return; }
        for (const line of text.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          try { resolve(JSON.parse(line.slice(5).trim())); return; } catch { /* next frame */ }
        }
        resolve({ transport: `unparseable body: ${text.slice(0, 200)}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ transport: e.code || e.message }));
    req.end(JSON.stringify(body));
  });
}

/** One tools/call. `isError` is the SDK's own flag — every typed refusal in
 *  mcp.ts is a throw, which the SDK turns into exactly that. */
async function tool(name, args = {}) {
  const r = await rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  if (r.transport) return { transport: r.transport, isError: true, text: r.transport };
  if (r.error) return { isError: true, text: `protocol: ${JSON.stringify(r.error)}` };
  return { isError: !!r.result?.isError, text: r.result?.content?.[0]?.text ?? '' };
}
const json = (t) => { try { return JSON.parse(t.text); } catch { return null; } };
const tabs = async () => json(await tool('list_tabs')) ?? [];

// --- the window -------------------------------------------------------------

const VIS = '.pane:not([hidden]) ';
const { win, close } = await launchApp({ userDataDir: PROFILE });

const xterms = () => win.evaluate(() => document.querySelectorAll('.xterm').length);
/** The spawn dialog's path in a GIVEN window, or null when no dialog is up.
 *  §11 and §12 launch app instances of their own, so they cannot use
 *  `promptPath()` below — it is bound to the first window. */
const modalPathIn = (w) => w.evaluate(() => {
  const el = document.querySelector('.spawn-modal .spawn-path');
  return el ? el.textContent : null;
});
const promptPath = () => modalPathIn(win);
const clickAnswer = async (allow) => {
  await win.waitForSelector('.spawn-modal', { timeout: 15_000 });
  await win.locator(`.spawn-modal .modal-actions button${allow ? '.primary' : ':not(.primary)'}`).click();
  await win.waitForSelector('.spawn-modal', { state: 'detached', timeout: 5_000 });
};

async function goTo(dir) {
  await win.locator('.address').click();
  await win.waitForTimeout(200);
  await win.locator('.address-input').fill(dir);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1_200);
}

/** The whole two-step, with the human in the middle. Returns both replies.
 *
 *  Denying arms a global cooldown (DENY_COOLDOWN_MS in spawnguard.ts) that
 *  refuses the next mint, and several sections below legitimately ask again
 *  right after a denial. Wait it out by POLLING rather than sleeping a
 *  hardcoded duration — the refusal itself is the clock, so this does not go
 *  stale if the constant changes. */
async function confirmSpawn(dir) {
  let ask = await tool('open_claude_session', { path: dir });
  for (let i = 0; i < 25 && /denied the last request/i.test(ask.text); i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    ask = await tool('open_claude_session', { path: dir });
  }
  const token = json(ask)?.token;
  if (!token) return { ask, started: { isError: true, text: 'no token minted' } };
  // Answer BEFORE redeeming: guard.answer settles the pending promise whether or
  // not anyone is waiting on it yet, so the redemption returns at once instead of
  // holding an HTTP request open for the click.
  await clickAnswer(true);
  return { ask, token, started: await tool('open_claude_session', { path: dir, token }) };
}

// === 0. the port, and a token from the one place a token is supposed to be ===
console.log('\n0 — the server, and a user-launched session');
{
  const cfgPath = path.join(PROFILE, 'mcp-agent-control.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : null;
  PORT = Number(/:(\d+)\//.exec(cfg?.mcpServers?.explorer?.url ?? '')?.[1] ?? 0);
  check('the app bound an MCP port and wrote its config', PORT > 1024,
    cfg?.mcpServers?.explorer?.url ?? `${cfgPath} is absent`);

  // A session the USER starts, from the file list, exactly as a person would.
  // In a NEW tab: the orange arrow converts the tab it is clicked in, and tab 1
  // has to stay a files tab so that §10 restores onto something that owns no
  // process — otherwise "nothing respawned before a tab was opened" is measuring
  // the restore's own focus.
  await win.locator('.tab.add').click();
  await win.waitForTimeout(600);
  await goTo(WORK);
  await win.locator('.entry', { hasText: 'harvest' }).first().locator('.entry-open').click();
  const f = await waitFor(() => dumpsFor(HARVEST)[0] ?? null, 20_000);
  TOKEN = f ? (/^CLAUDE_EXPLORER_MCP_TOKEN=(.*)$/m.exec(dumpBody(f))?.[1] ?? '') : '';
  check('a user-launched Claude session receives the bearer token in its environment',
    /^[0-9a-f]{64}$/.test(TOKEN), TOKEN ? `${TOKEN.slice(0, 12)}… (${TOKEN.length} chars)` : 'no dump');
  if (!TOKEN) { console.log('\nABORT: nothing to authenticate with'); process.exit(1); }
}

// === 1. the catalog =========================================================
console.log('\n1 — tools/list');
let VIEWER_SCHEMA = null;
{
  const r = await rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} });
  const names = (r.result?.tools ?? []).map((t) => t.name).sort();
  check('the catalog is exactly the four tools KAN-40 and KAN-41 shipped',
    JSON.stringify(names) === JSON.stringify(['close_tab', 'list_tabs', 'open_claude_session', 'open_viewer_tab']),
    names.join(', ') || JSON.stringify(r).slice(0, 200));

  // Named one by one because each was refused for its own reason, and a future
  // "while I'm in here" addition is the failure mode this guards.
  const banned = ['focus_tab', 'open_folder_tab', 'git_status', 'fs_read', 'search',
    'sessions_list', 'reveal_in_explorer', 'open_in_ide', 'save_space', 'switch_space',
    'resume_session', 'pty_write'].filter((n) => names.includes(n));
  check('and none of the tools the ticket refused', banned.length === 0, banned.join(', ') || 'none');

  VIEWER_SCHEMA = (r.result?.tools ?? []).find((t) => t.name === 'open_viewer_tab')?.inputSchema ?? null;
  const props = Object.keys(VIEWER_SCHEMA?.properties ?? {});
  check('open_viewer_tab advertises `path` and has no `mode` property at all',
    JSON.stringify(props) === '["path"]', props.join(', ') || JSON.stringify(VIEWER_SCHEMA));
}

// === 2. bad input is a typed error, never an exception =======================
console.log('\n2 — refusals');
{
  const before = (await tabs()).length;

  const bogus = await tool('close_tab', { tabId: 'not-a-tab-id' });
  check('close_tab with an unknown id is a tool error', bogus.isError, bogus.text);
  check('and it closed nothing', (await tabs()).length === before, `${before} tabs`);

  const missing = await tool('open_viewer_tab', { path: path.join(WORK, 'nope', 'gone.txt') });
  check('open_viewer_tab on a path that does not exist is a tool error',
    missing.isError && /no such path/i.test(missing.text), missing.text);

  const folder = await tool('open_viewer_tab', { path: REPO });
  check('open_viewer_tab on a folder is a tool error naming what it needs',
    folder.isError && /needs a file/i.test(folder.text), folder.text);

  const file = await tool('open_claude_session', { path: TRACKED });
  check('open_claude_session on a file is a tool error naming what it needs',
    file.isError && /needs a folder/i.test(file.text), file.text);

  // The ordering the design called load-bearing: canonicalize() would resolve a
  // relative path against Electron's cwd and hand a human a folder the model
  // never named. So the shape check runs first, and no prompt is ever shown.
  const rel = await tool('open_claude_session', { path: 'src' });
  check('open_claude_session on a relative path is refused before canonicalization',
    rel.isError && /absolute Windows path/i.test(rel.text), rel.text);
  check('and no prompt was shown for it', (await promptPath()) === null, String(await promptPath()));

  check('the server is still serving after six refusals', (await tabs()).length === before,
    `${before} tabs`);
}

// === 3. open_viewer_tab =====================================================
console.log('\n3 — open_viewer_tab');
{
  const before = (await tabs()).length;
  const r = await tool('open_viewer_tab', { path: TRACKED });
  check('a tracked file with changes opens', !r.isError && json(r)?.ok === true, r.text);

  await win.waitForTimeout(1_200);
  const view = await win.evaluate((sel) => {
    const p = document.querySelector(sel);
    return {
      head: !!p?.querySelector('.diff-head'),
      add: p?.querySelector('.diff-stat.add')?.textContent ?? '',
      del: p?.querySelector('.diff-stat.del')?.textContent ?? '',
      rows: p?.querySelectorAll('.drow.add, .drow.del').length ?? 0,
    };
  }, '.pane:not([hidden])');
  // The exact hunk counts from the commit above: a blank pane, a spinner or a
  // file view cannot produce +2/−1.
  check('the visible pane is the GIT DIFF of that file, with its real hunks',
    view.head && view.rows > 0 && view.add === '+2' && view.del === '−1', JSON.stringify(view));

  const row = (await tabs()).find((t) => t.title === 'tracked.txt');
  check('and it is reported as a viewer tab on the file\'s folder',
    row?.view === 'viewer' && row?.cwd === REPO, JSON.stringify(row));

  // `mode` is unrepresentable rather than rejected — there is nothing in the
  // schema to send. Sending it anyway must not steer the tool, and the oracle is
  // the renderer's own dedupe rather than a DOM class: openViewerTabList reuses a
  // tab only when the file AND THE MODE match, so a call that had been honoured
  // as "file" would have opened a SECOND tab on the same path. It lands back on
  // the existing diff tab instead, and the pane is still a diff.
  const idsBefore = (await tabs()).map((t) => t.id).join(',');
  const steer = await tool('open_viewer_tab', { path: path.join(REPO, 'tracked.txt'), mode: 'file' });
  await win.waitForTimeout(1_200);
  const stillDiff = await win.evaluate((sel) =>
    !!document.querySelector(sel)?.querySelector('.diff-head'), '.pane:not([hidden])');
  check('mode:"file" cannot steer it — the same diff tab is reused, no file view is opened',
    !steer.isError && stillDiff && (await tabs()).map((t) => t.id).join(',') === idsBefore,
    `${steer.text} | diff pane: ${stillDiff}`);

  // Outside a repo the tool still succeeds and the TAB carries git's own typed
  // refusal. That is the existing KAN-39 behaviour and the point is that it
  // reaches the user as a refusal rather than as a crash or an empty tab.
  const loose = await tool('open_viewer_tab', { path: LOOSE });
  await win.waitForTimeout(1_500);
  const pane = await win.evaluate((sel) => {
    const p = document.querySelector(sel);
    return {
      note: p?.querySelector('.viewer-note')?.textContent?.trim() ?? '',
      head: !!p?.querySelector('.diff-head'),
      rows: p?.querySelectorAll('.drow').length ?? 0,
    };
  }, '.pane:not([hidden])');
  check('a file outside any repo shows gitDiff\'s own refusal, not a crash or a blank',
    !loose.isError && /could not access 'HEAD'|not a git repository/i.test(pane.note)
      && !pane.head && pane.rows === 0, `${loose.text} | ${JSON.stringify(pane)}`);
  check('and both distinct files really produced a tab', (await tabs()).length === before + 2,
    `${before} -> ${(await tabs()).length}`);
}

// === 4. no token, no spawn — the headline ===================================
console.log('\n4 — open_claude_session without a token');
const TARGET = CAP_DIRS[0];
let firstToken = '';
{
  const beforeDumps = dumps().length;
  const beforeTabs = (await tabs()).length;
  const beforeTerms = await xterms();

  const ask = await tool('open_claude_session', { path: TARGET });
  const body = json(ask);
  firstToken = body?.token ?? '';
  check('the reply is needsConfirm, with a token and the canonical path',
    !ask.isError && body?.needsConfirm === true && /^[0-9a-f]{64}$/.test(body?.token ?? '')
      && body?.path === TARGET, ask.text.slice(0, 200));
  check('and an expiry about two minutes out',
    body?.expiresAt > Date.now() + 60_000 && body?.expiresAt < Date.now() + 180_000,
    body ? `${Math.round((body.expiresAt - Date.now()) / 1000)}s` : 'no body');

  // The three independent absences. The dump is the strongest: it means the CLI
  // binary was never executed at all, which no renderer-side bookkeeping can
  // fake. Given a moment first, so this is not just measuring that a spawn is
  // slower than an assertion.
  await win.waitForTimeout(2_500);
  check('NOTHING was spawned: claude was never executed', dumps().length === beforeDumps,
    `${beforeDumps} -> ${dumps().length} invocations`);
  check('no tab was created', (await tabs()).length === beforeTabs,
    `${beforeTabs} -> ${(await tabs()).length}`);
  check('and no terminal was mounted', (await xterms()) === beforeTerms,
    `${beforeTerms} -> ${await xterms()} .xterm elements`);

  check('the app is asking the user, and the prompt names that exact folder',
    (await promptPath()) === TARGET, String(await promptPath()));

  // One outstanding confirmation app-wide: a second ask cannot pile up a second
  // prompt (or a second live permission) behind the first.
  const second = await tool('open_claude_session', { path: CAP_DIRS[1] });
  check('a second token-less call while one is pending is refused',
    second.isError && /already asking/i.test(second.text), second.text);
  check('and it too spawned nothing', dumps().length === beforeDumps, `${dumps().length} invocations`);
}

// === 5. the token is single-use and bound to its path ========================
console.log('\n5 — tokens');
let AGENT_DIR = '';
{
  const beforeDumps = dumps().length;

  const wrong = await tool('open_claude_session', { path: CAP_DIRS[1], token: firstToken });
  check('a valid token redeemed for a DIFFERENT folder is refused',
    wrong.isError && /issued for/i.test(wrong.text), wrong.text);
  check('and nothing spawned for either folder', dumps().length === beforeDumps,
    `${dumps().length} invocations`);
  // Refused without consuming: a hostile or mistaken redemption must not burn
  // the approval the user actually gave.
  check('the prompt for the original folder is still up', (await promptPath()) === TARGET,
    String(await promptPath()));

  await clickAnswer(true);
  const ok = await tool('open_claude_session', { path: TARGET, token: firstToken });
  check('and the token still works for the folder it was issued for',
    !ok.isError && json(ok)?.started === true && json(ok)?.path === TARGET, ok.text);
  AGENT_DIR = TARGET;

  const spawned = await waitFor(() => (dumpsFor(TARGET).length ? dumpsFor(TARGET) : null), 20_000);
  check('a Claude session really started in it', !!spawned, spawned ? dumpArgv(spawned[0]) : 'no dump');

  const reuse = await tool('open_claude_session', { path: TARGET, token: firstToken });
  check('reusing that same token is refused — single use',
    reuse.isError && /unknown, already used, or expired/i.test(reuse.text), reuse.text);
  check('and did not start a second session on that folder', dumpsFor(TARGET).length === 1,
    `${dumpsFor(TARGET).length} sessions in ${path.basename(TARGET)}`);

  const madeUp = await tool('open_claude_session', { path: CAP_DIRS[2], token: 'a'.repeat(64) });
  check('an invented token is refused', madeUp.isError && /unknown, already used, or expired/i.test(madeUp.text),
    madeUp.text);

  // Deny, then try to redeem the token that prompt minted.
  const denied = await tool('open_claude_session', { path: CAP_DIRS[2] });
  const dTok = json(denied)?.token;
  await clickAnswer(false);
  const after = await tool('open_claude_session', { path: CAP_DIRS[2], token: dTok });
  check('a denied confirmation cannot be redeemed',
    after.isError && /declined|unknown, already used, or expired/i.test(after.text), after.text);
  check('and a denial spawns nothing', dumpsFor(CAP_DIRS[2]).length === 0,
    `${dumpsFor(CAP_DIRS[2]).length} sessions in ${path.basename(CAP_DIRS[2])}`);

  // The deny cooldown, end to end. Without it the loop above is a DoS: the modal
  // is a fixed full-window backdrop and a re-ask cycle costs ~36ms, so the app
  // is unusable and Allow is flashing under the cursor. Nothing spawns either
  // way — what is measured here is that the user is left alone.
  const tooSoon = await tool('open_claude_session', { path: CAP_DIRS[3] });
  check('an ask straight after a Deny is refused, and the refusal names the wait',
    tooSoon.isError && /denied the last request/i.test(tooSoon.text) && /\b\d+s\b/.test(tooSoon.text),
    tooSoon.text);
  // The absence that matters: no second modal was put in front of the user. A
  // per-path cooldown would have let CAP_DIRS[3] straight through.
  await win.waitForTimeout(500);
  check('and no new prompt was put in front of the user', (await promptPath()) === null,
    String(await promptPath()));

  // The original measurement, replayed: 12 asks back to back is what produced
  // 12 modals in 428 ms. Every path is a different one, so a per-path cooldown
  // would score 11 modals here and a global one scores none.
  const loopT0 = Date.now();
  const spam = [];
  for (let i = 0; i < 12; i++) spam.push(await tool('open_claude_session', { path: CAP_DIRS[i % 8] }));
  const loopMs = Date.now() - loopT0;
  check('twelve asks over eight different folders raise no modal at all',
    (await promptPath()) === null && spam.every((r) => r.isError && /denied the last request/i.test(r.text)),
    `${loopMs}ms, prompt=${await promptPath()}, ${spam.filter((r) => r.isError).length}/12 refused`);

  // ...and it wears off. A cooldown with no expiry would brick the tool for the
  // rest of the app run.
  const t0 = Date.now();
  const recovered = await waitFor(async () => {
    const r = await tool('open_claude_session', { path: CAP_DIRS[3] });
    return /denied the last request/i.test(r.text) ? null : r;
  }, 30_000, 1_000);
  check('a legitimate ask after the cooldown works again',
    !!recovered && !recovered.isError && json(recovered)?.needsConfirm === true,
    `${Math.round((Date.now() - t0) / 1000)}s — ${recovered?.text?.slice(0, 120) ?? 'never recovered'}`);
  await clickAnswer(false); // leave nothing pending for §7 (and re-arm the cooldown it polls out)
}

// === 6. no recursion — the other headline ===================================
console.log('\n6 — what the agent-spawned child was actually handed');
{
  const child = dumpBody(dumpsFor(AGENT_DIR)[0]);
  const childArgv = dumpArgv(dumpsFor(AGENT_DIR)[0]);
  const parent = dumpBody(dumpsFor(HARVEST)[0]);
  const parentArgv = dumpArgv(dumpsFor(HARVEST)[0]);

  // The control first, so "absent" is a measurement and not a broken scanner:
  // the SAME dump mechanism, reading a session the user started, finds all of it.
  check('CONTROL — the user-launched session got --mcp-config and the token',
    /--mcp-config/.test(parentArgv) && parent.includes(TOKEN)
      && /^CLAUDE_EXPLORER_MCP_TOKEN=/m.test(parent), parentArgv);

  check('the agent-spawned session got NO --mcp-config and no config path',
    !/--mcp-config/.test(childArgv) && !/mcp-agent-control\.json/i.test(childArgv), childArgv);
  // A scan of the WHOLE environment, not a lookup of the two variables we happen
  // to know the names of: any other variable leaking the token fails this too.
  check('and NO bearer token anywhere in its environment', !child.includes(TOKEN),
    child.includes(TOKEN) ? 'the token is in the child environment' : `${child.length} bytes scanned, clean`);
  check('it was launched with --strict-mcp-config, so the target folder\'s own .mcp.json is off too',
    /--strict-mcp-config/.test(childArgv), childArgv);
}

// === 7. eight, and then a ninth ==============================================
//
// KAN-64 REWROTE THIS SECTION. It used to assert the opposite: that the ninth
// session was REFUSED with a typed cap error and that the user was never asked
// about it. The number is a free allowance now, not a ceiling — this profile
// runs at 0, so every one of these nine costs a human click, and the ninth is
// asked about and then GRANTED rather than refused. "It throttles; it never
// blocks", measured end to end.
console.log('\n7 — eight, and then a ninth');
const CAP_TABS = [];
{
  // One session already exists from §5, so seven more make eight.
  let started = 1;
  for (let i = 1; i < 8; i++) {
    const r = await confirmSpawn(CAP_DIRS[i]);
    if (!r.started.isError && json(r.started)?.started === true) started++;
    else console.log(`    (session ${i} failed: ${r.started.text.slice(0, 120)})`);
  }
  check('eight concurrent app-spawned sessions are allowed', started === 8, `${started} started`);

  // The harvest tab has been a live Claude session for this whole section. If
  // user-launched sessions counted, one of the eight would have been an ask too
  // many — and, in §12's terms, the user's tab is not the tool's to manage.
  const live = (await tabs()).filter((t) => t.terminalKind === 'claude');
  CAP_TABS.push(...live.filter((t) => t.cwd !== HARVEST));
  check('a session the USER started is not one of the tool\'s',
    live.some((t) => t.cwd === HARVEST) && CAP_TABS.length === 8,
    `${CAP_TABS.length} app-spawned + ${live.length - CAP_TABS.length} user`);

  // THE KAN-64 REVERSAL. Nine already-open sessions used to be unreachable at
  // any price; now it costs exactly what the first eight cost — one Allow.
  const ninth = await confirmSpawn(NINTH_DIR);
  check('the ninth is ASKED about, not refused by a cap',
    !ninth.ask.isError && json(ninth.ask)?.needsConfirm === true, ninth.ask.text.slice(0, 200));
  check('and approving it opens a ninth app-spawned session',
    !ninth.started.isError && json(ninth.started)?.started === true,
    ninth.started.text.slice(0, 200));
  const ninthTab = (await tabs()).find((t) => t.cwd.toLowerCase() === NINTH_DIR.toLowerCase());
  check('which really is a ninth tab, live in the window',
    !!ninthTab && (await tabs()).filter((t) => t.terminalKind === 'claude' && t.cwd !== HARVEST)
      .length === 9,
    ninthTab ? ninthTab.title : 'no tab for the ninth folder');

  // Handed back to §8 at eight, which is the state the rest of this file was
  // written against.
  if (ninthTab) await tool('close_tab', { tabId: ninthTab.id });
}

// === 8. five closes, back to back ===========================================
console.log('\n8 — five close_tab calls with no gap');
{
  const doomed = CAP_TABS.slice(0, 5);
  const survivors = CAP_TABS.slice(5).map((t) => t.id);
  const beforeTerms = await xterms();

  // Issued in ONE tick, deliberately: the renderer answers control ops one per
  // React commit, and five closes that each read the pre-close tab list would
  // compose into the wrong count. A sleep between them would make this pass
  // against exactly the bug it exists to catch.
  const rs = await Promise.all(doomed.map((t) => tool('close_tab', { tabId: t.id })));
  check('all five calls returned ok', rs.every((r) => !r.isError && json(r)?.ok === true),
    rs.map((r) => (r.isError ? r.text.slice(0, 60) : 'ok')).join(' | '));

  const left = (await tabs()).filter((t) => t.terminalKind === 'claude' && t.cwd !== HARVEST);
  check('exactly three of the eight are left',
    left.length === 3 && left.every((t) => survivors.includes(t.id)),
    `${left.length}: ${left.map((t) => t.title).join(', ')}`);
  // The element, never its text: ConPTY repaints the whole screen buffer on a
  // resize, so pane text survives a terminal that was destroyed and remounted.
  check('and five terminals really went away', (await xterms()) === beforeTerms - 5,
    `${beforeTerms} -> ${await xterms()} .xterm elements`);

  // Still serving after five closes in one tick, and still willing to ask. At
  // this profile's allowance of 0 the ask is unconditional, so what this
  // measures is that close_tab left the guard in a working state — the count's
  // own bookkeeping is §11's and §12's job, where the allowance is not 0.
  const again = await tool('open_claude_session', { path: FANOUT[0] });
  check('with three left, a new session can still be asked for',
    !again.isError && json(again)?.needsConfirm === true, again.text.slice(0, 160));
  await clickAnswer(false);

  for (const t of left) await tool('close_tab', { tabId: t.id });
  check('the app-spawned sessions can all be closed through the tool',
    (await tabs()).every((t) => t.terminalKind !== 'claude' || t.cwd === HARVEST),
    (await tabs()).filter((t) => t.terminalKind === 'claude').map((t) => t.title).join(', '));
}

// === 8b. a slow path stalls one request, not the process ====================
//
// open_viewer_tab resolves a CALLER-NAMED path, and needs no confirmation at
// all. Resolved synchronously, an unreachable SMB host costs main ~21 seconds
// on its own thread: no IPC, no pty:data forwarding, no menu, no paint — every
// terminal in the app goes silent and the user sees a hung application. A
// prompt-injected agent loops it over fresh hostnames and it never comes back.
//
// The oracle is a SECOND request issued while the first is still stalled. It
// has to travel the same socket->main->control->renderer round trip, so it can
// only answer quickly if main was free the whole time.
console.log('\n8b — an unreachable UNC path');
{
  // 10.255.255.0/24 is non-routable, so the SMB connect hangs until Windows
  // gives up. Windows negative-caches per HOST, so pick one this machine has
  // not tried — a cached host fails instantly and would measure nothing.
  const dead = `\\\\10.255.255.${(process.pid % 200) + 30}\\s\\x.txt`;
  const t0 = Date.now();
  const stalled = tool('open_viewer_tab', { path: dead });
  await new Promise((r) => setTimeout(r, 400));

  const t1 = Date.now();
  const during = await tool('list_tabs');
  const listMs = Date.now() - t1;
  await stalled;
  const stallMs = Date.now() - t0;

  // Stated first, and loudly: if the host answers fast on this machine there is
  // no stall to be concurrent with, and the check below would pass vacuously.
  check('the unreachable host really did stall the request (otherwise the next check measures nothing)',
    stallMs > 5_000, `${stallMs}ms for ${dead}`);
  check('and a list_tabs issued 400ms into that stall was answered without waiting for it',
    !during.isError && listMs < 3_000, `${listMs}ms (stall was ${stallMs}ms)`);
}

// === 8c. ...and FOUR of them still stall only one worker ====================
//
// list_tabs above proves the event loop is free. It does not prove the app is,
// because `await` moves the stall off the event loop and onto libuv's
// THREADPOOL, which is four threads. Every fs operation main does for the
// window — the file browser's readdir, the viewer's readFile, session parsing,
// the trash — is node:fs/promises and queues on those same four. One agent turn
// can emit four tool calls, so the threadpool is the second lever on the same
// DoS, and the oracle has to be a request that actually touches the disk.
//
// Measured standalone: readdir("C:\Windows\System32") took 4ms alongside ONE
// unreachable-UNC realpath and 20,438ms alongside four.
//
// ONE host, asked for four times over. Windows negative-caches per host, so
// four resolutions ONE AT A TIME cost 21s + 0 + 0 + 0, while four at once all
// miss the cache together and cost four workers for the full 21s — the whole
// difference between the two shows up in the listing below, and the section
// takes ~21s whichever way it goes.
console.log('\n8c — four at once');
{
  const dead = Array(4).fill(`\\\\10.255.254.${(process.pid % 200) + 40}\\s\\x.txt`);
  const t0 = Date.now();
  const stalled = dead.map((p) => tool('open_viewer_tab', { path: p }));
  await new Promise((r) => setTimeout(r, 600));

  // Straight down fs.handlers -> listDir -> fs/promises readdir + stat, i.e.
  // exactly what the file browser does every time the user opens a folder.
  const lsMs = await win.evaluate(async (dir) => {
    const t = performance.now();
    await window.api.fsList(dir);
    return Math.round(performance.now() - t);
  }, WORK);
  const replies = await Promise.all(stalled);
  const stallMs = Date.now() - t0;

  check('four concurrent calls at the unreachable host really did stall (otherwise the next check measures nothing)',
    stallMs > 5_000, `${stallMs}ms for ${dead.length} calls at ${dead[0]}`);
  check('and a folder listing issued during all four came back without waiting for them',
    lsMs < 3_000, `${lsMs}ms (stall was ${stallMs}ms)`);
  check('every one of the four still answered with its own typed error, none hung',
    replies.every((r) => r.isError && /no such path/i.test(r.text)),
    replies.map((r) => r.text.slice(0, 40)).join(' | '));
}

// === 9. the fan-out criterion ===============================================
//
// Three REAL Claude Code sessions, in three named folders, each started through
// the tool with the user's click in between. Everything up to here could run
// against a stand-in; this cannot — the claim is about session identity and
// transcripts on disk, which only the real CLI writes.
let SESSION_IDS = [];
if (!FAST) {
  console.log('\n9 — three real sessions, three named folders');
  const t0 = Date.now();
  const started = [];
  for (const dir of FANOUT) started.push(await confirmSpawn(dir));
  check('all three returned started:true inside the control deadline',
    started.every((s) => !s.started.isError && json(s.started)?.started === true)
      && Date.now() - t0 < 45_000,
    `${Math.round((Date.now() - t0) / 1000)}s — ${started.map((s) => s.started.text.slice(0, 40)).join(' | ')}`);

  // The tool answers as soon as pty.spawn() returns, which is BEFORE the CLI has
  // run far enough to record anything — the three replies above came back in
  // about a second. So wait for the process, then read what it was given.
  await waitFor(() => FANOUT.every((d) => dumpsFor(d).length) || null, 30_000);

  const rows = await tabs();
  check('each is a Claude terminal tab titled with its folder\'s basename',
    FANOUT.every((d) => rows.some((t) => t.cwd === d && t.view === 'terminal'
      && t.terminalKind === 'claude' && t.title === path.basename(d))),
    rows.filter((t) => t.terminalKind === 'claude').map((t) => t.title).join(', '));

  SESSION_IDS = FANOUT.map((d) => {
    const f = dumpsFor(d)[0];
    return f ? (/--session-id ([0-9a-f-]{36})/.exec(dumpArgv(f))?.[1] ?? '') : '';
  });
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  check('each was launched with its own --session-id, a real UUID, all three distinct',
    SESSION_IDS.every((id) => UUID.test(id)) && new Set(SESSION_IDS).size === 3,
    SESSION_IDS.join(', '));
  check('and each of those children is a worker: --strict-mcp-config, no token',
    FANOUT.every((d, i) => /--strict-mcp-config/.test(dumpArgv(dumpsFor(d)[0]))
      && !dumpBody(dumpsFor(d)[0]).includes(TOKEN) && SESSION_IDS[i]),
    FANOUT.map((d) => dumpArgv(dumpsFor(d)[0]).replace(/--session-id \S+/, '')).join(' | '));

  // The workspace trust dialog. The design decided NOT to pre-empt it: the user
  // clicked Allow on this exact folder a second ago, so the prompt lands in front
  // of the human who authorised it. What has to be true is that it does not stop
  // the TOOL (asserted above — three started:true well inside the deadline) and
  // that it is answerable. Answer it the way that human would.
  let trustSeen = 0;
  for (let i = 0; i < FANOUT.length; i++) {
    await win.locator('.tab', { hasText: path.basename(FANOUT[i]) }).first().click();
    await win.waitForSelector(VIS + '.xterm', { timeout: 30_000 });
    const text = await waitFor(async () => {
      const t = await win.$eval(VIS + '.xterm-rows', (el) => el.textContent).catch(() => '');
      return /1\. Yes, I trust this folder|Tips for getting started|Welcome back/i.test(t) ? t : null;
    }, 120_000, 1_500) ?? '';
    if (/1\. Yes, I trust this folder/i.test(text)) {
      trustSeen++;
      const ptyId = await win.$eval(VIS + '[data-pty]', (el) => el.dataset.pty);
      await win.evaluate((id) => window.api.ptyWrite(id, '\r'), ptyId);
      await win.waitForTimeout(4_000);
    }
  }
  check('a virgin folder shows Claude\'s trust prompt, and it is answerable in the tab',
    trustSeen === 3, `${trustSeen} of 3 folders prompted`);

  // A turn each, so there is a transcript to resume. The oracle is the FILE, not
  // the screen: the marker is typed, and a terminal echoes what you type.
  for (let i = 0; i < FANOUT.length; i++) {
    await win.locator('.tab', { hasText: path.basename(FANOUT[i]) }).first().click();
    await win.waitForTimeout(600);
    await win.locator(VIS + '.xterm-screen').click();
    await win.keyboard.type(`Reply with exactly this and nothing else: ${MARK[i]}`);
    await win.waitForTimeout(600);
    const ptyId = await win.$eval(VIS + '[data-pty]', (el) => el.dataset.pty);
    for (let n = 0; n < 8; n++) {
      await win.evaluate((id) => window.api.ptyWrite(id, '\r'), ptyId);
      const file = transcript(FANOUT[i], SESSION_IDS[i]);
      const landed = await waitFor(() =>
        (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARK[i])) || null, 20_000, 1_000);
      if (landed) break;
    }
  }
  const onDisk = FANOUT.map((d, i) => transcript(d, SESSION_IDS[i]))
    .map((f, i) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(MARK[i]));
  check('each session has a transcript under ~/.claude/projects/<slug>/, at the id WE assigned',
    onDisk.every(Boolean), onDisk.map((v, i) => `${path.basename(FANOUT[i])}:${v}`).join(' '));

  // Leave a non-terminal tab active, so run 2's respawns are things this file
  // asked for rather than a side effect of which tab happened to be focused.
  await win.locator('.tab:not(.add)').first().click();
  await win.waitForTimeout(1_500); // the workspace save is debounced 400ms

  const ws = JSON.parse(fs.readFileSync(path.join(PROFILE, 'workspace.json'), 'utf8'));
  check('and workspace.json persists that same id against each tab',
    FANOUT.every((d, i) => ws.tabs.some((t) => t.cwd === d && t.resumeSessionId === SESSION_IDS[i])),
    ws.tabs.filter((t) => t.resumeSessionId).map((t) => `${t.title}=${t.resumeSessionId?.slice(0, 8)}`).join(' '));
}

await close();

// === 10. and they come back =================================================
if (!FAST) {
  console.log('\n10 — restart');
  const before = dumps().length;
  const { win: win2, close: close2 } = await launchApp({ userDataDir: PROFILE });
  await win2.waitForSelector('.tab:not(.add)');
  await win2.waitForTimeout(1_500);

  const titles = await win2.locator('.tab:not(.add)').allTextContents();
  check('all three tabs are back in the strip',
    FANOUT.every((d) => titles.some((t) => t.includes(path.basename(d)))),
    titles.map((t) => t.replace(/\s+/g, ' ').trim()).join(' | '));
  check('and nothing respawned before a tab was opened', dumps().length === before,
    `${before} -> ${dumps().length} invocations`);

  const resumed = [];
  const back = [];
  for (let i = 0; i < FANOUT.length; i++) {
    await win2.locator('.tab', { hasText: path.basename(FANOUT[i]) }).first().click();
    await win2.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 30_000 });
    const f = await waitFor(() => (dumpsFor(FANOUT[i]).length > 1 ? dumpsFor(FANOUT[i]).at(-1) : null), 20_000);
    resumed.push(f ? dumpArgv(f) : 'no respawn');
    // Nothing has been typed in this run, so the pane is now an honest witness:
    // the marker can only be on screen because the conversation came back.
    const t = await waitFor(async () => {
      const s = await win2.$eval('.pane:not([hidden]) .xterm-rows', (el) => el.textContent).catch(() => '');
      return s.includes(MARK[i]) ? s : null;
    }, 90_000, 2_000);
    back.push(!!t);
  }
  check('activating each one respawns it with --resume against the id we assigned',
    resumed.every((a, i) => a.includes('--resume') && a.includes(SESSION_IDS[i])),
    resumed.join(' | '));
  // Provenance, not preference. A restart that forgot which sessions an agent
  // started would hand every one of them the config and the token on respawn —
  // an escalation bought by quitting the app.
  //
  // Run 2 minted a NEW token, so §6's string is worthless here: asserting the
  // OLD token is absent from a new process could not fail. The control is the
  // USER's own tab, respawned in this same run — if the variable is missing from
  // that too, the server simply did not start and the three below prove nothing.
  await win2.locator('.tab', { hasText: 'harvest' }).first().click();
  await win2.waitForSelector('.pane:not([hidden]) .xterm', { timeout: 30_000 });
  const userAgain = await waitFor(() => (dumpsFor(HARVEST).length > 1 ? dumpsFor(HARVEST).at(-1) : null), 20_000);
  check('CONTROL — the user\'s own restored session is handed this run\'s token',
    !!userAgain && /^CLAUDE_EXPLORER_MCP_TOKEN=[0-9a-f]{64}$/m.test(dumpBody(userAgain))
      && !dumpBody(userAgain).includes(TOKEN),
    userAgain ? dumpArgv(userAgain) : 'the user tab never respawned');
  check('and each agent-started session is STILL a worker — no --mcp-config, no token',
    FANOUT.every((d) => {
      const f = dumpsFor(d).at(-1);
      return /--strict-mcp-config/.test(dumpArgv(f)) && !/--mcp-config/.test(dumpArgv(f))
        && !/^CLAUDE_EXPLORER_MCP_TOKEN=/m.test(dumpBody(f));
    }), resumed.join(' | '));
  check('and the conversation is on screen again in all three',
    back.every(Boolean), back.map((v, i) => `${path.basename(FANOUT[i])}:${v}`).join(' '));

  await close2();
}

// === 11. KAN-64 — restored agent tabs count, and are never reaped ===========
//
// Its OWN app run and its own throwaway profile, still under TMP (so the pid
// suffix that guards the single-instance lock covers it too) rather than
// reusing PROFILE — §9/§10's profile already carries three real Claude
// sessions and this section's claim is sharper with a workspace containing
// exactly eight agent-spawned tabs and nothing else. Every session below is a
// stand-in (no `.ce-real` anywhere under WORK/k64-*), so this needs no real
// Claude Code and costs seconds, not minutes — it runs whether or not --fast
// was passed.
//
// THE GAP THIS PROVES CLOSED: `PtyManager.agentSessions()` (KAN-41) is DERIVED
// from the live pty handle map, and a brand-new process starts that map empty
// — a restored terminal tab spawns on first activation, not at launch (App.tsx,
// `needsSpawn`). So a fresh process that has never had any of its restored
// agent tabs clicked reports zero live agent sessions no matter how many the
// last run left open, and without the fix the ninth `open_claude_session`
// below would open SILENTLY, with the user never told.
//
// THIS PROFILE RUNS AT THE DEFAULT ALLOWANCE OF 8, unlike §0-§8's 0, so it
// measures three things the rest of the file cannot:
//   - eight sessions opening with NO dialog at all (the free path);
//   - a restored tab still holding its slot, so the ninth ASKS;
//   - and the reap that runs before that ask leaving every DORMANT tab alone.
//
// RED-FIRST: reverting pty.handlers.ts's `agentSessionCount` to
// `mgr.agentSessions()` alone (workspace.ts's `agentSpawnedTabCount` un-called)
// turns the ninth-ask check red — nothing is live in run 2, so the ninth spawns
// silently instead of asking. Captured verbatim in the report.
console.log('\n11 — restored agent tabs count, and are never reaped');
{
  const PROFILE2 = mkdir(path.join(TMP, 'profile-kan64'));
  allowanceProfile(PROFILE2, 8);
  // [0] is the user-launched harvest folder (does not count against the cap,
  // exactly like HARVEST in §0/§7); [1..8] are the eight app-spawned ones.
  const K64 = Array.from({ length: 9 }, (_, i) => mkdir(path.join(WORK, `k64-${i}`)));

  const harvestToken = async (win, dir, name) => {
    await win.locator('.tab.add').click();
    await win.waitForTimeout(600);
    await win.locator('.address').click();
    await win.waitForTimeout(200);
    await win.locator('.address-input').fill(WORK);
    await win.keyboard.press('Enter');
    await win.waitForTimeout(1_200);
    await win.locator('.entry', { hasText: name }).first().locator('.entry-open').click();
    const f = await waitFor(() => dumpsFor(dir)[0] ?? null, 20_000);
    return f ? (/^CLAUDE_EXPLORER_MCP_TOKEN=(.*)$/m.exec(dumpBody(f))?.[1] ?? '') : '';
  };

  // --- run 1: eight FREE sessions, then quit with all eight tabs open -------
  const run1 = await launchApp({ userDataDir: PROFILE2 });
  const cfg1 = JSON.parse(fs.readFileSync(path.join(PROFILE2, 'mcp-agent-control.json'), 'utf8'));
  PORT = Number(/:(\d+)\//.exec(cfg1.mcpServers.explorer.url)[1]);
  TOKEN = await harvestToken(run1.win, K64[0], 'k64-0');
  check('run 1: a user-launched session yields this run\'s own token',
    /^[0-9a-f]{64}$/.test(TOKEN), TOKEN ? 'ok' : 'no dump');

  const answerIn = async (w, allow) => {
    await w.waitForSelector('.spawn-modal', { timeout: 15_000 });
    await w.locator(`.spawn-modal .modal-actions button${allow ? '.primary' : ':not(.primary)'}`).click();
    await w.waitForSelector('.spawn-modal', { state: 'detached', timeout: 5_000 });
  };

  // ONE CALL EACH, no token step anywhere: under the allowance the tool starts
  // the session outright. The dialog is probed after every call — the reply
  // only comes back once the spawn has landed, so a prompt would have to be on
  // screen at that moment.
  let started1 = 0;
  const seenModal = [];
  for (let i = 1; i <= 8; i++) {
    const r = await tool('open_claude_session', { path: K64[i] });
    if (!r.isError && json(r)?.started === true) started1++;
    else console.log(`    (session ${i}: ${r.text.slice(0, 120)})`);
    seenModal.push(await modalPathIn(run1.win));
  }
  check('run 1: eight sessions started with one call each — no token, no dialog',
    started1 === 8, `${started1} started`);
  check('run 1: and the user was never asked, not once',
    seenModal.every((p) => p === null), seenModal.filter(Boolean).join(' | ') || 'no prompt seen');
  // The strongest witness that all eight really ran: eight dump files, i.e. the
  // CLI was executed eight times. A reply cannot fake that. Polled, because the
  // tool answers when the SPAWN lands and the shim writes its dump a moment
  // later — a bare read here measured 7/8 once, and that was the harness racing
  // the shim, not the app.
  const ran1 = await waitFor(() => {
    const n = K64.slice(1, 9).filter((d) => dumpsFor(d).length > 0).length;
    return n === 8 ? n : null;
  }, 20_000) ?? K64.slice(1, 9).filter((d) => dumpsFor(d).length > 0).length;
  check('run 1: claude was really executed in all eight folders', ran1 === 8, `${ran1}/8 dumps`);

  await run1.win.waitForTimeout(1_500); // debounced persist, same margin §9 gives it
  const ws1 = JSON.parse(fs.readFileSync(path.join(PROFILE2, 'workspace.json'), 'utf8'));
  const onDisk1 = ws1.tabs.filter((t) => t.agentSpawned === true).length;
  check('run 1: workspace.json remembers all eight as agent-spawned tabs before any restart',
    onDisk1 === 8, `${onDisk1} persisted`);

  await run1.close(); // all eight left open on purpose — nothing closed them

  // --- run 2: a fresh process, nothing live, nothing activated ---------------
  const run2 = await launchApp({ userDataDir: PROFILE2 });
  await run2.win.waitForSelector('.tab:not(.add)');
  await run2.win.waitForTimeout(1_500);

  // The tab active when run 1 quit is restored active too, and KAN-46 spawns
  // a restored tab that is ON SCREEN immediately — not "clicked", but not the
  // KAN-64 gap either: that is one process for the one tab the window shows
  // by default (K64[8], the last one confirm1 selected), not all eight. So
  // the live/dormant SPLIT is the real assertion, and it doubles as proof
  // that the cap below is reading a genuine mix, not eight identical dormant
  // rows — Math.max(mgr, disk) has to combine one live session with seven
  // that are not for the ninth-ask refusal after this to mean anything.
  const before64 = K64.slice(1, 9).map((d) => dumpsFor(d).length);
  const respawnedOnOpen = before64.filter((n) => n > 1).length;
  check('run 2: opening the window respawns at most the one on-screen tab — the other seven stay dormant',
    respawnedOnOpen <= 1 && before64.every((n) => n === 1 || n === 2), before64.join(','));

  const cfg2 = JSON.parse(fs.readFileSync(path.join(PROFILE2, 'mcp-agent-control.json'), 'utf8'));
  PORT = Number(/:(\d+)\//.exec(cfg2.mcpServers.explorer.url)[1]);
  const HARVEST2 = mkdir(path.join(WORK, 'k64-harvest2'));
  TOKEN = await harvestToken(run2.win, HARVEST2, 'k64-harvest2');
  check('run 2: a fresh token was harvested after the restart',
    /^[0-9a-f]{64}$/.test(TOKEN), TOKEN ? 'ok' : 'no dump');

  const rows2 = await tabs();
  const restored = rows2.filter((t) => K64.slice(1, 9).some((d) => d.toLowerCase() === t.cwd.toLowerCase()));
  check('run 2: list_tabs sees all eight restored agent tabs',
    restored.length === 8, restored.map((t) => t.title).join(', '));

  // THE HEADLINE: no live pty for any of them (mgr.agentSessions() reads 0 on
  // this brand-new process), and the allowance is still spent — so the ninth
  // has to ask instead of opening silently. In run 1 the same call opened a
  // session with no dialog eight times in a row; that contrast is the whole
  // assertion, and it is why both halves live in this section.
  const NINTH = mkdir(path.join(WORK, 'k64-ninth'));
  const ninthAsk = await tool('open_claude_session', { path: NINTH });
  check('run 2: a NINTH ASKS, although nothing has ever been live in this run',
    !ninthAsk.isError && json(ninthAsk)?.needsConfirm === true, ninthAsk.text.slice(0, 200));
  const promptAfterNinth = await modalPathIn(run2.win);
  check('run 2: and the user really is being shown that exact folder',
    promptAfterNinth === NINTH, String(promptAfterNinth));

  // KAN-64: the number is the user's, so the dialog that exists BECAUSE of it
  // has to say where it lives. Someone meeting this for the ninth time should
  // not have to go looking. Asserted on the dialog's own text, and on the menu
  // path a person would actually follow.
  const modalText = await run2.win.evaluate(() =>
    document.querySelector('.spawn-modal')?.textContent ?? '');
  check('run 2: and the dialog says where to change the number',
    /Settings/i.test(modalText) && /Preferences/i.test(modalText) && /Ctrl\+,/.test(modalText),
    modalText.replace(/\s+/g, ' ').slice(-190));

  // THE CRITERION THAT PROTECTS THE USER'S DATA. Asking crossed the allowance,
  // so the reap ran — against eight tabs that are agent-spawned and have no
  // live process. Seven were never activated (no ptyId, so no status at all)
  // and one respawned on screen. NONE of them is dead, and all eight must still
  // be here. A reap keyed on "no live pty" or on "status is not running" wipes
  // the lot, silently, at the exact moment the user is being asked a question.
  const afterReap = await tabs();
  const survived = afterReap.filter((t) => K64.slice(1, 9).some((d) => d.toLowerCase() === t.cwd.toLowerCase()));
  check('run 2: the reap before that ask left all eight DORMANT restored tabs alone',
    survived.length === 8, `${survived.length}/8 survived: ${survived.map((t) => t.title).join(', ')}`);
  check('run 2: and it closed nothing else in the window either',
    afterReap.length === rows2.length, `${rows2.length} -> ${afterReap.length} tabs`);

  // ...and approving opens the ninth, over the number, exactly as §7 shows at
  // an allowance of 0. There is no count that refuses.
  await answerIn(run2.win, true);
  const ninthStarted = await tool('open_claude_session', { path: NINTH, token: json(ninthAsk).token });
  check('run 2: approving it opens a ninth session past the allowance',
    !ninthStarted.isError && json(ninthStarted)?.started === true,
    ninthStarted.text.slice(0, 200));

  // NOT a monotonic restart-lockout, and the other direction of the same rule:
  // take the count back under the allowance and the next session is free again.
  // Two tabs, because the ninth just landed — the ninth's own tab and one
  // restored-but-still-dormant one (never activated, no ptyId anywhere).
  const ninthTab2 = (await tabs()).find((t) => t.cwd.toLowerCase() === NINTH.toLowerCase());
  if (ninthTab2) await tool('close_tab', { tabId: ninthTab2.id });
  await tool('close_tab', { tabId: survived[0].id });
  await run2.win.waitForTimeout(700); // let the persist land, §9's own margin
  const TENTH = mkdir(path.join(WORK, 'k64-tenth'));
  const afterClose = await tool('open_claude_session', { path: TENTH });
  check('run 2: closing tabs takes it back under the allowance and the next one is free',
    !afterClose.isError && json(afterClose)?.started === true, afterClose.text.slice(0, 160));
  check('run 2: with no dialog for it', (await modalPathIn(run2.win)) === null,
    String(await modalPathIn(run2.win)));

  await run2.close();
}

// === 12. KAN-64 — the reap: dead agent tabs, and only those =================
//
// The other half of §11. There the reap ran and correctly did NOTHING; here it
// runs and closes exactly the right tabs. Its own profile and app run, at an
// allowance of 4 so the arithmetic is short.
//
// HOW A TAB IS MADE GENUINELY DEAD: the session's process is killed from
// OUTSIDE the app, the way a crash ends one. The pty really ran and really
// ended, so pty:exit really reached the renderer and the tab's status really is
// 'stopped' — nothing here fakes a status. Each kill names ONE process, matched
// on the session UUID the app minted for it (the app passes it as
// --session-id, so it is in that child's command line and nowhere else).
//
// NOT by having the stand-in exit on its own, and not by typing into its pane:
// both wedge the whole app, main included — an unrelated hazard around a
// ConPTY whose cmd.exe root exits of its own accord, reproducible with a
// four-line probe and nothing to do with this ticket. See the report; it is
// worth its own investigation, and this harness deliberately does not depend
// on it.
//
// The two things that must NOT be reaped are both here, and both look identical
// to a lazy test — "it has no live process" / "its status is not running":
//   - a tab THE USER opened whose Claude has exited (dead, but not the tool's);
//   - an agent tab whose session is still up, which reports 'waiting' rather
//     than 'running' once it has gone quiet — so "not running" is not death
//     either.
// The third, a dormant restored tab, is §11's.
console.log('\n12 — the reap');
{
  const PROFILE3 = mkdir(path.join(TMP, 'profile-reap'));
  allowanceProfile(PROFILE3, 4);
  const HARVEST3 = mkdir(path.join(WORK, 'reap-harvest')); // user-opened, stays up
  const USER_DEAD = mkdir(path.join(WORK, 'reap-user'));   // user-opened, killed
  const DEAD = ['reap-a', 'reap-b', 'reap-c'].map((n) => mkdir(path.join(WORK, n))); // agent, killed
  const ALIVE = mkdir(path.join(WORK, 'reap-alive'));      // agent-opened, stays up
  const FIFTH = mkdir(path.join(WORK, 'reap-fifth'));      // the one that needs room

  /** Kill the ONE stand-in behind `dir`'s session. The dump the shim wrote is
   *  named after that session's UUID, and the app put the same UUID on the
   *  child's command line (--session-id), so this matches exactly one process
   *  however many sessions are running. */
  const killSession = (dir) => {
    const id = /^d-(.+)-\d+\.txt$/.exec(dumpsFor(dir)[0] ?? '')?.[1];
    if (!id) return false;
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*${id}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
    { stdio: 'ignore' });
    return true;
  };

  const run3 = await launchApp({ userDataDir: PROFILE3 });
  const cfg3 = JSON.parse(fs.readFileSync(path.join(PROFILE3, 'mcp-agent-control.json'), 'utf8'));
  PORT = Number(/:(\d+)\//.exec(cfg3.mcpServers.explorer.url)[1]);

  /** Open a folder's Claude session the way a PERSON does — the orange arrow in
   *  the file list — so the tab it makes is not the tool's. */
  const userSession = async (name) => {
    await run3.win.locator('.tab.add').click();
    await run3.win.waitForTimeout(600);
    await run3.win.locator('.address').click();
    await run3.win.waitForTimeout(200);
    await run3.win.locator('.address-input').fill(WORK);
    await run3.win.keyboard.press('Enter');
    await run3.win.waitForTimeout(1_200);
    await run3.win.locator('.entry', { hasText: name }).first().locator('.entry-open').click();
  };

  await userSession('reap-harvest');
  const hf = await waitFor(() => dumpsFor(HARVEST3)[0] ?? null, 20_000);
  TOKEN = hf ? (/^CLAUDE_EXPLORER_MCP_TOKEN=(.*)$/m.exec(dumpBody(hf))?.[1] ?? '') : '';
  check('a user-launched session yields this run\'s token', /^[0-9a-f]{64}$/.test(TOKEN),
    TOKEN ? 'ok' : 'no dump');

  // The user's OWN tab, killed below exactly as the agent tabs are — the
  // control for "a tab the user created is never reaped". Same death,
  // different provenance, and provenance is the whole of what may not be
  // ignored.
  await userSession('reap-user');
  await waitFor(() => dumpsFor(USER_DEAD)[0] ?? null, 20_000);

  // Four agent sessions, all free: the allowance is 4 and nothing of the tool's
  // is open yet. The user's two tabs are not the tool's and do not count.
  let opened = 0;
  for (const d of [...DEAD, ALIVE]) {
    const r = await tool('open_claude_session', { path: d });
    if (!r.isError && json(r)?.started === true) opened++;
    else console.log(`    (${path.basename(d)}: ${r.text.slice(0, 120)})`);
  }
  check('four agent sessions opened freely under an allowance of 4', opened === 4, `${opened}/4`);
  // Every stand-in has to have written its dump before anything is killed —
  // that file is what names the process to kill.
  await waitFor(() => [...DEAD, ALIVE].every((d) => dumpsFor(d).length > 0) || null, 20_000);

  const killed = [...DEAD, USER_DEAD].filter(killSession).length;
  check('three agent sessions and the user\'s were killed from outside the app',
    killed === 4, `${killed}/4 found`);

  // The status the whole reap turns on, read out of list_tabs rather than
  // assumed. Polled: pty:exit travels main -> renderer -> a React commit.
  const settled = await waitFor(async () => {
    const rows = await tabs();
    const gone = rows.filter((t) => [...DEAD, USER_DEAD].some((d) => d.toLowerCase() === t.cwd.toLowerCase()));
    return gone.length === 4 && gone.every((t) => t.status === 'stopped') ? rows : null;
  }, 30_000);
  const aliveRow = (settled ?? []).find((t) => t.cwd.toLowerCase() === ALIVE.toLowerCase());
  const userRow = (settled ?? []).find((t) => t.cwd.toLowerCase() === USER_DEAD.toLowerCase());
  check('list_tabs reports the four ended sessions as stopped, and the live one as not',
    !!settled && !!aliveRow && aliveRow.status !== 'stopped',
    aliveRow ? `alive: ${aliveRow.status}` : 'never settled');
  check('and it marks the tool\'s tabs agentSpawned while the user\'s tab is not',
    aliveRow?.agentSpawned === true && userRow?.agentSpawned === undefined
      && userRow?.status === 'stopped',
    `user: agentSpawned=${userRow?.agentSpawned} status=${userRow?.status}`);

  // NOTHING IS REAPED WHILE YOU ARE MERELY USING THE APP. No timer, no boot
  // sweep, no background reaper — a dead agent tab stays on screen as the
  // record of what happened until its slot is actually wanted. So: click
  // around, wait several seconds, and count again.
  const beforeIdle = (await tabs()).length;
  await run3.win.locator('.tab:not(.add)').first().click();
  await run3.win.waitForTimeout(1_500);
  await run3.win.locator('.tab:not(.add)').last().click();
  await run3.win.waitForTimeout(3_500);
  const idleRows = await tabs();
  check('nothing is reaped while the app is merely being used',
    idleRows.length === beforeIdle
      && DEAD.every((d) => idleRows.some((t) => t.cwd.toLowerCase() === d.toLowerCase())),
    `${beforeIdle} -> ${idleRows.length} tabs`);

  // NOW ask for one more. This is the only moment a reap may happen: the fifth
  // session would cross the allowance of 4, the three dead agent tabs are
  // closed, that leaves one — and the session opens with NO prompt.
  const fifth = await tool('open_claude_session', { path: FIFTH });
  check('the fifth session opens with no prompt, because the reap made room',
    !fifth.isError && json(fifth)?.started === true, fifth.text.slice(0, 200));
  check('and the user was never asked', (await modalPathIn(run3.win)) === null,
    String(await modalPathIn(run3.win)));

  const after = await tabs();
  const stillDead = DEAD.filter((d) => after.some((t) => t.cwd.toLowerCase() === d.toLowerCase()));
  check('the three DEAD agent tabs were closed', stillDead.length === 0,
    stillDead.map((d) => path.basename(d)).join(', ') || 'none left');
  const left = after.map((t) => t.title).join(', ');
  check('the agent tab whose session is still up was not touched',
    after.some((t) => t.cwd.toLowerCase() === ALIVE.toLowerCase()), left);
  check('the tab the USER opened was not touched, dead though it is',
    after.some((t) => t.cwd.toLowerCase() === USER_DEAD.toLowerCase()), left);
  check('and the fifth session really has a tab of its own',
    after.some((t) => t.cwd.toLowerCase() === FIFTH.toLowerCase()), left);
  // The reap goes through the ordinary close path, so the closed tabs' xterms
  // are really gone from the DOM — not merely dropped from a list. The element,
  // never its text (ConPTY repaints its whole buffer on resize).
  const terms = await run3.win.evaluate(() => document.querySelectorAll('.xterm').length);
  check('and their terminals really left the window',
    terms === after.filter((t) => t.view === 'terminal').length,
    `${terms} .xterm elements for ${after.filter((t) => t.view === 'terminal').length} terminal tabs`);

  await run3.close();
}

// The stand-in sessions block on stdin; killing their tabs above took the ones
// this file created, and the app's exit takes the rest with the console. Sweep
// anyway — a harness that leaks eight cmd.exe per run is one nobody runs twice.
try {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*${SHIM.replace(/\\/g, '\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
  { stdio: 'ignore' });
} catch { /* best effort */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* %TEMP% */ }

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed${FAST ? '  (--fast: §9/§10 skipped)' : ''}`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
