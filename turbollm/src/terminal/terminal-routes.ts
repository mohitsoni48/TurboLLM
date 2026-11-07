// Terminal WebSocket routes — bridge a raw PTY session to the browser via WebSocket.
//
// GET /api/v1/code/terminal/ws?terminalId=:terminalId
//   Upgrade to WebSocket. The client receives raw PTY output as TEXT frames and sends
//   raw input the same way. A resize is NOT part of that stream — a real PTY resize is
//   an ioctl-level operation (node-pty's resize(), not bytes written to stdin), so the
//   client sends it as a separate BINARY frame carrying `{ cols, rows }` JSON — the one
//   piece of framing this protocol has, chosen specifically so it can never collide
//   with genuine terminal input/output (which are always TEXT frames).
//
// POST /api/v1/code/sessions/:sessionId/terminal
//   Create a new terminal session scoped to a Code session's repoRoot.
//   Returns { terminalId }.
//
// POST /api/v1/code/sessions/:sessionId/terminal/kill
//   Kill the terminal attached to a Code session.
//
// This is a thin bridge — the daemon never interprets the data flowing through.
// It's a raw pipe: PTY stdout → WebSocket, WebSocket → PTY stdin.

import type { Context, Hono } from 'hono'
import type { Deps } from '../deps'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { hashKey, isLanExposed, isLocalUpgrade, isLoopbackAddress, keyHashStillAccepted, verifyKeyValue } from '../auth'
import { sessionAuth } from '../code/session-auth'
import { agentCwd } from '../code/worktree'
import { createAgentTerminal, getManager } from './terminal-service'

async function body<T>(c: Context): Promise<T> { try { return await c.req.json() as T } catch { return {} as T } }

const require = createRequire(import.meta.url)

/** @deprecated The terminal service's exports were here before terminal-service.ts; importers move to it, and this re-export goes next release. */
export * from './terminal-service'

// ── types ──────────────────────────────────────────────────────────────

type S = 200 | 201 | 400 | 404 | 409 | 500 | 501
function err(c: Context, s: S, code: string, msg: string) {
  return c.json({ error: { code, message: msg } }, s)
}

// ── export ─────────────────────────────────────────────────────────────

export function registerTerminalRoutes(app: Hono, d: Deps): void {
  // ── create a terminal session for a Code session ───────────────────────
  // Reuses an existing active terminal for this Code session rather than spawning a
  // duplicate — the frontend calls this on every TerminalView mount (opening the tab,
  // navigating back to it), and without reuse each remount would leak another shell
  // (and another `claude` subprocess) that only the 5-minute cleanupIdle would reap.
  app.post('/api/v1/code/sessions/:sessionId/terminal', async (c) => {
    const run = d.db.getAgentRun(c.req.param('sessionId'))
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    if (!run.repoRoot) return err(c, 400, 'invalid_input', 'Session has no repo root.')
    const agent = run.codeAgent ?? 'turbollm'
    if (agent === 'turbollm') {
      return err(c, 400, 'invalid_input', 'This session uses the built-in chat UI, not a terminal agent.')
    }

    // The directory has to still exist, or node-pty's CreateProcess fails with a raw
    // "Cannot create process, error code: 267" (ERROR_DIRECTORY) that says nothing about WHICH
    // folder is missing or why — founder-reported. Genuinely reachable: the project can be moved,
    // renamed or deleted, an external drive unplugged, or (now that worktrees exist) the session's
    // worktree removed by hand with `git worktree remove`. Checked here rather than inside
    // PTYSession so the answer is an actionable HTTP error instead of a spawn failure.
    const cwd = agentCwd(run)
    if (!existsSync(cwd)) {
      const isWorktree = !!run.worktreePath && cwd === run.worktreePath
      return err(
        c, 400, 'cwd_missing',
        isWorktree
          ? `This session's worktree is gone: ${cwd}. It was probably removed outside TurboLLM ` +
            `(\`git worktree remove\`, or deleting the folder). The session's branch and any commits ` +
            `on it are unaffected — delete this session and start a new one on the same repo.`
          : `This session's folder no longer exists: ${cwd}. It may have been moved, renamed or ` +
            `deleted, or it lives on a drive that isn't connected. Reconnect or restore it, or ` +
            `delete this session.`,
      )
    }

    // The caller (TerminalView) fits xterm.js BEFORE calling this, so the PTY is spawned at
    // its real size from the very first byte the launch command writes — never a hardcoded
    // default later corrected by a follow-up resize. A resize that arrives after a TUI's very
    // first paint (Ink apps especially) can leave the display and the real PTY width out of
    // sync permanently, which is what caused the garbled/overlapping render.
    const b = await body<{ cols?: number; rows?: number }>(c)
    const cols = typeof b.cols === 'number' && b.cols > 0 ? Math.floor(b.cols) : 80
    const rows = typeof b.rows === 'number' && b.rows > 0 ? Math.floor(b.rows) : 24

    const m = getManager(d)
    const existing = m.findByCodeSessionId(run.id)
    if (existing && !m.isAgentExited(existing)) {
      // Reattaching to an already-running terminal (remount/reconnect) — resize it to the
      // CURRENT viewport rather than leaving it at whatever size it was created with.
      m.resize(existing, cols, rows)
      return c.json({ terminalId: existing }, 200)
    }
    if (existing) {
      // The agent CLI exited but the shell is still up (`-NoExit`/`exec bash`, pty-session.ts),
      // so the PTY looks alive while the terminal is really a dead end. Reusing it hands the
      // user a bare prompt with stale scrollback and NEVER relaunches — found live: one failed
      // `--resume` stranded a Code session permanently, and every reopen redisplayed the same
      // old error, making a already-shipped launch fix look like it had done nothing. Tear it
      // down so the create path below spawns a real agent terminal.
      m.kill(existing)
    }
    // Auto-resume (found live: a daemon restart kills this terminal's PTY, but the
    // conversation itself didn't end) — a genuinely first-ever launch registers run.id as
    // the CLI's OWN session id; any later one resumes that EXACT id, never "whatever this
    // directory's most recent conversation happens to be" (see buildTerminalLaunchCommand's
    // doc comment for the live bug that distinction fixes). Start the CLI in the mode this
    // session was created with (auto/plan/ask) — the mode lives on the conversation
    // (`agent_mode`, the same column PATCH .../mode writes), so a mode changed before
    // reopening applies to the next launch, since a CLI can't be switched mid-session from
    // out here.
    const mode = d.db.getConversation(run.convId)?.agentMode ?? 'auto'
    // Seed the conversation's first user message as the CLI's opening prompt, so a fresh Code
    // session doesn't open an empty CLI and make the user retype what they already sent. Only
    // on a genuine first launch — a resume already has the turn in its own transcript, and
    // re-sending it would duplicate it.
    const firstMessage = !run.terminalLaunchedOnce
      ? d.db.getConversation(run.convId, true)?.messages?.find((msg) => msg.role === 'user' && msg.isActive)?.content
      : undefined
    const result = await createAgentTerminal(d, run, { cols, rows, mode, firstMessage: firstMessage ?? undefined })
    if (!result.ok) return err(c, result.status, result.code, result.message)
    return c.json({ terminalId: result.terminalId }, 201)
  })

  // ── kill terminal for a Code session ──────────────────────────────────
  app.post('/api/v1/code/sessions/:sessionId/terminal/kill', (c) => {
    const run = d.db.getAgentRun(c.req.param('sessionId'))
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    const m = getManager(d)
    const terminalId = m.findByCodeSessionId(run.id)
    if (terminalId) m.kill(terminalId)
    // Revoke immediately here rather than relying solely on the PTY's async exit event
    // (TerminalManager's own onExit handler also revokes, for the "CLI exited on its own"
    // case) — a caller that kills-then-immediately-relaunches (model change, task 14)
    // shouldn't race an in-flight process-exit event.
    sessionAuth.revoke(run.id)
    return c.json({ ok: true }, 200)
  })

  // ── agent CLI exited (reported by `turbollm launch` as it ends) ───────
  // The daemon has no handle on the agent process itself — it spawns a SHELL and has the shell
  // run `turbollm launch <agent>` as its startup command (pty-session.ts), so the only thing
  // that reliably knows when the agent is done is that launch process. Marking it here means the
  // next open recreates the terminal instead of reattaching to the leftover shell.
  app.post('/api/v1/code/sessions/:sessionId/terminal/agent-exited', async (c) => {
    const run = d.db.getAgentRun(c.req.param('sessionId'))
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    // exitCode is optional (older callers send no body at all) — see TerminalSessionInfo.exitCode's
    // own doc comment for who actually reads it (nothing in the terminal-agent UI itself does).
    const { exitCode } = await body<{ exitCode?: number }>(c)
    getManager(d).markAgentExited(run.id, typeof exitCode === 'number' ? exitCode : undefined)
    return c.json({ ok: true }, 200)
  })

  // ── list active terminal sessions ─────────────────────────────────────
  app.get('/api/v1/code/terminals', (c) => {
    const m = getManager(d)
    const ids = m.listIds()
    const sessions = ids.map((id) => m.getInfo(id)).filter(Boolean)
    return c.json({ terminals: sessions })
  })
}

// ── standalone WebSocket handler (Node adapter) ─────────────────────────

/** Internal interface for the ws library WebSocket instance. */
interface WS {
  readyState: number
  /** Bytes queued by send() and not yet written to the socket. */
  bufferedAmount: number
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
  on(event: string, listener: (...args: any[]) => void): void
}

/** OPEN constant from ws library */
const WS_OPEN = 1

/** How much output may sit unsent in one viewer's socket buffer. Past it the viewer (a tunnel, a phone on a bad
 *  link) is not keeping up and the daemon would otherwise buffer without limit. */
export const MAX_VIEWER_BUFFERED_BYTES = 8 * 1024 * 1024

/** The buffer size at which a viewer already being closed is cut loose: close() waits on the peer's handshake, which a
 *  stalled peer never answers, so its buffer would keep growing in the meantime. */
const TERMINATE_VIEWER_BUFFERED_BYTES = MAX_VIEWER_BUFFERED_BYTES * 2

const WS_CLOSING = 2

/** Send PTY output to one viewer, or cut it loose if it has fallen too far behind: close 1013 (try again later) makes
 *  the web client reconnect (any non-1000 close does) and get the scrollback replay, the current screen. A viewer that
 *  is CLOSING and still past twice the limit is terminated, which frees its buffer immediately. */
export function sendToViewer(ws: { readyState: number; bufferedAmount: number; send(data: string): void; close(code: number, reason: string): void; terminate(): void }, data: string): void {
  if (ws.readyState === WS_CLOSING && ws.bufferedAmount > TERMINATE_VIEWER_BUFFERED_BYTES) { ws.terminate(); return }
  if (ws.readyState !== WS_OPEN) return
  if (ws.bufferedAmount > MAX_VIEWER_BUFFERED_BYTES) { ws.close(1013, 'Too slow, reconnect'); return }
  ws.send(data)
}

/** What let an open terminal WebSocket in, recorded at its handshake: the key and address checks
 *  run only then, so dropStaleTerminalSockets re-checks these when one of them may have gone. */
interface TerminalSocketBasis {
  /** The remote-access ingress port it arrived on, when it came over remote access. */
  ingressPort?: number
  /** Its peer is on this machine's loopback. */
  loopback: boolean
  /** The hash of the key that let it in; unset for one let in as local (isLocalUpgrade). */
  keyHash?: string
}

/** Every open terminal WebSocket, on any listener registerTerminalWs was given, with its basis. */
const openTerminalSockets = new Map<WS, TerminalSocketBasis>()

/** Drop every open Code-terminal WebSocket at once; the daemon's shutdown calls this beside
 *  closeAllConnections(). An upgraded socket is no longer one of the HTTP server's connections,
 *  so closeAllConnections() leaves it open and server.close() waits for it: one open terminal
 *  held the shutdown until its fallback timer, and `--stop` SIGKILLs at 10 s. terminate(), not
 *  close(): a close handshake waits on the peer (up to 30 s for one that went away). */
export function closeTerminalSockets(): void {
  for (const ws of openTerminalSockets.keys()) ws.terminate()
}

/** Drop each open terminal WebSocket whose way in is gone, and return how many. The upgraded
 *  socket is no HTTP connection, so neither a listener's closeAllConnections() nor its close()
 *  ends it, and its key was checked only at the handshake. So a LAN peer kept its live shell after
 *  LAN access was turned off (the rebind's old listener let go of everything else), a remote
 *  client after remote access was stopped (the ingress's close() leaves the socket to the
 *  provider's own connection), and anyone after the key that let them in was revoked. Gone:
 *  - came over remote access, and that ingress is no longer up on its port;
 *  - came from another machine on the main listener, and the daemon is no longer LAN-exposed
 *    (isLanExposed, which follows the address really bound);
 *  - was let in on a key that would no longer be accepted (keyHashStillAccepted).
 *  The daemon calls this after every bind (cli.ts listen()), on every remote-access state change
 *  (onRemoteState) and after a key is removed (DELETE /api/v1/keys/:id, Connect's re-mint). A
 *  socket of this machine's own let in as local is never dropped. */
export function dropStaleTerminalSockets(d: Deps): number {
  let dropped = 0
  for (const [ws, b] of openTerminalSockets) {
    const gone =
      (b.ingressPort !== undefined && d.remote?.ingressPort() !== b.ingressPort) ||
      (b.ingressPort === undefined && !b.loopback && !isLanExposed(d)) ||
      (b.keyHash !== undefined && !keyHashStillAccepted(b.keyHash, d))
    if (!gone) continue
    openTerminalSockets.delete(ws)
    ws.terminate()
    dropped++
  }
  return dropped
}

/**
 * Register the WebSocket upgrade handler directly with the Node server.
 *
 * The `ws` library is already installed (a dep of pi-coding-agent via openai/google-genai).
 * We use it to accept WebSocket upgrades on the `/api/v1/code/terminal/ws` path.
 */
export function registerTerminalWs(server: import('http').Server, _d: Deps): void {
  const wsLib = require('ws')
  const WebSocketServer = wsLib.Server
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => {
    const url = new URL(request.url ?? '', 'http://localhost')
    if (url.pathname !== '/api/v1/code/terminal/ws') { socket.destroy(); return }
    const terminalId = url.searchParams.get('terminalId') ?? ''
    if (!terminalId) { socket.destroy(); return }

    // Same gate as codeAuth on every other /api/v1/code/* route: this handler sits
    // directly on the raw http.Server 'upgrade' event, BEFORE Hono's app (and therefore
    // before lanAuth/codeAuth) ever sees the request, since Hono only handles 'request'
    // events — so without this check a WebSocket handshake would reach a live PTY shell
    // with no auth at all, even when the daemon is LAN-exposed or tunneled and every
    // sibling REST endpoint demands a key. Browsers can't set custom headers on a
    // WebSocket handshake, so the key travels as a `key` query param instead of the
    // `X-TurboLLM-Auth` header the REST client uses (verifyKeyValue is the same
    // credential check either way). No CORS applies to a handshake, so isLocalUpgrade also
    // refuses loopback trust to one a browser sends from another site's page.
    const local = isLocalUpgrade(socket.remoteAddress, socket.localPort, request.headers, _d)
    const key = url.searchParams.get('key') ?? ''
    if (!local && !verifyKeyValue(key, _d)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const m = getManager(_d)
    if (!m.isActive(terminalId)) { socket.destroy(); return }
    const ingress = _d.remote?.ingressPort()
    const basis: TerminalSocketBasis = {
      ingressPort: ingress !== undefined && socket.localPort === ingress ? ingress : undefined,
      loopback: isLoopbackAddress(socket.remoteAddress),
      keyHash: local ? undefined : hashKey(key),
    }
    wss.handleUpgrade(request, socket, head, (ws: WS) => {
      openTerminalSockets.set(ws, basis)
      wss.emit('connection', ws, request)
    })
  })

  wss.on('connection', (ws: WS, _request: import('http').IncomingMessage) => {
    ws.on('close', () => { openTerminalSockets.delete(ws) })
    const url = new URL(_request.url ?? '', 'http://localhost')
    const terminalId = url.searchParams.get('terminalId') ?? ''
    const m = getManager(_d)

    if (!m.isActive(terminalId)) {
      ws.close(4004, 'Terminal session not found or exited')
      return
    }

    // Kept as a named const (not inlined into registerWsListener's call) so unregister below
    // can pass back the SAME object reference — that's how the manager tells this tab's
    // listener apart from any other tab's listener attached to the same terminal id.
    const handler = {
      onData(data: string) {
        sendToViewer(ws, data)
      },
      onClose() {
        if (ws.readyState === WS_OPEN) { ws.close(1001, 'Terminal exited') }
      },
    }
    m.registerWsListener(terminalId, handler)

    ws.on('message', (data: Buffer | string, isBinary?: boolean) => {
      // Binary frame = resize control message ({ cols, rows } JSON), never terminal
      // input/output. Text frames (isBinary undefined/false with a string payload) are
      // raw PTY input, unchanged from before.
      if (isBinary && Buffer.isBuffer(data)) {
        try {
          const { cols, rows } = JSON.parse(data.toString('utf-8')) as { cols?: number; rows?: number }
          if (typeof cols === 'number' && typeof rows === 'number' && cols > 0 && rows > 0) {
            m.resize(terminalId, cols, rows)
          }
        } catch { /* malformed resize frame — ignore */ }
        return
      }
      const input = typeof data === 'string' ? data : data.toString('utf-8')
      m.write(terminalId, input)
    })

    ws.on('close', () => { m.unregisterWsListener(terminalId, handler) })
    ws.on('error', () => { m.unregisterWsListener(terminalId, handler) })
  })
}
