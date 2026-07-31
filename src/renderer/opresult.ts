import type { OpResult } from '../shared/types'

// Redeclared rather than imported from src/main/policy.ts so the renderer
// bundle never pulls in a main-process module. Main is the enforcer; this copy
// is only for display and for what the dialog sends back.
export const CONFIRM_WORD = 'CONFIRM'

/**
 * ONE confirm shape for the whole renderer (KAN-57).
 *
 * It started welded to the main-process policy round-trip and that is why
 * SpaceMenu and FileBrowser each hand-rolled their own `.modal-backdrop`
 * instead of reusing it. Exactly one field did the welding — a `retry` that
 * re-invoked an IPC op — so widening that one field is smaller than extracting
 * a shared shell, and it ends with one dialog rather than three plus a shell.
 */
export interface ConfirmRequest {
  /** The question. One sentence, naming exactly what is lost. */
  reason: string
  /** Type-to-confirm (CONFIRM_WORD). Set only by the main-process policy path
   *  below; a purely-renderer confirm leaves it absent — main re-validates the
   *  word, so a renderer-only action has nothing to send it to. */
  typed?: boolean
  /** Label of the danger button. Default 'Continue'. */
  confirmLabel?: string
  /** Do it. `word` is what was typed ('' when `typed` is falsy); a
   *  renderer-only action ignores it. Sync or async — the dialog closes when it
   *  settles. */
  confirm(word: string): void | Promise<void>
}

/**
 * Runs a policy-gated operation.
 *  - success            → returns the value
 *  - DENIED / ERROR     → onMessage(reason), returns undefined
 *  - NEEDS_CONFIRM      → onConfirm(request), returns undefined
 * The caller supplies `run` so the retry re-invokes the identical operation
 * with a confirm value; main re-validates it, so this is not a trust hole.
 */
export async function unwrap<T>(
  run: (confirm?: string) => Promise<OpResult<T>>,
  onMessage: (msg: string) => void,
  onConfirm: (req: ConfirmRequest) => void,
): Promise<T | undefined> {
  const r = await run()
  if (r.ok) return r.value
  if (r.code === 'NEEDS_CONFIRM') {
    onConfirm({
      reason: r.reason,
      typed: r.typed,
      confirm: async (confirm: string) => {
        const again = await run(confirm)
        if (!again.ok) onMessage(again.reason)
      },
    })
    return undefined
  }
  onMessage(r.reason)
  return undefined
}
