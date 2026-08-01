import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { isWindows } from '../shared/pathutil'
import { getSettings } from './settings'

// Windows CreateProcess does not PATH-resolve a bare command name, and Node refuses
// to spawn a .cmd/.bat without a shell — the exact problem resolveClaude() solves in
// pty.ts, so we solve it the same way instead of reaching for shell:true.
// shell:true pasted the folder into a cmd.exe command line unquoted: a folder named
// "research & development" ran `development` as a command.
//
// KAN-90: the `platform !== 'win32'` escape hatch that used to sit on the first
// line was the same never-exercised guess resolveClaude() carried, and wrong for
// the same reason — the default setting is `code`, and VS Code's shell command
// installs to /usr/local/bin, which is NOT on the PATH a Dock-launched app
// inherits from launchd. libuv's own search would have found nothing. Scanning
// costs one existsSync per directory and makes the setting mean the same thing
// on all three platforms.
const POSIX_EXTRA_BIN = ['/opt/homebrew/bin', '/usr/local/bin']
function resolveIde(cmd: string): string {
  if (isAbsolute(cmd)) return cmd
  const dirs = (process.env.PATH || '').split(delimiter)
  if (!isWindows) dirs.push(...POSIX_EXTRA_BIN, join(homedir(), '.local', 'bin'))
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of isWindows ? ['.exe', '.cmd', '.bat', ''] : ['']) {
      const full = join(dir, cmd + ext)
      if (existsSync(full)) return full
    }
  }
  return cmd // last resort — libuv does its own PATH search and will surface ENOENT
}

// Splits a configured command into its executable and flags. Flags reach the child
// as argv entries, never as a command line, so they cannot inject.
function splitCommand(s: string): string[] {
  // A quoted first token is unambiguous: `"C:\Program Files\My IDE\ide.exe" -n`.
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    if (end > 0) return [s.slice(1, end), ...(s.slice(end + 1).match(/\S+/g) ?? [])]
  }
  // An unquoted path that exists as-is beats whitespace splitting, so a bare
  // `C:\Program Files\My IDE\bin\ide.cmd` is not shredded into three tokens.
  if (existsSync(s)) return [s]
  return s.match(/\S+/g) ?? []
}

// Launches the configured IDE against a folder. The folder is passed as cwd plus a
// literal "." argument, so no part of a user-controlled path ever reaches a command
// line — nothing in the name can be interpreted, whatever the shim underneath is.
export function openInIde(folder: string): void {
  // ideCommand may carry flags ("code -n", "subl -w"). Only the first token is a
  // program to resolve; dropping the rest would silently stop honouring the setting.
  const [cmd = 'code', ...flags] = splitCommand((getSettings().ideCommand || 'code').trim())
  const exe = resolveIde(cmd)
  const batch = /\.(cmd|bat)$/i.test(exe)
  const file = batch ? process.env.COMSPEC || 'cmd.exe' : exe
  const args = batch ? ['/c', exe, ...flags, '.'] : [...flags, '.']
  const child = spawn(file, args, { cwd: folder, detached: true, stdio: 'ignore' })
  // Without shell:true a missing IDE now emits ENOENT; unhandled, that kills main.
  child.on('error', (err) => console.error('openInIde:', exe, err.message))
  child.unref()
}
