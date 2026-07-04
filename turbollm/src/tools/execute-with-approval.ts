// Shared tool-call executor with the real approval gate (F-019 replacement).
// Both live foreground chat (chat-routes.ts) and the background agent runner
// (generation.ts) call this single implementation instead of maintaining their
// own inline per-tool-call blocks.
import type { ToolRegistry, ToolCall } from './tool-registry'
import { type ToolPolicy, resolveToolPolicy } from './tool-policy'
import { waitForToolApproval } from './approval-gate'

export type ToolCallSink = (ev: { event: string; data: unknown }) => void | Promise<void>

export async function executeToolCallWithApproval(params: {
  tools: ToolRegistry
  sink: ToolCallSink
  convId: string
  id: string
  name: string
  args: Record<string, unknown>
  globalPolicies: Record<string, ToolPolicy>
  convOverrides: Record<string, 'allow' | 'deny'>
  signal: AbortSignal
  /** true for live foreground chat (can prompt a human); false for background agent runs
   *  (must never hang waiting for a human — 'ask'-policy tools are denied outright). */
  interactive: boolean
}): Promise<{ result: string; error?: string }> {
  const { tools, sink, convId, id, name, args, globalPolicies, convOverrides, signal, interactive } = params

  const policy = resolveToolPolicy(name, globalPolicies, convOverrides)

  if (policy === 'deny') {
    const result = 'Blocked: this tool is set to Deny in Tool Permissions settings.'
    await sink({ event: 'tool_call', data: { id, name, args, status: 'done', result } })
    return { result }
  }

  let cameFromApprovedAsk = false

  if (policy === 'ask') {
    if (!interactive) {
      const result = 'Blocked: this tool requires interactive approval, which is not available for background agent runs.'
      await sink({ event: 'tool_call', data: { id, name, args, status: 'done', result } })
      return { result }
    }

    await sink({ event: 'tool_call', data: { id, name, args, status: 'awaiting_approval' } })
    const decision = await waitForToolApproval(`${convId}:${id}`, signal)
    if (decision === 'deny') {
      const result = 'Denied by user.'
      await sink({ event: 'tool_call', data: { id, name, args, status: 'done', result } })
      return { result }
    }
    cameFromApprovedAsk = true
  }

  // policy === 'allow', or fell through from an approved 'ask'.
  if (!cameFromApprovedAsk) {
    await sink({ event: 'tool_call', data: { id, name, args, status: 'pending' } })
  }

  let result = ''
  let error: string | undefined
  try {
    const call: ToolCall = { id, name, args }
    result = await tools.executeTool(call)
  } catch (e) {
    error = (e as Error).message
    result = `Error: ${error}`
  }

  await sink({ event: 'tool_call', data: { id, name, args, status: error ? 'error' : 'done', result } })
  return { result, error }
}
