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
