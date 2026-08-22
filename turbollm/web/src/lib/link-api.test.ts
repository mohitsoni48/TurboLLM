// Unit tests for the two link-api calls whose ENDPOINT is the whole point.
//
// ADR-376 final review, C-2: the host panel's "Revoke" button called `deleteLink` with an
// `InboundLink.id`. That id is an API-KEY id, but `DELETE /api/v1/links/:id` filters
// `cfg.links` — the records for hosts this machine links OUT to, a different namespace
// entirely. The server answered `{ok:true}`, the UI refetched, the row was still there,
// and the peer's token kept working forever. Both were `string`, so nothing caught it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelRemoteDownload,
  deleteLink,
  listRemoteDownloads,
  mintLink,
  remoteLoad,
  remoteUnload,
  revokeInbound,
  startRemoteDownload,
  type ApiKeyId,
  type LinkRecordId,
} from './link-api'
import { ApiError } from './api'

beforeEach(() => {
  vi.restoreAllMocks()
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
})

function okFetch(body: unknown = { ok: true }) {
  const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
    JSON.stringify(body),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('revokeInbound', () => {
  it('deletes the API KEY, not a link record', async () => {
    const mock = okFetch()
    await revokeInbound('key-123' as ApiKeyId)
    expect(mock.mock.calls[0][0]).toBe('/api/v1/keys/key-123')
    expect((mock.mock.calls[0][1] as RequestInit).method).toBe('DELETE')
  })

  it('never touches the links route — that was the shipped no-op', async () => {
    const mock = okFetch()
    await revokeInbound('key-123' as ApiKeyId)
    expect(String(mock.mock.calls[0][0])).not.toContain('/api/v1/links')
  })
})

describe('deleteLink', () => {
  it('still removes a peer-side link record, which is a different thing entirely', async () => {
    const mock = okFetch()
    await deleteLink('link-1' as LinkRecordId)
    expect(mock.mock.calls[0][0]).toBe('/api/v1/links/link-1')
  })
})

describe('mintLink', () => {
  it('sends the preset through, so the server can record the telemetry dimension', async () => {
    const mock = okFetch({ keyId: 'k', linkString: 'tllink_x' })
    await mintLink({ name: 'laptop', capabilities: ['models:use'], preset: 'inference' })
    const body = JSON.parse((mock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.preset).toBe('inference')
  })
})

// ─── The peer-side admin proxy calls (ADR-376 phase 3, tasks 5b + 6) ────────────
//
// Same reasoning as `revokeInbound` above, and the same shipped bug to avoid: the SCREEN
// test proves the component picked the remote mutation, but only these prove the mutation
// reaches the remote ROUTE. Nothing else in the suite would notice if `remoteLoad` were
// pointed at `/api/v1/engine/start` — the very call that aborts every in-flight generation
// and then loads a different local model.
describe('the remote model actions', () => {
  it('loads through the LINK route, never the local engine route', async () => {
    const mock = okFetch()
    await remoteLoad('l1' as LinkRecordId, 'qwen3')
    expect(mock.mock.calls[0][0]).toBe('/api/v1/links/l1/load')
    expect((mock.mock.calls[0][1] as RequestInit).method).toBe('POST')
    expect(String(mock.mock.calls[0][0])).not.toContain('/engine/')
  })

  it('sends the model key, since an empty body means "re-load whatever was last loaded"', async () => {
    const mock = okFetch()
    await remoteLoad('l1' as LinkRecordId, 'qwen3')
    expect(JSON.parse((mock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ modelKey: 'qwen3' })
  })

  it('unloads through the link route, with no body', async () => {
    const mock = okFetch()
    await remoteUnload('l1' as LinkRecordId)
    expect(mock.mock.calls[0][0]).toBe('/api/v1/links/l1/unload')
    expect((mock.mock.calls[0][1] as RequestInit).method).toBe('POST')
  })

  it('percent-encodes a link id rather than splicing it into the path raw', async () => {
    const mock = okFetch()
    await remoteUnload('a/b' as LinkRecordId)
    expect(mock.mock.calls[0][0]).toBe('/api/v1/links/a%2Fb/unload')
  })
})

describe('the remote download actions', () => {
  it('reads one machine\'s queue from that machine\'s route', async () => {
    const mock = okFetch({ downloads: [{ id: 'd1', name: 'a.gguf' }] })
    const out = await listRemoteDownloads('l1' as LinkRecordId)
    expect(mock.mock.calls[0][0]).toBe('/api/v1/links/l1/downloads')
    expect(out).toHaveLength(1)
  })

  it('starts a download on the host with repo + rfilename', async () => {
    const mock = okFetch()
    await startRemoteDownload('l1' as LinkRecordId, { repo: 'o/r', rfilename: 'a.gguf', size: 10 })
    expect(mock.mock.calls[0][0]).toBe('/api/v1/links/l1/downloads')
    expect((mock.mock.calls[0][1] as RequestInit).method).toBe('POST')
    const body = JSON.parse((mock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toMatchObject({ repo: 'o/r', rfilename: 'a.gguf', size: 10 })
  })

  it('cancels a specific download on a specific machine, both ids encoded', async () => {
    const mock = okFetch()
    await cancelRemoteDownload('l1' as LinkRecordId, 'd 1')
    expect(mock.mock.calls[0][0]).toBe('/api/v1/links/l1/downloads/d%201')
    expect((mock.mock.calls[0][1] as RequestInit).method).toBe('DELETE')
  })
})

describe('the typed failure envelope', () => {
  function failFetch(status: number, error: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error }),
      { status, headers: { 'content-type': 'application/json' } },
    )))
  }

  it('lifts the capability a host 403 named, so the UI can say WHICH permission is missing', async () => {
    // Previously asserted only by hand-setting `e.capability` on a locally-built ApiError
    // in a component test, so the whole extraction path from the HTTP body was untested.
    failFetch(403, { code: 'forbidden', message: 'x', capability: 'models:load' })
    const err = await remoteLoad('l1' as LinkRecordId, 'k').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('forbidden')
    expect((err as ApiError).capability).toBe('models:load')
  })

  it('preserves the host\'s distinct codes rather than flattening them', async () => {
    for (const [status, code] of [[503, 'host_busy'], [409, 'model_not_loaded'], [503, 'unavailable']] as const) {
      failFetch(status, { code, message: 'x' })
      const err = await remoteUnload('l1' as LinkRecordId).catch((e) => e)
      expect((err as ApiError).code).toBe(code)
      expect((err as ApiError).status).toBe(status)
    }
  })

  it('leaves capability undefined when the host named none', async () => {
    failFetch(503, { code: 'host_busy', message: 'x' })
    const err = await remoteUnload('l1' as LinkRecordId).catch((e) => e)
    expect((err as ApiError).capability).toBeUndefined()
  })
})
