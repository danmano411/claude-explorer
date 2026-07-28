import { Fragment, useEffect, useMemo, useState } from 'react'
import type { ReadResult } from '../../shared/types'
import { winBasename } from '../../shared/pathutil'
import { parseUnifiedDiff } from '../diffparse'

/**
 * The answer to "what did Claude just change?" — a read-only unified diff of one
 * file's working-tree changes.
 *
 * Unified, not side-by-side: at tab width a two-column view halves the space for
 * code that is mostly long lines, and it costs three times the layout code for
 * no extra information.
 *
 * Line numbers come from the @@ headers (see diffparse), so they are the file's
 * real numbers — the number you type into Claude, not a position in the diff.
 */
export function DiffView({ filePath }: { filePath: string }) {
  const [res, setRes] = useState<ReadResult | null>(null)

  useEffect(() => {
    let dead = false
    setRes(null)
    // The contract says gitDiff never rejects, but a missing handler still would,
    // and a blank pane is a worse answer than a sentence.
    window.api
      .gitDiff(filePath)
      .catch((e): ReadResult => ({ ok: false, kind: 'error', reason: String(e) }))
      .then((r) => { if (!dead) setRes(r) })
    return () => { dead = true }
  }, [filePath])

  const diff = useMemo(() => (res?.ok ? parseUnifiedDiff(res.content) : null), [res])

  if (!res) return <div className="viewer-note">Reading changes…</div>

  if (!res.ok) {
    return (
      <div className="viewer-note">
        <p>{res.reason}</p>
      </div>
    )
  }

  if (!diff || diff.binary) {
    return <div className="viewer-note"><p>This file changed, but it is binary — there is nothing to show line by line.</p></div>
  }

  if (!diff.hunks.length) {
    return (
      <div className="viewer-note">
        <p>No working-tree changes to show for this file.</p>
        <button className="viewer-open" onClick={() => window.api.openPath(filePath)}>
          Open in default app
        </button>
      </div>
    )
  }

  return (
    <div className="viewer">
      <div className="diff-head">
        <span className="diff-file">{winBasename(filePath)}</span>
        <span className="diff-stat add">+{diff.added}</span>
        <span className="diff-stat del">−{diff.removed}</span>
        <span className="diff-hunks">
          {diff.hunks.length} change{diff.hunks.length === 1 ? '' : 's'}
        </span>
      </div>
      {res.truncated && (
        <p className="viewer-banner">
          Showing the first {res.lines.toLocaleString()} lines of a longer diff.
        </p>
      )}
      {/* ponytail: one row per diff line, capped at MAX_LINES (20k) by main.
          Virtualise only if a 20k-line diff actually feels slow. */}
      <div className="viewer-code diff-body">
        <div className="diff-rows">
          {diff.hunks.map((h, hi) => (
            <Fragment key={hi}>
              <div className="drow hunk">
                <span className="dn" />
                <span className="dn" />
                <span className="dt">
                  @@ -{h.oldStart},{h.oldCount} +{h.newStart},{h.newCount} @@ {h.heading}
                </span>
              </div>
              {h.lines.map((l, li) => (
                <Fragment key={li}>
                  <div className={`drow ${l.kind}`}>
                    <span className="dn">{l.oldNo ?? ''}</span>
                    <span className="dn">{l.newNo ?? ''}</span>
                    <span className="dt">
                      {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}
                      {l.text}
                    </span>
                  </div>
                  {l.noNewline && (
                    <div className="drow meta">
                      <span className="dn" />
                      <span className="dn" />
                      <span className="dt">\ No newline at end of file</span>
                    </div>
                  )}
                </Fragment>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}
