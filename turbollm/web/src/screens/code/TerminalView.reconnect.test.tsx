// The daemon replays a PTY's scrollback to every new WebSocket (terminal-manager.ts), and
// useTerminalConnection reconnects after every unexpected drop — so TerminalView must wipe its
// xterm before a RE-connect's replay lands, or each Wi-Fi blip appends another copy of the history.
// Only when that replay is under the daemon's 512K-char cap (SCROLLBACK_CAP, pty-session.ts): a
// capped replay is just the newest output, and wiping would lose the older transcript an inline
// TUI (claude, pi) committed. It must wipe only the CONTENT (an ED clear), never reset() the
// terminal: RIS also drops a running TUI's alt screen / mouse / bracketed-paste modes, which a
// capped replay never restores. And only on the NORMAL buffer: on the alt screen the replay
// repaints the TUI over its last frame, while an erase would blank the parts it drew once.
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  terminals: [] as Array<{ reset: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; buffer: { active: { type: 'normal' | 'alternate' } } }>,
  opts: null as null | { onConnect?: () => void; onMessage?: (d: string) => void },
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options = {}
    reset = vi.fn()
    write = vi.fn()
    buffer = { active: { type: 'normal' as 'normal' | 'alternate' } }
    constructor() { h.terminals.push(this) }
    loadAddon() {}
    open() {}
    onResize() {}
    onData() {}
    focus() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('../../lib/terminal-connection', () => ({
  useTerminalConnection: (_id: string | null, opts: typeof h.opts) => {
    h.opts = opts
    return { send: () => {}, sendResize: () => {} }
  },
  createTerminalForSession: async () => ({ terminalId: 't1', created: true }),
}))

import { TerminalView } from './TerminalView'

beforeEach(() => {
  h.terminals.length = 0
  h.opts = null
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

// SGR reset (so the erase uses the default background) + cursor home + erase screen + erase
// scrollback: clears what is shown, keeps the terminal's modes.
const CLEAR = '\x1b[0m\x1b[H\x1b[2J\x1b[3J'
// The daemon's replay cap (SCROLLBACK_CAP in src/terminal/pty-session.ts), in chars.
const REPLAY_CAP = 512 * 1024

describe('TerminalView — reconnect scrollback replay', () => {
  it('clears the terminal content before a reconnect\'s replay, but never on the first connect', () => {
    render(<TerminalView sessionId="s1" onClose={() => {}} />)
    const term = h.terminals.at(-1)!
    h.opts!.onConnect!()
    h.opts!.onMessage!('$ history\r\n')
    expect(term.write.mock.calls).toEqual([['$ history\r\n']])

    h.opts!.onConnect!() // a dropped socket came back: the server is about to replay it all again
    h.opts!.onMessage!('$ history\r\n')
    h.opts!.onMessage!('live\r\n') // only the replay frame is preceded by the clear
    expect(term.write.mock.calls).toEqual([['$ history\r\n'], [CLEAR], ['$ history\r\n'], ['live\r\n']])
    // Content only: a full reset() would also turn off a running TUI's alt screen/mouse/paste modes.
    expect(term.reset).not.toHaveBeenCalled()
  })

  it('clears only for a replay under the daemon\'s cap; a capped one keeps the older transcript', () => {
    render(<TerminalView sessionId="s1" onClose={() => {}} />)
    const term = h.terminals.at(-1)!
    h.opts!.onConnect!()
    h.opts!.onMessage!('msg 1\r\n')

    const whole = 'x'.repeat(REPLAY_CAP - 1) // shorter than the cap: the PTY's whole output
    h.opts!.onConnect!()
    h.opts!.onMessage!(whole)
    expect(term.write.mock.calls.slice(1)).toEqual([[CLEAR], [whole]])

    const trimmed = 'y'.repeat(REPLAY_CAP) // at the cap: front-trimmed, the oldest lines are gone
    term.write.mockClear()
    h.opts!.onConnect!()
    h.opts!.onMessage!(trimmed)
    expect(term.write.mock.calls).toEqual([[trimmed]])
  })

  it('treats the first connect of a NEW terminal (session switch) as a first connect', () => {
    const { rerender } = render(<TerminalView sessionId="s1" onClose={() => {}} />)
    h.opts!.onConnect!()
    rerender(<TerminalView sessionId="s2" onClose={() => {}} />)
    const next = h.terminals.at(-1)!
    expect(next).not.toBe(h.terminals[0])
    h.opts!.onConnect!()
    h.opts!.onMessage!('$ s2\r\n')
    expect(next.write.mock.calls).toEqual([['$ s2\r\n']])
    expect(next.reset).not.toHaveBeenCalled()
  })

  it('leaves the alt screen alone on a reconnect (a TUI\'s replay repaints it over the last frame)', () => {
    render(<TerminalView sessionId="s1" onClose={() => {}} />)
    const term = h.terminals.at(-1)!
    h.opts!.onConnect!()
    h.opts!.onMessage!('\x1b[?1049hframe 1')
    term.buffer.active.type = 'alternate'
    h.opts!.onConnect!()
    h.opts!.onMessage!('\x1b[?1049hframe 2')
    expect(term.write.mock.calls).toEqual([['\x1b[?1049hframe 1'], ['\x1b[?1049hframe 2']])
    expect(term.reset).not.toHaveBeenCalled()
  })
})
