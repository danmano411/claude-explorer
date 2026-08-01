// KAN-89: volume identity — the half of the path abstraction that needs the
// filesystem, so it lives in main. shared/pathutil.ts cannot host it: that file
// is bundled into the renderer, which has no node builtins. The renderer asks
// over CH.sameVolume instead.
//
// Nothing outside this file and shared/pathutil.ts may branch on the platform
// for path reasons.
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { driveKey, isWindows, sameDrive } from '../shared/pathutil'

/** st_dev, or null when the path cannot be stat'ed.
 *
 *  ALWAYS async, never statSync: a synchronous stat on an arbitrary user path
 *  freezes the whole window for the full SMB timeout on a dead UNC mount. That
 *  was KAN-65 (20,813 ms, unauthenticated) and KAN-68, and it is not being
 *  reintroduced through the back door of a path helper. */
async function devOf(p: string): Promise<number | null> {
  try {
    return (await stat(p)).dev
  } catch {
    return null
  }
}

/** Are `a` and `b` on the same volume — i.e. is a move a rename rather than a
 *  copy+delete? Two shipped behaviours ride on this: drag-and-drop (same volume
 *  is a move, across volumes a copy) and trash staging (undo is only a rename
 *  when the staging bucket is on the deleted item's own volume).
 *
 *  Windows: a pure string compare of drive letter / UNC share — byte-for-byte
 *  what shipped through 0.9.0, and no fs call, so no stall.
 *  POSIX: a real st_dev compare. There is no string answer there; every path
 *  hangs off one root and mount points are invisible in the path itself.
 *
 *  ponytail: a path that will not stat answers "different volume", i.e. copy.
 *  Both callers then keep the source — the opposite default loses it. In
 *  practice the caller's own operation fails immediately afterwards anyway. */
export async function sameVolume(a: string, b: string): Promise<boolean> {
  if (isWindows) return sameDrive(a, b)
  const [da, db] = await Promise.all([devOf(a), devOf(b)])
  return da !== null && da === db
}

/** The root of the volume `p` lives on — somewhere a same-volume staging
 *  directory can be created (trash.ts). "C:\" or "\\\\server\\share" on
 *  Windows; the mount point on POSIX. */
export async function volumeRootOf(p: string): Promise<string> {
  if (isWindows) {
    const key = driveKey(p)
    return key.startsWith('\\\\') ? key : key.toUpperCase() + '\\'
  }
  // A path that is already gone still has a volume — describeStuck() reports on
  // originals that were deleted — so start from the nearest ancestor that
  // exists, then climb while st_dev is unchanged. Where it changes is the mount
  // point, and that is exactly the boundary rename() will not cross.
  // ponytail: O(depth) stats, uncached, per call. Memoise on the dirname if a
  // bulk delete of a deep tree ever shows up in a profile.
  let cur = p
  let dev = await devOf(cur)
  while (dev === null && dirname(cur) !== cur) {
    cur = dirname(cur)
    dev = await devOf(cur)
  }
  if (dev === null) return '/'
  for (;;) {
    const up = dirname(cur)
    if (up === cur || (await devOf(up)) !== dev) return cur
    cur = up
  }
}
