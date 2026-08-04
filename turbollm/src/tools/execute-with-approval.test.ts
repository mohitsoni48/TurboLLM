// Regression coverage for the F-019 approval-gate executor, in particular the
// background-agent path: every tool defaults to 'ask' (tool-policy.ts), and a
// background run can never prompt a human (interactive: false) — so a tool the
// agent was explicitly configured to use (agentAllowedTools) must still run.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolRegistry, ToolCall } from './tool-registry'
import { executeToolCallWithApproval } from './execute-with-approval'

function fakeTools(result = 'ok'): ToolRegistry {
  return {
    executeTool: async (_call: ToolCall) => result,
  } as unknown as ToolRegistry
}

function collectSink() {
  const events: Array<{ event: string; data: unknown }> = []
  return { events, sink: (ev: { event: string; data: unknown }) => { events.push(ev) } }
}

test('background agent run executes an "ask"-default tool that is in agentAllowedTools', async () => {
  const { sink, events } = collectSink()
  const { result, error } = await executeToolCallWithApproval({
    tools: fakeTools('search results'),
    sink,
    convId: 'c1',
    id: 't1',
    name: 'web_search',
    args: {},
    globalPolicies: {}, // no explicit policy -> resolves to 'ask'
    convOverrides: {},
    signal: new AbortController().signal,
    interactive: false,
    agentAllowedTools: ['web_search'],
  })

  assert.strictEqual(error, undefined)
  assert.strictEqual(result, 'search results')
  assert.ok(events.some((e) => e.event === 'tool_call' && (e.data as { status: string }).status === 'done'))
})

test('background agent run blocks an "ask"-default tool NOT in agentAllowedTools', async () => {
  const { result } = await executeToolCallWithApproval({
    tools: fakeTools(),
    sink: () => {},
    convId: 'c1',
    id: 't2',
    name: 'fetch_url',
    args: {},
    globalPolicies: {},
    convOverrides: {},
    signal: new AbortController().signal,
    interactive: false,
    agentAllowedTools: ['web_search'], // fetch_url not whitelisted for this agent
  })

  assert.match(result, /Blocked.*background agent/)
})

test('background agent run blocks every tool when agentAllowedTools is omitted (unchanged default)', async () => {
  const { result } = await executeToolCallWithApproval({
    tools: fakeTools(),
    sink: () => {},
    convId: 'c1',
    id: 't3',
    name: 'web_search',
    args: {},
    globalPolicies: {},
    convOverrides: {},
    signal: new AbortController().signal,
    interactive: false,
  })

  assert.match(result, /Blocked.*background agent/)
})

test('explicit global "deny" wins even if the tool is in agentAllowedTools', async () => {
  const { result } = await executeToolCallWithApproval({
    tools: fakeTools(),
    sink: () => {},
    convId: 'c1',
    id: 't4',
    name: 'web_search',
    args: {},
    globalPolicies: { web_search: 'deny' },
    convOverrides: {},
    signal: new AbortController().signal,
    interactive: false,
    agentAllowedTools: ['web_search'],
  })

  assert.match(result, /Blocked.*Deny/)
})

// ── Phase 4 / C1: the isCodeAuthorized pass-through ─────────────────────────────────────────
// This function makes no decision with isCodeAuthorized — it only hands it to
// ToolRegistry.executeTool, which is where create_routine/update_routine/run_routine_now consult
// it. That one line (`params.isCodeAuthorized ?? false`) is the entire link between chat's
// per-request trust decision and the routine executors' gate, and nothing pinned it: deleting the
// argument, or replacing it with a literal, left the whole suite green. These capture the value
// executeTool actually received, so the pass-through itself is a test failure if it ever drifts.

/** A ToolRegistry double that records the 2nd argument executeTool was called with. `unknown`
 *  rather than `boolean` deliberately: an omitted argument must be observable as `undefined` here
 *  and distinguishable from an explicit `false`, so the ?? default is being tested and not the
 *  parameter default of some intermediate. */
function capturingTools(): { tools: ToolRegistry; seen: unknown[] } {
  const seen: unknown[] = []
  const tools = {
    executeTool: async (_call: ToolCall, isCodeAuthorized?: unknown) => { seen.push(isCodeAuthorized); return 'ok' },
  } as unknown as ToolRegistry
  return { tools, seen }
}

const passThroughBase = {
  sink: () => {},
  convId: 'c1',
  id: 't1',
  name: 'create_routine',
  args: {},
  globalPolicies: { create_routine: 'allow' as const },
  convOverrides: {},
  signal: new AbortController().signal,
  interactive: false,
}

test('isCodeAuthorized pass-through: OMITTING it reaches executeTool as false (fails closed)', async () => {
  const { tools, seen } = capturingTools()
  await executeToolCallWithApproval({ ...passThroughBase, tools })
  assert.deepStrictEqual(seen, [false], 'an omitted trust decision must arrive as an explicit false, never undefined')
})

test('isCodeAuthorized pass-through: an explicit false reaches executeTool as false', async () => {
  const { tools, seen } = capturingTools()
  await executeToolCallWithApproval({ ...passThroughBase, tools, isCodeAuthorized: false })
  assert.deepStrictEqual(seen, [false])
})

test('isCodeAuthorized pass-through: an explicit true reaches executeTool as true (not swallowed)', async () => {
  const { tools, seen } = capturingTools()
  await executeToolCallWithApproval({ ...passThroughBase, tools, isCodeAuthorized: true })
  assert.deepStrictEqual(seen, [true], 'a genuinely authorized caller must not be silently downgraded')
})

test('an "allow"-policy tool still executes for a background run with no agentAllowedTools needed', async () => {
  const { result, error } = await executeToolCallWithApproval({
    tools: fakeTools('42'),
    sink: () => {},
    convId: 'c1',
    id: 't5',
    name: 'run_code',
    args: {},
    globalPolicies: { run_code: 'allow' },
    convOverrides: {},
    signal: new AbortController().signal,
    interactive: false,
  })

  assert.strictEqual(error, undefined)
  assert.strictEqual(result, '42')
})
