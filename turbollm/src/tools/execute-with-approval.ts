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
  /** Settings → Tool permissions master toggle (default off) — silences a resolved
   *  'ask' only; an explicit 'deny' is still honored. See resolveToolPolicy. */
  autoAllowAll?: boolean
  signal: AbortSignal
  /** true for live foreground chat (can prompt a human); false for background agent runs
   *  (must never hang waiting for a human — 'ask'-policy tools are denied unless
   *  pre-approved via agentAllowedTools). */
  interactive: boolean
  /** For background agent runs only: the tool names this agent was explicitly configured
   *  to use. A human already approved this list when setting up the agent, so it stands
   *  in for the interactive approval a background run can never get. */
  agentAllowedTools?: string[]
  /** Phase 4 / C1: whether the caller driving this tool loop has cleared the same bar `codeAuth`
   *  enforces (host-local OR a valid API key). Purely pass-through — this function makes no
   *  decision with it; `ToolRegistry.executeTool` forwards it to create_routine/update_routine,
   *  the only tools that consult it, and only for code-flavor routines. OPTIONAL and defaulting
   *  to false so a caller that does not supply it fails closed, matching routine-tools.ts's own
   *  fail-closed philosophy. See each call site for how it computes (or deliberately omits) it. */
  isCodeAuthorized?: boolean
}): Promise<{ result: string; error?: string }> {
  const { tools, sink, convId, id, name, args, globalPolicies, convOverrides, signal, interactive, agentAllowedTools, autoAllowAll } = params

  const policy = resolveToolPolicy(name, globalPolicies, convOverrides, autoAllowAll)

  if (policy === 'deny') {
    const result = 'Blocked: this tool is set to Deny in Tool Permissions settings.'
    await sink({ event: 'tool_call', data: { id, name, args, status: 'done', result } })
    return { result }
  }

  let cameFromApprovedAsk = false

  if (policy === 'ask') {
    if (!interactive) {
      if (agentAllowedTools?.includes(name)) {
        cameFromApprovedAsk = true
      } else {
        const result = "Blocked: this tool requires interactive approval, which is not available for background agent runs. Add it to this agent's allowed tools, or set it to Allow in Developer → Tool permissions."
        await sink({ event: 'tool_call', data: { id, name, args, status: 'done', result } })
        return { result }
      }
    } else {
      await sink({ event: 'tool_call', data: { id, name, args, status: 'awaiting_approval' } })
      const decision = await waitForToolApproval(`${convId}:${id}`, signal)
      if (decision === 'deny') {
        const result = 'Denied by user.'
        await sink({ event: 'tool_call', data: { id, name, args, status: 'done', result } })
        return { result }
      }
      cameFromApprovedAsk = true
    }
  }

  // policy === 'allow', or fell through from an approved 'ask'.
  if (!cameFromApprovedAsk) {
    await sink({ event: 'tool_call', data: { id, name, args, status: 'pending' } })
  }

  let result = ''
  let error: string | undefined
  try {
    const call: ToolCall = { id, name, args }
    result = await tools.executeTool(call, params.isCodeAuthorized ?? false)
  } catch (e) {
    error = (e as Error).message
    result = `Error: ${error}`
  }

  await sink({ event: 'tool_call', data: { id, name, args, status: error ? 'error' : 'done', result } })
  return { result, error }
}
