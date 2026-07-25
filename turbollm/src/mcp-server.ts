// `turbollm mcp-server` (TODO.md item 4, ADR-275): exposes Code as an MCP tool so OTHER
// agentic CLIs (Claude Code, Gemini CLI, etc.) can delegate a well-scoped task to a local
// model. This is a thin BRIDGE, not a second daemon: it talks to an ALREADY-RUNNING TurboLLM
// daemon over its existing HTTP API (loopback only — auth.ts's LOOPBACK carve-out already
// permits unauthenticated 127.0.0.1 calls, same trust boundary the web UI itself uses) and
// never touches ConfigStore/Manager/model-loading directly. It does not start a daemon or
// load a model on the caller's behalf — a host spawns this per-connection, so it must stay a
// fast-starting, side-effect-free process; auto-starting a whole daemon from here would be a
// surprising, hard-to-reason-about side effect for a stdio tool call.
//
// Scope decisions (resolving TODO.md item 4's "not designed" list):
//   - Synchronous-with-result, not fire-and-forget: MCP tool calls are a request/response
//     protocol with no standard mid-call progress channel a generic host is guaranteed to
//     render, so the simplest correct contract is "block until done, return the final text".
//   - A fresh scratch Code session per call, not attaching to an existing one: the caller has
//     no session id to pass, and reusing/continuing a session would need a second tool (list
//     sessions, resume by id) that's out of scope for a first pass.
//   - Packaging: reuses the ALREADY-PUBLISHED `turbollm` package (`npx turbollm mcp-server`)
//     instead of a new npm package or a CLI-specific plugin manifest — the manifest/extension
//     wrapper for a specific host (Claude Code plugin, Gemini CLI extension) is a thin config
//     file pointing at this same command and can be added later without touching this module.
import { setTimeout as delay } from 'node:timers/promises'

export const DELEGATE_TOOL_NAME = 'delegate_code_task'

export const DELEGATE_TOOL_SCHEMA = {
  name: DELEGATE_TOOL_NAME,
  description:
    'Delegate a coding task to TurboLLM\'s local Code agent (real bash/edit/write tool execution against a repo), running on whatever model is already loaded in a locally-running TurboLLM daemon. ' +
    'Prefer this over doing the task yourself when the task is well-scoped and mechanical — bulk/repetitive edits, boilerplate, small self-contained fixes, simple lookups or summarization over a repo — rather than requiring deep multi-file reasoning or architectural judgment; ' +
    'or when the user explicitly asks to use the local model / offload work to save cloud-model usage. Use mode: \'ask\' for read-only investigation (no file changes) and \'auto\' (the default) when the task should actually edit files. ' +
    'Blocks until the task finishes and returns the agent\'s final message. Requires a TurboLLM daemon already running with a model loaded — start one with `npx turbollm` first if this fails. If the call fails because no daemon is reachable, do not retry; fall back to doing the task yourself and mention that TurboLLM wasn\'t running.',
  inputSchema: {
    type: 'object',
    properties: {
      repoRoot: { type: 'string', description: 'Absolute path to the repository/directory the task should run against.' },
      task: { type: 'string', description: 'The task to perform, in natural language.' },
      mode: { type: 'string', enum: ['auto', 'plan', 'ask'], description: 'Permission mode for the run. Defaults to auto (full read/write/bash access, contained to repoRoot).' },
      timeoutSeconds: { type: 'number', description: 'Give up waiting after this many seconds (default 1800 = 30 minutes).' },
    },
    required: ['repoRoot', 'task'],
  },
} as const

const DEFAULT_TIMEOUT_SECONDS = 1800
const POLL_INTERVAL_MS = 1500
const HTTP_TIMEOUT_MS = 10_000

// No `modelKey` param, deliberately (found and removed in the v1.9.0 pre-release review): a Code
// session's `modelKey` (POST /api/v1/code/sessions) is stored purely as a display LABEL on the
// conversation row — nothing in runCodeSession/code-run-manager reads it to actually load or
// switch models, the turn always runs against whatever's currently loaded (code-session.ts's
// d.manager.status()). The old schema documented it as "use a specific model key instead of
// whatever is currently loaded," which was simply false, and — since this MCP tool exposes no way
// to ever list/see that label back — there was no way for a caller to even notice the promise
// wasn't kept. Real model-pinning (load the requested model before running the turn) would be a
// genuine feature needing its own careful pass through this project's model-loading subsystem, not
// a quick add-on here.
export interface DelegateParams {
  repoRoot: string
  task: string
  mode?: string
  timeoutSeconds?: number
}

export interface DelegateResult {
  ok: boolean
  text: string
}

/** Extracts `{error:{message}}` from a code-routes.ts-shaped error body; falls back to the raw
 *  text (truncated) when the body isn't that shape, so a non-JSON error (proxy, crash page)
 *  still surfaces something readable instead of throwing during error formatting itself. */
async function describeHttpError(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '')
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } }
    if (parsed.error?.message) return parsed.error.message
  } catch { /* not JSON — fall through to raw */ }
  return raw.slice(0, 500) || `HTTP ${res.status}`
}

/** Runs one Code task to completion against a running daemon and returns its final message.
 *  `fetchImpl` is injectable for tests; production always uses the real global fetch. */
export async function delegateCodeTask(
  baseUrl: string,
  params: DelegateParams,
  fetchImpl: typeof fetch = fetch,
): Promise<DelegateResult> {
  const repoRoot = params.repoRoot.trim()
  const task = params.task.trim()
  if (!repoRoot) return { ok: false, text: 'repoRoot is required.' }
  if (!task) return { ok: false, text: 'task is required.' }

  const timeoutMs = Math.max(10, params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000
  const deadline = Date.now() + timeoutMs

  let createRes: Response
  try {
    createRes = await fetchImpl(`${baseUrl}/api/v1/code/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoRoot, task, mode: params.mode ?? 'auto' }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (e) {
    return {
      ok: false,
      text: `Could not reach the TurboLLM daemon at ${baseUrl}. Is it running? Start one with \`npx turbollm\`. (${e instanceof Error ? e.message : e})`,
    }
  }
  if (!createRes.ok) return { ok: false, text: `TurboLLM rejected the task: ${await describeHttpError(createRes)}` }
  const { sessionId } = await createRes.json() as { sessionId: string }

  const startRes = await fetchImpl(`${baseUrl}/api/v1/code/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}', // no content/promptOverride → runs the seeded task from session creation
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  if (!startRes.ok) return { ok: false, text: `TurboLLM could not start the run: ${await describeHttpError(startRes)}` }

  // Poll the persisted session rather than the SSE stream: this bridge has no UI to show live
  // progress TO, so "block until running:false, read back the transcript" is simpler and just
  // as correct as consuming the stream for a wait-for-result tool.
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS)
    let detailRes: Response
    try {
      detailRes = await fetchImpl(`${baseUrl}/api/v1/code/sessions/${sessionId}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    } catch {
      continue // transient — keep polling until the deadline
    }
    if (!detailRes.ok) continue
    const detail = await detailRes.json() as {
      running?: boolean
      conversation?: { messages?: Array<{ role: string; content: string }> }
    }
    if (detail.running) continue
    const messages = detail.conversation?.messages ?? []
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
    return { ok: true, text: lastAssistant?.content?.trim() || '(Code agent finished with no final message — check the TurboLLM UI for details.)' }
  }
  return {
    ok: false,
    text: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the Code agent. Session ${sessionId} may still be running — check the TurboLLM UI.`,
  }
}

// ── stdio JSON-RPC MCP server ────────────────────────────────────────────────
// Mirrors the wire format `tools/mcp-client.ts` already speaks as a CLIENT (this project has
// no MCP SDK dependency in either direction — hand-rolling stays consistent and adds zero deps).

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: unknown
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

/** Builds the JSON-RPC response for one already-parsed request. Exported separately from the
 *  stdio plumbing so the dispatch logic (the part with actual bugs to have) is unit-testable
 *  without spinning up real stdin/stdout streams. */
export async function handleMcpRequest(
  req: JsonRpcRequest,
  baseUrl: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ jsonrpc: '2.0'; id: string | number; result?: unknown; error?: { code: number; message: string } } | null> {
  if (req.id === undefined) return null // a notification (e.g. notifications/initialized) — nothing to reply to
  try {
    switch (req.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0', id: req.id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'turbollm', version } },
        }
      case 'tools/list':
        return { jsonrpc: '2.0', id: req.id, result: { tools: [DELEGATE_TOOL_SCHEMA] } }
      case 'tools/call': {
        const p = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
        if (p.name !== DELEGATE_TOOL_NAME) throw new Error(`Unknown tool: ${p.name}`)
        const args = p.arguments ?? {}
        if (!isString(args.repoRoot) || !args.repoRoot.trim()) throw new Error('repoRoot is required')
        if (!isString(args.task) || !args.task.trim()) throw new Error('task is required')
        const result = await delegateCodeTask(baseUrl, {
          repoRoot: args.repoRoot,
          task: args.task,
          mode: isString(args.mode) ? args.mode : undefined,
          timeoutSeconds: typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined,
        }, fetchImpl)
        return { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: result.text }], isError: !result.ok } }
      }
      default:
        throw new Error(`Unknown method: ${req.method}`)
    }
  } catch (e) {
    return { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }
  }
}

/** Runs the stdio MCP server loop until stdin closes (the host disconnected). */
export function runMcpServer(baseUrl: string, version: string): Promise<void> {
  return new Promise((resolveServer) => {
    process.stdin.setEncoding('utf8')
    let buf = ''

    const onData = (chunk: string) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        void handleLine(trimmed)
      }
    }

    async function handleLine(line: string): Promise<void> {
      let req: JsonRpcRequest
      try {
        req = JSON.parse(line) as JsonRpcRequest
      } catch {
        return // malformed frame — drop rather than crash the bridge over one bad line
      }
      const res = await handleMcpRequest(req, baseUrl, version)
      if (res) process.stdout.write(JSON.stringify(res) + '\n')
    }

    process.stdin.on('data', onData)
    process.stdin.on('end', () => resolveServer())
    process.stdin.on('close', () => resolveServer())
  })
}
