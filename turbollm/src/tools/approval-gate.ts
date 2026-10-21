// In-memory pending tool-call approval registry (F-019 replacement).
// Keyed by `${convId}:${toolCallId}` — tool-call ids come from the LLM and are only
// unique within a single request, so we prefix with convId to avoid any cross-
// conversation collision. Entries are created by waitForToolApproval() and resolved
// either by resolveToolApproval() (a human clicked Allow/Deny), by the caller's
// AbortSignal firing (generation was stopped/aborted — treated as a deny), or, for a
// wait given a limit (a chat turn's, Settings' chatApprovalWaitMinutes), by that limit
// running out ('timeout').
interface PendingApproval {
  resolve: (decision: 'allow' | 'deny') => void
  cleanup: () => void
  /** The tool the pending call is for, as the generation saw it (never the approver's word). */
  toolName?: string
}

const pending = new Map<string, PendingApproval>()

/**
 * Registers a pending approval for `key` and returns a Promise that resolves when
 * `resolveToolApproval(key, decision)` is called elsewhere, OR resolves to 'deny'
 * and cleans up if `signal` fires first. The abort listener is always removed and
 * the pending entry always deleted on every resolution path — no leaks.
 *
 * `waitMs` > 0 also ends the wait with 'timeout' once that long has passed with no answer
 * (a chat turn's wait, so a call nobody answers does not hold the chat, its engine slot and,
 * on Android, the wake lock for good). Its timer is this wait's own, unref'd (it never keeps
 * the daemon alive), and cleared on every other way the wait ends. Unset or 0 waits until
 * answered, as Code's ask mode does.
 */
export function waitForToolApproval(key: string, signal: AbortSignal, toolName?: string): Promise<'allow' | 'deny'>
export function waitForToolApproval(key: string, signal: AbortSignal, toolName: string | undefined, waitMs: number): Promise<'allow' | 'deny' | 'timeout'>
export function waitForToolApproval(key: string, signal: AbortSignal, toolName?: string, waitMs = 0): Promise<'allow' | 'deny' | 'timeout'> {
  return new Promise<'allow' | 'deny' | 'timeout'>((resolvePromise) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
      if (timer !== undefined) clearTimeout(timer)
    }
    const onAbort = () => {
      cleanup()
      pending.delete(key)
      resolvePromise('deny')
    }
    const entry: PendingApproval = {
      resolve: (decision) => {
        cleanup()
        resolvePromise(decision)
      },
      cleanup,
      toolName,
    }
    pending.set(key, entry)
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (waitMs > 0) {
      timer = setTimeout(() => {
        cleanup()
        // Only this wait's own entry: the key's call may have been answered and asked again.
        if (pending.get(key) === entry) pending.delete(key)
        resolvePromise('timeout')
      }, waitMs)
      timer.unref?.()
    }
  })
}

/** The tool name `key`'s pending approval was registered with, or undefined when none is pending
 *  or it was registered without one (a chat's calls, execute-with-approval.ts, and a Code
 *  session's, code-session.ts, record it). The approve route decides on it as well as on the
 *  toolName its caller sends. */
export function pendingToolApprovalName(key: string): string | undefined {
  return pending.get(key)?.toolName
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
