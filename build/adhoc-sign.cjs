// electron-builder afterPack hook (macOS only).
//
// The release is not signed with a Developer ID, so electron-builder skips
// signing and leaves Electron's per-binary "linker" signatures. Those have no
// sealed resources, so `codesign --verify` fails and Gatekeeper hangs the launch
// with no dialog. An ad-hoc signature over the whole bundle is valid, so macOS
// shows its normal "Open Anyway" prompt instead. Skipped when a real identity
// is configured (electron-builder signs in that case).
//
// Deliberately NO `--options runtime`. Hardened runtime kills Electron's V8
// JIT unless allow-jit entitlements are added — KAN-92's reason for turning
// down electron-builder's `mac.identity: "-"`, which enables it. Without the
// flag the signature is `flags=0x2(adhoc)` and the app runs normally
// (measured; see package.yml's macOS comment).
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK || process.env.CSC_NAME) return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
