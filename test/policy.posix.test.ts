import { describe, it, expect, vi } from 'vitest'
import { DEFAULT_SYSTEM_ROOTS, classify as winClassify } from '../src/main/policy'
import { isWindows } from '../src/shared/pathutil'

/**
 * KAN-90. policy.ts is the file-safety chokepoint, and through 0.9.0 every part
 * of it was drive letters and backslashes: `DEFAULT_SYSTEM_ROOTS` named four
 * `C:\` paths, `norm()` folded '/' onto '\', and `isDriveRoot()` matched `[a-z]:`
 * or a UNC share. Run unchanged on macOS or Linux it classifies EVERY path as
 * 'normal' — Explorer mode protects nothing at all, which is the failure this
 * ticket calls the highest-risk one in the fan-out.
 *
 * The POSIX arms are unreachable by calling the exports on Windows, so this
 * re-imports the module with process.platform forced, exactly as
 * volume.test.ts does for KAN-89. node:path is NOT reset by vi.resetModules,
 * which does not matter here: classify()/check() are pure string matching and
 * never touch it.
 *
 * The Windows behaviour is pinned by policy.test.ts, which is unchanged by this
 * ticket; the one Windows assertion below is here only to prove the two
 * platforms genuinely disagree, i.e. that the block above it measured the POSIX
 * arm and not a shared code path.
 */
const posix = await (async () => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  vi.resetModules()
  const mod = await import('../src/main/policy')
  Object.defineProperty(process, 'platform', real)
  vi.resetModules()
  return mod
})()

const cls = (p: string) => posix.classify(p)

describe('POSIX system roots are real protection', () => {
  it('flags the POSIX system directories and everything under them', () => {
    expect(cls('/etc')).toBe('system')
    expect(cls('/etc/hosts')).toBe('system')
    expect(cls('/usr/lib/python3.12')).toBe('system')
    expect(cls('/bin/sh')).toBe('system')
    expect(cls('/sbin/init')).toBe('system')
    expect(cls('/lib/systemd')).toBe('system')
    expect(cls('/boot/grub')).toBe('system')
    expect(cls('/System/Library/CoreServices')).toBe('system')
    expect(cls('/Library/LaunchDaemons')).toBe('system')
  })

  it('flags /private/etc — the spelling macOS gate() ACTUALLY sees', () => {
    // /etc is a symlink to /private/etc on macOS, and gate() canonicalises
    // through symlinks BEFORE classify() runs. A list holding only '/etc' is
    // therefore defeated by the guard's own resolution step: the delete arrives
    // spelled '/private/etc/hosts'.
    expect(cls('/private/etc/hosts')).toBe('system')
  })

  it('is still segment-aware, so a lookalike sibling is untouched', () => {
    expect(cls('/etcetera/notes.txt')).toBe('normal')
    expect(cls('/usrfiles')).toBe('normal')
    expect(cls('/home/dan/etc')).toBe('normal')
    expect(cls('/home/dan/usr/bin')).toBe('normal')
  })

  it('leaves the places a user actually keeps files alone', () => {
    expect(cls('/home/dan/projects/app')).toBe('normal')
    expect(cls('/Users/dan/Documents')).toBe('normal')
    // Dragging an app out of /Applications is how a mac uninstalls software;
    // guarding it would break the platform's most ordinary action.
    expect(cls('/Applications/Some App.app')).toBe('normal')
    // $TMPDIR on macOS. Protecting /var would deny every delete in the user's
    // own temp directory, which is why /var is deliberately not a root.
    expect(cls('/private/var/folders/qz/abc/T/scratch')).toBe('normal')
  })
})

describe('POSIX drive roots', () => {
  it('flags the filesystem root', () => {
    expect(cls('/')).toBe('driveRoot')
  })

  it('flags mount containers and the mounts inside them', () => {
    expect(cls('/Volumes')).toBe('driveRoot')
    expect(cls('/Volumes/Backup')).toBe('driveRoot')
    expect(cls('/mnt')).toBe('driveRoot')
    expect(cls('/mnt/data')).toBe('driveRoot')
    expect(cls('/media')).toBe('driveRoot')
    expect(cls('/media/dan')).toBe('driveRoot')
    expect(cls('/media/dan/USB Drive')).toBe('driveRoot') // udisks, Debian layout
    expect(cls('/run/media/dan/USB Drive')).toBe('driveRoot') // udisks, Fedora layout
  })

  it('a trailing separator does not change the answer', () => {
    expect(cls('/Volumes/Backup/')).toBe('driveRoot')
  })

  it('does NOT reach past the mount point — a folder ON the disk is ordinary', () => {
    // The over-protection half, and it is not hypothetical: /mnt/c is where WSL
    // puts the Windows C: drive, so a user browses under it constantly. Treating
    // it as a drive root would deny every operation in the tree.
    expect(cls('/Volumes/Backup/photos')).toBe('normal')
    expect(cls('/mnt/c/Users/dan/projects')).toBe('normal')
    expect(cls('/media/dan/USB Drive/notes.txt')).toBe('normal')
  })
})

describe('POSIX separators', () => {
  it('finds the trash directory as a path SEGMENT', () => {
    expect(cls('/home/dan/.claude-explorer-trash')).toBe('trash')
    expect(cls('/home/dan/.claude-explorer-trash/abc/f.txt')).toBe('trash')
  })

  it('does not split a POSIX filename that contains a backslash', () => {
    // A backslash is an ordinary character in a POSIX filename. Folding '/'
    // onto '\' — what the Windows arm does — turns this ONE file into two
    // segments, the second of which is the trash directory's name, and the app
    // then refuses to touch a perfectly legitimate file in BOTH modes.
    expect(cls('/home/dan/x\\.claude-explorer-trash')).toBe('normal')
    expect(cls('/home/dan/a\\b.txt')).toBe('normal')
  })
})

describe('the verdict a POSIX user actually gets', () => {
  it('denies a system path in Explorer mode and points at Developer mode', () => {
    const v = posix.check('delete', ['/etc/hosts'], 'explorer')
    expect(v.kind).toBe('deny')
    if (v.kind === 'deny') expect(v.reason).toContain('/etc/hosts')
  })

  it('demands the typed word in Developer mode', () => {
    const v = posix.check('delete', ['/usr/bin/env'], 'developer')
    expect(v.kind).toBe('confirm')
    if (v.kind === 'confirm') expect(v.typed).toBe(true)
  })

  it('blocks a mount point the same way a drive root is blocked on Windows', () => {
    expect(posix.check('delete', ['/Volumes/Backup'], 'explorer').kind).toBe('deny')
  })

  it('gate() refuses, and the exact word still gets through', async () => {
    // An identity resolver: canonicalisation is node:path's job and node:path is
    // still the host's here. What is under test is the classification, not the
    // walk — policy.test.ts covers the walk on the platform it can run on.
    const id = (p: string) => p
    expect(await posix.gate('delete', ['/etc/hosts'], 'explorer', undefined, undefined, id)).not.toBeNull()
    expect(await posix.gate('delete', ['/etc/hosts'], 'developer', undefined, undefined, id)).not.toBeNull()
    expect(await posix.gate('delete', ['/etc/hosts'], 'developer', posix.CONFIRM_WORD, undefined, id)).toBeNull()
    expect(await posix.gate('delete', ['/home/dan/notes.txt'], 'explorer', undefined, undefined, id)).toBeNull()
  })
})

describe.skipIf(!isWindows)('the two platforms really are different code paths', () => {
  it('the Windows roots are untouched and the Windows arm still answers Windows-shaped', () => {
    expect(DEFAULT_SYSTEM_ROOTS).toEqual([
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
    ])
    // The same input, the two arms, opposite answers — so nothing above was
    // measuring a shared code path that happens to agree.
    expect(winClassify('/etc/hosts')).toBe('normal')
    expect(cls('/etc/hosts')).toBe('system')
    expect(winClassify('C:\\Windows\\System32')).toBe('system')
    expect(cls('C:\\Windows\\System32')).toBe('normal')
  })
})
