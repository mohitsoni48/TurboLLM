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

test('handleMcpRequest: tools/list advertises exactly the delegate tool', async () => {
  const res = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, BASE, '1.0.0')
  const tools = (res!.result as { tools: Array<{ name: string }> }).tools
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, DELEGATE_TOOL_NAME)
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
