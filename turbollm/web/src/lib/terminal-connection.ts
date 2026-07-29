// Terminal WebSocket connection — bridges the browser's xterm.js renderer to
// the daemon's PTY session over WebSocket.
//
// Usage:
//   const conn = useTerminalConnection(terminalId, terminalElementRef)
//   // conn.state is 'connecting' | 'connected' | 'disconnected' | 'error'
//   // On connected: calls conn.send(text) to write raw bytes to the PTY.

import { useCallback, useEffect, useRef, useState } from 'react'
import { authHeaders, getAuthToken } from './api'
import { markCodeAuthNeeded, clearCodeAuthNeeded } from './auth-signal'

export type TerminalState = 'connecting' | 'connected' | 'disconnected' | 'error'

interface UseTerminalConnectionOptions {
  /** Called when the terminal is first ready to accept input (connected). */
  onConnect?: () => void
  /** Called on close with a reason code. */
  onClose?: (code: number, reason: string) => void
  /** Called when a raw PTY error occurs. */
  onError?: (err: Event) => void
  /** Called for every raw text frame the PTY sends (output + the scrollback replay the server
   *  sends immediately on connect). Set as `ws.onmessage` synchronously inside connect() —
   *  NOT via a caller-side effect keyed on the returned `ws` value. That used to be how this
   *  worked, and it raced: the server sends the scrollback replay essentially the instant the
   *  connection completes, but the returned `ws` value only updates on React's NEXT re-render
   *  (triggered by `onopen`'s setState, itself scheduled — not synchronous with the WebSocket's
   *  own event dispatch), so a caller's effect could attach its listener just after that first
   *  message already fired with nothing listening. Found live: a Code-session terminal going
   *  blank on switching, then working again a few switches later — exactly the signature of a
   *  race that sometimes loses and sometimes doesn't. */
  onMessage?: (data: string) => void
}

/**
 * Manage a single WebSocket connection to the terminal WS endpoint.
 * Returns { state, ws, send } where send writes raw bytes to the PTY.
 */
export function useTerminalConnection(
  terminalId: string | null,
  options: UseTerminalConnectionOptions = {},
) {
  const [state, setState] = useState<TerminalState>('disconnected')
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Keep the latest callbacks in a ref rather than as `connect`'s useCallback deps.
  // Callers (e.g. TerminalView) commonly pass inline arrow functions that are a new
  // reference on every render — if those were in `connect`'s deps, `connect`'s own
  // identity would change every render, which would change the main effect's
  // dependency array below, re-running it and calling its cleanup (disconnect()) on
  // every single re-render. That tore the live socket down constantly (observed as
  // an endless "error 1005 / closed 1006" reconnect loop that never let `claude`'s
  // output reach the browser). Reading callbacks via a ref keeps `connect` stable
  // across renders while still always invoking the latest handler.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const connect = useCallback((id: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    // The daemon's WS upgrade handler sits before Hono (see terminal-routes.ts), so it
    // can't read the X-TurboLLM-Auth header the REST client sends — a browser WebSocket
    // handshake can't carry custom headers at all. The stored key travels as a query
    // param instead; a no-op on the common loopback-only-bind setup, where no key is
    // required (isLocalUpgrade already lets it through with an empty/absent key).
    const token = getAuthToken()
    const keyParam = token ? `&key=${encodeURIComponent(token)}` : ''
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/code/terminal/ws?terminalId=${encodeURIComponent(id)}${keyParam}`
    const ws = new WebSocket(url)

    ws.onopen = () => {
      setState('connected')
      optionsRef.current.onConnect?.()
    }

    // Attached HERE, synchronously with the WebSocket's own creation — never via a later
    // effect keyed on this hook's returned `ws` value (see onMessage's doc comment for the
    // race that produced live).
    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : ''
      if (data) optionsRef.current.onMessage?.(data)
    }

    ws.onclose = (ev) => {
      setState('disconnected')
      optionsRef.current.onClose?.(ev.code, ev.reason)
    }

    ws.onerror = (ev) => {
      setState('error')
      optionsRef.current.onError?.(ev)
    }

    wsRef.current = ws
  }, [])

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    // Explicit 1000 (normal closure) — WebSocket.close() with NO code sends no status code at
    // all, and the WebSocket API then reports THIS SAME close back to our own onclose handler
    // as code 1005 ("no status received"), even though the disconnect was entirely intentional
    // (component unmount, session switch, etc.). TerminalView.tsx's onClose handler treats
    // anything other than 1000 as a real failure and surfaces a toast — an unintentional-looking
    // "1005 error" on a totally normal disconnect was a real, user-visible symptom of this,
    // compounded by (now fixed separately) an effect that was tearing the connection down and
    // reconnecting on nearly every parent re-render.
    wsRef.current?.close(1000, 'client disconnect')
    wsRef.current = null
    setState('disconnected')
  }, [])

  // Reconnect logic — try every 2 seconds, up to a max of 5 reconnect attempts.
  const scheduleReconnect = useCallback((id: string) => {
    if (reconnectTimerRef.current) return
    let attempts = 0
    const maxAttempts = 5
    const doReconnect = () => {
      if (!id) return
      attempts++
      if (attempts > maxAttempts) {
        setState('disconnected')
        return
      }
      connect(id)
      if (wsRef.current?.readyState === WebSocket.OPEN) return
      reconnectTimerRef.current = setTimeout(doReconnect, 2000)
    }
    reconnectTimerRef.current = setTimeout(doReconnect, 500)
  }, [connect])

  // Connect/disconnect based on terminalId changes.
  useEffect(() => {
    if (!terminalId) {
      disconnect()
      return
    }
    connect(terminalId)

    // Auto-reconnect on unexpected close.
    const ws = wsRef.current
    if (!ws) return

    const savedOnClose: ((ev: CloseEvent) => void) | null = ws.onclose
    ws.onclose = (ev) => {
      // Don't auto-reconnect on intentional close (code 1000 = normal).
      if (ev.code !== 1000) {
        scheduleReconnect(terminalId)
      }
      if (savedOnClose) savedOnClose(ev)
    }

    return () => {
      disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, connect, disconnect, scheduleReconnect])

  const send = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data)
    }
  }, [])

  // Resize is sent as a BINARY frame carrying `{ cols, rows }` JSON — deliberately NOT
  // a text frame, so the daemon can tell it apart from real terminal input/output and
  // route it to node-pty's real resize() (an ioctl-level PTY-size change), rather than
  // it ever being written into the shell's stdin as literal bytes. WebSocket.send(string)
  // always produces a TEXT frame in browsers regardless of content, so the JSON must be
  // encoded to a Uint8Array first — that's what actually makes the frame binary.
  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(new TextEncoder().encode(JSON.stringify({ cols, rows })))
    }
  }, [])

  return { state, ws: wsRef.current, send, sendResize }
}

/**
 * Create (or reuse an already-running) terminal session for a Code session.
 * `cols`/`rows` MUST be the real, already-fitted xterm.js size (TerminalView fits before
 * calling this) — the daemon spawns the PTY at exactly this size, never a default corrected
 * by a later resize (see TerminalView.tsx's module header for why that mattered).
 * `created` is true only on a genuinely fresh PTY (HTTP 201) — the daemon returns
 * an existing active terminal (HTTP 200) when one already runs for this Code
 * session, so the caller (TerminalView) knows whether to auto-launch `claude`
 * (fresh) or just reattach to what's already running (reused) rather than
 * re-sending the launch command into a live session. On error, returns null.
 */
export async function createTerminalForSession(
  sessionId: string,
  cols: number,
  rows: number,
  signal?: AbortSignal,
): Promise<{ terminalId: string; created: boolean } | { error: string } | null> {
  try {
    const res = await fetch(`/api/v1/code/sessions/${encodeURIComponent(sessionId)}/terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ cols, rows }),
      signal,
    })
    // Same shared signal code-api.ts's req() marks on every Code 401 — Code always requires
    // a key from a non-host device (auth.ts's codeAuth) independent of the rest of the app,
    // and this call previously bypassed that mechanism entirely (see the header fix above),
    // so a LAN/mobile client got a bare "could not create terminal session" instead of the
    // app's normal key-prompt.
    if (res.status === 401) markCodeAuthNeeded()
    else if (res.ok) clearCodeAuthNeeded()
    if (!res.ok) {
      // Surface the server's actual reason (repo missing, node-pty unavailable, spawn
      // failure, ...) instead of a generic "could not create" with nothing to go on.
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null
      return { error: body?.error?.message ?? `Terminal creation failed (${res.status}).` }
    }
    const data = (await res.json()) as { terminalId: string }
    return { terminalId: data.terminalId, created: res.status === 201 }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Network error creating terminal session.' }
  }
}

/**
 * Kill the terminal attached to a Code session.
 */
export async function killTerminalForSession(sessionId: string): Promise<void> {
  try {
    await fetch(`/api/v1/code/sessions/${encodeURIComponent(sessionId)}/terminal/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
    })
  } catch {
    /* best-effort */
  }
}
