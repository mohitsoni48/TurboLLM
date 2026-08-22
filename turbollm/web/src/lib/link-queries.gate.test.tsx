// Turbo Link's experimental gate, front-end half (ADR-376, `daemon.experimental.turboLink`).
//
// Every merged fleet list — Models, Downloads, Engines, the chat model picker — reaches
// Turbo Link through exactly two roots: `useLinks` and `useRemoteModels`. Everything
// downstream is derived from what those two return: `machineOptions` hides the machine
// filter when there are no links, `showOrigin` is `links.length > 0`, `sourcesByLink`
// produces no remote rows for an empty link list, and the per-link fan-outs
// (`useRemoteDownloads`, `useRemoteEngines`) only query ONLINE links they are handed.
//
// So gating those two roots is what makes the whole front end fall back to local-only, and
// this file pins that: with the flag off, no request is even made, and both hooks report an
// empty fleet.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useLinks, useRemoteModels } from './link-queries'

const LINK = {
  id: 'l1', name: 'workstation', baseUrl: 'http://h:6996', status: 'online',
  grantedCapabilities: ['models:use'], machineIdChanged: false, lastError: null,
}
const REMOTE = { linkId: 'l1', machine: 'workstation', model: { key: 'Q', name: 'Q', quant: null, nativeCtx: null, vision: false, loaded: false } }

let requested: string[] = []

/** A fetch that serves settings with `turboLink` at the given value, plus a populated
 *  fleet. Records every path asked for, so "made no request" is testable — not merely
 *  "returned nothing", which a broken URL would also satisfy. */
function installFetch(turboLink: boolean) {
  requested = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input)
    requested.push(url)
    const json = (b: unknown) => new Response(JSON.stringify(b), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
    if (url.includes('/api/v1/settings')) {
      return json({ experimental: { memory: false, cloudDeploy: false, routines: false, turboLink } })
    }
    if (url.includes('/api/v1/links/models')) return json({ models: [REMOTE] })
    if (url.includes('/api/v1/links')) return json({ links: [LINK] })
    return new Response('nope', { status: 404 })
  }))
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the Turbo Link experimental gate on the front end', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('fetches links and remote models while the flag is on', async () => {
    installFetch(true)
    const links = renderHook(() => useLinks(), { wrapper })
    await waitFor(() => expect(links.result.current.data).toHaveLength(1))

    const models = renderHook(() => useRemoteModels(), { wrapper })
    await waitFor(() => expect(models.result.current.data).toHaveLength(1))
  })

  it('reports an empty fleet and asks the daemon for nothing while the flag is off', async () => {
    installFetch(false)
    const links = renderHook(() => useLinks(), { wrapper })
    const models = renderHook(() => useRemoteModels(), { wrapper })
    // The settings read has to land first — until it does, the gate is unknown and neither
    // query may run. Waiting on it is what makes the assertion below meaningful rather than
    // merely early.
    await waitFor(() => expect(requested.some((u) => u.includes('/api/v1/settings'))).toBe(true))
    await waitFor(() => expect(links.result.current.fetchStatus).toBe('idle'))

    expect(links.result.current.data ?? []).toEqual([])
    expect(models.result.current.data ?? []).toEqual([])
    // No request at all — not a request whose answer is discarded. A disabled feature that
    // still polls every 15 s is the thing this gate exists to prevent.
    expect(requested.filter((u) => u.includes('/api/v1/links'))).toEqual([])
  })
})
