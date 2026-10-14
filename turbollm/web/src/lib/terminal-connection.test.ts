// Regression coverage for the terminal-create/kill auth bug: createTerminalForSession and
// killTerminalForSession used a raw fetch() with no X-TurboLLM-Auth header and never signaled
// auth-signal.ts on a 401 — invisible on loopback (codeAuth waives the key requirement there)
// but a hard failure from any genuinely non-local client (LAN/mobile), where codeAuth always
// requires a key (auth.ts). Mirrors code-api.test.ts's localStorage/fetch stubbing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createTerminalForSession, killTerminalForSession, useTerminalConnection } from './terminal-connection'
import { setAuthToken } from './api'
import { isCodeAuthNeeded, clearCodeAuthNeeded } from './auth-signal'

beforeEach(() => {
  vi.restoreAllMocks()
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  clearCodeAuthNeeded()
})

describe('createTerminalForSession', () => {
  it('sends the stored key as X-TurboLLM-Auth', async () => {
    setAuthToken('my-secret-key')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ terminalId: 't1' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await createTerminalForSession('sess-1', 80, 24)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/code/sessions/sess-1/terminal',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-TurboLLM-Auth': 'my-secret-key' }) }),
    )
  })

  it('returns terminalId/created on success (201 = freshly created)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ terminalId: 't1' }), { status: 201 })))
    const result = await createTerminalForSession('sess-1', 80, 24)
    expect(result).toEqual({ terminalId: 't1', created: true })
  })

  it('returns created:false on a reused terminal (200)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ terminalId: 't1' }), { status: 200 })))
    const result = await createTerminalForSession('sess-1', 80, 24)
    expect(result).toEqual({ terminalId: 't1', created: false })
  })

  it('marks the shared code-auth-needed signal on a 401, and surfaces its message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'unauthorized', message: 'A valid API key is required to access Code from a non-host device.' } }),
      { status: 401 },
    )))

    const result = await createTerminalForSession('sess-1', 80, 24)

    expect(isCodeAuthNeeded()).toBe(true)
    expect(result).toEqual({ error: 'A valid API key is required to access Code from a non-host device.' })
  })

  it('surfaces the server error message on other non-OK responses without touching the auth signal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'invalid_input', message: 'Session has no repo root.' } }),
      { status: 400 },
    )))

    const result = await createTerminalForSession('sess-1', 80, 24)

    expect(isCodeAuthNeeded()).toBe(false)
    expect(result).toEqual({ error: 'Session has no repo root.' })
  })

  it('returns an error object (not null) on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const result = await createTerminalForSession('sess-1', 80, 24)
    expect(result).toEqual({ error: 'Failed to fetch' })
  })
})

describe('killTerminalForSession', () => {
  it('sends the stored key as X-TurboLLM-Auth', async () => {
    setAuthToken('my-secret-key')
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await killTerminalForSession('sess-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/code/sessions/sess-1/terminal/kill',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-TurboLLM-Auth': 'my-secret-key' }) }),
    )
  })
})

// ── useTerminalConnection: onMessage must never race the WebSocket's own open/message events ──
// Regression for a real, live bug: onmessage used to be attached by the CALLER (TerminalView.tsx)
// in a separate effect keyed on this hook's returned `ws` value, which only updates on React's
// NEXT re-render after `onopen` (itself scheduled, not synchronous with the socket's own event
// dispatch). The server sends its scrollback replay essentially the instant the connection
// completes — if that message arrived before the caller's effect got a chance to attach a
// listener, it was silently dropped. Symptom reported live: a Code-session terminal going blank
// on switching sessions, then working again a few switches later (a race that sometimes loses).
// Fixed by attaching onmessage synchronously inside connect(), in the SAME block as onopen/
// onclose/onerror — this test proves a message dispatched in the same synchronous call as open
// (the worst case for the old race) still reaches the caller.

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor(public url: string) {}

  /** Test helper standing in for the real server behavior: the connection opens AND the
   *  scrollback replay arrives in the same synchronous call — the exact worst case the old
   *  race needed luck to avoid. */
  openThenImmediatelyMessage(data: string): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
    this.onmessage?.({ data })
  }
}

describe('useTerminalConnection: onMessage race', () => {
  it('delivers a message dispatched in the same synchronous call as open (no separate attach step needed)', () => {
    let created: FakeWebSocket | null = null
    vi.stubGlobal('WebSocket', class extends FakeWebSocket {
      constructor(url: string) { super(url); created = this }
    })

    const onMessage = vi.fn()
    renderHook(() => useTerminalConnection('term-1', { onMessage }))

    expect(created).not.toBeNull()
    created!.openThenImmediatelyMessage('scrollback replay content')

    expect(onMessage).toHaveBeenCalledWith('scrollback replay content')
  })

  it('delivers every subsequent message too, not just the first', () => {
    let created: FakeWebSocket | null = null
    vi.stubGlobal('WebSocket', class extends FakeWebSocket {
      constructor(url: string) { super(url); created = this }
    })

    const onMessage = vi.fn()
    renderHook(() => useTerminalConnection('term-1', { onMessage }))

    created!.openThenImmediatelyMessage('first')
    created!.onmessage?.({ data: 'second' })
    created!.onmessage?.({ data: 'third' })

    expect(onMessage.mock.calls.map((c) => c[0])).toEqual(['first', 'second', 'third'])
  })
})

// ── useTerminalConnection: auto-reconnect ──
// Regressions: the reconnect wrapper was installed only on the FIRST socket and the reconnect
// timer ref was never cleared, so a terminal survived exactly one drop per mount; and a reconnect
// whose handshake took >2 s got a second socket opened alongside it (overwriting wsRef, never
// closed — PTY output arrived twice and unmount closed only one).
class ReconnectWs {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static all: ReconnectWs[] = []
  readyState = ReconnectWs.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  send = vi.fn()
  constructor(public url: string) { ReconnectWs.all.push(this) }
  open(): void { this.readyState = ReconnectWs.OPEN; this.onopen?.() }
  /** The network drops (or a handshake fails): an abnormal close. */
  drop(): void { this.readyState = ReconnectWs.CLOSED; this.onclose?.({ code: 1006, reason: '' }) }
  /** Like a browser: closing a socket that never finished its handshake reports 1006, not the code passed. */
  close(code = 1005): void {
    const reported = this.readyState === ReconnectWs.CONNECTING ? 1006 : code
    this.readyState = ReconnectWs.CLOSED
    this.onclose?.({ code: reported, reason: '' })
  }
}

describe('useTerminalConnection: auto-reconnect', () => {
  beforeEach(() => {
    ReconnectWs.all = []
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', ReconnectWs)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })
  const unclosed = () => ReconnectWs.all.filter((w) => w.readyState !== ReconnectWs.CLOSED)

  it('reconnects after every unexpected drop, not just the first one per mount', () => {
    const { result } = renderHook(() => useTerminalConnection('t1'))
    act(() => ReconnectWs.all[0].open())
    for (let drop = 1; drop <= 3; drop++) {
      act(() => ReconnectWs.all[drop - 1].drop())
      advance(600)
      expect(ReconnectWs.all).toHaveLength(drop + 1)
      act(() => ReconnectWs.all[drop].open())
      expect(result.current.state).toBe('connected')
    }
  })

  it('never opens a second socket while a slow reconnect handshake is still in flight', () => {
    const { unmount } = renderHook(() => useTerminalConnection('t1'))
    act(() => ReconnectWs.all[0].open())
    act(() => ReconnectWs.all[0].drop())
    advance(600) // reconnect #1 created, still CONNECTING
    advance(6000) // the old code opened another socket every 2 s here
    expect(ReconnectWs.all).toHaveLength(2)
    act(() => ReconnectWs.all[1].open())
    advance(10_000)
    expect(ReconnectWs.all).toHaveLength(2)
    unmount()
    expect(unclosed()).toHaveLength(0)
  })

  it('still gives up after 5 failed attempts', () => {
    const { result } = renderHook(() => useTerminalConnection('t1'))
    act(() => ReconnectWs.all[0].open())
    act(() => ReconnectWs.all[0].drop())
    for (let i = 0; i < 10; i++) {
      advance(2000)
      const last = ReconnectWs.all[ReconnectWs.all.length - 1]
      if (last.readyState === ReconnectWs.CONNECTING) act(() => last.drop())
    }
    expect(ReconnectWs.all).toHaveLength(1 + 5)
    expect(result.current.state).toBe('disconnected')
  })

  it('does not resurrect a socket the caller disconnected mid-handshake', () => {
    const { unmount } = renderHook(() => useTerminalConnection('t1'))
    act(() => ReconnectWs.all[0].open())
    act(() => ReconnectWs.all[0].drop())
    advance(600) // reconnect #1 CONNECTING
    unmount() // its close reports 1006
    advance(30_000)
    expect(ReconnectWs.all).toHaveLength(2)
    expect(unclosed()).toHaveLength(0)
  })
})
