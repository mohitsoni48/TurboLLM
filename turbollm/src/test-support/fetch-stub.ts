/** A globalThis.fetch stub for fetch_url tests that behaves like real fetch where the tests
 *  depend on it: the RequestInit is honoured, in particular init.signal — an abort rejects the
 *  pending body read, which is what the timeout-budget tests exercise. Without the signal
 *  wiring, a test that would only fail if its timeout fired could never fail at all. */
export function stubFetch(handler: (url: string) => Response) {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal
    if (signal?.aborted) throw signal.reason
    const resp = handler(String(input))
    if (!signal || !resp.body) return resp
    const body = resp.body
    const wired = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = body.getReader()
        const onAbort = () => {
          reader.cancel().catch(() => {})
          try { controller.error(signal.reason) } catch { /* already closed */ }
        }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) {
              try { controller.close() } catch { /* consumer cancelled */ }
              break
            }
            if (controller.desiredSize === null) break // consumer cancelled
            controller.enqueue(value)
          }
        } catch (e) {
          try { controller.error(e) } catch { /* already errored or closed */ }
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      },
      cancel(reason) { body.cancel(reason).catch(() => {}) },
    })
    const wrapped = new Response(wired, { status: resp.status, statusText: resp.statusText, headers: resp.headers })
    // A handler can mark the URL that answered (the redirect tests do): keep it on the wrapper.
    if (resp.url) Object.defineProperty(wrapped, 'url', { value: resp.url })
    return wrapped
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = original } }
}
