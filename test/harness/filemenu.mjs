// KAN-55: Open Recent lives in the NATIVE application menu now, not a renderer
// dropdown.
//   npm run build && node test/harness/filemenu.mjs
//
// Native menu items are not in the DOM, so this drives them from the MAIN
// process — read the installed template back with electronApp.evaluate, then
// fire a row by its stable id:
//
//   Menu.getApplicationMenu().getMenuItemById('recent:0:session:7').click()
//
// (getMenuItemById searches nested submenus, so the ids are flat strings even
// though the tree is three deep.) Everything the click CAUSES is still
// observable in the DOM, and that is where the load-bearing assertions are.
//
// Two claims cost a real Claude spawn each, and both are proved two-sided
// because "a terminal tab appeared" proves neither — the first version of
// test/harness/resume.mjs asserted exactly that and reported PASS while resume
// was completely broken:
//
//   1. clicking a SESSION row must RESUME THAT SESSION (section 8):
//      we click a row that is NOT the newest and require its marker to come
//      back on screen while the newest session's marker does not.
//   2. clicking + NEW SESSION must start a FRESH conversation (section 9):
//      a transcript id appears on disk that was not there before the click,
//      and the pane never shows any pre-existing session's marker.
//
// IDENTIFYING A ROW IS THE HARD PART, and it is why this file computes an
// ordering oracle from disk. The old harness read a marker straight out of the
// row's text; the native label is ellipsized at 48 chars and every transcript
// resume.mjs writes begins "Reply with exactly this and nothing else: RESUM…",
// so the labels are now IDENTICAL and carry no identity at all. What a row
// still means to a user is its POSITION: "the j-th most recently active session
// in this folder". That is a property of the transcripts, not of our code, so
// the oracle below re-derives it from the jsonl timestamps and clicks that
// rank. If the menu ordered rows any other way, the wrong conversation comes
// back and section 8 fails.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const CLAUDE_DIR = path.join(os.homedir(), 'claudetest');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

// A folder Claude has never run in, so listSessions returns [] — the disabled
// "No sessions" row is a real state, not a mocked one.
const EMPTY_DIR = path.join(os.tmpdir(), `ce-filemenu-empty-${process.pid}`);
fs.rmSync(EMPTY_DIR, { recursive: true, force: true });
fs.mkdirSync(EMPTY_DIR, { recursive: true });

// An explicit throwaway profile. Recents ARE the Open Recent menu, and they are
// persisted under userData — starting from the real profile would mean this
// file asserts on whatever folders the developer happened to open last, and the
// "no recent folders" empty state (section 2) could never be reached at all.
// Pid-suffixed because the single-instance lock is keyed on userData: two
// concurrent runs from two worktrees would otherwise silently forward into each
// other's window.
const PROFILE = path.join(os.tmpdir(), `claude-explorer-filemenu-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });

const CAP = 20; // what src/main/menu.ts buildMenu() passes listSessions (whose
                // own default is uncapped — sessions:list is the resume oracle).
const MARKER_RE = /RESUME-OK-\d{6}|PROBE-OK-\d{6}/;

const slugFor = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const projectDir = (p) => path.join(os.homedir(), '.claude', 'projects', slugFor(p));
/** Windows menu labels double a literal `&`; main/menu.ts's amp() does this. */
const amp = (s) => s.replace(/&/g, '&&');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const VIS = '.pane:not([hidden]) ';
const tabCount = (win) => win.locator('.tab:not(.add)').count();
/** Visible terminal text, '' when the visible pane is not a terminal at all — so
 *  a spawn that never happened reports the FAILs below instead of throwing out
 *  of the run and swallowing every assertion after it. */
const paneText = (win) => win.$eval(VIS + '.xterm-rows', (el) => el.textContent).catch(() => '');

// --- the ordering oracle ---------------------------------------------------
// Independent of src/main/sessions.ts: "when was this conversation last active"
// is the newest timestamp in its transcript, and "which twenty" is the newest
// twenty. Deriving it here rather than asking the app is the whole point — an
// oracle that called listSessions() would agree with any ordering bug.
const dir = projectDir(CLAUDE_DIR);
const jsonls = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
if (jsonls.length < 2) {
  console.log(`  SKIP  need ≥2 Claude transcripts in ${dir} (run test/harness/resume.mjs first)`);
  process.exit(0);
}

const meta = jsonls.map((f) => {
  const full = path.join(dir, f);
  const text = fs.readFileSync(full, 'utf8');
  let updated = 0;
  let title = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (!Number.isNaN(ts)) updated = Math.max(updated, ts);
    if (!title && o.type === 'user' && o.message?.role === 'user') {
      const c = o.message?.content;
      const t = (typeof c === 'string' ? c
        : Array.isArray(c) ? (c.find((b) => b?.type === 'text')?.text ?? '') : '').trim();
      if (t && !t.startsWith('<')) title = t.slice(0, 80);
    }
  }
  const mtimeMs = fs.statSync(full).mtimeMs;
  return { id: f.replace(/\.jsonl$/, ''), file: f, text, mtimeMs, updated: updated || mtimeMs,
    marker: (title.match(MARKER_RE) ?? [])[0] ?? null };
});

const ranked = meta
  .slice().sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, CAP)   // which twenty
  .sort((a, b) => b.updated - a.updated)                          // in what order
  .map((m, rank) => ({ ...m, rank }));

const marked = ranked.filter((m) => m.marker);
const decoy = marked[0];
// Never the newest row, and never near the cap boundary either: mtime and the
// in-file timestamp agree except when something touches a jsonl without
// appending, and a target at rank 15+ could sit either side of the twenty-row
// slice for that reason. Deep enough to disprove "it just resumes the newest",
// shallow enough that neither ordering is in question.
const target = !decoy ? undefined
  : [...marked].reverse().find((m) => m.rank <= 14 && m.rank > decoy.rank && m.marker !== decoy.marker);
if (!decoy || !target) {
  console.log(`  SKIP  need ≥2 distinctly-marked transcripts inside the top ${CAP} of ${dir}`);
  process.exit(0);
}

console.log('\nFile ▸ Open Recent — the NATIVE application menu (KAN-55)');
const { app, win, close } = await launchApp({ userDataDir: PROFILE });

/** The whole installed application menu, as plain data. */
const menuTree = () => app.evaluate(({ Menu }) => {
  const walk = (items) => items.map((it) => ({
    id: it.id || null,
    label: it.label,
    type: it.type,
    role: it.role ?? null,
    enabled: it.enabled,
    accelerator: it.accelerator ?? null,
    submenu: it.submenu ? walk(it.submenu.items) : null,
  }));
  const m = Menu.getApplicationMenu();
  return m ? walk(m.items) : null;
});

/** Fire a menu row by id. Returns false if no such row is installed. */
const clickItem = (id) => app.evaluate(({ Menu }, wanted) => {
  const item = Menu.getApplicationMenu()?.getMenuItemById(wanted);
  if (!item) return false;
  item.click();
  return true;
}, id);

/**
 * Focus the visible terminal, optionally type, then send a key. Every Playwright
 * call is caught, for the same reason paneText() is: a pane that never opened
 * (or a spawn that died) must be reported by the assertions below as FAILs, not
 * thrown out of the run — an escaping rejection skips every remaining check, the
 * N/M summary, close(), and the EMPTY_DIR cleanup, and reports as a stack trace.
 */
const typeIntoPane = async (text, key = 'Enter') => {
  try {
    await win.locator(VIS + '.xterm-screen').click({ timeout: 5_000 });
    if (text) {
      await win.keyboard.type(text);
      await win.waitForTimeout(300);
    }
    await win.keyboard.press(key);
  } catch { /* the assertion that depends on this reports it */ }
};

/** buildMenu() is async and fire-and-forget from its triggers; poll for it. */
const menuWhere = async (pred, ms = 10_000) => {
  let tree = null;
  for (let i = 0; i * 250 < ms; i++) {
    tree = await menuTree();
    if (tree && pred(tree)) return tree;
    await win.waitForTimeout(250);
  }
  return tree;
};

const fileSub = (tree) => tree?.find((i) => i.label === 'File')?.submenu ?? [];
const recentSub = (tree) => fileSub(tree).find((i) => i.label === 'Open Recent')?.submenu ?? [];
const folderIndex = (tree, p) => recentSub(tree).findIndex((i) => i.label === amp(p));
const sessionRows = (tree, i) =>
  (recentSub(tree)[i]?.submenu ?? []).filter((r) => /^recent:\d+:session:\d+$/.test(r.id ?? ''));

// --- 1. the tab-strip button is gone --------------------------------------
{
  const strip = await win.evaluate(() =>
    Array.from(document.querySelectorAll('.tabbar > *'))
      .filter((el) => el.className.includes('menu'))
      .map((el) => el.className));
  // The Space menu is the control: if the selector strategy stopped matching
  // anything at all, this check would be the one that notices.
  check('the Space menu is the only dropdown left at the strip’s left edge',
    strip.length === 1 && strip[0] === 'spacemenu', strip.join(' | ') || '(nothing matched)');
  const dead = await win.evaluate(() =>
    ['.filemenu', '.filemenu-btn', '.filemenu-dropdown', '.recentmenu']
      .map((s) => `${s}:${document.querySelectorAll(s).length}`)
      .filter((s) => !s.endsWith(':0')));
  check('no renderer File button, dropdown or flyout is mounted', dead.length === 0, dead.join(' '));
}

// --- 2. the native File menu, on a profile with no recents ----------------
{
  const tree = await menuWhere((t) => t.some((i) => i.label === 'File'));
  check('an application menu is installed', Array.isArray(tree) && tree.length > 0,
    (tree ?? []).map((i) => i.label).join(' | ') || 'Menu.getApplicationMenu() is null');

  const rows = fileSub(tree).map((r) =>
    r.type === 'separator' ? '---' : r.role ? `role:${r.role}` : r.label);
  check('File is New Tab, Close Tab, Open Recent, Quit — Open Recent beside the tab commands',
    rows.join(' / ') === 'New Tab / Close Tab / --- / Open Recent / --- / role:quit',
    rows.join(' / '));

  const byId = Object.fromEntries(fileSub(tree).filter((r) => r.id).map((r) => [r.id, r]));
  check('the tab commands carry stable ids and their accelerators',
    /(CmdOrCtrl|Ctrl|Control)\+T$/i.test(byId['file:new-tab']?.accelerator ?? '')
    && /(CmdOrCtrl|Ctrl|Control)\+W$/i.test(byId['file:close-tab']?.accelerator ?? ''),
    `new-tab ${byId['file:new-tab']?.accelerator} / close-tab ${byId['file:close-tab']?.accelerator}`);

  // Reachable only from a fresh profile, which is why this file insists on one.
  const empty = recentSub(tree);
  check('with no recents, Open Recent holds one DISABLED placeholder and no folder rows',
    empty.length === 1 && empty[0].label === 'No recent folders' && empty[0].enabled === false
    && !empty.some((r) => (r.id ?? '').startsWith('recent:')),
    empty.map((r) => `${r.label}${r.enabled ? '' : ' (disabled)'}`).join(' | '));
}

// --- 3. the rebuild trigger: a folder opened THIS RUN ---------------------
// recents:add is the same IPC the app writes a recent with, and its handler is
// what asks for a rebuild. Nothing here reloads or reopens the menu — if the
// rebuild did not fire, the rows below never appear.
await win.evaluate(
  async (ps) => { for (const p of ps) await window.api.recentsAdd(p); },
  [EMPTY_DIR, CLAUDE_DIR],
);
let tree = await menuWhere((t) => folderIndex(t, CLAUDE_DIR) >= 0 && folderIndex(t, EMPTY_DIR) >= 0);
let ci = folderIndex(tree, CLAUDE_DIR);
let ei = folderIndex(tree, EMPTY_DIR);
{
  check('opening folders rebuilds the native menu and lists them under Open Recent',
    ci >= 0 && ei >= 0, recentSub(tree).map((r) => r.label).join(' | '));
  check('folder rows are most-recent-first and labelled with the absolute path',
    ci === 0 && ei === 1 && recentSub(tree)[0].label === amp(CLAUDE_DIR)
    && recentSub(tree)[0].id === 'recent:0',
    `${CLAUDE_DIR} at ${ci}, ${EMPTY_DIR} at ${ei}`);
}

// --- 4. inside a folder row ----------------------------------------------
{
  const kids = recentSub(tree)[ci]?.submenu ?? [];
  check('the folder’s submenu leads with Open Folder, then + New session, then a separator',
    kids[0]?.label === 'Open Folder' && kids[0]?.id === `recent:${ci}:open`
    && kids[1]?.label === '+ New session' && kids[1]?.id === `recent:${ci}:new`
    && kids[2]?.type === 'separator',
    kids.slice(0, 4).map((k) => k.label || k.type).join(' | '));

  const rows = sessionRows(tree, ci);
  check('the folder lists its sessions, ids contiguous from 0',
    rows.length > 0 && rows.every((r, j) => r.id === `recent:${ci}:session:${j}`),
    `${rows.length} rows`);
  // A row is `<title>   <relative time>` — menu.ts joins them with exactly three
  // spaces, and that gap is the only thing separating the two fields in a single
  // flat label. Matched WHOLE and anchored, because the previous form split on
  // the gap and tested the halves: when the separator breaks, split() yields ONE
  // element, so [0] and .pop() are the same string and a title containing any
  // digit satisfied the "time" half. Proven vacuous — with the gap sabotaged to
  // a single space the harness ran 29/30 with that assertion PASSING. This one
  // fails on a broken separator, a missing time, and a missing title alike.
  // `rows.length > 0 &&` is load-bearing: [].every() is true, so without it this
  // reports PASS for a menu with no session rows at all.
  const TIME = String.raw`(?:just now|yesterday|\d+[mhd] ago|\d{1,4}[./-]\d{1,2}[./-]\d{1,4})`;
  const ROW_RE = new RegExp(String.raw`^\S(?:.*\S)? {3}${TIME}$`);
  const malformed = rows.filter((r) => !ROW_RE.test(r.label ?? ''));
  check('every session row is a title, three spaces, then a relative time',
    rows.length > 0 && malformed.length === 0,
    malformed.length ? `${malformed.length} malformed, e.g. "${malformed[0].label}"`
      : rows[0]?.label ?? '(no rows)');
  // Only meaningful when the fixture holds MORE transcripts than the cap. Below
  // that, `rows.length === jsonls.length` is what a RAISED or REMOVED cap
  // produces too, so a green here would prove nothing — hence a skip that says
  // so rather than a check that cannot fail. (The old second clause,
  // `rows.length === ranked.length`, was the first one restated: ranked IS this
  // same array sliced to CAP, so it was structurally guaranteed.)
  if (jsonls.length > CAP) {
    check(`the list is capped at ${CAP}`, rows.length === CAP,
      `${rows.length} rows from ${jsonls.length} transcripts on disk`);
  } else {
    console.log(`  SKIP  the ${CAP}-row cap cannot bite: only ${jsonls.length} transcripts in ${dir}`);
  }

  const empties = recentSub(tree)[ei]?.submenu ?? [];
  // "No session rows at all" stated as sessionRows().length, not as a count of
  // id-carrying rows: the latter moves whenever the fixed rows above do.
  check('a folder with no sessions gets a DISABLED "No sessions" row, not an empty submenu',
    sessionRows(tree, ei).length === 0
    && empties.some((r) => r.label === 'No sessions' && r.enabled === false),
    empties.map((r) => r.label || r.type).join(' | '));
  check('…and it still leads with Open Folder and + New session — "no sessions" is about the list, not the actions',
    empties[0]?.id === `recent:${ei}:open` && empties[0]?.label === 'Open Folder'
    && empties[1]?.id === `recent:${ei}:new` && empties[1]?.label === '+ New session',
    empties.slice(0, 2).map((r) => r.label || r.type).join(' | ') || '(none)');
}

// --- 5. the Open Folder row opens a files tab ----------------------------
// Aimed at `recent:<i>:open`, NOT at the `recent:<i>` folder row itself. On
// Windows a menu item that owns a submenu is never activated by the mouse —
// hover or click opens the popup and the callback never fires — so a handler on
// the folder row is code no user can reach, and clicking it from here (which
// this harness CAN do: item.click() in main bypasses the shell entirely) would
// report PASS for a dead path. See fileSubmenu()'s doc comment in main/menu.ts.
{
  const before = await tabCount(win);
  const fired = await clickItem(`recent:${ei}:open`);
  await win.waitForTimeout(1200);
  const after = await tabCount(win);
  const crumbs = (await win.locator(VIS + '.breadcrumb').first().textContent().catch(() => '')) ?? '';
  check('the folder’s Open Folder row opens a FILE tab on that folder', fired && after === before + 1
    && crumbs.includes(path.basename(EMPTY_DIR)),
    `${before}→${after} tabs, crumbs "${crumbs.trim()}"`);
}

// --- 6. New Tab / Close Tab still work from the native menu --------------
{
  const before = await tabCount(win);
  await clickItem('file:new-tab');
  await win.waitForTimeout(800);
  const opened = await tabCount(win);
  check('File ▸ New Tab opens a tab', opened === before + 1, `${before}→${opened}`);
  await clickItem('file:close-tab');
  await win.waitForTimeout(800);
  const closed = await tabCount(win);
  // NOT `closed === before` alone: if New Tab is broken, `before` and `opened`
  // are the same number and a Close Tab that does nothing satisfies it too.
  // The claim is a DROP from whatever New Tab actually produced.
  check('File ▸ Close Tab closes the active one',
    opened === before + 1 && closed === opened - 1, `${opened}→${closed}`);
}

// --- 7. the other rebuild trigger: recents:remove ------------------------
{
  await win.evaluate((p) => window.api.recentsRemove(p), EMPTY_DIR);
  tree = await menuWhere((t) => folderIndex(t, EMPTY_DIR) === -1);
  ci = folderIndex(tree, CLAUDE_DIR);
  check('forgetting a recent rebuilds the menu without it',
    folderIndex(tree, EMPTY_DIR) === -1 && ci >= 0,
    recentSub(tree).map((r) => r.label).join(' | '));
}

// --- 8. THE ONE THAT MATTERS: a session row resumes THAT session ---------
{
  check('the target row’s transcript is on disk under its id',
    fs.existsSync(path.join(dir, target.file)), target.file);
  // The marker is only evidence if it identifies ONE transcript. Verified, not
  // assumed — two runs of resume.mjs in the same second could collide.
  const owners = meta.filter((m) => m.text.includes(target.marker)).map((m) => m.file);
  check('its marker appears in exactly one transcript on disk',
    owners.length === 1 && owners[0] === target.file, owners.join(', '));
  check('the decoy is a strictly newer, different conversation',
    decoy.rank < target.rank && decoy.marker !== target.marker,
    `rank ${decoy.rank} ${decoy.marker} vs clicked rank ${target.rank} ${target.marker}`);

  const rows = sessionRows(tree, ci);
  check('the menu still offers that rank as a clickable row',
    rows[target.rank]?.id === `recent:${ci}:session:${target.rank}`,
    `${rows.length} rows, want rank ${target.rank}`);
}

console.log(`\nresuming rank ${target.rank} — ${target.marker} (${target.id}), NOT the newest`);
{
  const before = await tabCount(win);
  const fired = await clickItem(`recent:${ci}:session:${target.rank}`);
  // Caught, not awaited bare: if the row is missing or the click spawned
  // nothing, this file must report a FAIL for it and keep going, not die with a
  // Playwright timeout and swallow every assertion below.
  await win.waitForSelector(VIS + '.xterm', { timeout: 30_000 }).catch(() => {});
  check('a terminal tab opened', fired && (await tabCount(win)) === before + 1);

  // Poll rather than sleep a flat 40s: claude prints the replayed conversation
  // as soon as it has read the transcript.
  let rows = '';
  for (let i = 0; i < 40; i++) {
    await win.waitForTimeout(1000);
    rows = await paneText(win);
    if (rows.includes(target.marker)) break;
    if (/trust/i.test(rows) && i === 8) await typeIntoPane('');
  }

  const resumed = rows.includes(target.marker);
  check('the CLICKED row’s conversation came back on screen', resumed,
    resumed ? target.marker : 'its history never appeared — fresh session, or the wrong one');
  // Guarded on a non-empty pane: "the decoy's marker is absent" is trivially
  // true of a terminal that never opened.
  check('and it is not the newest session’s history',
    rows.length > 0 && !rows.includes(decoy.marker),
    rows.length === 0 ? 'nothing on screen to judge'
      : rows.includes(decoy.marker) ? `${decoy.marker} is on screen — resumed the newest, not the clicked row` : '');

  if (!resumed) {
    const dump = path.join(os.tmpdir(), 'filemenu-resume.txt');
    fs.writeFileSync(dump, rows);
    console.log(`  (pane text written to ${dump})`);
  }
}

// --- 9. + New session: a FRESH session, never a resume -------------------
//
// "A terminal tab appeared" would pass whether this spawned a fresh
// conversation, silently resumed the newest one, or resumed nothing at all.
// Two-sided, same shape as section 8:
//   * a NEW transcript id appears on disk that was NOT there before the click
//   * the pane shows NONE of the pre-existing sessions' markers
console.log('\n+ New session — must be a fresh conversation, never a resume');
const beforeFiles = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')));
const knownMarkers = [...new Set(meta.map((m) => m.marker).filter(Boolean))];
{
  const beforeTabs = await tabCount(win);
  const fired = await clickItem(`recent:${ci}:new`);

  // Poll the tab COUNT rather than wait for '.xterm': the ACTIVE tab here is
  // already a terminal (section 8's resumed session), so waiting for '.xterm'
  // to merely exist resolves instantly on that stale pane instead of the new
  // one — and openClaudeNewTab is async (two IPC round trips, recentsAdd then
  // ptySpawn, before setTabs fires), so the count check has to survive that gap
  // rather than race it.
  let afterTabs = beforeTabs;
  for (let i = 0; i < 30 && afterTabs !== beforeTabs + 1; i++) {
    await win.waitForTimeout(300);
    afterTabs = await tabCount(win);
  }
  check('+ New session opened a terminal tab', fired && afterTabs === beforeTabs + 1,
    `${beforeTabs} → ${afterTabs}`);
  await win.waitForSelector(VIS + '.xterm', { timeout: 30_000 }).catch(() => {});

  // Evidence #1: before typing anything, the pane must not be replaying ANY
  // pre-existing conversation. A resume prints history within a second or two
  // of the transcript loading (section 8 above), so this window is enough to
  // catch a silent fallback to "resume the newest" without waiting a full turn.
  await win.waitForTimeout(5000);
  let rows = await paneText(win);
  const leaked = knownMarkers.filter((m) => rows.includes(m));
  check('the new pane shows none of the pre-existing sessions’ markers',
    rows.length > 0 && leaked.length === 0,
    rows.length === 0 ? 'nothing on screen to judge' : leaked.length ? `leaked: ${leaked.join(', ')}` : '');

  // Defensive, same as resume.mjs: a first run in a folder can ask to trust it.
  if (/trust/i.test(rows)) {
    await typeIntoPane('');
    await win.waitForTimeout(3000);
  }

  // Evidence #2: a real, distinct transcript gets written for THIS session —
  // not "a tab exists", the id on disk. A fresh marker (never seen before) also
  // rules out a resume falling back to some OTHER old, unmarked transcript.
  const PROBE = `PROBE-OK-${Date.now().toString().slice(-6)}`;
  await typeIntoPane(`Reply with exactly this and nothing else: ${PROBE}`);

  let newFile = null;
  for (let i = 0; i < 30 && !newFile; i++) {
    await win.waitForTimeout(1000);
    newFile = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).find((f) => !beforeFiles.has(f));
  }
  check('a NEW transcript id appeared on disk that was not there before the click',
    !!newFile, newFile ?? `no new file among ${fs.readdirSync(dir).length} on disk`);
  check('the new transcript is not the session resumed a moment ago',
    !!newFile && newFile !== target.file, newFile ?? '');

  rows = await paneText(win);
  const stillClean = knownMarkers.every((m) => !rows.includes(m));
  check('and still no pre-existing marker leaked in after the reply', stillClean,
    stillClean ? '' : knownMarkers.filter((m) => rows.includes(m)).join(', '));

  if (!newFile || leaked.length || !stillClean) {
    const dump = path.join(os.tmpdir(), 'filemenu-newsession.txt');
    fs.writeFileSync(dump, rows);
    console.log(`  (pane text written to ${dump})`);
  }
}

await close();
fs.rmSync(EMPTY_DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
