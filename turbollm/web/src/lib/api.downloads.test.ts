// File downloads that must carry the API key and report failure: the auto-tune run log (was a
// plain `<a href>`, which can't send X-TurboLLM-Auth, so over LAN/remote it saved the daemon's 401
// JSON) and the chat export (swallowed every error, so a failed export did nothing at all).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, downloadBenchLog, downloadChatExport } from './api'

beforeEach(() => {
  localStorage.setItem('tllm.authToken', 'k-123')
  // jsdom has no Blob-URL APIs; clicking a real <a href="blob:..."> would log a navigation warning.
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => {
  localStorage.removeItem('tllm.authToken')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('downloadBenchLog', () => {
  it('fetches the log with the API key and saves it under the daemon\'s filename', async () => {
    const fetchMock = vi.fn(async () => new Response('{"runs":[]}', {
      status: 200,
      headers: { 'Content-Disposition': 'attachment; filename="autotune-m-2026-10-13.json"' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    let saved = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved = this.download })

    await downloadBenchLog()

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/bench/log')
    expect(init.headers).toMatchObject({ 'X-TurboLLM-Auth': 'k-123' })
    expect(saved).toBe('autotune-m-2026-10-13.json')
  })

  it('rejects with the daemon\'s error instead of saving it as the log', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'no_bench_log', message: 'No auto-tune log available.' } }), { status: 404 },
    )))
    await expect(downloadBenchLog()).rejects.toThrow('No auto-tune log available.')
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })
})

describe('downloadChatExport', () => {
  it('rejects on a failed export so the caller can tell the user', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'unauthorized', message: 'API key required.' } }), { status: 401 },
    )))
    await expect(downloadChatExport('c1')).rejects.toBeInstanceOf(ApiError)
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it('rejects on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(downloadChatExport('c1')).rejects.toThrow('Failed to fetch')
  })

  it('resolves once the export has been handed to the browser', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    await expect(downloadChatExport('c1')).resolves.toBeUndefined()
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1)
  })
})
