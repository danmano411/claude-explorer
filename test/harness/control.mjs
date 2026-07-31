// KAN-39: the main -> renderer control channel and its four ops, against the
// real app.
//   npm run build && node test/harness/control.mjs
//
// HOW THIS REACHES THE CHANNEL. The four ops are driven from the MAIN process,
// the way filemenu.mjs drives native menus — because that is the only caller
// the channel is meant to have (KAN-40's MCP server is the first real one). The
// helper is `control(op)` from src/main/control.handlers.ts.
//
// It cannot be required out of the shipped bundle: electron-vite rolls the
// whole main tree into one CJS file with no exports, and `control()` has no
// caller yet, so rollup tree-shakes the function away entirely (grep out/main/
// index.js — `registerControlHandlers` is there, `control` is not). So this
// harness esbuilds src/main/control.handlers.ts into a throwaway CJS shim
// (electron external, esbuild is already a devDependency) and requires THAT
// inside electronApp.evaluate. Same source, same src/shared/ipc.ts channel
// constants, same createControlChannel — a second module instance of it, whose
// own `ipcMain.on('control:reply')` listener sits alongside the app's. Replies
// reach both; the app's own channel drops ids it never issued, which is its
// documented behaviour. `require` is NOT in lexical scope inside a Playwright
// main-process evaluate, so the shim is loaded via `process.mainModule.require`.
//
// WHAT IS ACTUALLY BEING PROVED. Requests arrive back-to-back with no React
// commit between them, and the renderer answers them one per commit. Two checks
// hang on that and are dispatched from a SINGLE evaluate so both control()
// calls send in the same tick, with no sleep anywhere between them:
//
//   - section 7: a tab opened by op N is in op N+1's listTabs.
//   - section 8: five closeTab ops against 8 tabs leave exactly 3.
//
// A sleep between the ops would make both of them pass against a renderer that
// answers from its enclosing closure, i.e. would make them worthless. Sleeps
// elsewhere in this file (pty status, DOM paints) are on assertions that are
// inherently about time passing, and are marked where they are.
//
// MUTATION LEDGER — every one of these was run against the built app and then
// reverted, because "it passes" is not evidence that it could ever fail:
//
//   A. drain the whole queue in one effect pass (delete the `controlBusy` gate
//      and the settle-then-re-arm) → section 7 goes 4 red. Section 8 stays
//      GREEN: `closeTab`/`openViewerTab` write through functional setTabs
//      (KAN-37), so the counts still compose even with no serialization.
//   B. revert KAN-37 inside closeTab (`closeTabList(tabs, id)` instead of
//      `(ts, id)`) → everything stays green on its own; the per-commit drain
//      defends the counts by itself. A + B together → section 8 goes 5 red,
//      12 tabs left instead of 3.
//   C. drop `controlBusy.current = false` from the drain's `.finally` — a queue
//      that never re-arms → 25 of 32 red, including EXACTLY THREE TABS ARE
//      LEFT: op 2 onward never runs and main times them out.
//
// So the section 8 count is belt AND braces, and only (C) — or (A + B) — reds
// it. That is worth knowing before anyone deletes one of the two mechanisms
// because "the harness still passes".
//
//   A'. section 9 is the probe that (A) ALONE reds — two closeTab ops naming
//       the same tab id in one tick. Serialized, op 2 is answered against
//       post-close state and must be refused; batched, both answer from the
//       same closure and both say ok. No functional updater can paper over
//       that, because the disagreement is in the REPLY, not in the tab list.
//   D. delete the `deadline` line from runControl (App.tsx) → section 10 red:
//      an already-expired request runs anyway and answers ok.
//   E. narrow the restore gate back to `req.op !== 'listTabs' && !restoreDone`
//      (App.tsx) → section 11 red: listTabs answers [] mid-restore, which is
//      the same bytes as "no tabs open" and so unrecoverable by a caller.
//   F. delete the `const refused = resolved.filter((t) => t.pinned)` filter from
//      requestClose (App.tsx) → section 9b red: the channel closes a pinned tab
//      and answers ok. (KAN-57 shipped this guard with NOTHING in the repo
//      covering it from the control side: nowhere else does `pinned` and the
//      channel meet, so the whole suite stayed green with the filter gone.)
//   G. flip the control arm's `requestClose([tabId], 'now')` to `'ask'`
//      (App.tsx) → section 8 reds FIRST, 3 of them: its opening burst closes a
//      live terminal, and with 'ask' that raises a modal nobody answers, so the
//      op times out and the tab stays. The backdrop then swallows every later
//      click and 9b is not reached at all. So `'now'` was already defended, by
//      section 8 and by accident; what 9b adds is the PINNED half of the arm
//      (F), which nothing else in the repo touched.
//
// NOTE on F: `closeNow` re-checks `pinned` too, so deleting only requestClose's
// filter reds 9b's REFUSAL-SHAPE check (the op answers ok) while the tab itself
// survives — measured. Deleting both filters reds all three of 9b's checks. The
// second filter is redundant defence, not dead defence, and this is the section
// that says so.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { launchApp } from './app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// An explicit throwaway profile, pid-suffixed. workspace.json is read back in
// section 2 as the disk snapshot listTabs must NOT be sourced from, so this
// must not be the developer's real profile; and the single-instance lock is
// keyed on userData, so a fixed name would make two concurrent runs (this repo
// is worked on from several worktrees at once) silently forward into each
// other's window.
const PROFILE = path.join(os.tmpdir(), `claude-explorer-control-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

// Scratch files for the viewer ops. Outside any repo on purpose — the diff
// refusal in section 4 is the real `gitDiff` "Not a Git repository" answer, not
// a mocked one.
const WORK = path.join(os.tmpdir(), `ce-control-work-${process.pid}`);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const scratch = (name, body = `${name}\n`) => {
  const p = path.join(WORK, name);
  fs.writeFileSync(p, body);
  return p;
};

// A real git repo with a real working-tree change, built here rather than
// borrowing the checkout: whether ROOT happens to be dirty is not this
// harness's business, and nothing about the checkout's name or location may be
// assumed (it routinely runs from a worktree).
const REPO = path.join(os.tmpdir(), `ce-control-repo-${process.pid}`);
fs.rmSync(REPO, { recursive: true, force: true });
fs.mkdirSync(REPO, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: REPO, stdio: 'pipe', encoding: 'utf8' });
git('init', '-q');
const TRACKED = path.join(REPO, 'tracked.txt');
fs.writeFileSync(TRACKED, 'one\ntwo\nthree\n');
git('add', 'tracked.txt');
git('-c', 'user.email=harness@example.com', '-c', 'user.name=harness', 'commit', '-qm', 'base');
fs.writeFileSync(TRACKED, 'one\nTWO CHANGED\nthree\nfour\n'); // 1 removed, 2 added

// Claude gets exactly ONE real spawn in this run (section 6), in its own folder
// so it never lands in the real project's session list.
const CLAUDE_DIR = path.join(os.tmpdir(), `ce-control-claude-${process.pid}`);
fs.rmSync(CLAUDE_DIR, { recursive: true, force: true });
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

const SHIM = path.join(os.tmpdir(), `ce-control-shim-${process.pid}.cjs`);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// --- preconditions the assertions below silently depend on ------------------
let inRepo = true;
try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: WORK, stdio: 'pipe' }); }
catch { inRepo = false; }
if (inRepo) {
  console.log('ABORT: the scratch folder is inside a git repo, so section 4 cannot see a refusal');
  process.exit(1);
}

// --- the shim ---------------------------------------------------------------
await build({
  entryPoints: [path.join(ROOT, 'src/main/control.handlers.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  external: ['electron'], outfile: SHIM, logLevel: 'silent',
});

const { app, win, close } = await launchApp({ userDataDir: PROFILE });

const wired = await app.evaluate(({ BrowserWindow }, shim) => {
  // Playwright evaluates this in the main process's global scope, where the
  // module-scoped `require` of the entry file is not visible.
  const req = typeof require === 'function'
    ? require : process.mainModule.require.bind(process.mainModule);
  const m = req(shim);
  m.registerControlHandlers(() => BrowserWindow.getAllWindows()[0] ?? null);
  globalThis.__ceControl = m.control;
  return Object.keys(m).sort().join(',');
}, SHIM);

/** One op. Never throws: a rejection comes back as { ok:false, code, error } so
 *  a typed refusal is data here, exactly as it is for KAN-40. */
const call = (op) => app.evaluate(async (_e, o) => {
  try { return { ok: true, result: await globalThis.__ceControl(o) }; }
  catch (e) { return { ok: false, code: e?.code ?? null, error: String(e?.message ?? e) }; }
}, op);

/**
 * Several ops dispatched in ONE main-process tick — no await, no sleep and no
 * IPC round trip between the sends, which is the whole point. Returns their
 * settled replies in issue order.
 */
const burst = (ops) => app.evaluate(async (_e, list) => {
  const settle = (o) => globalThis.__ceControl(o).then(
    (result) => ({ ok: true, result }),
    (e) => ({ ok: false, code: e?.code ?? null, error: String(e?.message ?? e) }),
  );
  const started = list.map(settle); // every send happens before the first await
  return Promise.all(started);
}, ops);

const tabs = async () => (await call({ op: 'listTabs' })).result ?? [];
const titles = (rows) => rows.map((r) => r.title).join(' | ');
const has = (rows, title) => rows.some((r) => r.title === title);
/** Poll listTabs until `pred` holds. Only ever used for the pty-status checks,
 *  which are assertions ABOUT elapsed time; returns the last rows either way so
 *  a timeout reports as a FAIL with real data instead of throwing. */
const until = async (pred, ms = 15_000) => {
  const t0 = Date.now();
  for (;;) {
    const rows = await tabs();
    if (pred(rows) || Date.now() - t0 > ms) return rows;
    await win.waitForTimeout(200);
  }
};

const FIELDS = ['id', 'ptyId', 'view', 'cwd', 'title', 'terminalKind', 'status'];

/** Pick a row on the tab strip's context menu (section 9b pins from the UI —
 *  `pinned` is renderer state with no control op behind it). */
const tabMenu = async (i, itemText) => {
  // Soft on both clicks: a regression that leaves a modal backdrop up makes the
  // right-click unhittable, and an escaping Playwright rejection would report a
  // stack trace instead of the FAILs naming what broke (the filemenu.mjs /
  // confirm.mjs policy). The outcome checks below still catch a click that
  // silently did not land.
  await win.locator('.tab:not(.add)').nth(i)
    .click({ timeout: 3000, button: 'right' }).catch(() => {});
  await win.waitForTimeout(250);
  await win.locator('.ctx-item', { hasText: itemText }).first().click({ timeout: 3000 }).catch(() => {});
  await win.waitForTimeout(400);
  if (await win.locator('.ctx-backdrop').count()) {
    await win.mouse.click(4, 4);
    await win.waitForTimeout(200);
  }
};

/** Wait for the visible viewer pane to stop saying "Reading changes…". Both
 *  DiffView states — hunks and a refusal — are reached through that placeholder,
 *  and it is itself a `.viewer-note`, so waiting on the selector alone reads the
 *  loading text and calls it the answer. */
const settled = (w) => w.waitForFunction(() => {
  const p = document.querySelector('.pane:not([hidden])');
  if (!p) return false;
  if (p.querySelector('.diff-head')) return true;
  const note = p.querySelector('.viewer-note')?.textContent ?? '';
  return note !== '' && !/^Reading/.test(note.trim());
}, null, { timeout: 15_000 }).catch(() => {});

// === 1. the channel answers, and a row is the shape the contract froze =======
console.log('\n1 — listTabs against a fresh profile');
{
  check('the shim exposes the real main-side helper', wired === 'control,registerControlHandlers', wired);

  const r = await call({ op: 'listTabs' });
  const rows = r.result ?? [];
  check('listTabs resolved with the live tab list', r.ok && rows.length === 1,
    r.ok ? `${rows.length} rows: ${titles(rows)}` : `${r.code}: ${r.error}`);

  const row = rows[0] ?? {};
  check('the row carries id / view / cwd / title for the home files tab',
    typeof row.id === 'string' && row.id.length > 0 && row.view === 'files'
      && typeof row.cwd === 'string' && row.cwd.includes(path.sep)
      && row.title === path.basename(row.cwd ?? ''),
    JSON.stringify(row));

  // A files tab owns no process, so both process fields are absent — and no
  // field outside the frozen set may appear at all. `groupId` is the one this
  // is really watching: M5 owns that model and a ControlTab does not speak it.
  const extra = Object.keys(row).filter((k) => !FIELDS.includes(k));
  check('and nothing else — no ptyId, no status, and no group field',
    row.ptyId === undefined && row.status === undefined && extra.length === 0,
    extra.length ? `leaked: ${extra.join(', ')}` : 'field set is exactly the contract');
}

// === 2. listTabs reports LIVE pty status, not a disk snapshot ================
console.log('\n2 — live pty status through the channel');
let shellPtyId = null;
{
  // A plain shell, not Claude: the claim is about the status stream, which is
  // the same machinery either way, and this costs no CLI startup.
  await win.locator('.tab:not(.add)').nth(0).click({ button: 'right' });
  await win.waitForTimeout(250);
  await win.locator('.ctx-item', { hasText: 'Open Terminal' }).first().click();
  await win.waitForTimeout(800); // the spawn, not an assertion

  let rows = await tabs();
  const term = rows.find((t) => t.view === 'terminal');
  shellPtyId = term?.ptyId ?? null;
  check('a terminal tab is reported with its ptyId and terminalKind',
    !!term && typeof term.ptyId === 'string' && term.terminalKind === 'shell',
    JSON.stringify(term));

  // ptyId is the injected correlation key KAN-40 joins on — it must be the id
  // main handed out, not a renderer invention.
  const known = await win.evaluate(() => document.querySelectorAll('.xterm').length);
  check('the reported ptyId belongs to a mounted terminal', known === 1 && !!shellPtyId,
    `${known} xterm elements, ptyId ${shellPtyId}`);

  rows = await until((rs) => rs.some((t) => t.ptyId === shellPtyId && t.status));
  const live = rows.find((t) => t.ptyId === shellPtyId)?.status;
  check('its status is a LIVE pty state', live === 'running' || live === 'waiting', String(live));

  // The transition is the load-bearing half: nothing on disk changes when a pty
  // dies, so a snapshot-backed listTabs cannot follow this.
  await win.evaluate((id) => window.api.ptyKill(id), shellPtyId);
  rows = await until((rs) => rs.some((t) => t.ptyId === shellPtyId && t.status === 'stopped'));
  const after = rows.find((t) => t.ptyId === shellPtyId)?.status;
  check('killing the pty moves that same tab to stopped', after === 'stopped',
    `${live} -> ${after}`);

  // And the negative side of the same claim, so "live" is not just a word: the
  // persisted workspace holds this very tab and has no status field at all.
  await win.waitForTimeout(700); // the workspace save is debounced 400ms
  let ws = '';
  try { ws = fs.readFileSync(path.join(PROFILE, 'workspace.json'), 'utf8'); } catch { /* absent */ }
  const parsed = ws ? JSON.parse(ws) : null;
  const persisted = JSON.stringify(parsed ?? {});
  const termId = rows.find((t) => t.ptyId === shellPtyId)?.id;
  check('workspace.json holds that tab yet carries no status — so this cannot be the source',
    !!termId && persisted.includes(termId) && !persisted.includes('"status"'),
    `${persisted.length} bytes, tab present: ${persisted.includes(termId)}`);
}

// === 3. openViewerTab opens a real diff =====================================
console.log('\n3 — openViewerTab in diff mode');
{
  const r = await call({ op: 'openViewerTab', args: { filePath: TRACKED, mode: 'diff' } });
  check('the op resolved', r.ok, r.ok ? '' : `${r.code}: ${r.error}`);
  await settled(win);

  const view = await win.evaluate(() => {
    const p = document.querySelector('.pane:not([hidden])');
    return {
      head: !!p?.querySelector('.diff-head'),
      add: p?.querySelector('.diff-stat.add')?.textContent ?? '',
      del: p?.querySelector('.diff-stat.del')?.textContent ?? '',
      rows: p?.querySelectorAll('.drow.add, .drow.del').length ?? 0,
      note: p?.querySelector('.viewer-note')?.textContent ?? '',
    };
  });
  // Two added lines and one removed, from the commit above — a DiffView that
  // rendered an empty or refused pane cannot produce these numbers.
  check('the visible pane is a diff of that file with its real hunks',
    view.head && view.rows > 0 && view.add === '+2' && view.del === '−1',
    JSON.stringify(view));

  const row = (await tabs()).find((t) => t.title === 'tracked.txt');
  check('and it is reported as a viewer tab on the file\'s folder',
    row?.view === 'viewer' && row?.cwd === REPO, JSON.stringify(row));
}

// === 4. ...and surfaces the existing typed refusal instead of crashing ======
console.log('\n4 — openViewerTab in diff mode outside any repo');
{
  const loose = scratch('loose.txt', 'not in a repo\n');
  const before = (await tabs()).length;
  const r = await call({ op: 'openViewerTab', args: { filePath: loose, mode: 'diff' } });
  check('the op still resolved — a refusal is not an op failure', r.ok,
    r.ok ? '' : `${r.code}: ${r.error}`);
  await settled(win);

  // The sentence is git's own, forwarded by gitDiff's classify(): outside a
  // repo `git diff HEAD -- f` answers "error: Could not access 'HEAD'" and only
  // the plumbing commands say "not a git repository", so both are accepted —
  // WHICH refusal git emits is a git detail, that one is shown instead of a
  // crash, a spinner or a fake diff is ours. The head/rows half is what stops
  // this passing on a blank pane.
  const pane = await win.evaluate(() => {
    const p = document.querySelector('.pane:not([hidden])');
    return {
      note: p?.querySelector('.viewer-note')?.textContent?.trim() ?? '',
      head: !!p?.querySelector('.diff-head'),
      rows: p?.querySelectorAll('.drow').length ?? 0,
    };
  });
  check('the pane shows gitDiff\'s own typed refusal — not a blank, a spinner or a fake diff',
    /could not access 'HEAD'|not a git repository/i.test(pane.note)
      && !pane.head && pane.rows === 0,
    JSON.stringify(pane));

  const rows = await tabs();
  check('and the tab is a real tab, not an empty one that never arrived',
    rows.length === before + 1 && has(rows, 'loose.txt'), titles(rows));
}

// === 5. an unknown tab id is data, not a throw ==============================
console.log('\n5 — closeTab with an id nothing owns');
{
  const before = await tabs();
  const r = await call({ op: 'closeTab', args: { tabId: 'no-such-tab-0000' } });
  check('it rejects with the renderer\'s own typed error',
    !r.ok && r.code === 'renderer' && r.error === 'control: unknown tab no-such-tab-0000',
    `${r.code}: ${r.error}`);

  const after = await tabs();
  check('nothing was closed', after.length === before.length, `${before.length} -> ${after.length}`);
  const alive = await win.locator('.app').count();
  check('the channel and the window both survived it',
    after.length > 0 && alive === 1, `${after.length} rows, ${alive} .app`);
}

// === 6. openClaudeSession really spawns =====================================
console.log('\n6 — openClaudeSession (the one real Claude spawn in this run)');
{
  const xtermsBefore = await win.evaluate(() => document.querySelectorAll('.xterm').length);
  const r = await call({ op: 'openClaudeSession', args: { cwd: CLAUDE_DIR } });
  check('the op resolved', r.ok, r.ok ? '' : `${r.code}: ${r.error}`);

  const rows = await tabs();
  const claude = rows.find((t) => t.terminalKind === 'claude');
  check('a Claude terminal tab exists, on that folder, with a pty',
    claude?.view === 'terminal' && claude?.cwd === CLAUDE_DIR && typeof claude?.ptyId === 'string',
    JSON.stringify(claude));

  // The ELEMENT, not its text: ConPTY repaints the whole buffer on resize, so
  // reading characters proves nothing about which xterm is on screen.
  await win.waitForTimeout(1_000);
  const xtermsAfter = await win.evaluate(() => document.querySelectorAll('.xterm').length);
  check('and one more xterm is mounted for it',
    xtermsAfter === xtermsBefore + 1, `${xtermsBefore} -> ${xtermsAfter}`);
}

// === 7. op N's tab is visible to op N+1, with NO sleep between them ==========
console.log('\n7 — same-tick visibility (acceptance criterion)');
{
  const fA = scratch('same-tick-a.txt');
  const [openA, listA] = await burst([
    { op: 'openViewerTab', args: { filePath: fA } },
    { op: 'listTabs' },
  ]);
  check('both ops of the pair resolved', openA.ok && listA.ok,
    `${JSON.stringify(openA.ok)} / ${JSON.stringify(listA.ok)}`);
  check('the tab op N opened is IN op N+1\'s listTabs',
    has(listA.result ?? [], 'same-tick-a.txt'), titles(listA.result ?? []));

  // Four in one tick, so the answers have to interleave with the writes rather
  // than merely arrive after all of them: list 1 must see B and NOT C.
  const fB = scratch('same-tick-b.txt');
  const fC = scratch('same-tick-c.txt');
  const [, l1, , l2] = await burst([
    { op: 'openViewerTab', args: { filePath: fB } },
    { op: 'listTabs' },
    { op: 'openViewerTab', args: { filePath: fC } },
    { op: 'listTabs' },
  ]);
  const r1 = l1.result ?? [];
  const r2 = l2.result ?? [];
  check('the first listTabs sees the first open and not the second',
    has(r1, 'same-tick-b.txt') && !has(r1, 'same-tick-c.txt'), titles(r1));
  check('the second sees both', has(r2, 'same-tick-b.txt') && has(r2, 'same-tick-c.txt'), titles(r2));
  check('and each open appended exactly one tab', r2.length === r1.length + 1,
    `${r1.length} -> ${r2.length}`);
}

// === 8. five back-to-back closeTab ops against 8 tabs =======================
console.log('\n8 — five closes against eight tabs (acceptance criterion)');
{
  // Down to one tab first, so "eight" is built here and does not depend on
  // anything above. The mass close is itself dispatched in one tick.
  const start = await tabs();
  await burst(start.slice(1).map((t) => ({ op: 'closeTab', args: { tabId: t.id } })));
  const one = await tabs();
  check('a burst of closes left exactly one tab', one.length === 1,
    `${start.length} -> ${one.length}: ${titles(one)}`);

  const files = Array.from({ length: 7 }, (_, i) => scratch(`bulk-${i}.txt`));
  await burst(files.map((f) => ({ op: 'openViewerTab', args: { filePath: f } })));
  const eight = await tabs();
  check('seven opens in one tick brought it to eight', eight.length === 8, titles(eight));

  const doomed = eight.slice(3);           // five, including the active one
  const keep = eight.slice(0, 3).map((t) => t.id);
  const replies = await burst(doomed.map((t) => ({ op: 'closeTab', args: { tabId: t.id } })));
  // The counts are part of the assertion, not decoration: a run where the
  // channel stalled reaches here with an empty burst, and `[].every(ok)` is
  // true — this check has to be incapable of passing on nothing.
  check('all five closes were accepted',
    replies.length === 5 && replies.every((x) => x.ok),
    `${replies.length} replies: ${replies.map((x) => (x.ok ? 'ok' : x.error)).join('; ')}`);

  const left = await tabs();
  check('EXACTLY THREE TABS ARE LEFT', left.length === 3, `${left.length}: ${titles(left)}`);
  check('and they are the three that were not named',
    keep.length === 3 && left.length === 3 && left.map((t) => t.id).join(',') === keep.join(','),
    titles(left));

  // The strip agrees with the answer — closing through the channel is the same
  // close a user performs, not a bookkeeping-only edit.
  const strip = await win.locator('.tab:not(.add)').count();
  check('the visible tab strip agrees', strip === 3, `${strip} tabs on screen`);
}

// === 9. the SAME tab closed twice in one tick ===============================
console.log('\n9 — two closeTab ops naming one tab, in one tick');
{
  // WHY THIS EXISTS NEXT TO SECTION 8, AND WHY IT IS NOT REDUNDANT. Section 8's
  // "five closes leave three" cannot fail on the staleness it is aimed at:
  // closeTab writes through a functional setTabs (KAN-37), so five closes of
  // five distinct ids compose to three whether the ops were serialized or all
  // answered from one stale closure. The counts are identical either way.
  //
  // Naming the SAME id twice moves the disagreement into the REPLY, where no
  // functional updater reaches: serialized, op 2 runs against a commit that no
  // longer holds the tab and must be REFUSED; batched, op 2 reads the same
  // pre-close closure as op 1 and cheerfully answers ok. Deleting this check
  // because section 8 looks like it covers the same ground puts the drain's
  // serialization back on nothing.
  const f = scratch('twice.txt');
  await call({ op: 'openViewerTab', args: { filePath: f } });
  const doomed = (await tabs()).find((t) => t.title === 'twice.txt');
  check('the tab to close twice exists', !!doomed, JSON.stringify(doomed ?? null));

  const [first, second] = await burst([
    { op: 'closeTab', args: { tabId: doomed?.id ?? 'no-such-tab' } },
    { op: 'closeTab', args: { tabId: doomed?.id ?? 'no-such-tab' } },
  ]);
  check('the first close was accepted', first?.ok === true, JSON.stringify(first));
  check('the second, answered against post-close state, was REFUSED',
    second?.ok === false && second?.code === 'renderer'
      && second?.error === `control: unknown tab ${doomed?.id}`,
    JSON.stringify(second));
  check('and the tab really is gone', !has(await tabs(), 'twice.txt'), titles(await tabs()));
}

// === 9b. a PINNED tab refuses closeTab ======================================
// KAN-57 put a pinned filter in `requestClose` and routed the control arm
// through it in `'now'` mode. Nothing in the repo covered either from this side
// — `grep -i pinned control.mjs` returned nothing — so both could be deleted
// with every test still green (mutations F and G in the ledger above). This is
// the only place `pinned` and the channel meet.
console.log('\n9b — a pinned tab refuses the close op');
{
  const before = await tabs();
  const title = await win.evaluate(() =>
    document.querySelector('.tab:not(.add) .tab-title')?.textContent?.trim() ?? '');
  const target = before.find((t) => t.title === title);
  check('PRE-STATE: the strip\'s first tab resolves to a control row',
    !!target && before.length > 1, `"${title}" -> ${JSON.stringify(target ?? null)}`);

  await tabMenu(0, 'Pin tab');
  check('PRE-STATE: it is pinned', (await win.locator('.tab.pinned').count()) === 1,
    `${await win.locator('.tab.pinned').count()} pinned`);

  const refused = await call({ op: 'closeTab', args: { tabId: target?.id ?? 'no-such-tab' } });
  // TYPED, not swallowed and not a crash: the drain turns the throw into the
  // channel's `{ ok:false, error }` shape, the same one the unknown-tab refusal
  // in section 5 uses — so a caller can tell "refused" from "worked".
  check('closeTab REFUSES a pinned tab, in the typed refusal shape',
    refused.ok === false && refused.code === 'renderer'
      && refused.error === `control: tab ${target?.id} is pinned`, JSON.stringify(refused));
  const survived = await tabs();
  check('…and the tab is still open — a refusal, not a close that also errored',
    survived.length === before.length && has(survived, title), titles(survived));

  // POSITIVE CONTROL. Without it, both checks above are satisfied by a closeTab
  // op that is broken for every tab.
  await tabMenu(0, 'Unpin tab');
  const accepted = await call({ op: 'closeTab', args: { tabId: target?.id ?? 'no-such-tab' } });
  const after = await tabs();
  check('POSITIVE CONTROL: unpinned, the very same op answers ok and the tab closes',
    accepted.ok === true && after.length === before.length - 1 && !has(after, title),
    `${JSON.stringify(accepted)} — ${titles(after)}`);
}

// === 10. a request main has already given up on is not run ==================
console.log('\n10 — an expired request');
{
  // Sent RAW, not through control(): main stamps `deadline` itself and would
  // never mint one in the past, so the only way to reach the renderer's expiry
  // gate is to bypass the helper. The two channel names are the frozen CH
  // constants (src/shared/ipc.ts); the shim exports only control/register.
  //
  // listTabs on purpose: if the gate is missing the op RUNS, and this is the
  // one op whose running leaves the window exactly as it found it — the reply
  // (ok with rows, instead of a refusal) is what discriminates, not a side
  // effect. A mutating op would prove the same thing by damaging the run.
  const reply = await app.evaluate(({ BrowserWindow, ipcMain }, id) => new Promise((resolve) => {
    const on = (_e, r) => {
      if (!r || r.id !== id) return; // the app's own channel replies to its own ids
      ipcMain.off('control:reply', on);
      clearTimeout(t);
      resolve(r);
    };
    const t = setTimeout(() => { ipcMain.off('control:reply', on); resolve(null); }, 10_000);
    ipcMain.on('control:reply', on);
    BrowserWindow.getAllWindows()[0].webContents.send('control:request', {
      op: 'listTabs', id, deadline: Date.now() - 1,
    });
  }), 'harness-expired-deadline');

  check('the renderer answered it at all', !!reply, JSON.stringify(reply));
  check('and REFUSED it rather than running work nobody is waiting for',
    reply?.ok === false && /expired/.test(reply?.error ?? ''), JSON.stringify(reply));

  const alive = await tabs();
  check('the channel still works afterwards', alive.length > 0, `${alive.length} rows`);
}

// === 11. listTabs before restore has committed ==============================
// LAST on purpose: it reloads the window.
console.log('\n11 — listTabs during restore');
{
  const WS = path.join(PROFILE, 'workspace.json');
  await win.waitForTimeout(700); // the workspace save is debounced 400ms

  // Hold restore open by answering workspace:get slowly with the SAME bytes the
  // real handler would return — the file on disk is sanitize()'s own output
  // (setWorkspace writes sanitize(w)) and sanitize is idempotent, so this is the
  // real answer, late. Nothing else about the app is stubbed.
  const stubbed = await app.evaluate(({ ipcMain }, ws) => {
    const req = typeof require === 'function'
      ? require : process.mainModule.require.bind(process.mainModule);
    const nfs = req('node:fs');
    if (!nfs.existsSync(ws)) return false;
    ipcMain.removeHandler('workspace:get');
    ipcMain.handle('workspace:get', async () => {
      await new Promise((r) => setTimeout(r, 4_000));
      return JSON.parse(nfs.readFileSync(ws, 'utf8'));
    });
    return true;
  }, WS);
  check('a real workspace is on disk for the delayed handler to serve', stubbed, WS);

  await win.reload();
  await win.waitForSelector('.app', { timeout: 15_000 }); // committed, so the queue exists
  // Well inside the 4s hold: `restoreDone` cannot have flipped yet.
  const r = await call({ op: 'listTabs' });
  // [] and "no tabs open" are the same bytes on the wire, so a caller 200ms
  // after launch that got [] would be told the window is empty while four tabs
  // are about to appear — with nothing in the reply to make it ask again. A
  // typed error is distinguishable, and main's 15s budget leaves room to retry.
  check('it says NOT READY instead of answering an empty list',
    r.ok === false && r.code === 'renderer' && /not ready/.test(r.error ?? ''),
    JSON.stringify(r));

  // …and once restore lands, the same op answers with the restored tabs — so
  // the gate is a delay, not a permanent refusal.
  const back = await until((rs) => rs.length > 0, 12_000);
  check('and answers normally once restore commits', back.length > 0, titles(back));
}

await close();
fs.rmSync(SHIM, { force: true });
fs.rmSync(WORK, { recursive: true, force: true });
fs.rmSync(REPO, { recursive: true, force: true });
fs.rmSync(CLAUDE_DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
