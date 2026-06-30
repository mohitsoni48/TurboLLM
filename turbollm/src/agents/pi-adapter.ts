// pi-adapter — single boundary for all pi SDK imports (spec 13 §3.1)
import {
  createAgentSession,
  ModelRegistry,
  AuthStorage,
  SessionManager,
  defineTool,
} from '@earendil-works/pi-coding-agent'
import { streamSimple as openaiStreamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AgentType } from '../config/config'
import type { Deps } from '../deps'
import type { EventSink } from '../chat/generation'
import type { ToolCallGuard } from './fs-guard'
import type { GenerationGate } from './gate'
import { RUN_HEADER } from './engine-progress-tap'

// ── Types ─────────────────────────────────────────────────────────────────────
export interface PiAgentConfig {
  baseUrl: string
  modelId: string
  agent: AgentType
  systemPrompt: string
  userMessage: string
  tools: string[]
  customTools: ReturnType<typeof defineTool>[]
  onEvent: EventSink
  /** Pre-exec guard (spec 13 §4.2). Enforced INSIDE each custom tool's execute —
   *  pi's SDK createAgentSession() does not accept the extension `tool_call` hook,
   *  so we co-locate enforcement with the tool. A blocked call returns an error
   *  result to the model instead of running. */
  onToolCall: ToolCallGuard
  /** Shared engine-slot mutex (spec 13 §3.4). When present, pi's engine calls run
   *  at 'bg' priority so foreground chat preempts them. */
  gate?: GenerationGate
  /** Working directory pi anchors its own framing to. Set to the agent's primary
   *  root so pi's default system prompt treats that folder as the workspace (else
   *  pi defaults to the repo dir and the model refuses paths outside it). */
  cwd: string
  /** Permission mode (ADR pending). 'read' = read-only built-ins; 'auto'/'bypass' =
   *  full read/bash/edit/write; 'ask' = approve each (handled at the tool layer). */
  mode?: AgentMode
  /** Run id used to tag engine requests so the prefill-progress tap can route
   *  llama.cpp's prompt_progress back to this run's event sink (spec 13 §prefill). */
  runId?: string
}

export type AgentMode = 'ask' | 'auto' | 'bypass' | 'read'

/** Wrap a custom tool so the guard runs before its execute. A blocked call never
 *  reaches the underlying tool — the model gets a denial message as the result. */
export function guardTool(
  tool: ReturnType<typeof defineTool>,
  guard: ToolCallGuard,
): ReturnType<typeof defineTool> {
  const original = tool.execute
  return defineTool({
    name: tool.name,
    label: tool.label,
    description: tool.description ?? '',
    parameters: tool.parameters,
    execute: async (id, params, _signal, _onUpdate, _ctx) => {
      const verdict = guard(tool.name, params as Record<string, unknown>)
      if ('block' in verdict) {
        return { content: [{ type: 'text', text: `Denied: ${verdict.reason}` }], details: undefined }
      }
      return original(id, params, _signal, _onUpdate, _ctx)
    },
  })
}

export interface AgentRunResult {
  tokens: { input: number; output: number }
  cost: number
}

// ── runAgentSession ───────────────────────────────────────────────────────────
/** Create session, register provider, map pi events to our EventSink. */
export async function runAgentSession(
  config: PiAgentConfig,
  signal: AbortSignal,
): Promise<AgentRunResult> {
  const auth = AuthStorage.create()
  auth.setRuntimeApiKey('local', 'agent-key')
  const registry = ModelRegistry.inMemory(auth)

  registerLocalProvider(config.baseUrl, config.modelId, auth, registry, config.gate, signal, config.runId)
  const model = registry.find('local', config.modelId)
  if (!model) throw new Error(`Model ${config.modelId} not found`)

  // Guard EVERY custom tool at its execute boundary (the SDK's createAgentSession
  // does not accept the extension `tool_call` hook, so this is where enforcement lives).
  const guardedTools = config.customTools.map((t) => guardTool(t, config.onToolCall))

  // Permission mode (ADR pending) decides which of pi's REAL built-in tools the agent
  // gets. 'read' restricts to the read-only set; everything else enables pi's full
  // read/bash/edit/write so the agent can actually do work (start servers, run scripts).
  const builtinTools = config.mode === 'read'
    ? { tools: ['read', 'grep', 'find', 'ls'] }
    : {} // omit noTools/tools → pi enables read, bash, edit, write
  const { session } = await createAgentSession({
    model,
    authStorage: auth,
    modelRegistry: registry,
    cwd: config.cwd,
    sessionManager: SessionManager.inMemory(config.cwd),
    ...builtinTools,
    // Our task-tracking + bridged registry tools, in addition to pi's built-ins.
    customTools: guardedTools,
  })

  // Context-awareness (spec 13 §12.1): enable pi's native auto-compaction so a long
  // contract survives the context wall. The working doc is NOT in pi's transcript
  // (it's DB-persisted, §12.2) so it survives compaction by construction. pi manages
  // the threshold; we surface a 'compaction' event to the UI when it fires.
  session.setAutoCompactionEnabled(true)

  let runResult: AgentRunResult | undefined
  // pi's tool_execution_end carries only the id (no toolName), so remember the name from
  // the start event and echo it back on end — otherwise the UI overwrites the tool name
  // with "undefined" when the call completes.
  const toolNames = new Map<string, string>()

  session.subscribe((event) => {
    switch (event.type) {
      case 'message_update': {
        const me = event.assistantMessageEvent
        if (me.type === 'text_delta') {
          config.onEvent({ event: 'delta', data: { delta: me.delta } })
        } else if (me.type === 'thinking_delta') {
          config.onEvent({ event: 'reasoning', data: { delta: me.delta } })
        }
        break
      }
      case 'tool_execution_start':
        toolNames.set(event.toolCallId, event.toolName)
        config.onEvent({ event: 'tool_call', data: { id: event.toolCallId, name: event.toolName, args: event.args, status: 'pending' } })
        break
      case 'tool_execution_end':
        config.onEvent({ event: 'tool_call', data: { id: event.toolCallId, name: toolNames.get(event.toolCallId), status: event.isError ? 'error' : 'done', result: toolResultText(event.result) } })
        break
      case 'compaction_start':
        config.onEvent({ event: 'compaction', data: { status: 'start' } })
        break
      case 'compaction_end':
        config.onEvent({ event: 'compaction', data: { status: 'end' } })
        break
      case 'agent_end': {
        const stats = session.getSessionStats()
        runResult = {
          tokens: { input: stats.tokens.input, output: stats.tokens.output },
          cost: stats.cost,
        }
        break
      }
    }
  })

  if (signal.aborted) {
    session.dispose()
    const err = new Error('Aborted')
    err.name = 'AbortError'
    throw err
  }

  const disposeOnAbort = () => session.dispose()
  signal.addEventListener('abort', disposeOnAbort, { once: true })

  try {
    // The SDK's createAgentSession has no system-prompt option (it builds the prompt
    // internally from its resourceLoader), so the agent's system prompt + active skill
    // instructions are prepended to the first user message. Reliable on small models —
    // the framing becomes part of the task.
    const prompt = config.systemPrompt
      ? `${config.systemPrompt}\n\n---\n\n${config.userMessage}`
      : config.userMessage
    await session.prompt(prompt)
  } catch (e) {
    config.onEvent({ event: 'error', data: { code: 'agent_error', message: e instanceof Error ? e.message : String(e) } })
    throw e
  } finally {
    signal.removeEventListener('abort', disposeOnAbort)
    session.dispose()
  }

  return runResult ?? { tokens: { input: 0, output: 0 }, cost: 0 }
}

// Tools that are NEVER bridged into an autonomous agent run — no human-in-the-loop.
// run_code executes arbitrary JS; the foreground-chat confirmation gate doesn't apply
// to unattended agent runs, so it must not be reachable here (security review C4).
const NON_BRIDGEABLE = new Set(['run_code'])

// ── buildBridgedTools ─────────────────────────────────────────────────────────
/** Wrap TurboLLM ToolRegistry tools as pi custom tools, filtered to the tool NAMES the
 *  agent's skills actually grant (skills hold tool names; the caller resolves them).
 *  run_code is excluded unconditionally. */
export async function buildBridgedTools(
  d: Deps,
  grantedToolNames: string[],
): Promise<ReturnType<typeof defineTool>[]> {
  const defs = await d.tools?.buildToolDefinitions() ?? []
  const granted = new Set(grantedToolNames)

  return defs
    .filter((t) => granted.has(t.function.name) && !NON_BRIDGEABLE.has(t.function.name))
    .map((t) =>
    defineTool({
      name: t.function.name,
      label: t.function.name,
      description: t.function.description ?? '',
      // MCP tool schemas are runtime JSON-schema objects. Cast to TSchema for pi's type
      // contract — pi accepts JSON-schema at runtime, this is a type-only bridge.
      parameters: (t.function.parameters ?? { type: 'object', properties: {} }) as never,
      execute: async (id, params, _signal, _onUpdate, _ctx) => {
        const result = await d.tools!.executeTool({ id, name: t.function.name, args: params as Record<string, unknown> })
        return { content: [{ type: 'text', text: result }], details: undefined }
      },
    }),
  )
}

/** Extract readable text from pi's tool result ({ content: [{type:'text',text}] }),
 *  so the SSE `result` field is a string, not "[object Object]". */
function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content
  if (Array.isArray(content)) {
    return content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
  }
  return result == null ? '' : String(result)
}

/** Bridge an async-resolved event stream into the synchronous AssistantMessageEventStream
 *  pi's streamSimple must return: forward every event + the terminal result once the
 *  inner (gate-held) stream is available. */
function forwardStream(inner: Promise<AssistantMessageEventStream>): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream()
  // NEVER re-throw here: this runs inside `void inner.then(...)`, so a throw becomes an
  // unhandled rejection (daemon-crash risk, review C1). On any failure just end the
  // stream so pi sees a clean termination and surfaces the error through its own loop.
  void inner.then(
    async (s) => {
      try {
        for await (const ev of s) out.push(ev)
        out.end(await s.result())
      } catch {
        out.end()
      }
    },
    () => out.end(), // gate acquire failed — end empty so pi doesn't hang
  )
  return out
}

// ── registerLocalProvider ─────────────────────────────────────────────────────
/** Register our gateway as a local-openai provider. When a GenerationGate is
 *  supplied, pi's engine calls are bracketed by the gate (spec 13 §3.4) so a
 *  background agent run yields the single engine slot to foreground chat: we
 *  provide a custom `streamSimple` that acquires the gate at 'bg' priority,
 *  delegates to pi-ai's built-in openai-completions streamer, and releases the
 *  gate when the stream completes (success or error). */
/** Per-engine-call timeout: if the engine produces nothing for this long, abort the
 *  request so a stalled (not killed) llama-server can't hold the gate forever (review H1). */
const GENERATION_TIMEOUT_MS = 10 * 60_000

export function registerLocalProvider(
  baseUrl: string,
  modelId: string,
  authStorage: AuthStorage,
  registry: ModelRegistry,
  gate?: GenerationGate,
  runSignal?: AbortSignal,
  runId?: string,
): void {
  authStorage.setRuntimeApiKey('local', 'agent-key')
  registry.registerProvider('local', {
    baseUrl,
    apiKey: 'agent-key',
    authHeader: true,
    api: 'openai-completions',
    ...(gate
      ? {
          streamSimple: (model, context, options) => {
            // Tie the engine fetch to BOTH the run's abort signal (so model eviction /
            // cancel aborts the in-flight request) AND a hard timeout (so a stalled
            // engine can't wedge the gate). pi passes options.signal to its fetch.
            const timeout = AbortSignal.timeout(GENERATION_TIMEOUT_MS)
            const mergedSignal = runSignal
              ? AbortSignal.any([runSignal, timeout, ...(options?.signal ? [options.signal] : [])])
              : AbortSignal.any([timeout, ...(options?.signal ? [options.signal] : [])])
            options = { ...options, signal: mergedSignal }
            // Ask llama.cpp for prefill progress and tag the request so the global
            // fetch tap (engine-progress-tap) can route prompt_progress back to this
            // run's UI. onPayload adds the non-standard body field; the header keys
            // the tap. Both are no-ops without a runId / a llama.cpp engine.
            if (runId) {
              options = {
                ...options,
                headers: { ...(options.headers as Record<string, string> | undefined), [RUN_HEADER]: runId },
                onPayload: (payload) => {
                  if (payload && typeof payload === 'object') (payload as Record<string, unknown>).return_progress = true
                  return payload
                },
              }
            }
            // Acquire BEFORE the request, release when the stream drains. The
            // returned stream is handed straight to pi; we only attach a release
            // on its terminal result() so the gate is never leaked.
            // This provider is registered as 'openai-completions', so model is
            // that api at runtime — narrow for pi-ai's typed streamSimple.
            const oaModel = model as Parameters<typeof openaiStreamSimple>[0]
            const stream = gate
              .acquire('bg')
              .then((release) => {
                // Guarantee release even if openaiStreamSimple throws SYNCHRONOUSLY
                // (malformed model/options) — otherwise the gate leaks and the engine
                // slot wedges for all future runs (review C1 sync-leak).
                try {
                  const s = openaiStreamSimple(oaModel, context, options)
                  void s.result().finally(release)
                  return s
                } catch (e) {
                  release()
                  throw e
                }
              })
            // pi expects a stream synchronously; bridge the acquire promise by
            // returning a stream that forwards once the gate is held.
            return forwardStream(stream)
          },
        }
      : {}),
    models: [{
      id: modelId,
      name: 'Local Model',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 8192,
    }],
  })
}
