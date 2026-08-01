// KAN-64 — the setting itself: what the Settings modal offers, what a Save
// writes, and what comes back after a restart.
//
//   npm run build && node test/harness/allowanceui.mjs
//
// SEPARATE FROM mcptools.mjs on purpose. That file needs a bearer token, which
// costs a real spawned session and several app runs; this claim needs neither —
// it is a dropdown, a JSON file and a restart. Seconds, not minutes.
//
// WHAT THIS IS FOR, and it is not "the modal has a select": the number the
// guard enforces is read from settings.json (mcp.ts's `allowance`), and the
// only way a user can set it is this control. A modal that renders the value
// but never sends it back — an `agentFreeSessions` missing from `save()`'s
// patch — leaves the whole feature stuck on its default with nothing on screen
// to say so, and no unit test of settings.ts can see that.
//
// RED-FIRST: against the unmodified build there is no such control at all, so
// every check below fails on the selector. The sharper proof is a targeted
// mutation — dropping `agentFreeSessions` from SettingsModal's `save()` patch,
// which leaves the dropdown working, the modal closing and the file written,
// and turns exactly the two "persisted" checks red. Captured in the report.
//
// The profile is per-pid and thrown away: the single-instance lock is keyed on
// userData, and this repo runs several worktrees at once.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { launchApp } from './app.mjs';

const PROFILE = path.join(os.tmpdir(), `ce-k64-ui-${process.pid}`);
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
const SETTINGS = path.join(PROFILE, 'settings.json');
const onDisk = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return null; } };

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const sel = (win) => win.locator('select[data-setting="agentFreeSessions"]');
const openSettings = async (app, win) => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'open-settings');
  });
  await win.waitForSelector('.modal', { timeout: 5_000 });
};

console.log('\n1 — the control, and what it offers');
{
  const { app, win, close } = await launchApp({ userDataDir: PROFILE });
  await openSettings(app, win);

  const opts = await sel(win).locator('option').evaluateAll((els) => els.map((e) => e.value));
  check('the dropdown offers exactly 0, 4, 8 and 16 and nothing else',
    JSON.stringify(opts) === JSON.stringify(['0', '4', '8', '16']), opts.join(', '));
  check('and it starts on the shipped default of 8', (await sel(win).inputValue()) === '8',
    await sel(win).inputValue());
  // The label has to name the tradeoff in the user's terms — "0" alone is the
  // one value whose meaning is not obvious from the number.
  const zero = await sel(win).locator('option[value="0"]').textContent();
  check('and 0 says what 0 means', /ask every time/i.test(zero ?? ''), String(zero));

  // A save with the value CHANGED. The whole point of the file check below is
  // that a modal can render a value it never sends.
  await sel(win).selectOption('4');
  await win.locator('.modal-actions button.primary').click();
  await win.waitForSelector('.modal', { state: 'detached', timeout: 5_000 });
  await win.waitForTimeout(400);

  const disk = onDisk();
  check('saving wrote agentFreeSessions: 4 to settings.json',
    disk?.agentFreeSessions === 4, JSON.stringify(disk));
  // ...and took nothing else with it. This modal writes the whole settings
  // object, so a new field is also a new way to clobber the old ones.
  check('and left the other settings intact',
    disk?.ideCommand === 'code' && disk?.agentControl === true && disk?.groupWithSource === true,
    JSON.stringify(disk));

  await close();
}

console.log('\n2 — after a restart, and after a hand edit');
{
  // Same profile, new process: this is the "survives a restart" half, and it
  // reads the value back through the UI rather than off the disk it was just
  // written to.
  const { app, win, close } = await launchApp({ userDataDir: PROFILE });
  await openSettings(app, win);
  check('the restarted app shows the saved 4', (await sel(win).inputValue()) === '4',
    await sel(win).inputValue());
  await win.locator('.modal-actions button:not(.primary)').click(); // Cancel
  await close();
}

{
  // A value no UI can produce, written by hand into the file — the guard must
  // fall back to the DEFAULT, never to "never ask". 9999 is the shape that
  // matters: every `count >= allowance` comparison against it is false forever,
  // i.e. it would silently disable the human gate from a text editor.
  fs.writeFileSync(SETTINGS, JSON.stringify({ ...onDisk(), agentFreeSessions: 9999 }, null, 2));
  const { app, win, close } = await launchApp({ userDataDir: PROFILE });
  await openSettings(app, win);
  check('a hand-edited 9999 reads back as the default of 8',
    (await sel(win).inputValue()) === '8', await sel(win).inputValue());
  // And the app corrects the file the next time it writes, rather than leaving
  // the junk on disk for the next reader.
  await win.locator('.modal-actions button.primary').click();
  await win.waitForSelector('.modal', { state: 'detached', timeout: 5_000 });
  await win.waitForTimeout(400);
  check('and a save replaces the junk on disk with 8', onDisk()?.agentFreeSessions === 8,
    JSON.stringify(onDisk()));
  await close();
}

try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* %TEMP% */ }
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failing:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
