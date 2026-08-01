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
import { createRequire } from 'node:module'
import { isLocalUpgrade, verifyKeyValue } from '../auth'
import { sessionAuth } from '../code/session-auth'
import { claudePermissionModeChoices, resolveClaudePermissionMode } from './agent-modes'
import { TerminalManager } from './terminal-manager'
import { quotePtyShellArg } from '../util/shell-command'

async function body<T>(c: Context): Promise<T> { try { return await c.req.json() as T } catch { return {} as T } }

const require = createRequire(import.meta.url)

// ── terminal-agent auto-resume across a daemon restart ──────────────────
// REVISED (founder-reported live bug): the first version of this used claude's `--continue`
// ("resume the most recent conversation in the CURRENT DIRECTORY"), which is ambiguous the
// moment two Code sessions share a repoRoot — whichever session happened to relaunch later
// would silently inherit whatever OTHER session's conversation was most recently active in
// that folder, reported live as "randomly resuming old conversations". Fixed by keying
// resumption on TurboLLM's OWN Code session id instead of directory-recency: `--session-id
// <id>` on a genuinely first-ever launch REGISTERS that fixed id with the CLI; `--resume <id>`
// on every later launch resumes that EXACT session, never anyone else's. TurboLLM's own
// agent_run id is already a real UUID (randomUUID() at creation) — reused directly as the
// CLI's session id, so no separate id-mapping table is needed; the existing row IS the map.
// Only agents with CONFIRMED flag syntax are listed — an unlisted agent still starts fresh
// every time (today's behavior for all of them) rather than guessing unverified CLI syntax.
const AGENT_SESSION_ID_FLAGS: Partial<Record<string, { first: string; resume: string }>> = {
  claude: { first: '--session-id', resume: '--resume' },
}

// ── Web tools are permission-gated, and "auto" did not cover them ───────────────────────
// Measured live (founder-reported "web search fails"): with `--permission-mode acceptEdits`, a
// terminal-agent turn asking for a web lookup came back
// `permission_denials: [{tool_name:"WebSearch", tool_input:{query:"hono npm package latest
// version"}}]` — the model composed a perfectly good search and the CLI refused to run it. Claude
// Code's auto/acceptEdits modes auto-approve EDITS; a web read is not an edit, so it still wants a
// prompt, and a Code session that is meant to run unattended has nobody to answer it.
//
// Scoped to auto only, and to these two tools only. Both are strictly READ-ONLY — they touch no
// file and run no command — so pre-allowing them takes nothing away from the gates plan and ask
// exist to enforce: every edit and every shell command still prompts exactly as before. Notably
// this is NOT `bypassPermissions`, which would disable every check at once (the same reason
// agent-modes.ts deliberately refuses to map any TurboLLM mode onto it).
const AUTO_MODE_ALLOWED_TOOLS: Partial<Record<string, readonly string[]>> = {
  claude: ['WebSearch', 'WebFetch'],
}

// ── Seeding the session's FIRST message (founder-reported, 2026-08-01) ────────────────────────
// Symptom: in a fresh Code session with the Claude CLI selected, typing the first message opened
// the CLI but the message never arrived — it had to be retyped.
//
// The first attempt at this POSTed the message to the gateway's own `/v1/messages`. That could
// never have worked: `/v1/messages` is the MODEL API, and the CLI is a *client* of it, not a
// server — it exposes nothing the daemon can push a turn into. So the POST ran a real generation
// on the engine, returned the reply to the daemon's own `fetch`, threw it away, and left the CLI's
// conversation untouched (while logging that it had succeeded).
//
// Claude Code takes an initial prompt as a positional argument — `claude [options] [prompt]`,
// which "starts an interactive session by default". Verified against the real CLI in a real PTY:
// the prompt is auto-SUBMITTED, not merely pre-filled (the model answered it and the context meter
// moved). That makes the CLI itself responsible for delivery, so there is no readiness race to
// lose — which a "write it to the PTY once the TUI looks ready" approach would have had, since the
// launch can sit in a 180s model load first.
//
// Claude only: a positional prompt is that CLI's documented syntax, and passing one to an agent
// whose syntax hasn't been verified is the same guess AGENT_SESSION_ID_FLAGS refuses to make.

/** Upper bound on a seeded first message. Windows caps a command line near 8191 chars and this
 *  one is nested inside another (`powershell -Command "turbollm launch … 'prompt'"`), so the
 *  budget is shared. 4000 leaves ample room for the flags either side while covering any realistic
 *  opening message. Over the cap the prompt is omitted rather than truncated — a silently
 *  half-sent instruction is worse than a message the user can see was not sent. */
export const MAX_SEEDED_MESSAGE_CHARS = 4000

/** Whether this message can be handed to the CLI as a launch argument. */
export function canSeedFirstMessage(message: string, agent: string): boolean {
  if (agent !== 'claude') return false
  const trimmed = message.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_SEEDED_MESSAGE_CHARS
}

/** Pure/exported so the resume-flag decision is unit-testable without a live PTY/daemon (mirrors
 *  code-session.ts's codeEventToFrame pattern). `sessionId` is always TurboLLM's own Code
 *  session id (run.id) — passed as the CLI's OWN session id too, so "which conversation to
 *  resume" is never ambiguous even when two Code sessions share a repoRoot.
 *
 *  `permissionMode` carries the session's TurboLLM mode (auto/plan/ask) across to the CLI's own
 *  permission mode — already resolved to a value THIS CLI accepts by agent-modes.ts, which is why
 *  it arrives as a string rather than being mapped here. Null/undefined appends nothing, so an
 *  agent with no confirmed mapping (everything except claude) launches exactly as before.
 *  Everything after `launch <agent>` that isn't one of our own flags is forwarded to the CLI
 *  verbatim by cli.ts's passthrough filter — `--permission-mode` included.
 *
 *  `firstMessage` seeds the CLI's opening turn — see the block comment above. */
export function buildTerminalLaunchCommand(
  agent: string,
  port: number,
  token: string,
  sessionId: string,
  launchedOnce: boolean,
  permissionMode?: string | null,
  mode?: string | null,
  firstMessage?: string | null,
): string {
  const flags = AGENT_SESSION_ID_FLAGS[agent]
  const sessionArg = flags ? ` ${launchedOnce ? flags.resume : flags.first} ${sessionId}` : ''
  const modeArg = permissionMode ? ` --permission-mode ${permissionMode}` : ''
  const allowed = mode === 'auto' ? AUTO_MODE_ALLOWED_TOOLS[agent] : undefined
  const allowedArg = allowed?.length ? ` --allowedTools ${allowed.join(',')}` : ''
  // FIRST, before any flag, and quoted for the shell pty-session.ts spawns.
  //
  // Position is load-bearing, not stylistic: `--allowedTools, --allowed-tools <tools...>` is
  // VARIADIC in the CLI's own `--help`, so it consumes every token that follows it. Placed at the
  // end, the prompt was silently eaten as one more tool name and the session opened empty —
  // measured, after the first version of this did exactly that (ctx stayed 0%, no turn ran).
  // Leading it keeps it clear of that and of any future variadic option.
  //
  // Quoting matters more than usual here — this is arbitrary user prose reaching a command line,
  // where an apostrophe in "don't" would otherwise terminate the string.
  const promptArg = firstMessage && canSeedFirstMessage(firstMessage, agent)
    ? ` ${quotePtyShellArg(firstMessage.trim())}`
    : ''
  return `turbollm launch ${agent}${promptArg} --port ${port} --token ${token}${sessionArg}${modeArg}${allowedArg}`
}

// ── types ──────────────────────────────────────────────────────────────

type S = 200 | 201 | 400 | 404 | 409 | 500 | 501
function err(c: Context, s: S, code: string, msg: string) {
  return c.json({ error: { code, message: msg } }, s)
}

// ── manager singleton (lazy, same pattern as CodeRunManager) ───────────

let terminalManager: TerminalManager | null = null

/** Whether this install actually has a terminal backend.
 *
 *  `node-pty` is an OPTIONAL dependency (it is a native module, and TurboLLM's whole pitch is
 *  "no compiling, no Python" — a failed node-gyp build must not fail the install for everyone).
 *  npm therefore skips it silently when no prebuild fits the platform/ABI, which means a perfectly
 *  healthy install can have no way to spawn a PTY. Exported so the UI can be told BEFORE offering
 *  a terminal-only agent, rather than letting someone pick `claude` and discover at session-open
 *  that this machine can't run it (same rule as the engine catalog: never offer what isn't
 *  actually available, ADR-239).
 *
 *  Cached — the answer can't change for the life of the daemon process. */
let backendAvailable: boolean | null = null

export function isTerminalBackendAvailable(): boolean {
  if (backendAvailable === null) {
    try {
      require.resolve('node-pty')
      backendAvailable = true
    } catch {
      backendAvailable = false
    }
  }
  return backendAvailable
}

function getManager(_d: Deps): TerminalManager {
  if (!terminalManager) {
    // Force the resolve here (via the shared check above) so tests can run without node-pty
    // installed, and so the UI's availability flag and this construction can never disagree.
    if (isTerminalBackendAvailable()) {
      terminalManager = new TerminalManager(_d.store.dir())
    }
  }
  return terminalManager ?? {
    create: () => { throw new Error('node-pty not available — install with: npm install node-pty --save') },
    isActive: () => false,
    getInfo: () => undefined,
    listIds: () => [],
    kill: () => {},
    registerWsListener: () => {},
    unregisterWsListener: () => {},
    cleanupIdle: () => {},
    findByCodeSessionId: () => null,
  } as unknown as TerminalManager
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
    try {
      // Built here, server-side — the client never constructs or even sees this string; the
      // shell runs it as its own startup command (pty-session.ts), never typed into stdin.
      // The daemon's OWN configured port (honors a --port override / in-place rebind), NOT
      // the incoming request's Host/URL port — unlike a browser-facing origin (e.g.
      // comfyui/install's own derivation), this spawns a LOCAL subprocess that must always
      // reach the real daemon directly. Deriving it from the request would pick up a dev
      // proxy's port instead (`npm run dev` in web/, :5173 → :6996) whenever the terminal is
      // opened through that proxy, launching the CLI against a port nothing is listening on.
      const port = d.store.snapshot().daemon.port
      // Session-scoped token (not the shared static 'turbollm-local' every other launch target
      // uses) — lets the gateway tell this session's requests apart from any other concurrently
      // open terminal-agent session, for the thinking-budget override and usage-stat attribution
      // (session-auth.ts). Idempotent: a remount/reconnect against an already-running terminal
      // never reaches this branch (the `existing` check above returns early), so the CLI's
      // already-running auth is never invalidated by a token that would differ from what it
      // still has cached — but even if it did, mint() returns the SAME token for this session.
      const token = sessionAuth.mint(run.id)
      // Auto-resume (found live: a daemon restart kills this terminal's PTY, but the
      // conversation itself didn't end) — a genuinely first-ever launch registers run.id as
      // the CLI's OWN session id; any later one resumes that EXACT id, never "whatever this
      // directory's most recent conversation happens to be" (see buildTerminalLaunchCommand's
      // doc comment for the live bug that distinction fixes).
      // Start the CLI in the mode this session was created with (auto/plan/ask), rather than
      // whatever the CLI defaults to. The mode lives on the conversation (`agent_mode`, the same
      // column PATCH .../mode writes), so a mode changed before reopening applies to the next
      // launch — a CLI can't be switched mid-session from out here.
      const mode = d.db.getConversation(run.convId)?.agentMode ?? 'auto'
      const permissionMode = resolveClaudePermissionMode(mode, await claudePermissionModeChoices())
      // Seed the conversation's first user message as the CLI's opening prompt, so a fresh Code
      // session doesn't open an empty CLI and make the user retype what they already sent. Only
      // on a genuine first launch — a resume already has the turn in its own transcript, and
      // re-sending it would duplicate it.
      const firstMessage = !run.terminalLaunchedOnce
        ? d.db.getConversation(run.convId, true)?.messages?.find((msg) => msg.role === 'user' && msg.isActive)?.content
        : undefined
      const launchCommand = buildTerminalLaunchCommand(
        agent, port, token, run.id, !!run.terminalLaunchedOnce,
        agent === 'claude' ? permissionMode : null,
        mode,
        firstMessage,
      )
      const terminalId = m.create(run.repoRoot, run.id, cols, rows, launchCommand)
      if (!run.terminalLaunchedOnce) d.db.updateAgentRun(run.id, { terminalLaunchedOnce: true })
      return c.json({ terminalId }, 201)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create terminal session.'
      // Was previously swallowed here — the client got a generic toast with no way to diagnose
      // *why* creation failed (wrong repoRoot, spawn failure, etc.) and neither did the server
      // log. Surface the real cause server-side at minimum.
      console.error('[terminal] create failed for session', run.id, ':', e)
      if (msg.includes('node-pty not available')) return err(c, 501, 'not_available', msg)
      return err(c, 500, 'create_failed', msg)
    }
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
  app.post('/api/v1/code/sessions/:sessionId/terminal/agent-exited', (c) => {
    const run = d.db.getAgentRun(c.req.param('sessionId'))
    if (!run) return err(c, 404, 'not_found', 'Session not found.')
    getManager(d).markAgentExited(run.id)
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
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: string, listener: (...args: any[]) => void): void
}

/** OPEN constant from ws library */
const WS_OPEN = 1

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
    // credential check either way).
    const local = isLocalUpgrade(socket.remoteAddress, request.headers, _d)
    if (!local && !verifyKeyValue(url.searchParams.get('key') ?? '', _d)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const m = getManager(_d)
    if (!m.isActive(terminalId)) { socket.destroy(); return }
    wss.handleUpgrade(request, socket, head, (ws: WS) => { wss.emit('connection', ws, request) })
  })

  wss.on('connection', (ws: WS, _request: import('http').IncomingMessage) => {
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
        if (ws.readyState === WS_OPEN) { ws.send(data) }
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
