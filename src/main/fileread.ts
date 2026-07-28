import { readFile, stat } from 'node:fs/promises'
import { humanizeFsError } from './fs'
import type { ReadResult } from '../shared/types'

export const MAX_BYTES = 5 * 1024 * 1024 // stat cap: never decode more than this
export const MAX_LINES = 20_000
export const MAX_CHARS = 2_000_000 // a minified bundle is ONE line; the line cap alone does nothing

/**
 * Read a file for the read-only viewer. Never throws: every refusal is a typed
 * arm of ReadResult, and 'binary' / 'toolarge' are normal outcomes with their
 * own UI, not faults.
 *
 * Guard order is load-bearing:
 *   1. size   — stat() first, so a 2GB file is refused without being read.
 *   2. binary — NUL byte in the first 8KB (the same heuristic git uses).
 *   3. BOM    — strip UTF-8 BOM, decode UTF-8. No charset sniffing.
 *   4. cap    — 20k lines AND 2M chars, flagged with truncated:true.
 *
 * Not policy-gated: reading is not mutation.
 */
export async function readTextFile(path: string): Promise<ReadResult> {
  let buf: Buffer
  try {
    const st = await stat(path)
    if (st.isDirectory()) return { ok: false, kind: 'error', reason: 'Not a file' }
    if (st.size > MAX_BYTES) {
      return {
        ok: false,
        kind: 'toolarge',
        reason: `Too large to preview (${(st.size / 1024 / 1024).toFixed(1)} MB)`,
      }
    }
    // Size is already bounded to MAX_BYTES, so one read is cheaper than an
    // open + 8KB probe + second read. The decode below is the expensive part,
    // and the binary check still runs before it.
    buf = await readFile(path)
  } catch (err) {
    return { ok: false, kind: 'error', reason: humanizeFsError(err) }
  }

  if (buf.subarray(0, 8192).includes(0)) {
    return { ok: false, kind: 'binary', reason: 'Binary file' }
  }

  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  let content = buf.toString('utf8', bom ? 3 : 0)

  let truncated = false
  if (content.length > MAX_CHARS) {
    content = content.slice(0, MAX_CHARS)
    truncated = true
  }
  const parts = content.split('\n')
  if (parts.length > MAX_LINES) {
    content = parts.slice(0, MAX_LINES).join('\n')
    truncated = true
  }
  return { ok: true, content, truncated, lines: Math.min(parts.length, MAX_LINES) }
}
