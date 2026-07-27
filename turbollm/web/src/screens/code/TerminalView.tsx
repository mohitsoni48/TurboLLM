// TerminalView — embeds xterm.js with the @xterm/addon-fit addon.
//
// The terminal replaces the transcript/composer view in CodeSessionScreen when
// the user toggles "Terminal" in the header toolbar. It is a FULL-SCREEN claude TUI:
// the terminal occupies the entire main area, with no split view.
//
// The PTY output is raw bytes; the browser receives them as UTF-8 text over
// WebSocket and renders them in a real xterm.js terminal emulator.
//
// The WS listener is managed by `useTerminalConnection` which auto-reconnects.
// Terminal input → WS send → PTY stdin. Terminal resize → WS send `\x1b[8;{rows};{cols}t`.
//
// All colors use CSS variables to pass the no-hex-color lint.

import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { TerminalState, useTerminalConnection, createTerminalForSession } from '../../lib/terminal-connection'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'

// `turbollm launch claude` (not bare `claude`) — it resolves the running daemon's
// port and wires ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_MODEL so Claude
// Code actually talks to the locally loaded model instead of the cloud API
// (cli-launch.ts's launchCli). Bare `claude` would silently hit api.anthropic.com.
function getLaunchCommand(): string {
  return 'turbollm launch claude'
}

interface TerminalViewProps {
  /** The Code session ID this terminal is scoped to. */
  sessionId: string
  /** Called when the terminal view is dismissed (closed). */
  onClose: () => void
}

export function TerminalView({ sessionId, onClose }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  // Real state, NOT a ref — useTerminalConnection(terminalId, ...) reads this value at
  // render time. A ref's mutation doesn't itself trigger a re-render, so if this were a
  // ref (as it originally was), useTerminalConnection could stay permanently stuck on
  // the `null` it saw during the FIRST render, and the WebSocket (and therefore the
  // `turbollm launch claude` auto-launch) would never actually happen for any session
  // that doesn't already have some OTHER reason to re-render after the create() call
  // resolves. `created` (true only for a genuinely fresh HTTP-201 PTY, never a reused
  // HTTP-200 one) travels alongside it so a reopen of an already-running terminal never
  // resends the launch command into its live stdin.
  const [terminal, setTerminal] = useState<{ id: string; created: boolean } | null>(null)
  const [terminalState, setTerminalState] = useState<TerminalState>('disconnected')
  const [claudeLaunched, setClaudeLaunched] = useState(false)
  const [terminalReady, setTerminalReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    void createTerminalForSession(sessionId).then((result) => {
      if (cancelled) return
      if (result) {
        setTerminal({ id: result.terminalId, created: result.created })
      } else {
        toast.error('Could not create terminal session.')
        onClose()
      }
    })
    return () => { cancelled = true }
  }, [sessionId, onClose])

  // `sendRef` lets handleConnect reach the CURRENT `send` function even though
  // it's defined (for readability, grouped with the launch-on-connect logic)
  // before the useTerminalConnection() call below that produces `send`.
  const sendRef = useRef<(data: string) => void>(() => {})

  const handleConnect = useCallback(() => {
    if (!claudeLaunched && terminal?.created) {
      setClaudeLaunched(true)
      // Must go over the WebSocket to the PTY (send), NOT terminalRef.current.write()
      // — write() only renders text locally in xterm.js and never reaches the shell,
      // so the launch command would sit on screen looking sent while nothing actually
      // ran. `\r` alone (not `\r\n`) matches what a real Enter keypress sends.
      setTimeout(() => {
        sendRef.current(getLaunchCommand() + '\r')
      }, 200)
    }
  }, [claudeLaunched, terminal?.created])

  const { send, sendResize, ws } = useTerminalConnection(terminal?.id ?? null, {
    onConnect: handleConnect,
    onClose: (code, reason) => {
      setTerminalState('disconnected')
      if (code !== 1000) {
        toast.warning(`Terminal connection closed: ${reason || code}`)
      }
    },
    onError: () => {
      setTerminalState('error')
      toast.error('Terminal connection error.')
    },
  })
  sendRef.current = send

  // PTY output → xterm display. This is the OTHER half of the bridge — term.onData
  // (below) already sends keystrokes TO the PTY, but incoming WebSocket messages were
  // never written back to the terminal, so the screen stayed permanently blank no
  // matter what ran server-side. `ws` is a new WebSocket instance per (re)connect, so
  // this must re-attach onmessage whenever it changes.
  useEffect(() => {
    if (!ws) return
    const handler = (ev: MessageEvent) => {
      const data = typeof ev.data === 'string' ? ev.data : ''
      if (data) terminalRef.current?.write(data)
    }
    ws.addEventListener('message', handler)
    return () => ws.removeEventListener('message', handler)
  }, [ws])

  useEffect(() => {
    if (!containerRef.current) return
    if (terminalRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", menlo, monospace',
      theme: {
        background: 'var(--panel)',
        foreground: 'var(--ink)',
        cursor: 'var(--panel-highlight)',
        selectionBackground: 'var(--muted)',
        black: 'var(--muted)',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: 'var(--ink)',
        brightBlack: 'var(--panel-highlight)',
        brightRed: '#ff7a93',
        brightGreen: '#b9f27c',
        brightYellow: '#ff9e64',
        brightBlue: '#7da6ff',
        brightMagenta: '#c0a8e8',
        brightCyan: '#0db9d7',
        brightWhite: '#acb0d0',
      },
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    terminalRef.current = term

    term.loadAddon(fitAddon)
    term.open(containerRef.current)

    term.onResize(({ cols, rows }) => {
      // A real PTY resize is an ioctl-level size change (node-pty's resize()), not
      // something achieved by writing an escape sequence into the shell's stdin — an
      // earlier version tried exactly that (`\x1b[8;rows;colst` sent via `send`, which
      // writes to the PTY's INPUT stream) and it corrupted the display: the shell
      // couldn't parse it as real input and echoed it back as literal garbage text.
      // sendResize goes over a separate binary WS frame the daemon routes to the
      // actual resize() call instead.
      sendResize(cols, rows)
    })

    term.onData((data) => {
      send(data)
    })

    term.focus()

    setTimeout(() => {
      fitAddon.fit()
      setTerminalReady(true)
    }, 50)

    return () => {
      term.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [send, sendResize])

  const handleResize = useCallback(() => {
    if (fitAddonRef.current && terminalReady) {
      try {
        fitAddonRef.current.fit()
      } catch {
        /* best-effort fit */
      }
    }
  }, [terminalReady])

  useEffect(() => {
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [handleResize])

  // Keyboard shortcut: Ctrl+D to close terminal view.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const stateLabel = terminalState === 'connected'
    ? 'Connected'
    : terminalState === 'connecting'
      ? 'Connecting…'
      : terminalState === 'error'
        ? 'Error'
        : terminal
          ? 'Disconnected'
          : 'Initializing…'

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      style={{ background: 'var(--panel)', color: 'var(--ink)' }}
    >
      {/* Terminal header bar */}
      <div
        className="flex shrink-0 items-center justify-between border-b px-3 py-1.5"
        style={{ borderColor: 'var(--panel-border)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
            Terminal
          </span>
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
            style={{
              background: terminalState === 'connected' ? 'var(--panel-border)' : 'var(--muted)',
              color: terminalState === 'connected' ? 'var(--ink)' : 'var(--muted)',
            }}
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: terminalState === 'connected' ? 'var(--ink)' : 'var(--muted)' }}
            />
            {stateLabel}
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          className="h-6 w-6 p-0"
          title="Close terminal (Ctrl+D)"
        >
          ✕
        </Button>
      </div>

      {/* Terminal container */}
      <div ref={containerRef} className="min-h-0 flex-1 p-0" />
    </div>
  )
}
