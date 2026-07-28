import { useEffect, useMemo, useState } from 'react'
import type { ReadResult } from '../../shared/types'
import { HIGHLIGHT_MAX_CHARS, highlightToHtml, langForPath } from '../highlight'

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

/**
 * Plain-text fallback, shaped EXACTLY like Shiki's output (`pre.shiki > code >
 * span.line`) so the highlighted version drops in with no reflow and the CSS
 * line-number counter works from the very first paint.
 *
 * Built as one HTML string rather than React nodes on purpose: a capped file is
 * still 20k lines, and reconciling 20k spans costs far more than a single
 * innerHTML parse. Escaping `& < >` is sufficient here — this is element
 * content, never an attribute value.
 */
function plainHtml(code: string): string {
  const lines = code
    .split('\n')
    .map((l) => `<span class="line">${l.replace(/[&<>]/g, (c) => ESC[c])}</span>`)
    .join('\n')
  return `<pre class="shiki"><code>${lines}</code></pre>`
}

/**
 * Read-only file viewer tab.
 *
 * Renders plain text immediately and upgrades to highlighted HTML when Shiki
 * resolves, so a large file never blocks the first paint. Refusals from main
 * ('binary' / 'toolarge') are ordinary informative states with a plain sentence
 * and an escape hatch — an image is not an error.
 */
export function Viewer({ filePath, mode = 'file' }: { filePath: string; mode?: 'file' | 'diff' }) {
  const [res, setRes] = useState<ReadResult | null>(null)
  const [lit, setLit] = useState<string | null>(null)

  useEffect(() => {
    let dead = false
    setRes(null)
    setLit(null)
    const req = mode === 'diff' ? window.api.gitDiff(filePath) : window.api.fsRead(filePath)
    // The contract says these never reject, but a missing handler still would,
    // and a blank pane is a worse answer than a sentence.
    req
      .catch((e): ReadResult => ({ ok: false, kind: 'error', reason: String(e) }))
      .then((r) => { if (!dead) setRes(r) })
    return () => { dead = true }
  }, [filePath, mode])

  useEffect(() => {
    if (!res?.ok || !res.content) return
    // A diff is not one language; the diff surface owns its own rendering.
    const lang = mode === 'diff' ? null : langForPath(filePath)
    if (!lang || res.content.length > HIGHLIGHT_MAX_CHARS) return
    let dead = false
    highlightToHtml(res.content, lang).then((h) => { if (!dead && h) setLit(h) })
    return () => { dead = true }
  }, [res, filePath, mode])

  // Memoised so a re-render never re-escapes a multi-megabyte file.
  const plain = useMemo(() => (res?.ok ? plainHtml(res.content) : ''), [res])

  if (!res) return <div className="viewer-note">Reading…</div>

  if (!res.ok) {
    return (
      <div className="viewer-note">
        <p>{res.kind === 'binary' ? 'This file is binary, so there is no text to show.' : res.reason}</p>
        {res.kind !== 'error' && (
          <button className="viewer-open" onClick={() => window.api.openPath(filePath)}>
            Open in default app
          </button>
        )}
      </div>
    )
  }

  if (!res.content) return <div className="viewer-note">This file is empty.</div>

  return (
    <div className="viewer">
      {res.truncated && (
        <p className="viewer-banner">
          Showing the first {res.lines.toLocaleString()} lines of a longer file.
        </p>
      )}
      <div className="viewer-code" dangerouslySetInnerHTML={{ __html: lit ?? plain }} />
    </div>
  )
}
