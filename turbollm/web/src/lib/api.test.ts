// The Laya engine (huggingface.co/convaiinnovations/laya) is wired into the engine catalog the
// same way rapid-mlx/sglang/mlx-vlm are (ADR-044 pattern): one POST to install, the same route
// with ?update=1 to upgrade. This just asserts the client hits the exact endpoints the catalog's
// `installEndpoint: '/api/v1/engines/laya'` promises.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installLaya, updateLaya } from './api'

describe('installLaya / updateLaya', () => {
  let calls: { url: string; method: string | undefined }[]

  beforeEach(() => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method })
      return new Response(JSON.stringify({ accepted: true, engine: 'laya' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
  })

  it('installLaya POSTs the catalog install endpoint with no query string', async () => {
    const res = await installLaya()
    expect(calls).toEqual([{ url: '/api/v1/engines/laya', method: 'POST' }])
    expect(res).toEqual({ accepted: true, engine: 'laya' })
  })

  it('updateLaya POSTs the same endpoint with ?update=1', async () => {
    await updateLaya()
    expect(calls).toEqual([{ url: '/api/v1/engines/laya?update=1', method: 'POST' }])
  })
})
