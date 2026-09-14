import { describe, it, expect, vi, afterEach } from 'vitest'
import { getRemoteStatus, startRemote, preflightRemote, isPublicProvider } from './remote-api'

const mockFetch = (body: unknown, status = 200) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))

afterEach(() => vi.unstubAllGlobals())

describe('remote-api', () => {
  it('reads status from /api/v1/remote/status', async () => {
    mockFetch({ provider: 'cloudflare-quick', enabled: true, state: { kind: 'connected', url: 'https://x.test' }, url: 'https://x.test' })
    const s = await getRemoteStatus()
    expect(s.provider).toBe('cloudflare-quick')
    expect(s.state.kind).toBe('connected')
  })

  it('surfaces the disabled code as a typed error rather than a bare failure', async () => {
    mockFetch({ error: { code: 'remote_access_disabled', message: 'off' } }, 403)
    await expect(getRemoteStatus()).rejects.toMatchObject({ code: 'remote_access_disabled' })
  })

  it('POSTs to start', async () => {
    const f = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ state: { kind: 'starting' } }), { status: 200 }))
    vi.stubGlobal('fetch', f)
    await startRemote()
    expect(f.mock.calls[0][0]).toBe('/api/v1/remote/start')
    expect((f.mock.calls[0][1] as RequestInit).method).toBe('POST')
  })

  it('sends the provider id when preflighting', async () => {
    const f = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ provider: 'ngrok', state: { kind: 'needs-setup', reason: 'x' } }), { status: 200 }))
    vi.stubGlobal('fetch', f)
    await preflightRemote('ngrok')
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string)).toEqual({ provider: 'ngrok' })
  })

  it('knows which providers are publicly reachable — Serve is not', () => {
    expect(isPublicProvider('tailscale-serve')).toBe(false)
    expect(isPublicProvider('tailscale-funnel')).toBe(true)
    expect(isPublicProvider('cloudflare-quick')).toBe(true)
    expect(isPublicProvider('cloudflare-named')).toBe(true)
    expect(isPublicProvider('ngrok')).toBe(true)
    expect(isPublicProvider('custom')).toBe(true)
  })
})
