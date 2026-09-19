// postinstall (POSIX only). node-pty spawns every macOS pty through its
// `spawn-helper` binary, which must be executable. node-pty 1.1.0's published
// tarball stores prebuilds/darwin-*/spawn-helper as 0644, and none of its own
// install scripts set the bit (post-install.js only handles Windows conpty),
// so EVERY install leaves it unusable — CI's included. Each pty.spawn() then
// throws "posix_spawnp failed." and terminal and Claude tabs open dead.
//
// Measured on a macos-26 arm64 runner: the shipped v0.10.0 DMG fails exactly
// so, and chmod +x on that one file alone makes it spawn. electron-builder
// copies the mode it finds here into app.asar.unpacked, so fixing it at install
// time covers `npm run dev` and the packaged app both; package.yml's "Verify a
// terminal can start" step asserts the packaged result.
//
// Delete this once node-pty ships the helper executable: check the next
// version with `npm pack node-pty@<v>` and `tar -tvzf` for -rwxr-xr-x.
const fs = require('node:fs')
const path = require('node:path')

if (process.platform === 'win32') process.exit(0)
const dir = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds')
if (!fs.existsSync(dir)) process.exit(0)
for (const arch of fs.readdirSync(dir)) {
  const helper = path.join(dir, arch, 'spawn-helper')
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
}
