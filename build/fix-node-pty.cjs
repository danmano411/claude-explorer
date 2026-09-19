// postinstall (POSIX only). node-pty ships a `spawn-helper` binary that must be
// executable. Its own install script normally sets that, but npm now skips
// dependency install scripts unless approved, leaving the bit unset — and every
// pty.spawn() then fails with "posix_spawnp failed", so terminal and Claude tabs
// open but nothing can be typed into them. Fixing it here also covers the copy
// electron-builder packs into app.asar.unpacked.
const fs = require('node:fs')
const path = require('node:path')

if (process.platform === 'win32') process.exit(0)
const dir = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds')
if (!fs.existsSync(dir)) process.exit(0)
for (const arch of fs.readdirSync(dir)) {
  const helper = path.join(dir, arch, 'spawn-helper')
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
}
