// A stand-in for the app's in-app TurboLLM SDK HTTP server (architecture §4.3), as an injected `fetch`: tests that
// drive the attached engine path open no socket (plan §0.4, ADR-215).

export interface SentSdkRequest {
  method: string
  path: string
  authorization: string | null
  body: unknown
}

/** One reply to a route, or 'unreachable' for a request that fails as a refused connection does. */
export type SdkReply = { status: number; body?: unknown } | 'unreachable'

export const sdkAccepted: SdkReply = { status: 202, body: { state: 'loading' } }

export function sdkStatus(state: string, extra: Record<string, unknown> = {}): SdkReply {
  return { status: 200, body: { state, ...extra } }
}

/** The reply to GET /sdk/v1/engines (ADR-462): the SDK's engine catalog, entries as given. */
export function sdkEnginesReply(data: unknown[]): SdkReply {
  return { status: 200, body: { object: 'list', data } }
}

/** Answers each `"<METHOD> <path>"` route from its own queue of replies (the last one repeats; an unknown route is a
 *  404) and records every request it was sent. */
export function fakeSdk(routes: Record<string, SdkReply[]>) {
  const sent: SentSdkRequest[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    sent.push({
      method,
      path: url.pathname,
      authorization: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const reply = nextReply(routes[`${method} ${url.pathname}`] ?? [{ status: 404 }])
    if (reply === 'unreachable') throw new TypeError('fetch failed')
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status })
  }) as typeof globalThis.fetch
  const routesCalled = () => sent.map((r) => `${r.method} ${r.path}`)
  return { fetch, sent, routesCalled }
}

function nextReply(queue: SdkReply[]): SdkReply {
  return queue.length > 1 ? (queue.shift() as SdkReply) : queue[0]
}
