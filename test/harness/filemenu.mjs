// KAN-54: the File menu, and the three-level cascade that replaced the
// standalone Open Recent button.
//   npm run build && node test/harness/filemenu.mjs
//
// The load-bearing claim is the third level: clicking a session must RESUME
// THAT SESSION. "A terminal tab appeared" is not evidence of that — the first
// version of test/harness/resume.mjs asserted exactly that and reported PASS
// while resume was completely broken. So the proof here is a two-sided one:
//
//   * every session row in ~/claudetest carries a distinct marker in its title
//     (each transcript's first user prompt), and each marker string exists in
//     exactly ONE jsonl on disk — checked, not assumed;
//   * we click a session that is NOT the newest, and require its marker to
//     come back on screen while the newest session's marker does not.
//
// A fresh session shows neither marker; resuming the newest one shows the
// wrong marker. Both failure modes are caught.
//
// Everything else (the cascade, laziness, the disabled row, the flip, the
// keyboard chain) is cheap and runs in the same window before the slow part.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const CLAUDE_DIR = path.join(os.homedir(), 'claudetest');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

// A folder Claude has never run in, so sessions:list returns [] — the disabled
// "No sessions" row is a real state, not a mocked one.
const EMPTY_DIR = path.join(os.tmpdir(), `ce-filemenu-empty-${process.pid}`);
fs.rmSync(EMPTY_DIR, { recursive: true, force: true });
fs.mkdirSync(EMPTY_DIR, { recursive: true });

const slugFor = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const projectDir = (p) => path.join(os.homedir(), '.claude', 'projects', slugFor(p));
const sessionFile = (dir, id) => path.join(projectDir(dir), `${id}.jsonl`);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const VIS = '.pane:not([hidden]) ';
/** Windows paths are full of backslashes; JSON.stringify produces exactly the
 *  double-quoted, backslash-escaped form a CSS attribute selector wants. */
const byPath = (p) => `[data-path=${JSON.stringify(p)}]`;
const rectOf = (win, sel) =>
  win.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, innerWidth: window.innerWidth };
  });
const focused = (win) =>
  win.evaluate(() => {
    const el = document.activeElement;
    return { lvl: el?.dataset?.lvl ?? '0', text: (el?.textContent ?? '').trim(), cls: el?.className ?? '' };
  });

// --- pre-flight: this needs real transcripts to resume ---------------------
const dir = projectDir(CLAUDE_DIR);
const onDisk = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
if (onDisk.length < 2) {
  console.log(`  SKIP  need ≥2 Claude transcripts in ${dir} (run test/harness/resume.mjs first)`);
  process.exit(0);
}

const openMenu = async (win) => {
  await win.click('.filemenu-btn');
  await win.waitForSelector('.filemenu-dropdown');
  await win.waitForTimeout(150);
};
const hoverRecent = async (win) => {
  await win.locator('[data-sub="recent"]').hover();
  await win.waitForSelector('.filemenu-project');
  await win.waitForTimeout(150);
};

console.log('\nFile menu — structure, laziness, and the three-level cascade');
const { app, win, close } = await launchApp();

// Seed the recent list through the same IPC the app writes it with. This is
// setup, not the thing under test — the menu still has to READ it.
await win.evaluate(
  async (ps) => { for (const p of ps) await window.api.recentsAdd(p); },
  [EMPTY_DIR, CLAUDE_DIR],
);
await win.waitForTimeout(200);

// --- 1. the strip's left edge ---------------------------------------------
{
  const gone = await win.locator('.recentmenu').count();
  check('the standalone Open Recent button is gone', gone === 0, gone ? `${gone} left` : '');
  const edge = await win.evaluate(() =>
    Array.from(document.querySelectorAll('.tabbar > *'))
      .filter((el) => el.className.includes('menu'))
      .map((el) => el.className));
  check('spaces + File are the only dropdowns at the left edge',
    edge.length === 2 && edge[0] === 'spacemenu' && edge[1] === 'filemenu', edge.join(' | '));
  check('the File button is there', await win.locator('.filemenu-btn').count() === 1);
}

// --- 2. level 1, and nothing loaded yet -----------------------------------
await openMenu(win);
{
  const items = (await win.locator('.filemenu-dropdown [data-lvl="1"]').allTextContents())
    .map((t) => t.replace(/[▸\s]+/g, ' ').trim());
  check('File holds exactly New Tab and Open Recent',
    items.length === 2 && items[0] === 'New Tab' && items[1] === 'Open Recent', items.join(' | '));
  const projects = await win.locator('.filemenu-project').count();
  check('no recents flyout until Open Recent is entered', projects === 0, `${projects} rows`);
}

// --- 3. level 2, and the lazy-load claim ----------------------------------
await hoverRecent(win);
{
  const paths = await win.locator('.filemenu-project').evaluateAll((els) =>
    els.map((e) => e.dataset.path));
  check('Open Recent lists the recent projects',
    paths.includes(CLAUDE_DIR) && paths.includes(EMPTY_DIR), paths.join(' | '));
  // THE laziness assertion: the project list is up, so if sessions were fetched
  // on menu-open the rows would exist by now. They must not.
  const sessions = await win.locator('.filemenu-session').count();
  check('sessions are NOT fetched for every project when the menu opens',
    sessions === 0, `${sessions} session rows already rendered`);
}

// --- 4. the flip, before anything slow ------------------------------------
{
  const wide = await rectOf(win, '.filemenu-flyout');
  const row = await rectOf(win, '[data-sub="recent"]');
  check('a flyout with room opens rightward and stays on screen',
    wide.left >= row.right - 2 && wide.right <= wide.innerWidth,
    `flyout ${Math.round(wide.left)}..${Math.round(wide.right)} of ${wide.innerWidth}`);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(520, 760));
  await win.waitForTimeout(400);
  const narrow = await rectOf(win, '.filemenu-flyout');
  const narrowRow = await rectOf(win, '[data-sub="recent"]');
  check('near the right edge it flips leftward instead of clipping',
    narrow.right <= narrow.innerWidth && narrow.left >= 0 && narrow.left < narrowRow.right - 2,
    `flyout ${Math.round(narrow.left)}..${Math.round(narrow.right)} of ${narrow.innerWidth}`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820));
  await win.waitForTimeout(400);
}

// --- 5. level 3 -----------------------------------------------------------
let markers = [];           // [{ id, marker }] newest-first, as the menu lists them
await hoverRecent(win);
await win.locator(byPath(CLAUDE_DIR)).hover();
await win.waitForSelector('.filemenu-session');
await win.waitForTimeout(400);
{
  const rows = await win.locator('.filemenu-session').evaluateAll((els) =>
    els.map((e) => ({
      id: e.dataset.session,
      title: e.querySelector('.filemenu-label')?.textContent ?? '',
      time: e.querySelector('.filemenu-time')?.textContent ?? '',
    })));
  check('hovering a project lists its sessions', rows.length > 0, `${rows.length} sessions`);
  check('every session row carries a title and a relative time',
    rows.every((r) => r.title.length > 0 && /ago|just now|yesterday|\d/.test(r.time)),
    rows[0] ? `${rows[0].title} — ${rows[0].time}` : '');
  check('the list is capped at 20', rows.length <= 20, `${rows.length}`);

  markers = rows
    .map((r) => ({ id: r.id, marker: (r.title.match(/RESUME-OK-\d{6}|PROBE-OK/) ?? [])[0] }))
    .filter((m) => m.marker);
  check('the session titles carry distinguishable markers', markers.length >= 2,
    markers.map((m) => m.marker).join(', '));
}

// --- 6. the empty project -------------------------------------------------
await win.locator(byPath(EMPTY_DIR)).hover();
await win.waitForTimeout(600);
{
  const empty = await win.locator('.filemenu-sessions .filemenu-empty').allTextContents();
  const rows = await win.locator('.filemenu-session').count();
  check('a project with no sessions shows a disabled row, not an empty flyout',
    empty.some((t) => /no sessions/i.test(t)) && rows === 0, `${empty.join('|')} / ${rows} rows`);
}

// --- 7. clicking the project row itself -----------------------------------
{
  const before = await win.locator('.tab:not(.add)').count();
  await win.locator(byPath(EMPTY_DIR)).click();
  await win.waitForTimeout(900);
  const after = await win.locator('.tab:not(.add)').count();
  const crumbs = await win.locator(VIS + '.breadcrumb').first().textContent().catch(() => '');
  check('clicking a project row opens a FILE tab on that folder',
    after === before + 1 && (crumbs ?? '').includes(path.basename(EMPTY_DIR)),
    `${before}→${after} tabs, crumbs "${(crumbs ?? '').trim()}"`);
  check('the menu closed behind it', await win.locator('.filemenu-dropdown').count() === 0);
}

// --- 8. dismissal ---------------------------------------------------------
{
  await openMenu(win);
  await hoverRecent(win);
  await win.mouse.click(900, 20); // empty tab-strip, outside the whole chain
  await win.waitForTimeout(250);
  const chrome = await win.locator('.filemenu-dropdown').count()
    + await win.locator('.filemenu-flyout').count();
  check('an outside click closes the whole chain, flyouts included', chrome === 0, `${chrome} left open`);
}

// --- 9. the keyboard chain ------------------------------------------------
{
  await openMenu(win);
  await win.keyboard.press('ArrowDown');
  const a = await focused(win);
  await win.keyboard.press('ArrowDown');
  const b = await focused(win);
  await win.waitForSelector('.filemenu-project');
  check('ArrowDown walks level 1 and focus alone opens Open Recent',
    a.text === 'New Tab' && a.lvl === '1' && b.text.startsWith('Open Recent') && b.lvl === '1',
    `${a.text} → ${b.text}`);

  await win.keyboard.press('ArrowRight');
  const c = await focused(win);
  await win.waitForSelector('.filemenu-session');
  await win.waitForTimeout(400);
  check('ArrowRight steps into the project list', c.lvl === '2', `lvl ${c.lvl}: ${c.text}`);

  await win.keyboard.press('ArrowRight');
  const d = await focused(win);
  check('ArrowRight again steps into that project’s sessions', d.lvl === '3', `lvl ${d.lvl}: ${d.text}`);

  await win.keyboard.press('ArrowDown');
  const e = await focused(win);
  check('ArrowDown moves within the session list', e.lvl === '3' && e.text !== d.text, e.text);

  await win.keyboard.press('ArrowLeft');
  const f = await focused(win);
  check('ArrowLeft goes back to the project row and closes its flyout',
    f.lvl === '2' && await win.locator('.filemenu-session').count() === 0, `lvl ${f.lvl}`);

  await win.keyboard.press('Escape');
  const g = await focused(win);
  check('Escape goes back to level 1', g.lvl === '1' && await win.locator('.filemenu-project').count() === 0,
    `lvl ${g.lvl}: ${g.text}`);

  await win.keyboard.press('Escape');
  await win.waitForTimeout(150);
  const h = await focused(win);
  check('Escape again closes the menu and returns focus to the File button',
    await win.locator('.filemenu-dropdown').count() === 0 && h.cls.includes('filemenu-btn'),
    h.cls);
}

// --- 10. THE ONE THAT MATTERS: clicking a session resumes THAT session -----
//
// Pick the OLDEST marked session, never the newest: a resume that quietly falls
// back to "the most recent conversation in this folder" would still look right
// if we always clicked row 1.
const target = markers[markers.length - 1];
const decoy = markers[0];
{
  const targetFile = sessionFile(CLAUDE_DIR, target.id);
  const has = (f, m) => fs.readFileSync(f, 'utf8').includes(m);
  check('the chosen session’s transcript is on disk under its id', fs.existsSync(targetFile),
    path.basename(targetFile));
  // The marker is only evidence if it identifies ONE transcript. Verified, not
  // assumed — two runs of resume.mjs in the same second could collide.
  const owners = onDisk.filter((f) => has(path.join(dir, f), target.marker));
  check('its marker appears in exactly one transcript on disk',
    owners.length === 1 && owners[0] === `${target.id}.jsonl`, owners.join(', '));
  check('the decoy (newest) session is a different conversation',
    decoy.id !== target.id && decoy.marker !== target.marker,
    `newest ${decoy.marker} vs clicked ${target.marker}`);
}

console.log(`\nresuming ${target.marker} (${target.id}) — the OLDEST session, not the newest`);
{
  const before = await win.locator('.tab:not(.add)').count();
  await openMenu(win);
  await hoverRecent(win);
  await win.locator(byPath(CLAUDE_DIR)).hover();
  await win.waitForSelector('.filemenu-session');
  await win.waitForTimeout(400);
  await win.locator(`[data-session="${target.id}"]`).click();

  await win.waitForSelector(VIS + '.xterm', { timeout: 30_000 });
  check('a terminal tab opened', await win.locator('.tab:not(.add)').count() === before + 1);

  // Poll rather than sleep a flat 25s: claude prints the replayed conversation
  // as soon as it has read the transcript.
  let rows = '';
  for (let i = 0; i < 40; i++) {
    await win.waitForTimeout(1000);
    rows = await win.$eval(VIS + '.xterm-rows', (el) => el.textContent);
    if (rows.includes(target.marker)) break;
    if (/trust/i.test(rows) && i === 8) {
      await win.locator(VIS + '.xterm-screen').click();
      await win.keyboard.press('Enter');
    }
  }

  const resumed = rows.includes(target.marker);
  check('the CLICKED session’s conversation came back on screen', resumed,
    resumed ? target.marker : 'its history never appeared — fresh session, or the wrong one');
  check('and it is not some other session’s history', !rows.includes(decoy.marker),
    rows.includes(decoy.marker) ? `${decoy.marker} is on screen — resumed the newest, not the clicked one` : '');

  if (!resumed) {
    const dump = path.join(os.tmpdir(), 'filemenu-resume.txt');
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
