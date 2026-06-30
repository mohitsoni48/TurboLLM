// Engine prefill-progress tap for agent runs.
//
// Agent turns run through the pi SDK, which talks to llama-server with the
// official OpenAI client. pi-ai exposes no fetch hook and its ProviderResponse
// carries no body, so there's no SDK seam to read the raw engine stream — yet
// llama.cpp's `return_progress` extension emits `prompt_progress` chunks in that
// stream that the plain Chat path already turns into a "Processing prompt — N%"
// bar. To get the same bar in the Agent tab we install ONE global fetch wrapper
// that, *only* for requests carrying our run header, tees the response: one
// branch goes to the OpenAI client untouched, the other is sniffed for
// `prompt_progress` and forwarded to that run's progress sink.
//
// It is deliberately defensive: any failure in the tee/parse falls back to the
// original, unmodified response so a tap bug can never break an agent run.

export interface PrefillProgress {
  phase: 'prompt'
  processed: number
  total: number
  pct: number
  tps: number
}

/** Header that marks an engine request as belonging to an agent run + names it,
 *  so the tap routes progress to the right run and ignores everything else
 *  (foreground chat, other fetches). */
export const RUN_HEADER = 'x-turbollm-run'

const sinks = new Map<string, (p: PrefillProgress) => void>()
let installed = false

/** Register a progress callback for a run id. Call before the run's engine
 *  traffic starts; always pair with {@link unregisterRunProgress} in a finally. */
export function registerRunProgress(runId: string, onProgress: (p: PrefillProgress) => void): void {
  sinks.set(runId, onProgress)
}

export function unregisterRunProgress(runId: string): void {
  sinks.delete(runId)
}

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

/** Pull our run header out of a fetch() call's arguments (it can live on a
 *  Request object or on the init.headers in any of Headers/array/record form). */
function runIdFromFetchArgs(input: FetchInput, init?: FetchInit): string | undefined {
  const read = (h: unknown): string | undefined => {
    if (!h) return undefined
    if (h instanceof Headers) return h.get(RUN_HEADER) ?? undefined
    if (Array.isArray(h)) return (h as [string, string][]).find(([k]) => k.toLowerCase() === RUN_HEADER)?.[1]
    const rec = h as Record<string, string>
    for (const k of Object.keys(rec)) if (k.toLowerCase() === RUN_HEADER) return rec[k]
    return undefined
  }
  return read(init?.headers) ?? (input instanceof Request ? read(input.headers) : undefined)
}

/** Parse llama.cpp SSE text for `prompt_progress` and emit to the sink. Tolerant
 *  of partial lines across chunks via the carried `buf`. */
function scanForProgress(buf: string, onProgress: (p: PrefillProgress) => void): string {
  let rest = buf
  let nl: number
  while ((nl = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, nl).trim()
    rest = rest.slice(nl + 1)
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const obj = JSON.parse(payload) as { prompt_progress?: { processed?: number; total?: number; tps?: number } }
      const pp = obj.prompt_progress
      if (pp && pp.total) {
        const processed = pp.processed ?? 0
        onProgress({ phase: 'prompt', processed, total: pp.total, pct: Math.round((processed / pp.total) * 100), tps: pp.tps ?? 0 })
      }
    } catch { /* not a JSON data line (or split mid-line) — ignore */ }
  }
  return rest // carry any trailing partial line into the next chunk
}

/** Install the global fetch wrapper once. Idempotent; safe to call at startup. */
export function installEngineProgressTap(): void {
  if (installed) return
  installed = true
  const realFetch = globalThis.fetch
  if (typeof realFetch !== 'function') return

  globalThis.fetch = async function tappedFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
    const runId = runIdFromFetchArgs(input, init)
    const sink = runId ? sinks.get(runId) : undefined
    const res = await realFetch(input, init)
    if (!sink || !res.body) return res
    try {
      // Tee: branch `a` is handed back to the OpenAI client unchanged; branch `b`
      // is consumed here purely to sniff prompt_progress.
      const [a, b] = res.body.tee()
      void (async () => {
        const reader = b.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf = scanForProgress(buf + decoder.decode(value, { stream: true }), sink)
          }
        } catch { /* stream aborted/closed — nothing to do */ }
      })()
      return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers })
    } catch {
      // Anything unexpected → return the untouched response so the run is unaffected.
      return res
    }
  }
}
