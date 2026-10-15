// GET /api/v1/connect/:cli can replace a CLI key, so the daemon (auth.ts lanAuth) refuses it
// without the X-TurboLLM-UI header, which a page on another site cannot add without a preflight.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getConnect } from './api'

describe('getConnect', () => {
  let calls: { url: string; method?: string; headers: Record<string, string> }[]

  beforeEach(() => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, headers: (init?.headers ?? {}) as Record<string, string> })
      return new Response(JSON.stringify({ cli: 'claude-code', snippets: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
  })

  it('GETs the encoded CLI name with the UI header the daemon requires', async () => {
    await getConnect('claude code')
    expect(calls[0].url).toBe('/api/v1/connect/claude%20code')
    expect(calls[0].method).toBeUndefined()
    expect(calls[0].headers['X-TurboLLM-UI']).toBe('1')
  })
})
