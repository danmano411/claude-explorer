// KAN-98: does the built app actually RENDER, not just start?
//
// KAN-96 shipped a v0.10.0 draft with the renderer completely broken — a bare
// `process.platform` read in renderer/keys.ts is a ReferenceError under
// `contextIsolation: true`, thrown at module-evaluation time, before React
// ever mounted. `#root` stayed empty and `.app` never appeared. `npm test` was
// 1384/1384 green (vitest runs in node, where `process` exists) and CI's tsc
// + unit suite never launches the real app. This is the harness that does,
// wired into pr-check.yml specifically so that class of bug fails the PR
// instead of shipping in a release draft.
//
//   npm run build && node test/harness/smoke.mjs
import { launchApp } from './app.mjs';

const TIMEOUT = 10_000; // short and loud: KAN-96's symptom was a silent 30s
// Playwright timeout that read as flake, not failure.

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const printConsoleErrors = (errors) => {
  if (!errors?.length) { console.log('  (no renderer console errors captured)'); return; }
  console.log('  renderer console errors:');
  for (const e of errors) console.log('    -', e);
};

try {
  const { win, close, consoleErrors } = await launchApp({ timeout: TIMEOUT });
  // launchApp() already waited for `.app` (throws on failure, caught below).
  // The other half of the assertion: something actually mounted under the
  // static `<div id="root">` in index.html, not just that a `.app` element
  // matched somewhere.
  const rootChildren = await win.evaluate(() => document.querySelector('#root')?.children.length ?? 0);
  check('.app appeared', true);
  check('#root has child nodes', rootChildren > 0, `${rootChildren} children`);
  if (results.some((r) => !r.pass)) printConsoleErrors(consoleErrors);
  await close();
} catch (err) {
  check(`.app appeared within ${TIMEOUT}ms`, false, err.message);
  printConsoleErrors(err.consoleErrors);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
