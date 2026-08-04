import assert from 'node:assert/strict'
import { test } from 'node:test'
import { delegateCodeTask, handleMcpRequest, DELEGATE_TOOL_NAME } from './mcp-server'

const BASE = 'http://127.0.0.1:6996'

/** Builds a fake fetch that answers by URL suffix + method, in the exact call order a real
 *  delegateCodeTask run makes them: POST /sessions → POST /sessions/:id/messages → GET /sessions/:id (polled). */
function fakeFetch(handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>): typeof fetch {
  let i = 0
  return (async (url: string, init?: RequestInit) => {
    const h = handlers[Math.min(i, handlers.length - 1)]
    i++
    return h(url, init)
  }) as typeof fetch
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

test('delegateCodeTask: happy path returns the last assistant message once running=false', async () => {
  const f = fakeFetch([
    () => json({ sessionId: 'sess-1' }, 201),
    () => json({ ok: true, queued: false }, 202),
    () => json({
      running: false,
      conversation: { messages: [
        { role: 'user', content: 'do the thing' },
        { role: 'assistant', content: 'done, here is the result' },
      ] },
    }),
  ])
  const result = await delegateCodeTask(BASE, { repoRoot: '/repo', task: 'do the thing', timeoutSeconds: 10 }, f)
  assert.equal(result.ok, true)
  assert.equal(result.text, 'done, here is the result')
})

test('delegateCodeTask: polls past running=true frames before returning', async () => {
  let pollCount = 0
  const f = fakeFetch([
    () => json({ sessionId: 'sess-2' }, 201),
    () => json({ ok: true, queued: false }, 202),
    () => {
      pollCount++
      if (pollCount < 3) return json({ running: true, conversation: { messages: [] } })
      return json({ running: false, conversation: { messages: [{ role: 'assistant', content: 'finished after polling' }] } })
    },
  ])
  const result = await delegateCodeTask(BASE, { repoRoot: '/repo', task: 'x', timeoutSeconds: 30 }, f)
  assert.equal(result.ok, true)
  assert.equal(result.text, 'finished after polling')
  assert.ok(pollCount >= 3)
})

test('delegateCodeTask: daemon unreachable returns a clear, non-throwing error', async () => {
  const f = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
  const result = await delegateCodeTask(BASE, { repoRoot: '/repo', task: 'x' }, f)
  assert.equal(result.ok, false)
  assert.match(result.text, /Is it running/)
  assert.match(result.text, /npx turbollm/)
})

test('delegateCodeTask: session-create rejection (e.g. missing repoRoot) surfaces the daemon\'s own error message', async () => {
  const f = fakeFetch([() => json({ error: { code: 'invalid_input', message: 'repoRoot is required.' } }, 400)])
  const result = await delegateCodeTask(BASE, { repoRoot: '/repo', task: 'x' }, f)
  assert.equal(result.ok, false)
  assert.match(result.text, /repoRoot is required/)
})

test('delegateCodeTask: 409 model_not_loaded from POST /messages surfaces cleanly, not a raw HTTP status', async () => {
  const f = fakeFetch([
    () => json({ sessionId: 'sess-3' }, 201),
    () => json({ error: { code: 'model_not_loaded', message: 'Load a model first.' } }, 409),
  ])
  const result = await delegateCodeTask(BASE, { repoRoot: '/repo', task: 'x' }, f)
  assert.equal(result.ok, false)
  assert.match(result.text, /Load a model first/)
})

test('delegateCodeTask: empty repoRoot or task fails fast without any network call', async () => {
  let called = false
  const f = (async () => { called = true; return json({}) }) as typeof fetch
  const r1 = await delegateCodeTask(BASE, { repoRoot: '  ', task: 'x' }, f)
  const r2 = await delegateCodeTask(BASE, { repoRoot: '/repo', task: '  ' }, f)
  assert.equal(r1.ok, false)
  assert.equal(r2.ok, false)
  assert.equal(called, false)
})

test('delegateCodeTask: gives up after the deadline with a message that names the session id', async () => {
  const f = fakeFetch([
    () => json({ sessionId: 'sess-stuck' }, 201),
    () => json({ ok: true, queued: false }, 202),
    () => json({ running: true, conversation: { messages: [] } }), // never finishes
  ])
  // timeoutSeconds floors at 10s in the implementation; the poll interval (1.5s) still fires
  // a few times inside that window, exercising the real timeout path without a slow test.
  const start = Date.now()
  const result = await delegateCodeTask(BASE, { repoRoot: '/repo', task: 'x', timeoutSeconds: 1 }, f)
  assert.equal(result.ok, false)
  assert.match(result.text, /Timed out/)
  assert.match(result.text, /sess-stuck/)
  assert.ok(Date.now() - start < 15_000) // sanity: didn't hang way past the floor
})

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────────

test('handleMcpRequest: initialize returns protocol version and serverInfo', async () => {
  const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, BASE, '1.2.3')
  assert.ok(res)
  assert.equal((res!.result as { serverInfo: { version: string } }).serverInfo.version, '1.2.3')
})

test('handleMcpRequest: tools/list advertises the delegate tool plus the routine/agent/model tools', async () => {
  const res = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, BASE, '1.0.0')
  const names = (res!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
  assert.deepEqual(names, [DELEGATE_TOOL_NAME, 'list_routines', 'create_routine', 'list_agents', 'create_agent', 'list_models'])
})

test('handleMcpRequest: initialize surfaces server instructions steering "routine"/"agent" at TurboLLM\'s own tools', async () => {
  const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, BASE, '1.0.0')
  const instructions = (res!.result as { instructions: string }).instructions
  assert.match(instructions, /TurboLLM Routine/)
  assert.match(instructions, /NEVER cron/)
})

test('handleMcpRequest: create_routine/list_routines descriptions carry the same anti-cron warning', async () => {
  const res = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, BASE, '1.0.0')
  const tools = (res!.result as { tools: Array<{ name: string; description: string }> }).tools
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]))
  assert.match(byName.create_routine, /NEVER cron/)
  assert.match(byName.list_routines, /NEVER cron/)
  // Agent/model tools are unaffected — the warning is only noise there.
  assert.doesNotMatch(byName.list_agents, /NEVER cron/)
  assert.doesNotMatch(byName.list_models, /NEVER cron/)
})

test('handleMcpRequest: a notification (no id) returns null — nothing written to stdout', async () => {
  const res = await handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, BASE, '1.0.0')
  assert.equal(res, null)
})

test('handleMcpRequest: tools/call with an unknown tool name returns a JSON-RPC error, not a throw', async () => {
  const res = await handleMcpRequest(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    BASE, '1.0.0',
  )
  assert.ok(res!.error)
  assert.match(res!.error!.message, /Unknown tool/)
})

test('handleMcpRequest: tools/call missing required arguments returns a JSON-RPC error', async () => {
  const res = await handleMcpRequest(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: DELEGATE_TOOL_NAME, arguments: { task: 'x' } } },
    BASE, '1.0.0',
  )
  assert.ok(res!.error)
  assert.match(res!.error!.message, /repoRoot/)
})

test('handleMcpRequest: tools/call success wraps delegateCodeTask\'s result as MCP content, isError=false on success', async () => {
  const f = fakeFetch([
    () => json({ sessionId: 'sess-4' }, 201),
    () => json({ ok: true, queued: false }, 202),
    () => json({ running: false, conversation: { messages: [{ role: 'assistant', content: 'all done' }] } }),
  ])
  const res = await handleMcpRequest(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: DELEGATE_TOOL_NAME, arguments: { repoRoot: '/repo', task: 'x' } } },
    BASE, '1.0.0', f,
  )
  const result = res!.result as { content: Array<{ type: string; text: string }>; isError: boolean }
  assert.equal(result.isError, false)
  assert.equal(result.content[0].text, 'all done')
})

test('handleMcpRequest: tools/call failure (e.g. daemon down) sets isError=true rather than a JSON-RPC error', async () => {
  const f = (async () => { throw new Error('down') }) as typeof fetch
  const res = await handleMcpRequest(
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: DELEGATE_TOOL_NAME, arguments: { repoRoot: '/repo', task: 'x' } } },
    BASE, '1.0.0', f,
  )
  const result = res!.result as { isError: boolean }
  assert.equal(result.isError, true)
})

test('handleMcpRequest: unknown method returns a JSON-RPC error', async () => {
  const res = await handleMcpRequest({ jsonrpc: '2.0', id: 7, method: 'bogus/method' }, BASE, '1.0.0')
  assert.ok(res!.error)
  assert.match(res!.error!.message, /Unknown method/)
})

// ── routine/agent tools ──────────────────────────────────────────────────────
// A claude_cli Code session is the REAL external Claude Code CLI (cli-launch.ts), never routed
// through ToolRegistry — these are its only way to reach TurboLLM's Routines feature at all.
// Each mirrors its ToolRegistry counterpart's exact text contract (routine-tools.ts's
// execListRoutines/execCreateRoutine, chat-agent-tools.ts's execListAgents/execCreateAgent).

function toolCallReq(name: string, args?: Record<string, unknown>) {
  return { jsonrpc: '2.0' as const, id: 10, method: 'tools/call', params: { name, arguments: args } }
}

test('list_routines: empty list says so instead of an empty bullet list', async () => {
  const f = fakeFetch([() => json([])])
  const res = await handleMcpRequest(toolCallReq('list_routines'), BASE, '1.0.0', f)
  const result = res!.result as { content: Array<{ text: string }>; isError: boolean }
  assert.equal(result.content[0].text, 'No routines exist yet.')
  assert.equal(result.isError, false)
})

test('list_routines: formats id, status, flavor, schedule, and prompt — same shape as chat/pi\'s own list_routines', async () => {
  const routine = { id: 'r1', status: 'active', flavor: 'chat', scheduleDisplay: 'Runs every hour', prompt: 'Find jobs' }
  const f = fakeFetch([() => json([routine])])
  const res = await handleMcpRequest(toolCallReq('list_routines'), BASE, '1.0.0', f)
  const text = (res!.result as { content: Array<{ text: string }> }).content[0].text
  assert.equal(text, '- r1 [active] chat — "Runs every hour" — Find jobs')
})

test('list_routines: a non-ok response surfaces the daemon\'s own error message, marked isError', async () => {
  const f = fakeFetch([() => json({ error: { message: 'db locked' } }, 500)])
  const res = await handleMcpRequest(toolCallReq('list_routines'), BASE, '1.0.0', f)
  const result = res!.result as { content: Array<{ text: string }>; isError: boolean }
  assert.equal(result.content[0].text, 'Error: db locked')
  assert.equal(result.isError, true)
})

test('list_routines: a network failure reports unreachable, not an uncaught exception', async () => {
  const f = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
  const res = await handleMcpRequest(toolCallReq('list_routines'), BASE, '1.0.0', f)
  const text = (res!.result as { content: Array<{ text: string }> }).content[0].text
  assert.match(text, /^Error: could not reach the TurboLLM daemon/)
})

const VALID_ROUTINE_ARGS = {
  flavor: 'chat', prompt: 'Find Android jobs', scheduleDisplay: 'Runs every hour',
  scheduleRule: { kind: 'interval', everyMs: 3_600_000 }, modelKey: 'm', agentId: 'agent-1',
}

test('create_routine: invalid args are rejected WITHOUT ever reaching the network', async () => {
  let called = false
  const f = (async () => { called = true; return json({}) }) as typeof fetch
  const res = await handleMcpRequest(toolCallReq('create_routine', { flavor: 'chat' }), BASE, '1.0.0', f)
  const result = res!.result as { content: Array<{ text: string }>; isError: boolean }
  assert.match(result.content[0].text, /^Error:/)
  assert.equal(result.isError, true)
  assert.equal(called, false, 'validateCreate must short-circuit before any fetch')
})

test('create_routine: valid args land pending_confirmation, same message shape as chat/pi\'s create_routine', async () => {
  const created = { id: 'r1', scheduleDisplay: VALID_ROUTINE_ARGS.scheduleDisplay, status: 'pending_confirmation' }
  const f = fakeFetch([() => json(created, 201)])
  const res = await handleMcpRequest(toolCallReq('create_routine', VALID_ROUTINE_ARGS), BASE, '1.0.0', f)
  const result = res!.result as { content: Array<{ text: string }>; isError: boolean }
  assert.match(result.content[0].text, /^Created routine "r1" \(Runs every hour\) in status "pending_confirmation"\./)
  assert.match(result.content[0].text, /NOT run until a human confirms it/)
  assert.equal(result.isError, false)
})

test('create_routine: a rejected create surfaces the daemon\'s error, marked isError', async () => {
  const f = fakeFetch([() => json({ error: { message: 'agentId is required for a chat-flavor routine.' } }, 400)])
  const res = await handleMcpRequest(toolCallReq('create_routine', VALID_ROUTINE_ARGS), BASE, '1.0.0', f)
  const result = res!.result as { content: Array<{ text: string }>; isError: boolean }
  assert.equal(result.content[0].text, 'Error: agentId is required for a chat-flavor routine.')
  assert.equal(result.isError, true)
})

test('list_agents: empty list points at create_agent instead of showing nothing', async () => {
  const f = fakeFetch([() => json([])])
  const res = await handleMcpRequest(toolCallReq('list_agents'), BASE, '1.0.0', f)
  const text = (res!.result as { content: Array<{ text: string }> }).content[0].text
  assert.equal(text, 'No custom agents exist yet. Use create_agent to make one.')
})

test('list_agents: formats id, name, description, and tools', async () => {
  const agent = { id: 'a1', name: 'Job Search', description: 'Finds jobs', tools: ['web_search', 'fetch_url'] }
  const f = fakeFetch([() => json([agent])])
  const res = await handleMcpRequest(toolCallReq('list_agents'), BASE, '1.0.0', f)
  const text = (res!.result as { content: Array<{ text: string }> }).content[0].text
  assert.equal(text, '- a1 "Job Search" — Finds jobs — tools: web_search, fetch_url')
})

test('create_agent: missing name is rejected without ever reaching the network', async () => {
  let called = false
  const f = (async () => { called = true; return json({}) }) as typeof fetch
  const res = await handleMcpRequest(toolCallReq('create_agent', {}), BASE, '1.0.0', f)
  const result = res!.result as { content: Array<{ text: string }>; isError: boolean }
  assert.equal(result.content[0].text, 'Error: name is required.')
  assert.equal(result.isError, true)
  assert.equal(called, false)
})

test('create_agent: success echoes the created agent\'s id and name', async () => {
  const created = { id: 'a1', name: 'Job Search Assistant' }
  const f = fakeFetch([() => json(created, 201)])
  const res = await handleMcpRequest(toolCallReq('create_agent', { name: 'Job Search Assistant' }), BASE, '1.0.0', f)
  const text = (res!.result as { content: Array<{ text: string }> }).content[0].text
  assert.equal(text, 'Created agent a1 "Job Search Assistant".')
})

// ── list_models ──────────────────────────────────────────────────────────────
// Closes the exact gap that produced a real live miss: a claude_cli session with no way to
// discover a real modelKey picked "gpt-4" for create_routine instead.

test('list_models: empty library points at the Models screen instead of showing nothing', async () => {
  const f = fakeFetch([() => json({ models: [] })])
  const res = await handleMcpRequest(toolCallReq('list_models'), BASE, '1.0.0', f)
  const text = (res!.result as { content: Array<{ text: string }> }).content[0].text
  assert.equal(text, 'No models in the library yet — add one in TurboLLM\'s Models screen first.')
})

test('list_models: formats the exact compound modelKey, not a generic display name', async () => {
  const model = { key: 'gemma 4 26b a4b qat|Q4_0|14439362752', name: 'Gemma 4 26B A4B QAT', quant: 'Q4_0', sizeLabel: '26B-A4B' }
  const f = fakeFetch([() => json({ models: [model] })])
  const res = await handleMcpRequest(toolCallReq('list_models'), BASE, '1.0.0', f)
  const text = (res!.result as { content: Array<{ text: string }> }).content[0].text
  assert.equal(text, '- gemma 4 26b a4b qat|Q4_0|14439362752 — Gemma 4 26B A4B QAT (Q4_0, 26B-A4B)')
})
