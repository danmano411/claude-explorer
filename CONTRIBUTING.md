# Contributing to Claude Explorer

Thanks for your interest! This is a small, focused project — contributions of all sizes are welcome.

## Getting set up

```bash
git clone https://github.com/danmano411/claude-explorer.git
cd claude-explorer
npm install
npm run dev
```

You'll need Node 20+ and, to actually launch sessions, [Claude Code](https://claude.com/claude-code) on your `PATH`. Development targets Windows; node-pty ships a prebuilt N-API binary, so no compiler toolchain is required.

## Before you open a PR

- **Run the tests:** `npm test` (Vitest). Add tests for new logic — the pure modules under `src/shared` and `src/renderer` are the easy places to unit-test.
- **Type-check:** `npx tsc --noEmit` should be clean.
- **Smoke-test the build:** `npm run package` should produce an installer without errors if you touched build config or main-process code.
- Keep changes focused. One concern per PR is easier to review than a grab-bag.

## Project layout

- `src/main/` — Electron main process: file operations, trash/undo staging, PTY spawning, IPC handlers.
- `src/preload/` — the `window.api` bridge (context-isolated).
- `src/shared/` — the frozen IPC contract (`ipc.ts`), shared types, and pure helpers (`pathutil.ts`).
- `src/renderer/` — React UI: tabs, file browser, navigation, undo stack, selection model.
- `test/` — Vitest unit tests.

The IPC contract in `src/shared/ipc.ts` is the seam between processes. If you add a channel, update the channel constants **and** the `Api` interface, then wire the main-process handler and the preload bridge to match.

## Style

Match the surrounding code — no separate linter config to fight with. Prefer small, focused files over large ones.

## Reporting bugs

Open an issue with your Windows version, what you did, what you expected, and what happened. Console output (from `npm run dev`) helps a lot.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE), the same license as the project.
