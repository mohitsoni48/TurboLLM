// A clicked OSC 8 hyperlink in the Code terminal. xterm's default opens a blank window and then sets
// its location; the desktop app's window-open handler (wrapper/main.js) only ever sees about:blank
// there and denies it, so the click did nothing. The link must reach window.open as its own URL.
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type LinkHandler = { activate: (e: MouseEvent, uri: string) => void; allowNonHttpProtocols?: boolean }
const h = vi.hoisted(() => ({ options: [] as Array<{ linkHandler?: LinkHandler }> }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options = {}
    buffer = { active: { type: 'normal' } }
    constructor(opts: { linkHandler?: LinkHandler }) { h.options.push(opts) }
    loadAddon() {}
    open() {}
    onResize() {}
    onData() {}
    write() {}
    focus() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('../../lib/terminal-connection', () => ({
  useTerminalConnection: () => ({ send: () => {}, sendResize: () => {} }),
  createTerminalForSession: async () => ({ terminalId: 't1', created: true }),
}))

import { TerminalView } from './TerminalView'

beforeEach(() => {
  h.options.length = 0
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => vi.unstubAllGlobals())

describe('TerminalView — OSC 8 links', () => {
  it('opens a confirmed link by its own URL, with no opener', () => {
    render(<TerminalView sessionId="s1" onClose={() => {}} />)
    const handler = h.options.at(-1)?.linkHandler
    expect(handler).toBeTruthy()
    // http(s) only: xterm drops every other scheme before a handler without allowNonHttpProtocols.
    expect(handler!.allowNonHttpProtocols).toBeFalsy()

    const open = vi.fn(() => null)
    vi.stubGlobal('open', open)
    vi.stubGlobal('confirm', vi.fn(() => true))
    handler!.activate(new MouseEvent('click'), 'https://gcc.gnu.org/onlinedocs/gcc/Warning-Options.html')
    expect(open).toHaveBeenCalledWith('https://gcc.gnu.org/onlinedocs/gcc/Warning-Options.html', '_blank', 'noopener,noreferrer')
  })

  it('opens nothing when the user declines the confirm', () => {
    render(<TerminalView sessionId="s1" onClose={() => {}} />)
    const open = vi.fn(() => null)
    vi.stubGlobal('open', open)
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    h.options.at(-1)!.linkHandler!.activate(new MouseEvent('click'), 'https://example.com/')
    expect(confirm).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
  })
})
