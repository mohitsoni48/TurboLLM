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
    'Delegate a coding task to TurboLLM\'s local Code agent (real bash/edit/write tool execution against a repo), running on whatever model is already loaded in a locally-running TurboLLM daemon. Blocks until the task finishes and returns the agent\'s final message. Requires a TurboLLM daemon already running with a model loaded — start one with `npx turbollm` first if this fails.',
  inputSchema: {
    type: 'object',
    properties: {
      repoRoot: { type: 'string', description: 'Absolute path to the repository/directory the task should run against.' },
      task: { type: 'string', description: 'The task to perform, in natural language.' },
      mode: { type: 'string', enum: ['auto', 'plan', 'ask'], description: 'Permission mode for the run. Defaults to auto (full read/write/bash access, contained to repoRoot).' },
      modelKey: { type: 'string', description: 'Optional — use a specific model key instead of whatever is currently loaded.' },
      timeoutSeconds: { type: 'number', description: 'Give up waiting after this many seconds (default 1800 = 30 minutes).' },
    },
    required: ['repoRoot', 'task'],
  },
} as const

const DEFAULT_TIMEOUT_SECONDS = 1800
const POLL_INTERVAL_MS = 1500
const HTTP_TIMEOUT_MS = 10_000

export interface DelegateParams {
  repoRoot: string
  task: string
  mode?: string
  modelKey?: string
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
      body: JSON.stringify({ repoRoot, task, mode: params.mode ?? 'auto', modelKey: params.modelKey }),
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
          modelKey: isString(args.modelKey) ? args.modelKey : undefined,
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
