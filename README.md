<p align="center">
  <img src="img/icon.png" alt="" width="128" height="128">
</p>

<h1 align="center">Claude Explorer</h1>

<p align="center">
  A Windows file manager built around one thing: launching
  <a href="https://claude.com/claude-code">Claude Code</a> from any folder in one click —
  and keeping every session you start somewhere you can actually see it.
</p>

---

## Quickstart

Requires [Claude Code](https://claude.com/claude-code) on your `PATH`. Claude Explorer launches your existing `claude` CLI; it does not bundle one.

**Option A — Installer**
1. Download the latest `Claude Explorer Setup x.y.z.exe` from the [Releases page](https://github.com/danmano411/claude-explorer/releases).
2. Run it. You get a Desktop shortcut and a Start Menu entry; right-click the app → **Pin to taskbar** to pin it.
3. Running a newer installer later upgrades in place, keeping your recent folders, settings and workspace.

**Option B — Build from source**
```bash
git clone https://github.com/danmano411/claude-explorer.git
cd claude-explorer
npm install
npm run package          # → dist/Claude Explorer Setup x.y.z.exe
```
Then run the installer in `dist/`. For live development instead, `npm run dev`.

## What it is, and why it exists

If you live in Claude Code, you spend a surprising amount of your day `cd`-ing into a project and typing `claude`. Then doing it again in another terminal for another project. Then losing track of which window was which.

Claude Explorer collapses that. It browses your filesystem like File Explorer does — rename, copy, move, delete, undo — but every folder row has an arrow that opens a Claude Code session in that directory, inside the app, in a tab.

The interesting part is what happens once you have several. Sessions live in **spaces**: separate, named workspaces you switch between, each remembering its own tabs and layout. One space per project — and the app tells you when a session in a space you *aren't* looking at is waiting on you. That is the whole design goal: running several Claude sessions at once without any of them quietly stalling on a permission prompt you never saw.

Editing stays in Claude. The file viewer is read-only on purpose — this app's job is to *supervise* the AI doing the editing (browse, launch, watch, review the diff), not to be a worse version of two tools you already have.

## Features

**Spaces.** Named workspaces you switch between with `Ctrl+1..9`, each with its own tabs, layout and remembered active tab. Pin the ones you always want — they separate to the top of the list and take `Ctrl+Shift+1..9` — give each a soft background colour so you can tell at a glance which project you are in, and cycle with `Ctrl+Tab`. Every one of those keybinds is rebindable in Settings.

**It tells you when Claude needs you.** Sessions report what they are actually doing — working, waiting on your permission, finished — read from Claude Code's own hooks rather than guessed from terminal output. A session blocked in another space marks its tab, its space, and the spaces menu, so it cannot sit there unnoticed. The markers are always on; a sound (off by default) and a desktop notification (asked on first run) are yours to opt into.

**One click from any folder.** An arrow on every folder row opens Claude Code there. Or start from the CLI (`claude-explorer --open <path>`), or straight from a Windows Explorer context menu.

**Open Recent.** Recent folders *and* resumable Claude sessions, read straight from `~/.claude/projects`. Pick up an old conversation without remembering a session id or touching a terminal.

**Four kinds of tab, one window.** A tab is independently a folder listing, a read-only file viewer, a Claude session, or a plain shell. Group them into tab folders, split the window into a grid of panes, pin the ones you never want to lose. It all comes back on restart.

**See what Claude changed.** In a git repo every row carries git's own status letter, deleted files leave a struck-through ghost row, and **Show changes** opens a coloured unified diff with real file line numbers — the number you type back into Claude, not a position within the diff. The gutter refreshes when the terminal next door goes quiet, so it keeps up with a session that is editing while you watch.

**Search.** Bundled ripgrep across both filenames and file contents — honouring `.gitignore` in Explorer mode, searching everything in Developer mode.

**Let Claude drive the app.** A loopback-only MCP server gives sessions four tools: list tabs, close a tab, open a file in the viewer, open a new Claude session. See [Agent control](#agent-control).

**Safety, in two modes.** Explorer mode hides system noise and refuses to mutate system paths at all; Developer mode unlocks that behind a typed confirmation. Deletes stage to a same-drive trash first, so `Ctrl+Z` genuinely undoes them.

And the ordinary things work: drag and drop with Windows move/copy conventions, multiselect, tab colours and reordering, back/forward/refresh, an editable address bar, full undo/redo.

## Agent control

Claude sessions this app launches receive an `--mcp-config` pointing at a loopback HTTP server on an ephemeral port, authenticated with a bearer token minted per app run that never touches disk. The server binds to `127.0.0.1` only, and the token is the whole authentication — an unauthenticated local process gets a 401.

Four tools, deliberately: `list_tabs`, `close_tab`, `open_viewer_tab`, `open_claude_session`. A session spawned *by* an agent receives neither the tools nor the token, so fan-out cannot compound. `open_claude_session` has a free allowance (default 8 concurrent) past which it asks you — it throttles, it never refuses outright. One switch in Settings takes the entire surface away.

## Safety

- **Explorer mode** (default) — behaves like File Explorer. Hidden files and Windows noise (`.git`, `$Recycle.Bin`, `System Volume Information`, …) stay out of the listing, and anything that would mutate a **system path** is refused outright with a plain-English reason.
- **Developer mode** — hidden files and dotfiles appear, dimmed; mutating a system path is allowed behind a typed `CONFIRM`; `Shift+Del` performs a permanent delete that skips the trash and cannot be undone.

`C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData` and drive roots are system paths, and the rule matches the folder *and everything beneath it*. The app's own trash staging folder is off-limits in **both** modes, because changing it would break pending undo. Browsing is never restricted; only mutation is.

Every decision is made in the main process, not the UI, so no call site can forget to ask. This is a guardrail against mis-drags and mistaken deletes — yours or an AI's — not a security sandbox: the app runs a real shell for you on request.

## Updating

**Installed from a release:** Claude Explorer checks GitHub Releases on start, downloads new versions in the background, and offers to restart. Windows and Linux only — see [Platform support](#platform-support) for why macOS updates by hand.

**Built from source:** auto-update is off, since local builds are not tied to the release feed. `git pull && npm install && npm run package`, then run the freshly built installer.

## Platform support

**Windows** is the tested platform. Every release is built, run and QA'd there, and auto-update works.

**macOS** and **Linux** builds are produced from the same release as of v0.10.0. They are new — the packaging is verified in CI, but they have had far less real-world use than the Windows build. Please report anything that looks wrong.

| | Artifact | Auto-update |
|---|---|---|
| Windows | `Claude-Explorer-Setup-x.y.z.exe` | Yes |
| macOS (Apple Silicon) | `Claude-Explorer-x.y.z-arm64.dmg` | **No** — see below |
| macOS (Intel) | `Claude-Explorer-x.y.z-x64.dmg` | **No** — see below |
| Linux (x64) | `Claude-Explorer-x.y.z-x86_64.AppImage` | Yes |

### macOS: the app is unsigned, and Gatekeeper will say so

Claude Explorer is not signed with an Apple `Developer ID` certificate and is not notarized. That requires an Apple Developer Program membership at $99/year, which this project does not have. Nothing is wrong with your download — Apple simply has no way to attest to it.

The first time you open it you will get:

> **"Claude Explorer" cannot be opened because Apple cannot check it for malicious software.**

To open it anyway:

1. **Right-click** (or Control-click) the app in Applications and choose **Open**, then **Open** again in the dialog. Double-clicking will *not* offer this — the right-click menu is what unlocks it.
2. On Apple Silicon you may instead need **System Settings → Privacy & Security**, scroll to the message about Claude Explorer, and click **Open Anyway**.
3. If macOS instead insists the app **"is damaged and can't be opened"**, that is the quarantine flag rather than actual damage. Clear it:
   ```bash
   xattr -cr "/Applications/Claude Explorer.app"
   ```

You only have to do this once per installed version.

**Auto-update is switched off on macOS** as a direct consequence, deliberately rather than by accident. macOS verifies an update against the app's code signature before installing it, so an unsigned build cannot update itself; rather than download ~100 MB on every launch and fail at the last step, the app does not try. Watch the [Releases page](https://github.com/danmano411/claude-explorer/releases) and drag the new DMG over the old app. Windows and Linux update themselves normally.

### Linux

Download the AppImage, `chmod +x` it, and run it. It updates itself in place.

Two differences from Windows, neither a bug: the unread-session badge goes through the Unity Launcher API, so Unity, KDE and GNOME-with-Dash-to-Dock show it while plain GNOME Shell shows nothing (the in-app markers carry the feature either way), and **Open in Terminal** tries a list of known terminal emulators — with none of them installed it declines rather than guessing.

## Tech stack

Electron + electron-vite · React + TypeScript · [node-pty](https://github.com/microsoft/node-pty) · [@xterm/xterm](https://xtermjs.org/) · [Shiki](https://shiki.style) for syntax highlighting · bundled [ripgrep](https://github.com/BurntSushi/ripgrep) · Vitest + Playwright. Packaged with electron-builder — NSIS on Windows, DMG on macOS, AppImage on Linux.

## License

[Apache License 2.0](LICENSE) © Claude Explorer contributors.
