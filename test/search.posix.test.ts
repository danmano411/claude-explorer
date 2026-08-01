import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

/**
 * KAN-90. resolveRg() hardcoded `@vscode/ripgrep-win32-${arch}/bin/rg.exe` and
 * `<resources>/rg.exe`. Off Windows both candidates are names of files that do
 * not exist, so it returns null and search degrades to filename-only on every
 * query, forever, with no error the user can act on.
 *
 * The per-platform packages are already optional dependencies in the lockfile
 * (@vscode/ripgrep-darwin-x64/-arm64, -linux-x64/-arm64) and ship `bin/rg` with
 * no extension, so this is a naming fix rather than a dependency.
 *
 * resolveRg() reads process.platform at CALL time, so no module reload is
 * needed — just move the platform around the call. node:path is the host's, so
 * expectations are built with the same join() the module uses.
 */

const box = vi.hoisted(() => ({ isPackaged: false, appPath: '/app', exists: (_p: string): boolean => false }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return box.isPackaged
    },
    getAppPath: () => box.appPath,
  },
}))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const existsSync = (p: unknown) => box.exists(String(p))
  return { ...real, existsSync, default: { ...real, existsSync } }
})

const { resolveRg } = await import('../src/main/search')

const RESOURCES = '/Applications/Claude Explorer.app/Contents/Resources'

function on(platform: string, opts: { packaged?: boolean; exists: (p: string) => boolean }): string | null {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const realResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  Object.defineProperty(process, 'resourcesPath', { value: RESOURCES, configurable: true })
  box.isPackaged = opts.packaged ?? false
  box.exists = opts.exists
  try {
    return resolveRg()
  } finally {
    Object.defineProperty(process, 'platform', realPlatform)
    if (realResources) Object.defineProperty(process, 'resourcesPath', realResources)
    else delete (process as unknown as Record<string, unknown>).resourcesPath
    box.isPackaged = false
    box.exists = () => false
  }
}

const pkg = (p: string, arch: string, exe: string) =>
  join('/app', `node_modules/@vscode/ripgrep-${p}-${arch}/bin/${exe}`)

beforeEach(() => {
  box.appPath = '/app'
})

describe('resolveRg picks the platform\'s own ripgrep package', () => {
  it('macOS arm64, unpackaged', () => {
    const target = pkg('darwin', 'arm64', 'rg')
    expect(on('darwin', { exists: (p) => p === target })).toBe(target)
  })

  it('macOS x64, unpackaged', () => {
    const target = pkg('darwin', 'x64', 'rg')
    expect(on('darwin', { exists: (p) => p === target })).toBe(target)
  })

  it('Linux x64, unpackaged', () => {
    const target = pkg('linux', 'x64', 'rg')
    expect(on('linux', { exists: (p) => p === target })).toBe(target)
  })

  it('Linux arm64, unpackaged', () => {
    const target = pkg('linux', 'arm64', 'rg')
    expect(on('linux', { exists: (p) => p === target })).toBe(target)
  })

  it('does NOT look for the Windows package off Windows', () => {
    // The whole defect in one line: a machine that has ONLY the win32 package
    // present (which is what a checkout carried over from a Windows box looks
    // like) must not resolve it on POSIX — that binary cannot execute there.
    const win = pkg('win32', 'x64', 'rg.exe')
    expect(on('darwin', { exists: (p) => p === win })).toBeNull()
  })

  it('packaged: the resource is `rg`, with no extension', () => {
    const target = join(RESOURCES, 'rg')
    expect(on('darwin', { packaged: true, exists: (p) => p === target })).toBe(target)
    expect(on('linux', { packaged: true, exists: (p) => p === target })).toBe(target)
    // ...and the .exe spelling is not what it asks for any more.
    expect(on('linux', { packaged: true, exists: (p) => p === join(RESOURCES, 'rg.exe') })).toBeNull()
  })

  it('still returns null rather than throwing when nothing is installed', () => {
    expect(on('linux', { exists: () => false })).toBeNull()
  })
})

describe('Windows is unchanged', () => {
  it('unpackaged: the win32 package, rg.exe', () => {
    const target = pkg('win32', 'x64', 'rg.exe')
    expect(on('win32', { exists: (p) => p === target })).toBe(target)
  })

  it('unpackaged arm64: the win32 arm64 package', () => {
    const target = pkg('win32', 'arm64', 'rg.exe')
    expect(on('win32', { exists: (p) => p === target })).toBe(target)
  })

  it('packaged: <resources>/rg.exe, exactly as it shipped', () => {
    const target = join(RESOURCES, 'rg.exe')
    expect(on('win32', { packaged: true, exists: (p) => p === target })).toBe(target)
  })
})
