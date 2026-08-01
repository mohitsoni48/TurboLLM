// turbollm/src/routines/chat-runner.ts
//
// Chat-flavor Routine execution — the "detached version of the existing chat generation path"
// spec 20 §5 asks for, tracing to the Scope-A detached-generation lineage that spec cites (spec
// 20 §5's last bullet). NOT a reuse of chat-routes.ts's runGeneration(): that function is
// hard-coupled to a live Hono SSE StreamHandle (stream.writeSSE(...) throughout) and has no
// live client to stream to here — a routine's result is written to the DB/RoutineRun, never
// streamed. Reused directly instead: executeToolCallWithApproval (tools/execute-with-approval.ts),
// which already supports a non-interactive background caller via `interactive:false` +
// `agentAllowedTools` (confirmed dead code since the old background agent runner, generation.ts,
// was deleted per ADR-163 — this is that seam, finally used again); engineModelAlias/
// clampMaxTokens (request shaping, same as chat-routes.ts); and ToolLoopTracker/
// LOOP_BREAK_AFTER/LOOP_ABORT_AFTER (runaway-guard.ts) — chat-routes.ts's own tool loop has only
// a round-count ceiling (MAX_TOOL_ITER) with no same-call loop breaker, so an UNATTENDED run
// needs this wired explicitly (there is no human to notice a stuck loop).
//
// Requests stream:false — nobody is watching deltas live, so one non-streaming completion per
// round is simpler and exactly as sufficient as chat-routes.ts's own SSE delta parser, without
// reimplementing it for an audience of nobody.
import type { Deps } from '../deps'
import type { CustomChatAgent } from '../config/config'
import type { Routine, RoutineRun } from './schema'
import { clampMaxTokens } from '../config/config'
import { engineModelAlias } from '../engines/compat'
import { executeToolCallWithApproval } from '../tools/execute-with-approval'
import { ToolLoopTracker, LOOP_BREAK_AFTER, LOOP_ABORT_AFTER } from './runaway-guard'
import { stallRoutineRun, type PendingRoutineToolCall } from './approval'

/** Mirrors chat-routes.ts's own MAX_TOOL_ITER (16) — same headroom reasoning: a handful of
 *  web_search/fetch_url/run_code rounds plus a final answer round. A ceiling, not a target. */
export const MAX_TOOL_ITER = 16

export type ChatRunOutcome =
  | { status: 'ok'; result: string }
  | { status: 'needs_approval' }
  | { status: 'errored'; error: string }

interface WireMessage { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }
interface LoopState { messages: WireMessage[]; toolLoop: ToolLoopTracker; iter: number }

function buildInitialMessages(agent: CustomChatAgent, prompt: string): WireMessage[] {
  const messages: WireMessage[] = []
  if (agent.systemPrompt) messages.push({ role: 'system', content: agent.systemPrompt })
  messages.push({ role: 'user', content: prompt })
  return messages
}

function findAgent(d: Deps, routine: Routine): CustomChatAgent | undefined {
  return d.store.snapshot().customAgents.find((a) => a.id === routine.agentId)
}

/** Runs one Chat Routine fire to completion (or a stall/error), starting a FRESH conversation
 *  each time — a routine run is always a new task, never a continued thread (spec 20 §1's Chat
 *  Routine description). `signal` combines the caller's wall-clock deadline with cancellation. */
export async function runChatRoutine(d: Deps, routine: Routine, run: RoutineRun, signal: AbortSignal): Promise<ChatRunOutcome> {
  const agent = findAgent(d, routine)
  if (!agent) return { status: 'errored', error: `Chat agent "${routine.agentId}" no longer exists.` }

  const conv = d.db.createConversation({
    kind: 'agent', modelKey: routine.modelKey, systemPrompt: agent.systemPrompt,
    skillIds: agent.skillIds, allowedTools: agent.tools, agentId: agent.id,
  })
  d.db.addMessage(conv.id, 'user', routine.prompt)

  return runChatRoundLoop(d, run, agent, conv.id, signal, { messages: buildInitialMessages(agent, routine.prompt), toolLoop: new ToolLoopTracker(), iter: 0 })
}

/** Resume a stalled Chat Routine after an approve/deny decision. `pending` is the exact resume
 *  point stallRoutineRun() persisted — never re-derived from a (possibly since-edited) live
 *  Routine row, per spec 20 §6's "resumes with its original snapshot" rule. Since this runner
 *  owns its own tool loop end-to-end (no live pi/subprocess in the middle), resuming here is a
 *  literal continuation from the exact blocked point — no fresh-turn approximation needed. */
export async function resumeChatRoutine(
  d: Deps, routine: Routine, run: RoutineRun, pending: PendingRoutineToolCall, decision: 'allow' | 'deny', signal: AbortSignal,
): Promise<ChatRunOutcome> {
  const agent = findAgent(d, routine)
  if (!agent) return { status: 'errored', error: `Chat agent "${routine.agentId}" no longer exists.` }
  if (decision === 'deny') return { status: 'errored', error: `Tool call "${pending.call.name}" denied by user.` }

  const conv = d.db.getConversation(pending.convId, true)
  if (!conv) return { status: 'errored', error: "The routine's conversation no longer exists." }

  const messages = buildInitialMessages(agent, routine.prompt)
  for (const m of conv.messages ?? []) messages.push({ role: m.role, content: m.content })
  messages.push({
    role: 'assistant', content: pending.assistantContent || null,
    tool_calls: [...pending.precedingCalls, pending.call].map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
  })
  for (const c of pending.precedingCalls) messages.push({ role: 'tool', content: c.result, tool_call_id: c.id })

  const approved = d.tools
    ? await executeToolCallWithApproval({
        tools: d.tools, sink: () => {}, convId: pending.convId, id: pending.call.id, name: pending.call.name, args: pending.call.args,
        globalPolicies: d.store.snapshot().tools.toolPolicies ?? {}, convOverrides: d.db.getToolOverrides(pending.convId),
        signal, interactive: false, agentAllowedTools: agent.tools,
      })
    : { result: 'Error: no tool registry available.' }
  messages.push({ role: 'tool', content: approved.result, tool_call_id: pending.call.id })

  return runChatRoundLoop(d, run, agent, pending.convId, signal, { messages, toolLoop: new ToolLoopTracker(), iter: 0 })
}

async function runChatRoundLoop(d: Deps, run: RoutineRun, agent: CustomChatAgent, convId: string, signal: AbortSignal, state: LoopState): Promise<ChatRunOutcome> {
  const ms = d.manager.status()
  const target = d.manager.target?.() ?? null
  if (ms.state !== 'running' || !ms.model || !target) return { status: 'errored', error: 'No model loaded.' }

  const engineKind = d.registry.active()?.kind ?? ''
  const baseToolDefs = d.tools ? (await d.tools.buildToolDefinitions()).filter((t) => agent.tools.includes(t.function.name)) : []
  const maxLimit = d.store.snapshot().modelDefaults.maxTokens ?? 0

  while (state.iter < MAX_TOOL_ITER) {
    state.iter++
    if (signal.aborted) return { status: 'errored', error: 'Routine run timed out or was cancelled.' }

    const reqBody: Record<string, unknown> = { model: engineModelAlias(engineKind) ?? ms.model.key, messages: state.messages, stream: false }
    if (baseToolDefs.length) reqBody.tools = baseToolDefs
    const cappedMax = clampMaxTokens(undefined, maxLimit)
    if (cappedMax != null) reqBody.max_tokens = cappedMax

    const res = await fetch(`${target}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody), signal })
    if (!res.ok) return { status: 'errored', error: `Engine returned ${res.status}.` }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> }
    const message = data.choices?.[0]?.message
    if (!message) return { status: 'errored', error: 'Engine returned no message.' }

    const toolCalls = message.tool_calls ?? []
    if (toolCalls.length === 0) {
      const content = message.content ?? ''
      d.db.addMessage(convId, 'assistant', content)
      return { status: 'ok', result: content }
    }

    state.messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls })
    const precedingCalls: PendingRoutineToolCall['precedingCalls'] = []

    for (const tc of toolCalls) {
      let args: Record<string, unknown>
      try { args = JSON.parse(tc.function.arguments || '{}') } catch { args = {} }

      const loopCount = state.toolLoop.record(tc.function.name, args)
      if (loopCount > LOOP_ABORT_AFTER) {
        return { status: 'errored', error: `"${tc.function.name}" was called with identical arguments ${loopCount} times in a row — stopped automatically to avoid an infinite loop.` }
      }

      if (!agent.tools.includes(tc.function.name)) {
        stallRoutineRun(d.db, run.id, { convId, assistantContent: message.content ?? '', precedingCalls, call: { id: tc.id, name: tc.function.name, args } })
        return { status: 'needs_approval' }
      }

      if (loopCount > LOOP_BREAK_AFTER) {
        const blocked = `Blocked: "${tc.function.name}" was called with identical arguments too many times in a row — not executed.`
        precedingCalls.push({ id: tc.id, name: tc.function.name, args, result: blocked })
        state.messages.push({ role: 'tool', content: blocked, tool_call_id: tc.id })
        continue
      }

      const executed = d.tools
        ? await executeToolCallWithApproval({
            tools: d.tools, sink: () => {}, convId, id: tc.id, name: tc.function.name, args,
            globalPolicies: d.store.snapshot().tools.toolPolicies ?? {}, convOverrides: d.db.getToolOverrides(convId),
            signal, interactive: false, agentAllowedTools: agent.tools,
          })
        : { result: 'Error: no tool registry available.' }
      precedingCalls.push({ id: tc.id, name: tc.function.name, args, result: executed.result })
      state.messages.push({ role: 'tool', content: executed.result, tool_call_id: tc.id })
    }
  }
  return { status: 'errored', error: `Exceeded the ${MAX_TOOL_ITER}-round tool-call ceiling without finishing.` }
}
