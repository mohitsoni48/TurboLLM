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
//
// Routine/agent tools (added later): a `claude_cli` Code session is the REAL external Claude
// Code CLI (cli-launch.ts spawns it pointed at this daemon's gateway) — a genuinely separate
// process with its own Read/Write/Bash toolset, never routed through ToolRegistry the way chat
// and the in-process 'pi' agent are. Without this, a claude_cli session asked to "create a
// routine" has no way to know TurboLLM's Routines feature exists at all, and (observed live)
// improvises an OS-level cron job with its own Bash tool instead. list_routines/create_routine/
// list_agents/create_agent close that gap the same way delegate_code_task closes "no way to
// reach Code" — REST calls to the already-running daemon, not a second implementation.
// Deliberately narrower than ToolRegistry's full routine surface: update_routine's whole safety
// property in routine-tools.ts is its two-phase preview-then-confirm flow (a diff computed
// against the LIVE routine, applied only on a second call with confirm:true) — reproducing that
// faithfully through a stateless REST proxy is real additional work, not a proxy away. And
// delete_routine/run_routine_now are both higher-stakes (an unattended cascading delete; an
// immediate real bash/edit/write run) than what the reported problem — "it couldn't even create
// one" — actually needs fixed. All three stay a deliberate follow-up, not an oversight.
import { setTimeout as delay } from 'node:timers/promises'
import { CREATE_ROUTINE_TOOL, LIST_ROUTINES_TOOL } from './routines/routine-tools'
import { validateCreate, type RoutineBody } from './routines/routine-routes'
import { LIST_AGENTS_TOOL, CREATE_AGENT_TOOL } from './chat/chat-agent-tools'
import { LIST_MODELS_TOOL } from './models/model-tools'
import type { Routine } from './routines/schema'
import type { CustomChatAgent } from './config/config'
import type { ModelEntry } from './models/scanner'

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

// ── Routine/agent tools ────────────────────────────────────────────────────────
// Each mirrors its ToolRegistry counterpart's exact text contract (routine-tools.ts's
// execListRoutines/execCreateRoutine, chat-agent-tools.ts's execListAgents/execCreateAgent) —
// same success/error message shape — so a claude_cli session sees IDENTICAL output to what a
// chat or pi session's tool call would produce, just reached over HTTP instead of a direct
// store call (this process has no DB access of its own — see the module header).

/** Adapts a ToolRegistry-shaped ToolDefinition ({type:'function', function:{...}}) into the MCP
 *  tool-list shape ({name, description, inputSchema}) — same schema object, different envelope. */
function toMcpTool(def: { function: { name: string; description?: string; parameters?: Record<string, unknown> } }) {
  return {
    name: def.function.name,
    description: def.function.description ?? '',
    inputSchema: def.function.parameters ?? { type: 'object', properties: {} },
  }
}

/** Surfaced in the `initialize` response — an MCP client MAY fold this into the model's context
 *  before it ever sees a user message (spec's own wording: "a hint... added to the system
 *  prompt"). Not guaranteed to be honored by every host (tracked upstream as a real gap, e.g.
 *  anthropics/claude-code#43749) — belt, not the only suspender: create_routine/list_routines'
 *  own descriptions below carry the same warning, since a tool's description is the one part of
 *  an MCP server every host reliably surfaces. Written after a live miss: a claude_cli session
 *  asked in plain words to "create a routine" reached for its own Bash tool and wrote an OS-level
 *  cron job instead — it had no reason to think "routine" meant anything but the word's normal
 *  sense until told so explicitly. */
const MCP_SERVER_INSTRUCTIONS =
  'This server is TurboLLM\'s own app — not a generic scheduler integration. In this app, "a routine" ' +
  'specifically means a TurboLLM Routine (list_routines/create_routine below), and "an agent" specifically ' +
  'means a TurboLLM custom chat agent (list_agents/create_agent below). Whenever the user asks to schedule, ' +
  'automate, or set up something to run on its own on a recurring basis, or uses the word "routine", use ' +
  'these tools — NEVER cron, systemd timers, Windows Task Scheduler, or launchd: TurboLLM has no visibility ' +
  'into those and nothing you write there will ever actually run through it.'

/** create_routine/list_routines get the SAME anti-cron framing as MCP_SERVER_INSTRUCTIONS baked
 *  directly into their own description, not just the initialize hint — a tool's own description
 *  is the one part of an MCP server every host reliably shows the model, hint-honoring or not.
 *  Deliberately NOT applied to CREATE_ROUTINE_TOOL/LIST_ROUTINES_TOOL themselves (the shared
 *  objects chat/pi also use via ToolRegistry): those callers never had cron/Bash access to
 *  reach for in the first place, so the warning would be pure noise on every OTHER surface this
 *  same schema serves. */
function withAntiCronFraming(def: Parameters<typeof toMcpTool>[0]) {
  const mcp = toMcpTool(def)
  return { ...mcp, description: `${MCP_SERVER_INSTRUCTIONS}\n\n${mcp.description}` }
}

const ROUTINE_TOOLS = [
  withAntiCronFraming(LIST_ROUTINES_TOOL), withAntiCronFraming(CREATE_ROUTINE_TOOL),
  toMcpTool(LIST_AGENTS_TOOL), toMcpTool(CREATE_AGENT_TOOL), toMcpTool(LIST_MODELS_TOOL),
]

async function listModelsText(baseUrl: string, fetchImpl: typeof fetch): Promise<string> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/api/v1/models`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  } catch (e) {
    return `Error: could not reach the TurboLLM daemon at ${baseUrl}. (${e instanceof Error ? e.message : e})`
  }
  if (!res.ok) return `Error: ${await describeHttpError(res)}`
  const { models } = await res.json() as { models: ModelEntry[] }
  if (models.length === 0) return 'No models in the library yet — add one in TurboLLM\'s Models screen first.'
  return models.map((m) => `- ${m.key} — ${m.name} (${m.quant}, ${m.sizeLabel})`).join('\n')
}

async function listRoutinesText(baseUrl: string, fetchImpl: typeof fetch): Promise<string> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/api/v1/routines`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  } catch (e) {
    return `Error: could not reach the TurboLLM daemon at ${baseUrl}. (${e instanceof Error ? e.message : e})`
  }
  if (!res.ok) return `Error: ${await describeHttpError(res)}`
  const routines = await res.json() as Routine[]
  if (routines.length === 0) return 'No routines exist yet.'
  return routines.map((r) => `- ${r.id} [${r.status}] ${r.flavor} — "${r.scheduleDisplay}" — ${r.prompt}`).join('\n')
}

/** Runs `validateCreate` — the SAME function POST /api/v1/routines itself calls — before ever
 *  reaching the network, so a malformed call gets the identical message whether it's caught here
 *  or at the route, not a second copy of the wording that can drift. */
async function createRoutineText(baseUrl: string, args: Record<string, unknown>, fetchImpl: typeof fetch): Promise<string> {
  const problem = validateCreate(args as unknown as RoutineBody)
  if (problem) return `Error: ${problem}`
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/api/v1/routines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (e) {
    return `Error: could not reach the TurboLLM daemon at ${baseUrl}. (${e instanceof Error ? e.message : e})`
  }
  if (!res.ok) return `Error: ${await describeHttpError(res)}`
  const routine = await res.json() as Routine
  return `Created routine "${routine.id}" (${routine.scheduleDisplay}) in status "pending_confirmation". ` +
    'It will NOT run until a human confirms it in the Routines panel — tell the user to review and confirm it.'
}

async function listAgentsText(baseUrl: string, fetchImpl: typeof fetch): Promise<string> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/api/v1/chat-agents`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  } catch (e) {
    return `Error: could not reach the TurboLLM daemon at ${baseUrl}. (${e instanceof Error ? e.message : e})`
  }
  if (!res.ok) return `Error: ${await describeHttpError(res)}`
  const agents = await res.json() as CustomChatAgent[]
  if (agents.length === 0) return 'No custom agents exist yet. Use create_agent to make one.'
  return agents.map((a) => `- ${a.id} "${a.name}" — ${a.description || '(no description)'} — tools: ${a.tools.join(', ') || '(none)'}`).join('\n')
}

async function createAgentText(baseUrl: string, args: Record<string, unknown>, fetchImpl: typeof fetch): Promise<string> {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (!name) return 'Error: name is required.'
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/api/v1/chat-agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...args, name }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (e) {
    return `Error: could not reach the TurboLLM daemon at ${baseUrl}. (${e instanceof Error ? e.message : e})`
  }
  if (!res.ok) return `Error: ${await describeHttpError(res)}`
  const agent = await res.json() as CustomChatAgent
  return `Created agent ${agent.id} "${agent.name}".`
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
          result: {
            protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'turbollm', version },
            instructions: MCP_SERVER_INSTRUCTIONS,
          },
        }
      case 'tools/list':
        return { jsonrpc: '2.0', id: req.id, result: { tools: [DELEGATE_TOOL_SCHEMA, ...ROUTINE_TOOLS] } }
      case 'tools/call': {
        const p = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
        const args = p.arguments ?? {}
        if (p.name === DELEGATE_TOOL_NAME) {
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
        const textByTool: Record<string, () => Promise<string>> = {
          list_routines: () => listRoutinesText(baseUrl, fetchImpl),
          create_routine: () => createRoutineText(baseUrl, args, fetchImpl),
          list_agents: () => listAgentsText(baseUrl, fetchImpl),
          create_agent: () => createAgentText(baseUrl, args, fetchImpl),
          list_models: () => listModelsText(baseUrl, fetchImpl),
        }
        const run = textByTool[p.name ?? '']
        if (!run) throw new Error(`Unknown tool: ${p.name}`)
        const text = await run()
        return { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text }], isError: text.startsWith('Error:') } }
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
