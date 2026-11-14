// Bounds for the daemon's NON-engine fetches. The daemon's global dispatcher has no headers/body timeout (an engine
// generation is legitimately silent for minutes, util/daemon-dispatcher.ts), so a registry or API call that never
// answers must carry its own deadline or it hangs forever.

/** A metadata call (GitHub / npm / PyPI / Hugging Face JSON): small bodies, answered in well under a second normally. */
export const API_TIMEOUT_MS = 30_000

/** A release LISTING (GitHub `releases?per_page=100`, up to three pages): each page's body can run to megabytes, and
 *  the deadline covers parsing it too, so a slow but healthy link needs longer than a metadata call. */
export const LISTING_TIMEOUT_MS = 120_000

/** `signal` (if any) combined with a `ms` deadline: aborts on whichever fires first. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

/** A signal that aborts after `ms` without `touch()` — stall detection for a long download, where a total deadline
 *  would kill a healthy slow transfer. Call `touch()` per received chunk and `stop()` when the transfer ends. */
export function createIdleAbort(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; touch: () => void; stop: () => void } {
  const ac = new AbortController()
  const abort = (reason: unknown): void => ac.abort(reason)
  let timer: NodeJS.Timeout
  const arm = (): void => {
    timer = setTimeout(() => abort(new Error(`no data received for ${Math.round(ms / 1000)} s`)), ms)
    timer.unref()
  }
  arm()
  const stop = (): void => clearTimeout(timer)
  const follow = (): void => { stop(); abort(signal?.reason) }
  if (signal?.aborted) follow()
  else signal?.addEventListener('abort', follow, { once: true })
  return {
    signal: ac.signal,
    touch: () => { stop(); if (!ac.signal.aborted) arm() },
    stop: () => { stop(); signal?.removeEventListener('abort', follow) },
  }
}
