// GenerationGate — priority-queue mutex shared between the foreground chat SSE
// handler and the background agent runner. Foreground ('fg') requests jump ahead
// of queued background ('bg') callers so the user's chat always feels snappy.
// Acquired once per engine call; released before tool execution.

interface Waiter {
  priority: 'fg' | 'bg'
  grant: (release: () => void) => void
  giveUp: (err: Error) => void
}

/** How long a waiter sits queued before self-healing by giving up (default, when the caller
 *  doesn't pass its own timeoutMs). A caller can legitimately wait behind a long generation, but
 *  3 minutes of QUEUE TIME (not generation time — the clock starts only once something else
 *  already holds the gate) covers every normal case seen in practice; past that, the current
 *  holder almost certainly leaked its release (an exception that escaped its own cleanup path,
 *  or a downstream hang) rather than genuinely still being busy. */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 180_000

export class GenerationGate {
  private held = false
  private queue: Waiter[] = []

  /**
   * Acquire the gate. Resolves with a release function once granted.
   *
   * Found live (2026-07-13): the original version of this method took no `signal`/timeout at
   * all — a waiter queued behind a stuck holder (one whose release got skipped by a bug
   * somewhere in ITS OWN cleanup path — an exception escaping a try/finally, an aborted request
   * whose completion hook never fires, etc.) hung FOREVER with no way out, and since callers
   * (code-session.ts's before_provider_request hook and its invoke_skill tool) awaited this
   * BEFORE entering their own try/finally, calling Stop couldn't unstick it either — pi's own
   * session.abort() itself waits for the agent to go idle, which never happens while a tool call
   * is stuck on an unresolvable acquire(). One stuck holder therefore permanently wedged EVERY
   * future 'bg' acquisition system-wide (Code turns, invoke_skill, memory/distiller/reviewer,
   * chat's autoTitle — everything that shares this one gate), recoverable only by restarting the
   * daemon. Fixed two ways, both REJECTING rather than silently granting access on give-up —
   * silently proceeding risks two concurrent requests hitting the same local engine instance,
   * which is a worse failure mode (engine instability/crash) than a clean, catchable error:
   *   1. `signal`, when given, lets the CALLER'S OWN cancellation (e.g. the user hitting Stop)
   *      actually give up on a stuck wait instead of blocking it forever.
   *   2. `timeoutMs` (default {@link DEFAULT_ACQUIRE_TIMEOUT_MS}) is an unconditional last-resort
   *      self-heal against a LEAKED hold from any cause, including ones not yet found — every
   *      acquire() call gets this protection whether or not its caller passes a signal.
   */
  async acquire(priority: 'fg' | 'bg', opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<() => void> {
    if (!this.held) {
      this.held = true
      return this.makeRelease()
    }
    return new Promise<() => void>((resolvePromise, rejectPromise) => {
      const signal = opts?.signal
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const waiter: Waiter = {
        priority,
        grant: (release) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          clearTimeout(timer)
          resolvePromise(release)
        },
        giveUp: (err) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          clearTimeout(timer)
          rejectPromise(err)
        },
      }

      const removeFromQueue = () => {
        const i = this.queue.indexOf(waiter)
        if (i !== -1) this.queue.splice(i, 1)
      }
      const onAbort = () => { removeFromQueue(); waiter.giveUp(new Error('gate_acquire_aborted')) }

      if (signal?.aborted) { waiter.giveUp(new Error('gate_acquire_aborted')); return }
      signal?.addEventListener('abort', onAbort, { once: true })

      timer = setTimeout(() => {
        removeFromQueue()
        console.warn(`[gate] acquire('${priority}') timed out after ${timeoutMs}ms still queued — the current holder likely leaked its release without calling it. Rejecting instead of silently granting access, to avoid two concurrent requests hitting the same engine.`)
        waiter.giveUp(new Error('gate_acquire_timeout'))
      }, timeoutMs)

      if (priority === 'fg') {
        // fg jumps ahead of all bg waiters
        const firstBg = this.queue.findIndex((w) => w.priority === 'bg')
        this.queue.splice(firstBg >= 0 ? firstBg : this.queue.length, 0, waiter)
      } else {
        this.queue.push(waiter)
      }
    })
  }

  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.queue.shift()
      if (next) next.grant(this.makeRelease())
      else this.held = false
    }
  }
}
