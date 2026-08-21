// Unit tests for the two link-api calls whose ENDPOINT is the whole point.
//
// ADR-376 final review, C-2: the host panel's "Revoke" button called `deleteLink` with an
// `InboundLink.id`. That id is an API-KEY id, but `DELETE /api/v1/links/:id` filters
// `cfg.links` — the records for hosts this machine links OUT to, a different namespace
// entirely. The server answered `{ok:true}`, the UI refetched, the row was still there,
// and the peer's token kept working forever. Both were `string`, so nothing caught it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteLink, revokeInbound, mintLink, type ApiKeyId, type LinkRecordId } from './link-api'

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
