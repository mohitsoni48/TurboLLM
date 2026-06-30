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
}

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

  registerLocalProvider(config.baseUrl, config.modelId, auth, registry, config.gate)
  const model = registry.find('local', config.modelId)
  if (!model) throw new Error(`Model ${config.modelId} not found`)

  // Guard EVERY custom tool at its execute boundary (the SDK's createAgentSession
  // does not accept the extension `tool_call` hook, so this is where enforcement lives).
  const guardedTools = config.customTools.map((t) => guardTool(t, config.onToolCall))

  const { session } = await createAgentSession({
    model,
    authStorage: auth,
    modelRegistry: registry,
    cwd: config.cwd,
    sessionManager: SessionManager.inMemory(config.cwd),
    // Disable pi's built-in read/bash/edit/write entirely — the agent only ever sees
    // our guarded custom tools (FS, bridged registry, action tools). Belt: the guard
    // also hard-denies these names if pi ever re-enables them.
    noTools: 'builtin',
    customTools: guardedTools,
  })

  let runResult: AgentRunResult | undefined

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
        config.onEvent({ event: 'tool_call', data: { id: event.toolCallId, name: event.toolName, args: event.args, status: 'pending' } })
        break
      case 'tool_execution_end':
        config.onEvent({ event: 'tool_call', data: { id: event.toolCallId, status: event.isError ? 'error' : 'done', result: toolResultText(event.result) } })
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

// ── buildBridgedTools ─────────────────────────────────────────────────────────
/** Wrap TurboLLM ToolRegistry tools as pi custom tools. */
export async function buildBridgedTools(
  d: Deps,
  agent: AgentType,
): Promise<ReturnType<typeof defineTool>[]> {
  const defs = await d.tools?.buildToolDefinitions() ?? []

  const granted = agent.skills.includes('*')
    ? defs
    : defs.filter((t) => agent.skills.includes(t.function.name))

  return granted.map((t) =>
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
  void inner.then(
    async (s) => {
      try {
        for await (const ev of s) out.push(ev)
        out.end(await s.result())
      } catch (e) {
        out.end()
        throw e
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
export function registerLocalProvider(
  baseUrl: string,
  modelId: string,
  authStorage: AuthStorage,
  registry: ModelRegistry,
  gate?: GenerationGate,
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
            // Acquire BEFORE the request, release when the stream drains. The
            // returned stream is handed straight to pi; we only attach a release
            // on its terminal result() so the gate is never leaked.
            // This provider is registered as 'openai-completions', so model is
            // that api at runtime — narrow for pi-ai's typed streamSimple.
            const oaModel = model as Parameters<typeof openaiStreamSimple>[0]
            const stream = gate
              .acquire('bg')
              .then((release) => {
                const s = openaiStreamSimple(oaModel, context, options)
                void s.result().finally(release)
                return s
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
