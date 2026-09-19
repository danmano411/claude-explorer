// CI assertion for package.yml's macOS legs: spawn one command through the
// PACKAGED app's node-pty, the way its main process does, and fail unless the
// command actually ran. Run under the app's own binary with
// ELECTRON_RUN_AS_NODE=1; argv[2] is node-pty's path INSIDE app.asar, and
// Electron redirects its native module and spawn-helper to app.asar.unpacked.
//
// The marker is computed by the shell, so it cannot appear unless the shell
// ran. A non-executable spawn-helper makes spawn() throw "posix_spawnp
// failed.", which exits non-zero on its own.
const pty = require(process.argv[2])
const p = pty.spawn('/bin/sh', ['-c', 'echo PTY_$((6*7))'], { cols: 80, rows: 24, cwd: '/tmp', env: process.env })
let out = ''
p.onData((d) => { out += d })
p.onExit(() => {
  if (!out.includes('PTY_42')) {
    console.error('pty ran but printed: ' + JSON.stringify(out))
    process.exit(1)
  }
  console.log('pty OK')
  process.exit(0)
})
setTimeout(() => {
  console.error('pty timed out, output so far: ' + JSON.stringify(out))
  process.exit(1)
}, 15000)
