// Regression coverage for the eject-targets-the-wrong-engine bug (ADR-389 follow-up):
// stopEngine() used to send an empty body no matter what, so the backend had no way to
// know WHICH model an eject click meant and always stopped the primary manager. Ejecting
// an embedding model loaded into its own pool slot actually stopped a running chat model
// instead.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stopEngine } from './api'

describe('stopEngine', () => {
  let calls: { url: string; body: unknown }[]

  beforeEach(() => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(init.body as string) : undefined })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
  })

  it('sends the given model key in the request body', async () => {
    await stopEngine('bge-m3')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/v1/engine/stop')
    expect(calls[0].body).toEqual({ modelKey: 'bge-m3' })
  })

  it('sends no model key when called with none (unchanged default behavior)', async () => {
    await stopEngine()
    expect(calls[0].body).toEqual({ modelKey: undefined })
  })
})
