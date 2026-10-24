// Unit tests for code-api.ts's session-export download (Phase 3, ADR-251) — the one function in
// this module that isn't a plain JSON req() call, so it gets its own focused coverage: real
// fetch/Blob/anchor-download plumbing, mocked at the browser API boundary (fetch, URL.createObjectURL,
// anchor.click), not the function's own logic.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodeSession, downloadCodeSessionExport, streamCodeSession } from './code-api'
import { ApiError } from './api'

// jsdom doesn't implement localStorage's methods by default (authHeaders() reads it on every
// call) — same gap CodeComposer.test.tsx already works around; stubbed locally, not in the
// shared src/test/setup.ts.
beforeEach(() => {
  vi.restoreAllMocks()
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  // jsdom doesn't implement the Blob-URL APIs, and clicking a real <a href="blob:..."> would log
  // a jsdom "not implemented: navigation" warning — both stubbed so the test exercises the real
  // download-trigger code path without either noise.
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

describe('createCodeSession', () => {
  it('sends the session name the user chose as `title`, so the daemon keeps it', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sessionId: 's1', convId: 'c1' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await createCodeSession({ repoRoot: '/work/repo', mode: 'auto', task: 'Fix the login bug', title: 'Login fix' })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ task: 'Fix the login bug', title: 'Login fix' })
  })
})

describe('downloadCodeSessionExport', () => {
  it('fetches the export URL, reads the real filename off Content-Disposition, and triggers a download', async () => {
    const blob = new Blob(['# hello'], { type: 'text/markdown' })
    const fetchMock = vi.fn(async () => new Response(blob, {
      status: 200,
      headers: { 'Content-Disposition': 'attachment; filename="my-session-2026-07-24.md"' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await downloadCodeSessionExport('sess-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/code/sessions/sess-1/export?format=markdown',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })

  it('falls back to a default filename when Content-Disposition is missing/unparsable', async () => {
    const blob = new Blob(['# hello'])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(blob, { status: 200 })))

    let capturedDownload = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      capturedDownload = this.download
    })

    await downloadCodeSessionExport('sess-1')
    expect(capturedDownload).toBe('code-session.md')
  })

  it('throws ApiError (not a generic Error) on a non-OK response, without attempting a download', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'not_found', message: 'Session not found.' } }),
      { status: 404 },
    )))

    await expect(downloadCodeSessionExport('missing')).rejects.toThrow(ApiError)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })
})

describe('streamCodeSession', () => {
  // Exactly hono's writeSSE framing: event, data, THEN id. The old parser yielded on the data
  // line with whatever an EARLIER id line had set, so during a live tail (one frame per read)
  // every seq was undefined and the reconnect cursor never advanced — a reconnect replayed the
  // whole turn and duplicated its text.
  const frame = (event: string, data: unknown, id?: number) =>
    [`event: ${event}`, `data: ${JSON.stringify(data)}`, id !== undefined && `id: ${id}`].filter(Boolean).join('\n') + '\n\n'
  const frames = [
    frame('meta', { assistantMessageId: 'a1' }), // the route's synthesized meta carries no id
    frame('meta', { assistantMessageId: 'a1' }, 0),
    frame('delta', { delta: 'Hel' }, 1),
    frame('delta', { delta: 'lo' }, 2),
  ]

  async function seqs(chunks: string[]): Promise<string[]> {
    const enc = new TextEncoder()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close() },
    }), { status: 200 })))
    const out: string[] = []
    for await (const ev of streamCodeSession('s1', 0, new AbortController().signal)) out.push(`${ev.event}@${ev.seq}`)
    return out
  }

  const expected = ['meta@undefined', 'meta@0', 'delta@1', 'delta@2']

  it('carries each frame\'s own id as seq during a live tail (one frame per read)', async () => {
    expect(await seqs(frames)).toEqual(expected)
  })

  it('carries each frame\'s own id as seq in a replay burst (all frames in one read)', async () => {
    expect(await seqs([frames.join('')])).toEqual(expected)
  })

  it('carries each frame\'s own id when a frame is split across reads (before its id line)', async () => {
    const all = frames.join('')
    const cut = all.indexOf('id: 1')
    expect(await seqs([all.slice(0, cut), all.slice(cut, cut + 3), all.slice(cut + 3)])).toEqual(expected)
  })
})
