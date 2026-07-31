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
const promptPath = () => win.evaluate(() => {
  const el = document.querySelector('.spawn-modal .spawn-path');
  return el ? el.textContent : null;
});
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

// === 7. the cap =============================================================
console.log('\n7 — eight, and then no more');
const CAP_TABS = [];
{
  // One session already exists from §5, so seven more reach the cap.
  let started = 1;
  for (let i = 1; i < 8; i++) {
    const r = await confirmSpawn(CAP_DIRS[i]);
    if (!r.started.isError && json(r.started)?.started === true) started++;
    else console.log(`    (session ${i} failed: ${r.started.text.slice(0, 120)})`);
  }
  check('eight concurrent app-spawned sessions are allowed', started === 8, `${started} started`);

  const ninth = await tool('open_claude_session', { path: FANOUT[0] });
  check('the ninth is refused with the typed cap error',
    ninth.isError && /at most 8 Claude sessions started by this tool/i.test(ninth.text), ninth.text);
  // The cap is checked at MINT, so the user is never asked to approve something
  // that cannot land.
  check('and the user was never prompted for it', (await promptPath()) === null,
    String(await promptPath()));

  // The harvest tab has been a live Claude session for this whole section. If
  // user-launched sessions counted, the eighth would have been refused.
  const live = (await tabs()).filter((t) => t.terminalKind === 'claude');
  CAP_TABS.push(...live.filter((t) => t.cwd !== HARVEST));
  check('a session the USER started does not consume the cap',
    live.some((t) => t.cwd === HARVEST) && CAP_TABS.length === 8,
    `${CAP_TABS.length} app-spawned + ${live.length - CAP_TABS.length} user`);
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

  // The cap is derived from the live pty map, not a counter — so closing frees
  // it. A monotonic counter would refuse this forever after the eighth session.
  const again = await tool('open_claude_session', { path: FANOUT[0] });
  check('with three left, the cap lets a new session be asked for again',
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
