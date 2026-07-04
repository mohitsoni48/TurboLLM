// In-memory pending tool-call approval registry (F-019 replacement).
// Keyed by `${convId}:${toolCallId}` — tool-call ids come from the LLM and are only
// unique within a single request, so we prefix with convId to avoid any cross-
// conversation collision. Entries are created by waitForToolApproval() and resolved
// either by resolveToolApproval() (a human clicked Allow/Deny) or by the caller's
// AbortSignal firing (generation was stopped/aborted — treated as a deny).
interface PendingApproval {
  resolve: (decision: 'allow' | 'deny') => void
  cleanup: () => void
}

const pending = new Map<string, PendingApproval>()

/**
 * Registers a pending approval for `key` and returns a Promise that resolves when
 * `resolveToolApproval(key, decision)` is called elsewhere, OR resolves to 'deny'
 * and cleans up if `signal` fires first. The abort listener is always removed and
 * the pending entry always deleted on every resolution path — no leaks.
 */
export function waitForToolApproval(key: string, signal: AbortSignal): Promise<'allow' | 'deny'> {
  return new Promise<'allow' | 'deny'>((resolvePromise) => {
    const onAbort = () => {
      pending.delete(key)
      resolvePromise('deny')
    }
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }
    pending.set(key, {
      resolve: (decision) => {
        cleanup()
        resolvePromise(decision)
      },
      cleanup,
    })
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Resolves the pending approval for `key`, if any. Returns true if a pending entry
 * existed and was resolved; returns false if no pending entry exists (already
 * resolved, expired, or never existed) — the caller should treat that as a 404.
 */
export function resolveToolApproval(key: string, decision: 'allow' | 'deny'): boolean {
  const entry = pending.get(key)
  if (!entry) return false
  pending.delete(key)
  entry.resolve(decision)
  return true
}
