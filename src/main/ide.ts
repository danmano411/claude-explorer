import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { getSettings } from './settings'

// Windows CreateProcess does not PATH-resolve a bare command name, and Node refuses
// to spawn a .cmd/.bat without a shell — the exact problem resolveClaude() solves in
// pty.ts, so we solve it the same way instead of reaching for shell:true.
// shell:true pasted the folder into a cmd.exe command line unquoted: a folder named
// "research & development" ran `development` as a command.
function resolveIde(cmd: string): string {
  if (process.platform !== 'win32' || isAbsolute(cmd)) return cmd
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const ext of ['.exe', '.cmd', '.bat', '']) {
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
