// turbollm/src/ext/generation.test.ts
//
// generation.ts's engine-wiring is not exercised by routes.runs.test.ts (that file injects a
// fake `makeBody` and never touches this module — see generation.ts's own header comment). This
// file targets the one piece of generation.ts that IS practical and worthwhile to unit-test in
// isolation: `loadFullHistory`'s pagination loop, which fixes a Critical bug a review found —
// `d.chatStore.listMessages(scope, chatId, {limit: N})` with no cursor returns the OLDEST page
// (`ORDER BY seq ASC`), so a single un-paginated call silently drops the newest messages —
// including the turn currently being generated — once a chat has more than one page's worth of
// history. `pageSize` is overridable specifically so this can be proven with a handful of
// messages instead of needing to push 200+ real rows through the store.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConversationStore } from '../chat/db.js'
import { ChatStoreRouter } from '../chat/store/router.js'
import {
  loadFullHistory, shouldFlushCheckpoint, FLUSH_INTERVAL_MS, FLUSH_MIN_CHARS,
  extractChunkUsage, buildUsagePatch, buildEngineRequestBody, mapSampling, createMakeBody,
} from './generation.js'
import { ToolRegistry, MCP_AGENT_REFUSED_MESSAGE, MCP_ROUTINE_REFUSED_MESSAGE } from '../tools/tool-registry'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

const SCOPE = { tenant: 'acme', owner: 'u1' }

function harness() {
  const dir = tmpDir('turbollm-ext-gen-')
  const conv = new ConversationStore(dir)
  const chatStore = new ChatStoreRouter(conv.chatStore, conv.chatStore)
  return { chatStore, cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('loadFullHistory pages past a single page and includes the newest (highest-seq) messages', async () => {
  const { chatStore, cleanup } = harness()
  try {
    const chat = await chatStore.createChat(SCOPE, { title: 'History paging' })
    const TOTAL = 11
    for (let i = 0; i < TOTAL; i++) {
      await chatStore.addMessage(SCOPE, chat.id, { role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}` })
    }

    // A page size of 2 forces 6 pages to cover 11 messages — proves the loop actually walks
    // `nextCursor` forward rather than returning (and stopping at) the first page.
    const all = await loadFullHistory(chatStore, SCOPE, chat.id, 2)

    assert.equal(all.length, TOTAL, 'every message must be returned, not just the first page')
    assert.deepEqual(all.map((m) => m.content), Array.from({ length: TOTAL }, (_, i) => `msg-${i}`),
      'messages must come back in seq order across the page boundary, with none dropped or duplicated')
    // This is exactly what the bug silently dropped: the highest-seq (newest) message.
    assert.equal(all[all.length - 1].content, `msg-${TOTAL - 1}`)
  } finally {
    cleanup()
  }
})

test('loadFullHistory returns everything in one call when the chat fits in a single page', async () => {
  const { chatStore, cleanup } = harness()
  try {
    const chat = await chatStore.createChat(SCOPE, { title: 'Small chat' })
    await chatStore.addMessage(SCOPE, chat.id, { role: 'user', content: 'hi' })
    await chatStore.addMessage(SCOPE, chat.id, { role: 'assistant', content: 'hello' })

    const all = await loadFullHistory(chatStore, SCOPE, chat.id)
    assert.deepEqual(all.map((m) => m.content), ['hi', 'hello'])
  } finally {
    cleanup()
  }
})

test('loadFullHistory on a chat with no messages returns an empty array', async () => {
  const { chatStore, cleanup } = harness()
  try {
    const chat = await chatStore.createChat(SCOPE, { title: 'Empty chat' })
    const all = await loadFullHistory(chatStore, SCOPE, chat.id, 2)
    assert.deepEqual(all, [])
  } finally {
    cleanup()
  }
})

// ── shouldFlushCheckpoint (C2 fix) ──────────────────────────────────────────────────────────
//
// The mid-stream checkpoint flush this backs (createMakeBody, in generation.ts) can't be
// exercised end-to-end here — there is no live model/engine to drive a real streaming
// generation in this environment (see generation.ts's own header comment; the file's contract
// is otherwise only exercised through the interface routes.runs.ts depends on, per its route
// tests, which inject a fake `makeBody`). What IS practical and worthwhile to test directly is
// the pure "should I flush now?" decision itself, since it was deliberately extracted out of the
// I/O-performing closure specifically so it could be.
test('shouldFlushCheckpoint: flushes once the char threshold is reached, well before the time threshold', () => {
  assert.equal(shouldFlushCheckpoint(10, FLUSH_MIN_CHARS), true)
  assert.equal(shouldFlushCheckpoint(10, FLUSH_MIN_CHARS + 1), true)
  assert.equal(shouldFlushCheckpoint(0, FLUSH_MIN_CHARS), true, 'char threshold alone is sufficient, even at 0 elapsed ms')
})

test('shouldFlushCheckpoint: flushes once the time threshold elapses, even with very little new content', () => {
  assert.equal(shouldFlushCheckpoint(FLUSH_INTERVAL_MS, 1), true)
  assert.equal(shouldFlushCheckpoint(FLUSH_INTERVAL_MS + 50, 1), true)
})

test('shouldFlushCheckpoint: does not flush before either threshold is reached', () => {
  assert.equal(shouldFlushCheckpoint(FLUSH_INTERVAL_MS - 1, FLUSH_MIN_CHARS - 1), false)
  assert.equal(shouldFlushCheckpoint(100, 10), false)
  assert.equal(shouldFlushCheckpoint(0, 0), false)
})

test('shouldFlushCheckpoint: never flushes when there is nothing new, regardless of elapsed time', () => {
  assert.equal(shouldFlushCheckpoint(FLUSH_INTERVAL_MS * 100, 0), false)
  assert.equal(shouldFlushCheckpoint(Number.MAX_SAFE_INTEGER, 0), false)
  // A negative "new chars" delta should never occur in practice, but must not be treated as
  // "new data" either — the guard is `<= 0`, not `=== 0`.
  assert.equal(shouldFlushCheckpoint(FLUSH_INTERVAL_MS * 100, -5), false)
})

test('shouldFlushCheckpoint: respects overridden thresholds instead of the module defaults', () => {
  assert.equal(shouldFlushCheckpoint(999, 50, { intervalMs: 1000, minChars: 100 }), false)
  assert.equal(shouldFlushCheckpoint(1000, 50, { intervalMs: 1000, minChars: 100 }), true)
  assert.equal(shouldFlushCheckpoint(1, 100, { intervalMs: 1000, minChars: 100 }), true)
})

// ── extractChunkUsage / buildUsagePatch (final-review-round-3 Critical fix) ────────────────────
//
// Same rationale as shouldFlushCheckpoint above: there is no live model/engine in this
// environment to drive a real streaming generation end-to-end (see this file's header comment
// and generation.ts's own), so a genuine "does runGenerationLoop actually call updateMessage
// with usage, does it emit the SSE event at the right point" test is not feasible here without a
// fake-engine harness this test suite doesn't have. What IS practical and directly testable is
// the pure decision logic that was deliberately extracted out of the per-chunk parse loop and
// the patch-building closure specifically so it could be — mirroring the C2 fix's own precedent.
test('extractChunkUsage: captures a real usage object, exactly as the engine sends it (no field renaming)', () => {
  const chunk = { choices: [], usage: { prompt_tokens: 120, completion_tokens: 340, total_tokens: 460 } }
  assert.deepEqual(extractChunkUsage(chunk), { prompt_tokens: 120, completion_tokens: 340, total_tokens: 460 })
})

test('extractChunkUsage: returns undefined when usage is absent — the ordinary case for every non-final chunk', () => {
  assert.equal(extractChunkUsage({ choices: [{ delta: { content: 'hi' } }] }), undefined)
  assert.equal(extractChunkUsage({}), undefined)
})

test('extractChunkUsage: treats null/non-object/array usage as absent rather than crashing or capturing garbage', () => {
  assert.equal(extractChunkUsage({ usage: null }), undefined)
  assert.equal(extractChunkUsage({ usage: 'not-an-object' }), undefined)
  assert.equal(extractChunkUsage({ usage: 42 }), undefined)
  assert.equal(extractChunkUsage({ usage: [1, 2, 3] }), undefined)
})

test('extractChunkUsage: still captures usage on a chunk whose choices array is empty — the exact chunk shape the old code silently discarded', () => {
  const chunk = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }
  assert.deepEqual(extractChunkUsage(chunk), { prompt_tokens: 10, completion_tokens: 5 })
})

test('buildUsagePatch: omits the usage key entirely when nothing has arrived yet, rather than sending {}', () => {
  const patch = buildUsagePatch(undefined)
  assert.deepEqual(patch, {})
  assert.equal('usage' in patch, false)
})

test('buildUsagePatch: includes the captured usage object once real data has arrived', () => {
  const usage = { prompt_tokens: 10, completion_tokens: 20 }
  assert.deepEqual(buildUsagePatch(usage), { usage })
})

test('buildUsagePatch: spreads cleanly into a patch literal alongside other fields, either way', () => {
  const withUsage = { content: 'hi', status: 'complete' as const, ...buildUsagePatch({ prompt_tokens: 1 }) }
  assert.deepEqual(withUsage, { content: 'hi', status: 'complete', usage: { prompt_tokens: 1 } })

  const withoutUsage = { content: 'hi', status: 'streaming' as const, ...buildUsagePatch(undefined) }
  assert.deepEqual(withoutUsage, { content: 'hi', status: 'streaming' })
  assert.equal('usage' in withoutUsage, false)
})

// Release-gate I7: samplingOverride is unvalidated integrator JSON (chat.sampling, stored
// verbatim). A tenant setting sampling.model/.messages/.stream/.stream_options must never be
// able to override this route's own control fields.
test('buildEngineRequestBody: a legitimate sampling key merges in alongside the control fields', () => {
  const body = buildEngineRequestBody(
    { model: 'real-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
    { temperature: 0.7, top_p: 0.9 },
  )
  assert.deepEqual(body, {
    temperature: 0.7, top_p: 0.9,
    model: 'real-model', messages: [{ role: 'user', content: 'hi' }], stream: true,
  })
})

test('buildEngineRequestBody: sampling cannot override model, messages, stream, or stream_options', () => {
  const body = buildEngineRequestBody(
    { model: 'real-model', messages: [{ role: 'user', content: 'real history' }], stream: true, stream_options: { include_usage: true } },
    { model: 'attacker-model', messages: [{ role: 'user', content: 'smuggled prompt' }], stream: false, stream_options: { include_usage: false }, temperature: 0.5 },
  )
  assert.equal(body.model, 'real-model', 'sampling must not override which model is called')
  assert.deepEqual(body.messages, [{ role: 'user', content: 'real history' }], 'sampling must not override the assembled history')
  assert.equal(body.stream, true, 'sampling must not turn off streaming — the SSE read loop assumes it is on')
  assert.deepEqual(body.stream_options, { include_usage: true }, 'sampling must not override usage capture')
  assert.equal(body.temperature, 0.5, 'a non-reserved sampling key still comes through normally')
})

// Round-2 release-gate finding H2: buildEngineRequestBody's precedence only protects fields the
// ROUTE explicitly sets afterward — tool_choice is never set by any route, so there was no
// control field for it to lose to, and it reached the engine verbatim. Live-reproduced: a tenant
// setting sampling.tool_choice: 'required' could COMPEL a tool call every turn (not just hope for
// one), executed under the local install's own tool policy — sharpening I10's accepted risk.
test('mapSampling: tool_choice never survives the passthrough, even though no route ever re-sets it', () => {
  const out = mapSampling({ temperature: 0.7, tool_choice: 'required' }, 'repeat_penalty')
  assert.equal('tool_choice' in out, false, 'tool_choice must be dropped, not passed through as an unrecognized key')
  assert.equal(out.temperature, 0.7, 'a legitimate sampling key must still pass through')
})

// H2's second hole: `tools` leaked specifically on vLLM/SGLang, where the route deliberately
// withholds reqBody.tools (toolsSupported false, since those engines default tool_choice to
// "auto" once ANY tools array is present) — a tenant's own sampling.tools defeated that
// suppression on exactly the engines it was meant to protect.
test('mapSampling: tools never survives the passthrough, even on engines where the route withholds its own', () => {
  const out = mapSampling({ tools: [{ type: 'function', function: { name: 'evil' } }] }, 'repeat_penalty')
  assert.equal('tools' in out, false, 'tools must be dropped — the route decides tools, not tenant sampling JSON')
})

test('mapSampling: model, messages, stream, and stream_options are all denylisted too, not just tool_choice/tools', () => {
  const out = mapSampling(
    { model: 'x', messages: [{ role: 'user', content: 'x' }], stream: false, stream_options: {}, top_k: 40 },
    'repeat_penalty',
  )
  for (const key of ['model', 'messages', 'stream', 'stream_options']) {
    assert.equal(key in out, false, `${key} must be dropped by mapSampling's own denylist, not left to spread order alone`)
  }
  assert.equal(out.top_k, 40)
})

// ── a tenant's tool calls and the owner's MCP routines ─────────────────────────────────────────

type ScriptedCall = { id: string; name: string; args: Record<string, unknown> }

/** One tenant run through the real createMakeBody, against a loopback engine whose first reply
 *  makes `calls(routineId)` and whose second answers "done". The install holds the owner's agent
 *  listing an MCP tool and a confirmed chat routine on it, behind a real ToolRegistry, with the
 *  routine and agent tools set to Allow and the MCP tool to `mcpPolicy`. Returns each call's
 *  result by id, the routine's stored prompt, the agents and what runNow fired. */
async function tenantRun(calls: (routineId: string) => ScriptedCall[], mcpPolicy: 'allow' | 'ask') {
  const routines = new ConversationStore(tmpDir('turbollm-ext-gen-routines-'))
  const routine = routines.createRoutine({ flavor: 'chat', prompt: 'owner prompt', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'owner-mcp-agent' })
  routines.confirmRoutine(routine.id, '2099-01-01T00:00:00.000Z')
  const replies = [
    [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls(routine.id).map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ],
    [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ],
  ]
  const engine = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const c of replies.shift() ?? []) res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', ...c })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => engine.listen(0, '127.0.0.1', r))
  const { chatStore, cleanup } = harness()
  try {
    const agents = [{ id: 'owner-mcp-agent', name: 'Owner', systemPrompt: '', tools: ['mcp__srv_1__run'] }]
    const agentStore = { snapshot: () => ({ customAgents: agents }), update: (fn: (cfg: { customAgents: typeof agents }) => void) => fn({ customAgents: agents }) }
    const fired: string[] = []
    const runNow = async (id: string) => { fired.push(id); return { ok: true as const } }
    const tools = new ToolRegistry({ search: {}, sandbox: {}, mcpServers: [] } as never, routines, runNow, agentStore as never, undefined, () => true)
    const toolPolicies = { update_routine: 'allow', run_routine_now: 'allow', create_agent: 'allow', mcp__srv_1__run: mcpPolicy }
    const d = {
      chatStore,
      manager: {
        status: () => ({ state: 'running', model: { key: 'm', name: 'M', ctx: 8192 } }),
        target: () => `http://127.0.0.1:${(engine.address() as AddressInfo).port}`,
        currentOpts: () => undefined,
        generationStart: () => {},
        generationEnd: () => {},
      },
      registry: { active: () => undefined },
      store: { snapshot: () => ({ tools: { toolPolicies, autoAllowAll: false }, modelDefaults: {} }) },
      tools,
    } as unknown as Deps
    const chat = await chatStore.createChat(SCOPE, { title: 'tenant' })
    await chatStore.addMessage(SCOPE, chat.id, { role: 'user', content: 'go' })
    const placeholder = await chatStore.addMessage(SCOPE, chat.id, { role: 'assistant', content: '', status: 'streaming' })
    const results: Record<string, string> = {}
    const emit = (ev: { event: string; data: unknown }) => {
      const data = ev.data as { id?: string; result?: string }
      if (ev.event === 'tool_call' && data.id && data.result !== undefined) results[data.id] = data.result
    }
    const body = createMakeBody(d)({ chatId: chat.id, messageId: placeholder.id, scope: SCOPE })
    assert.deepEqual(await body({ emit, signal: new AbortController().signal }), { status: 'complete' })
    return { results, prompt: routines.getRoutine(routine.id)?.prompt, agents, fired }
  } finally {
    cleanup()
    routines.close()
    engine.closeAllConnections()
    await new Promise<void>((r) => engine.close(() => r()))
  }
}

// A chat routine runs its agent's tools with no approval. A tenant's run passed neither refuseMcp
// nor refuseMcpAgentsAndRoutines, so with update_routine and run_routine_now on Allow it rewrote
// the owner's MCP routine's prompt and fired it: the MCP tool, left on Ask (which blocks the
// tenant's own direct call of it), then ran on the tenant's prompt, and on every later fire.
test('a tenant run cannot rewrite or fire a chat routine whose agent uses an MCP tool, nor create such an agent', async () => {
  const out = await tenantRun((routineId) => [
    { id: 'call_mcp', name: 'mcp__srv_1__run', args: {} },
    { id: 'call_update', name: 'update_routine', args: { routineId, prompt: 'tenant prompt', confirm: true } },
    { id: 'call_run', name: 'run_routine_now', args: { routineId } },
    { id: 'call_agent', name: 'create_agent', args: { name: 'Tenant agent', systemPrompt: 'x', tools: ['mcp__srv_1__run'] } },
  ], 'ask')
  assert.match(out.results.call_mcp, /^Blocked: this tool requires interactive approval/)
  assert.equal(out.results.call_update, `Error: ${MCP_ROUTINE_REFUSED_MESSAGE}`)
  assert.equal(out.results.call_run, `Error: ${MCP_ROUTINE_REFUSED_MESSAGE}`)
  assert.equal(out.results.call_agent, `Error: ${MCP_AGENT_REFUSED_MESSAGE}`)
  assert.equal(out.prompt, 'owner prompt')
  assert.deepEqual(out.fired, [])
  assert.deepEqual(out.agents.map((a) => a.id), ['owner-mcp-agent'])
})

test('a tenant run still calls an MCP tool the install set to Allow', async () => {
  const out = await tenantRun(() => [{ id: 'call_mcp', name: 'mcp__srv_1__run', args: {} }], 'allow')
  // No server is connected here: reaching the lookup is the point (it was not refused).
  assert.equal(out.results.call_mcp, 'Error: MCP server "srv-1" not connected.')
})
