// A dropped terminal socket is followed by up to five reconnect attempts (useTerminalConnection:
// 0.5 s, then every 2 s), and a browser fires `error` and then `close` 1006 on every handshake
// that fails. TerminalView toasted each of those events, so a 10-second outage (Wi-Fi blip, the
// daemon restarting) stacked 12 toasts. One per outage, until a socket opens again.
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options = {}
    buffer = { active: { type: 'normal' } }
    reset() {}
    write() {}
    loadAddon() {}
    open() {}
    onResize() {}
    onData() {}
    focus() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('../../components/ui/sonner', () => ({ toast: { warning: h.warning, error: h.error, success: vi.fn() } }))
// The real useTerminalConnection (its reconnect cycle is what produced the toasts); only the
// REST call that creates the PTY is stubbed.
vi.mock('../../lib/terminal-connection', async (orig) => ({
  ...(await orig<typeof import('../../lib/terminal-connection')>()),
  createTerminalForSession: async () => ({ terminalId: 't1', created: true }),
}))

import { TerminalView } from './TerminalView'

/** Like a browser's WebSocket: an unclean close fires `error`, then `close` 1006. */
class BrowserWs {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static all: BrowserWs[] = []
  readyState = BrowserWs.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  send = vi.fn()
  constructor(public url: string) { BrowserWs.all.push(this) }
  open(): void { this.readyState = BrowserWs.OPEN; this.onopen?.() }
  /** The network drops a live socket, or a handshake fails. */
  fail(): void {
    this.readyState = BrowserWs.CLOSED
    this.onerror?.(new Event('error'))
    this.onclose?.({ code: 1006, reason: '' })
  }
  close(): void { this.readyState = BrowserWs.CLOSED }
}

const toasts = () => h.warning.mock.calls.length + h.error.mock.calls.length
const last = () => BrowserWs.all[BrowserWs.all.length - 1]

describe('TerminalView — connection toasts', () => {
  beforeEach(() => {
    BrowserWs.all = []
    h.warning.mockClear()
    h.error.mockClear()
    vi.stubGlobal('WebSocket', BrowserWs)
    // Fires on observe(), as a real one does with the current size: that creates the PTY.
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: () => void) {}
      observe() { this.cb() }
      unobserve() {}
      disconnect() {}
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** A connected terminal, with fake timers from there on. */
  const connected = async () => {
    const view = render(<TerminalView sessionId="s1" onClose={() => {}} />)
    await act(async () => {}) // createTerminalForSession resolves, the hook opens its socket
    expect(BrowserWs.all).toHaveLength(1)
    vi.useFakeTimers()
    act(() => last().open())
    return view
  }

  /** The daemon is unreachable for `ms`: the live socket drops and every reconnect handshake fails. */
  const outage = (ms: number) => {
    const before = BrowserWs.all.length
    act(() => last().fail())
    for (let t = 0; t < ms; t += 100) {
      act(() => { vi.advanceTimersByTime(100) })
      if (BrowserWs.all.length > before && last().readyState === BrowserWs.CONNECTING) act(() => last().fail())
    }
  }

  it('a 10-second outage shows one toast, not one per failed reconnect', async () => {
    const { unmount } = await connected()
    outage(10_000)
    expect(BrowserWs.all.length).toBeGreaterThan(3) // it did keep retrying
    expect(toasts()).toBe(1)
    unmount()
  })

  it('a socket that opens again ends the outage: the next drop gets its own toast', async () => {
    const { unmount } = await connected()
    outage(3_000)
    expect(toasts()).toBe(1)
    act(() => { vi.advanceTimersByTime(2_000) })
    act(() => last().open()) // back
    expect(toasts()).toBe(1)
    outage(3_000)
    expect(toasts()).toBe(2)
    unmount()
  })
})
