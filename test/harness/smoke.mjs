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
  const { close, consoleErrors } = await launchApp({ timeout: TIMEOUT });
  // launchApp() already waited for `.app` (it throws on failure, caught below),
  // so reaching this line IS the assertion — React mounted App.tsx's root
  // element, which is the half KAN-96 broke.
  check('.app appeared', true);

  // The second assertion has to be INDEPENDENT of the first or it is decorative.
  // "#root has child nodes" was the obvious candidate and is worthless here:
  // `.app` is App.tsx's own root element (App.tsx:2243) and React mounts it
  // INTO `#root`, so `#root.children.length > 0` is structurally guaranteed the
  // moment `.app` matches — it cannot fail while the check above passes. That is
  // exactly the "assert something structurally guaranteed" trap in CLAUDE.md.
  //
  // Uncaught renderer errors are genuinely independent: the app can mount and
  // still be throwing — a missing preload binding, a component swallowed by an
  // error boundary, a rejected IPC promise. None of those move `.app`, and all
  // of them are the same class of defect KAN-96 belonged to (renderer-only, so
  // vitest in node cannot see them). Demonstrated red separately from `.app`,
  // by throwing asynchronously from main.tsx after mount.
  check('no uncaught renderer errors', consoleErrors.length === 0,
    consoleErrors.length ? `${consoleErrors.length} captured` : 'none');
  if (results.some((r) => !r.pass)) printConsoleErrors(consoleErrors);
  await close();
} catch (err) {
  check(`.app appeared within ${TIMEOUT}ms`, false, err.message);
  printConsoleErrors(err.consoleErrors);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
