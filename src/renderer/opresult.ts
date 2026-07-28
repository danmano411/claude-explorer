import type { OpResult } from '../shared/types'

// Redeclared rather than imported from src/main/policy.ts so the renderer
// bundle never pulls in a main-process module. Main is the enforcer; this copy
// is only for display and for what the dialog sends back.
export const CONFIRM_WORD = 'CONFIRM'

export interface ConfirmRequest {
  reason: string
  typed: boolean
  retry(confirm: string): Promise<void>
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
      retry: async (confirm: string) => {
        const again = await run(confirm)
        if (!again.ok) onMessage(again.reason)
      },
    })
    return undefined
  }
  onMessage(r.reason)
  return undefined
}
