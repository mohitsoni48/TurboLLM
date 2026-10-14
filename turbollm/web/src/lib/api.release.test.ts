// Release-source API client (issue #276): URL, method and encoding of the five new routes.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listReleaseAssets,
  startReleaseInstall,
  getReleaseInstall,
  discardReleaseInstall,
  updateEngine,
} from './api'

describe('release source api', () => {
  let calls: { url: string; method?: string; body: unknown }[]

  beforeEach(() => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      })
      return new Response(JSON.stringify({ ok: true, state: 'idle' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
  })

  it('listReleaseAssets GETs with the repo URL-encoded', async () => {
    await listReleaseAssets('PrismML-Eng/llama.cpp')
    expect(calls[0].url).toBe('/api/v1/engines/release/assets?repo=PrismML-Eng%2Fllama.cpp')
    expect(calls[0].method).toBeUndefined()
  })

  it('startReleaseInstall POSTs the plan as JSON', async () => {
    const plan = { repo: 'a/b', tag: 't1', asset: 'x.zip' }
    await startReleaseInstall(plan)
    expect(calls[0].url).toBe('/api/v1/engines/release/install')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toEqual(plan)
  })

  it('getReleaseInstall GETs the job view', async () => {
    const view = await getReleaseInstall()
    expect(calls[0].url).toBe('/api/v1/engines/release/install')
    expect(view.state).toBe('idle')
  })

  it('discardReleaseInstall with no binPath aborts (no query string)', async () => {
    await discardReleaseInstall()
    expect(calls[0].url).toBe('/api/v1/engines/release/install')
    expect(calls[0].method).toBe('DELETE')
  })

  it('discardReleaseInstall encodes the binPath', async () => {
    await discardReleaseInstall('C:\\e\\build\\a b\\llama-server.exe')
    expect(calls[0].url).toBe(
      `/api/v1/engines/release/install?binPath=${encodeURIComponent('C:\\e\\build\\a b\\llama-server.exe')}`,
    )
    expect(calls[0].method).toBe('DELETE')
  })

  it('updateEngine POSTs /engines/:id/update with the id encoded', async () => {
    await updateEngine('eng/1')
    expect(calls[0].url).toBe('/api/v1/engines/eng%2F1/update')
    expect(calls[0].method).toBe('POST')
  })

  describe('listReleaseAssets no_compatible_asset', () => {
    const rows = [{ name: 'x-mac.zip', size: 1, os: 'macos', arch: 'arm64', backend: 'cpu', cudaVersion: null, compatible: false, reason: 'macOS build', recommended: false, companions: [] }]

    it('keeps the 404 rows as a noCompatible listing', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ error: { code: 'no_compatible_asset', message: 'none' }, assets: rows }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      )))
      const listing = await listReleaseAssets('a/b')
      expect(listing.noCompatible).toBe(true)
      expect(listing.repo).toBe('a/b')
      expect(listing.assets).toEqual(rows)
    })

    it('other errors still throw ApiError', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ error: { code: 'github_rate_limited', message: 'slow down' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      )))
      await expect(listReleaseAssets('a/b')).rejects.toMatchObject({ code: 'github_rate_limited' })
    })
  })
})
