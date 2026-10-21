// BUG-001 regression tests: Qwen3 / thinking models returning only <think>...</think>
// tokens after the tool-calling loop, leaving visible content empty.
//
// The fix: after the tool loop exits, strip <think> blocks from the accumulated
// content. If the visible content is empty/whitespace, make one extra inference
// pass with tool_choice:'none' and use that result as the final reply.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, rmSync } from 'node:fs'
import { Hono } from 'hono'
import { stripThinkingBlocks, needsExtraPass } from './think-utils.js'
import { recentTitleTurns, abortAllInFlightChats, chatCodeAuthorization, inFlightChatIds, registerChatRoutes } from './chat-routes.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'

// ── stripThinkingBlocks ───────────────────────────────────────────────────────

test('stripThinkingBlocks: removes a single <think> block', () => {
  const input = '<think>some chain of thought</think>The actual answer.'
  assert.equal(stripThinkingBlocks(input), 'The actual answer.')
})

test('stripThinkingBlocks: removes multiple <think> blocks', () => {
  const input = '<think>step 1</think>middle<think>step 2</think>end'
  assert.equal(stripThinkingBlocks(input), 'middleend')
})

test('stripThinkingBlocks: case-insensitive tag match', () => {
  const input = '<THINK>hidden</THINK>visible'
  assert.equal(stripThinkingBlocks(input), 'visible')
})

test('stripThinkingBlocks: multiline think block is removed', () => {
  const input = '<think>\nline one\nline two\n</think>\nFinal answer.'
  assert.equal(stripThinkingBlocks(input).trim(), 'Final answer.')
})

test('stripThinkingBlocks: no think block returns input unchanged', () => {
  const input = 'Plain response with no thinking.'
  assert.equal(stripThinkingBlocks(input), input)
})

test('stripThinkingBlocks: only think block yields empty string after trim', () => {
  const input = '<think>only reasoning, no visible content</think>'
  assert.equal(stripThinkingBlocks(input).trim(), '')
})

test('stripThinkingBlocks: whitespace-only after stripping yields empty after trim', () => {
  const input = '<think>reasoning</think>   \n  '
  assert.equal(stripThinkingBlocks(input).trim(), '')
})

// ── needsExtraPass ───────────────────────────────────────────────────────────

test('needsExtraPass: returns true when content is only a <think> block', () => {
  assert.equal(needsExtraPass('<think>deep thoughts</think>'), true)
})

test('needsExtraPass: returns true when content is whitespace only', () => {
  assert.equal(needsExtraPass('   \n\t  '), true)
})

test('needsExtraPass: returns true when content is empty string', () => {
  assert.equal(needsExtraPass(''), true)
})

test('needsExtraPass: returns false when visible content exists after stripping', () => {
  assert.equal(needsExtraPass('<think>reasoning</think>Here is my answer.'), false)
})

test('needsExtraPass: returns false for plain text with no thinking tokens', () => {
  assert.equal(needsExtraPass('The capital of France is Paris.'), false)
})

test('needsExtraPass: returns false when think block is followed by non-whitespace', () => {
  assert.equal(needsExtraPass('<think>step</think>\n\nActual answer here.'), false)
})

// ── recentTitleTurns ──────────────────────────────────────────────────────────
// GitHub: "the AI generated chat title is broken. It gets title based on memory and not based
// on msg I send." For a brand-new conversation (exactly when auto-title fires), engineMessages
// is just [system, user] — a plain slice(-2) grabbed the memory-stuffed system prompt right
// alongside the real first message.

test('recentTitleTurns: excludes the injected system prompt for a brand-new conversation', () => {
  const engineMessages = [
    { role: 'system', content: 'You are TurboLLM...\n\nWhat you know about the user from past conversations:\n- Likes cats\n- Works in finance' },
    { role: 'user', content: 'How do I center a div in CSS?' },
  ]
  const turns = recentTitleTurns(engineMessages)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].role, 'user')
  assert.equal(turns[0].content, 'How do I center a div in CSS?')
})

test('recentTitleTurns: still takes the last N when there IS real history (no system message present)', () => {
  const engineMessages = [
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'first reply' },
    { role: 'user', content: 'second turn' },
  ]
  const turns = recentTitleTurns(engineMessages)
  assert.deepEqual(turns.map((t) => t.content), ['first reply', 'second turn'])
})

test('recentTitleTurns: a system message is excluded even when mixed in with real history', () => {
  const engineMessages = [
    { role: 'system', content: 'hidden capability + memory block' },
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'first reply' },
  ]
  const turns = recentTitleTurns(engineMessages)
  assert.ok(turns.every((t) => t.role !== 'system'))
  assert.deepEqual(turns.map((t) => t.content), ['first turn', 'first reply'])
})

test('recentTitleTurns: empty input yields empty output, no throw', () => {
  assert.deepEqual(recentTitleTurns([]), [])
})

// ── Phase 4 / C1: the trust decision chat's routine tools are threaded from ──────────────────
// chat-routes.ts computes `isCodeAuthorized` as `!codeGateBlocks(c, d)` at BOTH generation entry
// points (/messages and /continue) and hands it to runGeneration → executeToolCallWithApproval →
// ToolRegistry.executeTool → the routine executors' code-flavor gate. The SSE loop is far too
// heavy to drive here, but the invariant that whole chain rests on is a pure per-request decision
// and is directly testable: for the exact deployment the threat model names — LAN-exposed daemon
// with the API key requirement OFF, keyless caller, non-loopback address — `chatCodeAuthorization`
// must be FALSE. If it is ever true there, gating the executors buys nothing. Same fake `Deps`
// shape routine-routes.test.ts's own I2 run-now tests use, driven through a real Hono Context (the
// decision reads getConnInfo, which no hand-rolled Context object can honestly supply).
//
// I1: these drive `chatCodeAuthorization` EXPORTED FROM chat-routes.ts — the exact function both
// generation entry points call — not a re-derivation of `!codeGateBlocks(c, d)` against the import
// from routine-routes.ts. That distinction is the whole fix: a reviewer previously restored the
// full CRITICAL with a green suite by aliasing chat-routes.ts's `codeGateBlocks` import and
// shadowing the name locally with `() => false`. Re-deriving the expression here measured the real
// function while production measured the shadow; driving the real exported one cannot.

/** Runs chat-routes.ts's own `chatCodeAuthorization` over a one-route app, so the assertion runs
 *  against a REAL Hono Context rather than a stand-in. */
function gateProbe(daemon: { lanBind: boolean; requireApiKey: boolean }, apiKeys: unknown[] = []) {
  const app = new Hono()
  const d = {
    store: {
      snapshot: () => ({ daemon, apiKeys }),
      update: (fn: (cfg: { apiKeys: unknown[] }) => void) => fn({ apiKeys }),
    },
  } as unknown as Deps
  app.get('/probe', (c) => c.json({ isCodeAuthorized: chatCodeAuthorization(c, d) }))
  return app
}

/** A real remote peer address, the way @hono/node-server's getConnInfo reads it. */
const LAN_PEER = { incoming: { socket: { remoteAddress: '192.168.1.50', remotePort: 54321, remoteFamily: 'IPv4' } } }
const LOOPBACK_PEER = { incoming: { socket: { remoteAddress: '127.0.0.1', remotePort: 54321, remoteFamily: 'IPv4' } } }

async function probe(app: Hono, env: unknown, headers: Record<string, string> = {}): Promise<boolean> {
  const res = await app.request('/probe', { headers }, env)
  return (await res.json() as { isCodeAuthorized: boolean }).isCodeAuthorized
}

test('C1 invariant: a keyless non-loopback caller on an open LAN (lanBind, no requireApiKey) is NOT code-authorized', async () => {
  const app = gateProbe({ lanBind: true, requireApiKey: false })
  assert.equal(await probe(app, LAN_PEER), false,
    'this is the exact configuration lanAuth waves through — the routine tools\' gate is the only thing left')
})

test('C1 invariant: an undetermined remote address on an open LAN fails closed too', async () => {
  const app = gateProbe({ lanBind: true, requireApiKey: false })
  assert.equal(await probe(app, undefined), false)
})

test('C1 invariant: a wrong/garbage API key does not buy code authorization', async () => {
  const app = gateProbe({ lanBind: true, requireApiKey: false })
  assert.equal(await probe(app, LAN_PEER, { 'X-TurboLLM-Auth': 'tllm-not-a-real-key' }), false)
})

// Polarity control: the expression must not be false for EVERYONE (which would also "pass" the
// tests above while breaking every legitimate host user).
test('C1 invariant: the host itself IS code-authorized (loopback on a LAN-exposed daemon)', async () => {
  const app = gateProbe({ lanBind: true, requireApiKey: false })
  assert.equal(await probe(app, LOOPBACK_PEER), true)
})

test('C1 invariant: a loopback-only bind is code-authorized regardless of address resolution', async () => {
  const app = gateProbe({ lanBind: false, requireApiKey: false })
  assert.equal(await probe(app, undefined), true)
})

// The tests above pin what chatCodeAuthorization DECIDES; they cannot pin that both SSE handlers
// still ASK it — the two producers live inside the /messages and /continue handlers, which need a
// live engine, a stream and a full conversation to drive. That gap is real and was demonstrated
// twice: a reviewer replaced chat-routes.ts:280 with `const isCodeAuthorized = true` and the whole
// suite stayed green. This is a structural assertion over the source text rather than a
// behavioural one — deliberately, as the cheapest thing that actually fails on that exact edit.
//
// I1: it is a SUPPLEMENT now, not the primary defence. It pins only that both entry points call
// the named function rather than re-inlining the expression; what that function RESOLVES TO is
// pinned behaviourally by the five tests above, which drive the real export. The previous version
// of this test was the only thing standing behind the decision, and it pinned the spelling of the
// two producers while asserting nothing about what `codeGateBlocks` resolved to inside the module
// — so an import-alias-plus-local-shadow refactor passed it with both producer lines untouched.
test('C1 invariant: both chat generation entry points DERIVE isCodeAuthorized, never hardcode it', () => {
  const src = readFileSync(new URL('./chat-routes.ts', import.meta.url), 'utf8')
  const producers = src.match(/const isCodeAuthorized = .*/g) ?? []
  assert.equal(producers.length, 2, 'expected exactly two producers (POST /messages and POST /continue)')
  for (const line of producers) {
    assert.equal(line, 'const isCodeAuthorized = chatCodeAuthorization(c, d)',
      'a chat generation entry point must call the exported, behaviourally-pinned decision function — never inline the expression, which puts it back out of the tests\' reach')
  }
  assert.doesNotMatch(src, /isCodeAuthorized\s*[:=]\s*true/, 'no chat path may assert code authorization by literal')
  assert.match(src, /isCodeAuthorized: ctx\.isCodeAuthorized/, 'the tool loop must forward the per-request value, not recompute or fake one')
})

// ── inFlightChatIds (ADR-434 (i)(3)) ─────────────────────────────────────────────────────────
// The Jev-load confirmation names the chats a load would interrupt: exactly the conversations
// abortAllInFlightChats() would abort. Driven through the real POST /messages route with the
// engine fetch held open, in the style of chat-routes.remote.test.ts (real store, no port).

/** `tools`, when given, is the tool registry the chat loop calls, its tools allowed without asking. */
function inFlightHarness(tools?: unknown) {
  const dir = tmpDir('tllm-chat-inflight-')
  const store = new ConversationStore(dir)
  const cfg = {
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: {}, autoAllowAll: tools !== undefined },
  }
  const d = {
    db: store,
    // `dir`: an engine's error text is path-redacted against it (engineErrorText).
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dir },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }), get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    modelRouter: { resolveRemoteTarget: () => undefined },
    manager: {
      status: () => ({ state: 'running', model: { key: 'gemma-27b', name: 'Gemma 27B', ctx: 8192 } }),
      target: () => 'http://engine.invalid',
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      setLiveGen: () => {},
      recordCompletion: () => {},
    },
    tools,
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  return { app, store, d, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

/** Holds the engine's reply until `finish()` — the chat stays in flight until then. */
function holdEngineReply(): { finish: () => void; restore: () => void } {
  const original = globalThis.fetch
  let finish!: () => void
  const released = new Promise<void>((resolve) => { finish = resolve })
  globalThis.fetch = (async () => {
    await released
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join('')
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return { finish, restore: () => { globalThis.fetch = original } }
}

test('inFlightChatIds lists a chat while its reply is generating, and drops it when done', async () => {
  const h = inFlightHarness()
  const engine = holdEngineReply()
  try {
    const conv = h.store.createConversation()
    assert.deepEqual(inFlightChatIds(), [])

    const res = await h.app.request(`/api/v1/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(inFlightChatIds(), [conv.id])

    engine.finish()
    await res.text()
    assert.deepEqual(inFlightChatIds(), [])
  } finally {
    engine.restore()
    h.cleanup()
  }
})

// ── Chat fixes, driven through the real routes (inFlightHarness above) ───────────────────────

const sseReply = (text: string) => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
)

/** Replaces the engine with `impl`, recording every request body sent to it. */
function fakeEngine(impl: (init: RequestInit | undefined, n: number) => Response | Promise<Response> = () => sseReply('ok')) {
  const original = globalThis.fetch
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return impl(init, bodies.length)
  }) as typeof fetch
  return { bodies, restore: () => { globalThis.fetch = original } }
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
/** Polls `cond` until it holds — a precondition the test waits FOR, never a guessed duration. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 2))
  }
}

test('Regenerate and edit-and-resend send the answered turn WITH its image and document text, as the first send did', async () => {
  const h = inFlightHarness()
  const engine = fakeEngine()
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    await (await h.app.request(`${base}/messages`, json({
      content: 'What is in this picture? Also summarize the file.',
      images: ['data:image/png;base64,AAAA'], docContext: '[Attached: report.txt]\nQ3 revenue was $4M', textAttachments: ['report.txt'],
    }))).text()
    const firstSend = engine.bodies[0].messages.at(-1)!.content

    await h.app.request(`${base}/regenerate`, { method: 'POST' })
    await (await h.app.request(`${base}/continue`, json({}))).text()
    assert.deepEqual(engine.bodies[1].messages.at(-1)!.content, firstSend)

    // Edit the question: the new version keeps the image and the document, with the new text.
    const userId = h.store.getMessages(conv.id).find((m) => m.role === 'user')!.id
    await h.app.request(`${base}/messages/${userId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Only the file, please.' }) })
    await (await h.app.request(`${base}/continue`, json({}))).text()
    assert.deepEqual(engine.bodies[2].messages.at(-1)!.content, [
      { type: 'text', text: '[Attached: report.txt]\nQ3 revenue was $4M\n\nOnly the file, please.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])
  } finally {
    engine.restore()
    h.cleanup()
  }
})

// The document text is stored for the resends above, but the chat polls GET /conversations/:id
// every 4 s and shows a document by its name: each poll sent every attached document's full text.
test('the chat routes return an attached document by name, without its stored text', async () => {
  const h = inFlightHarness()
  const engine = fakeEngine()
  const docText = '[Attached: report.txt]\nQ3 revenue was $4M'
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    await (await h.app.request(`${base}/messages`, json({ content: 'Summarize the file.', docContext: docText, textAttachments: ['report.txt'] }))).text()
    const [q1, a1] = h.store.getMessages(conv.id)
    const singleVersion = await h.app.request(`${base}/messages/${q1.id}/variants`)
    await (await h.app.request(`${base}/continue`, json({ edit: { messageId: q1.id, content: 'Only the totals.' } }))).text()
    const put = (id: string, content: string) => h.app.request(`${base}/messages/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) })
    const activate = () => h.app.request(`${base}/messages/${q1.id}/activate`, { method: 'POST' })
    // Activating the version already shown (a stale tab, a double click on the switcher) takes the route's
    // early return, not the switch: that return answers with the messages too.
    const activateActive = () => {
      assert.equal(h.store.getMessage(q1.id)!.isActive, true, 'q1 is the active version again')
      return activate()
    }

    const responses = {
      singleVersion,
      conversation: await h.app.request(base),
      variants: await h.app.request(`${base}/messages/${q1.id}/variants`),
      activate: await activate(),
      activateActive: await activateActive(),
      replyEdit: await put(a1.id, 'fixed reply'),
      questionEdit: await put(q1.id, 'Summarize it again.'),
    }
    for (const [what, res] of Object.entries(responses)) {
      assert.equal(res.status, 200, what)
      const text = await res.text()
      assert.ok(!text.includes('Q3 revenue'), `${what} sent the document text`)
      assert.ok(!text.includes('docContext'), what)
      assert.ok(text.includes('"textAttachments":["report.txt"]'), `${what} still names the document`)
    }
    assert.equal(h.store.getMessage(q1.id)!.docContext, docText, 'still stored, for a resend')
    await (await h.app.request(`${base}/continue`, json({}))).text()
    assert.deepEqual(engine.bodies.at(-1)!.messages.at(-1), { role: 'user', content: `${docText}\n\nSummarize it again.` })
  } finally {
    engine.restore()
    h.cleanup()
  }
})

test('a stale turn unwinding after Stop never removes the NEXT turn\'s in-flight entry', async () => {
  let toolDone!: () => void
  const toolGate = new Promise<void>((r) => { toolDone = r })
  let toolEntered!: () => void
  const inTool = new Promise<void>((r) => { toolEntered = r })
  const h = inFlightHarness({
    buildToolDefinitions: async () => [{ type: 'function', function: { name: 'slow_tool', description: '', parameters: { type: 'object', properties: {} } } }],
    executeTool: async () => { toolEntered(); await toolGate; return 'tool result' }, // does not honor abort, like fetch_url/run_code/MCP
  })
  const engine = fakeEngine((init, n) => {
    if (n === 1) { // turn A, round 1: the model calls the slow tool
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: 'slow_tool', arguments: '{}' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''), { status: 200 })
    }
    // turn B: a long generation, held open until it is aborted
    const signal = init?.signal
    return new Response(new ReadableStream({
      start(c) { signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))) },
    }), { status: 200 })
  })
  try {
    const conv = h.store.createConversation()
    const send = () => h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'hi' }))
    const resA = await send()
    void resA.body!.cancel() // the page is gone: the turn runs in the daemon on its own
    await inTool // turn A is now inside slow_tool
    const replyA = h.store.getMessages(conv.id).find((m) => m.role === 'assistant')!.id
    // Stop (the page's only way to stop a reply): it aborts A and frees the chat at once.
    const stop = await (await h.app.request('/api/v1/chat/stop', json({ conversationId: conv.id, messageId: replyA }))).json()
    assert.deepEqual(stop, { ok: true, stopped: true })
    assert.deepEqual(inFlightChatIds(), [], 'Stop drops A\'s entry')
    const resB = await send() // ...and the page immediately sends a follow-up
    assert.equal(resB.status, 200)
    toolDone() // turn A's tool returns; A sees its abort and unwinds through its finally
    // A's reply is saved right after runGeneration's finally (its first stale release); the rest of
    // its turn body, up to the second stale release, settles within the next macrotask.
    await waitFor(() => h.store.getMessage(replyA)?.stats.totalMs !== undefined, 'turn A to unwind and save its reply')
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(inFlightChatIds(), [conv.id], 'turn B is still generating and must stay tracked')
    assert.equal((await send()).status, 409, 'a third send must still be refused while B runs')

    await h.app.request('/api/v1/chat/stop', json({ conversationId: conv.id })) // Stop reaches B
    await resB.text()
    assert.deepEqual(inFlightChatIds(), [])
  } finally {
    toolDone()
    engine.restore()
    h.cleanup()
  }
})

test('a turn that throws before generating releases its in-flight entry (no stuck 409) and tells its viewer', async () => {
  const h = inFlightHarness()
  const engine = fakeEngine()
  const originalError = console.error
  const logged: unknown[][] = []
  console.error = (...args: unknown[]) => { logged.push(args) } // the turn's failure is logged
  try {
    const conv = h.store.createConversation()
    const url = `/api/v1/conversations/${conv.id}/messages`
    // A malformed body is now refused before the turn starts (below), so the throw comes from a
    // history that fails to read inside the callback (maybeAutoCompact is its first reader).
    const getConversation = h.store.getConversation.bind(h.store)
    h.store.getConversation = ((id: string, inc?: boolean) => {
      const real = getConversation(id, inc)
      return real && { ...real, get messages(): never { throw new Error('history unreadable') } }
    }) as typeof h.store.getConversation
    const bad = await h.app.request(url, json({ content: 'hi' }))
    assert.equal(bad.status, 200, 'the throw must come from inside the turn')
    // The turn runs in the daemon; its viewer's stream ends once the run has (after the release).
    // A rejection nobody handled would fail this file (the test runner reports it).
    const text = await bad.text()
    assert.match(text, /event: error\ndata: \{"code":"turn_failed","message":"The reply could not be generated\."\}/)
    assert.ok(logged.some((args) => String(args[0]).startsWith('[chat] turn for')), 'logged')
    assert.deepEqual(inFlightChatIds(), [])
    h.store.getConversation = getConversation
    const ok = await h.app.request(url, json({ content: 'hi again' }))
    assert.equal(ok.status, 200)
    await ok.text()
  } finally {
    console.error = originalError
    engine.restore()
    h.cleanup()
  }
})

test('POST /messages refuses non-array images or textAttachments (and a non-string docContext) before storing anything', async () => {
  const h = inFlightHarness()
  const engine = fakeEngine()
  try {
    const conv = h.store.createConversation()
    const url = `/api/v1/conversations/${conv.id}/messages`
    for (const bad of [{ images: 'data:image/png;base64,AAAA' }, { textAttachments: 'file.txt' }, { images: [1] }, { docContext: { text: 'x' } }]) {
      const res = await h.app.request(url, json({ content: 'hi', ...bad }))
      assert.equal(res.status, 400, JSON.stringify(bad))
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'invalid_input')
    }
    assert.deepEqual(h.store.getMessages(conv.id), [], 'nothing stored')
    assert.deepEqual(inFlightChatIds(), [])
    assert.equal(engine.bodies.length, 0)
    // Arrays of strings (and null for an absent field) still go through.
    const ok = await h.app.request(url, json({ content: 'hi', images: ['data:image/png;base64,AAAA'], textAttachments: null, docContext: null }))
    assert.equal(ok.status, 200)
    await ok.text()
    assert.deepEqual(h.store.getMessages(conv.id).map((m) => m.role), ['user', 'assistant'])
  } finally {
    engine.restore()
    h.cleanup()
  }
})

test('switching an older assistant reply\'s variant swaps its downstream turns too, and switching back restores them', async () => {
  const h = inFlightHarness()
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    h.store.addMessage(conv.id, 'user', 'Recommend a language')
    const a1 = h.store.addMessage(conv.id, 'assistant', 'Use Python')
    await h.app.request(`${base}/regenerate`, { method: 'POST' })
    const a2 = h.store.addMessage(conv.id, 'assistant', 'Use Rust', { variantGroup: h.store.getMessage(a1.id)!.variantGroup! })
    h.store.addMessage(conv.id, 'user', 'How do I install cargo?')
    h.store.addMessage(conv.id, 'assistant', 'Run rustup ...')

    const toPython = await (await h.app.request(`${base}/messages/${a1.id}/activate`, { method: 'POST' })).json() as { messages: Array<{ content: string }> }
    assert.deepEqual(toPython.messages.map((m) => m.content), ['Recommend a language', 'Use Python'])
    const toRust = await (await h.app.request(`${base}/messages/${a2.id}/activate`, { method: 'POST' })).json() as { messages: Array<{ content: string }> }
    assert.deepEqual(toRust.messages.map((m) => m.content), ['Recommend a language', 'Use Rust', 'How do I install cargo?', 'Run rustup ...'])
  } finally {
    h.cleanup()
  }
})

// Regenerate used to be /regenerate (deactivate the reply) and then /continue. When /continue was
// refused (a Turbo Link machine asleep, the model gone), the reply stayed deactivated with no
// switcher to bring it back, and the next send went out as user, user.
test('a Regenerate the upstream refuses keeps the reply it would have replaced', async () => {
  const h = inFlightHarness()
  const replies = ['a1', 'a1 again']
  const engine = fakeEngine((_init, n) => sseReply(replies[n - 1]))
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    const active = () => h.store.getMessages(conv.id).map((m) => `${m.role}:${m.content}`)
    await (await h.app.request(`${base}/messages`, json({ content: 'q1' }))).text()

    const manager = h.d.manager as unknown as { status: () => unknown }
    const running = manager.status
    manager.status = () => ({ state: 'stopped', model: null }) // the engine went away
    const refused = await h.app.request(`${base}/continue`, json({ regenerate: true }))
    assert.equal(refused.status, 409)
    assert.deepEqual(active(), ['user:q1', 'assistant:a1'])

    manager.status = running
    await (await h.app.request(`${base}/continue`, json({ regenerate: true }))).text()
    assert.deepEqual(active(), ['user:q1', 'assistant:a1 again'])
    assert.deepEqual(engine.bodies[1].messages.map((m) => m.role), ['user'], 'the replaced reply is not sent')
    const reply = h.store.getMessages(conv.id)[1]
    assert.deepEqual(h.store.getMessageVariants(reply.variantGroup!).map((m) => m.content), ['a1', 'a1 again'], 'both versions on one switcher')
  } finally {
    engine.restore()
    h.cleanup()
  }
})

// The test above covers a refusal before the turn starts. The engine or a linked host can still
// refuse once it has: a 503 while a model loads, a fetch that throws because the host went to sleep
// after its last probe or the engine died, an error chunk in the stream. The old reply then stayed
// set aside behind the version switcher, with an empty reply shown in its place.
test('a Regenerate the engine or linked host refuses once the turn has started keeps the reply it would have replaced', async () => {
  const h = inFlightHarness()
  const failures: Array<[string, () => Response]> = [
    ['engine_error', () => new Response(JSON.stringify({ error: { message: 'Loading model' } }), { status: 503 })],
    ['engine_stopped', () => { throw new TypeError('fetch failed') }],
    ['engine_error', () => new Response(`data: ${JSON.stringify({ error: { message: 'out of memory' } })}\n\n`, { status: 200 })],
  ]
  const engine = fakeEngine((_init, n) => n === 1 ? sseReply('a1') : n <= failures.length + 1 ? failures[n - 2][1]() : sseReply('a1 again'))
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    const active = () => h.store.getMessages(conv.id).map((m) => `${m.role}:${m.content}`)
    await (await h.app.request(`${base}/messages`, json({ content: 'q1' }))).text()
    const a1 = h.store.getMessages(conv.id)[1].id

    for (const [code] of failures) {
      const sse = await (await h.app.request(`${base}/continue`, json({ regenerate: true, messageId: a1 }))).text()
      assert.match(sse, new RegExp(`"code":"${code}"`), 'the error still reaches the chat')
      assert.deepEqual(active(), ['user:q1', 'assistant:a1'], code)
      const group = h.store.getMessage(a1)!.variantGroup!
      assert.deepEqual(h.store.getMessageVariants(group).map((m) => `${m.content}:${m.isActive}`), ['a1:true'], 'no empty version left on its switcher')
      assert.deepEqual(inFlightChatIds(), [])
    }

    await (await h.app.request(`${base}/continue`, json({ regenerate: true, messageId: a1 }))).text()
    assert.deepEqual(active(), ['user:q1', 'assistant:a1 again'])
    assert.deepEqual(h.store.getMessageVariants(h.store.getMessage(a1)!.variantGroup!).map((m) => `${m.content}:${m.isActive}`), ['a1:false', 'a1 again:true'])
  } finally {
    engine.restore()
    h.cleanup()
  }
})

test('a Regenerate that streamed text before the engine failed, or that was stopped, keeps its new reply', async () => {
  const h = inFlightHarness()
  const engine = fakeEngine((init, n) => {
    if (n === 1) return sseReply('a1')
    // Shorter than the parser's lookahead, so it is still held back when the error chunk arrives.
    if (n === 2) return new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'a2 partial' } }] })}\n\n`,
      `data: ${JSON.stringify({ error: { message: 'out of memory' } })}\n\n`,
    ].join(''), { status: 200 })
    const signal = init?.signal // held open until Stop aborts it
    return new Response(new ReadableStream({
      start(c) { signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))) },
    }), { status: 200 })
  })
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    const active = () => h.store.getMessages(conv.id).map((m) => `${m.role}:${m.content}`)
    await (await h.app.request(`${base}/messages`, json({ content: 'q1' }))).text()

    await (await h.app.request(`${base}/continue`, json({ regenerate: true }))).text()
    assert.deepEqual(active(), ['user:q1', 'assistant:a2 partial'])

    const stopped = (await h.app.request(`${base}/continue`, json({ regenerate: true }))).text()
    await waitFor(() => engine.bodies.length === 3, 'the regenerate to reach the engine')
    await h.app.request('/api/v1/chat/stop', json({ conversationId: conv.id }))
    await stopped
    assert.deepEqual(active(), ['user:q1', 'assistant:'], 'a Stop keeps what it stopped, as before')
    const group = h.store.getMessages(conv.id)[1].variantGroup!
    assert.deepEqual(h.store.getMessageVariants(group).map((m) => `${m.content}:${m.isActive}`), ['a1:false', 'a2 partial:false', ':true'])
  } finally {
    engine.restore()
    h.cleanup()
  }
})

// Two replies in a row (a chat routine's tool-call round and its answer, or an OpenAI import's
// tool-call turn): the new reply took its group from the row right after the question, the first
// reply, still active, so it got none, and the reply it replaced was left alone in a group with no
// active member, where no switcher could reach it.
test('Regenerate after two replies in a row keeps the replaced reply on the new reply\'s switcher', async () => {
  const h = inFlightHarness()
  const engine = fakeEngine(() => sseReply('It is 19C'))
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    h.store.addMessage(conv.id, 'user', 'weather?')
    h.store.addMessage(conv.id, 'assistant', '', { toolCalls: [{ id: 'tc1', name: 'get_weather', args: {}, result: '18C' }] })
    h.store.addMessage(conv.id, 'assistant', 'It is 18C')

    await (await h.app.request(`${base}/continue`, json({ regenerate: true }))).text()
    const active = h.store.getMessages(conv.id)
    assert.deepEqual(active.map((m) => `${m.role}:${m.content}`), ['user:weather?', 'assistant:', 'assistant:It is 19C'])
    const reply = active[2]
    assert.ok(reply.variantGroup, 'the new reply joins a group')
    assert.deepEqual(h.store.getMessageVariants(reply.variantGroup!).map((m) => `${m.content}:${m.isActive}`), ['It is 18C:false', 'It is 19C:true'])
    assert.equal(active[1].variantGroup, null, 'the tool-call round is left as it was')
  } finally {
    engine.restore()
    h.cleanup()
  }
})

// A stale tab or another device still showing a version that was switched away from: acting on it
// froze this branch's rows under the stale one (two replies in a row on switching back), or
// spliced a reply into the middle of an unrelated branch.
test('PUT and /activate on a message no longer on the shown branch are refused and change nothing', async () => {
  const h = inFlightHarness()
  const replies = ['reply1', 'reply2', 'reply3', 'reply4']
  const engine = fakeEngine((_init, n) => sseReply(replies[n - 1]))
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    const active = () => h.store.getMessages(conv.id).map((m) => m.content)
    const put = (id: string, content: string) => h.app.request(`${base}/messages/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) })
    const activate = (id: string) => h.app.request(`${base}/messages/${id}/activate`, { method: 'POST' })

    await (await h.app.request(`${base}/messages`, json({ content: 'u1' }))).text()
    const u1 = h.store.getMessages(conv.id)[0].id
    await (await h.app.request(`${base}/continue`, json({ regenerate: true }))).text()
    const reply1 = h.store.getMessageVariants(h.store.getMessages(conv.id)[1].variantGroup!)[0].id
    // Tab B edits u1 and gets a reply; tab A still shows u1 with its reply2 (switcher 2/2).
    assert.equal((await put(u1, 'u1 B')).status, 200)
    await (await h.app.request(`${base}/continue`, json({}))).text()
    assert.deepEqual(active(), ['u1 B', 'reply3'])

    const staleEdit = await put(u1, 'u1 A')
    assert.equal(staleEdit.status, 409)
    assert.equal(((await staleEdit.json()) as { error: { code: string } }).error.code, 'stale_message')
    const staleSwitch = await activate(reply1)
    assert.equal(staleSwitch.status, 409)
    assert.deepEqual(active(), ['u1 B', 'reply3'])

    // The branches are intact: switching back shows u1 with the one reply it had.
    assert.equal((await activate(u1)).status, 200)
    assert.deepEqual(active(), ['u1', 'reply2'])
    assert.equal((await activate(reply1)).status, 200, 'its switcher works again once it is shown')
    assert.deepEqual(active(), ['u1', 'reply1'])
  } finally {
    engine.restore()
    h.cleanup()
  }
})

// /continue { regenerate } named no reply and always set aside the last row, so a tab that still
// showed a2 last, after another tab added q3 and a3, regenerated a3, a reply it never showed.
test('a Regenerate of a reply that is no longer the last one is refused as stale and changes nothing', async () => {
  const h = inFlightHarness()
  const replies = ['a1', 'a2', 'a3', 'a3 again']
  const engine = fakeEngine((_init, n) => sseReply(replies[n - 1]))
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    const active = () => h.store.getMessages(conv.id).map((m) => m.content)
    const idOf = (content: string) => h.store.getMessages(conv.id).find((m) => m.content === content)!.id
    await (await h.app.request(`${base}/messages`, json({ content: 'q1' }))).text()
    await (await h.app.request(`${base}/messages`, json({ content: 'q2' }))).text()
    const a2 = idOf('a2')
    await (await h.app.request(`${base}/messages`, json({ content: 'q3' }))).text() // tab B

    const stale = await h.app.request(`${base}/continue`, json({ regenerate: true, messageId: a2 })) // tab A
    assert.equal(stale.status, 409)
    assert.equal(((await stale.json()) as { error: { code: string } }).error.code, 'stale_message')
    assert.deepEqual(active(), ['q1', 'a1', 'q2', 'a2', 'q3', 'a3'])
    assert.equal(engine.bodies.length, 3, 'nothing sent to the engine')
    assert.equal(h.store.getMessage(idOf('a3'))!.variantGroup, null, 'a3 was not set aside')

    // Naming the reply shown last regenerates it.
    await (await h.app.request(`${base}/continue`, json({ regenerate: true, messageId: idOf('a3') }))).text()
    assert.deepEqual(active(), ['q1', 'a1', 'q2', 'a2', 'q3', 'a3 again'])
  } finally {
    engine.restore()
    h.cleanup()
  }
})

// PUT and /activate each ran several statements with no transaction: one that failed partway (disk
// full, an I/O error) left a question and its tail deactivated with nothing in their place, or a
// frozen tail next to the version still shown.
test('an edit or a version switch whose last statement fails changes nothing', async () => {
  const h = inFlightHarness()
  const originalError = console.error
  console.error = () => {} // Hono logs the handler's throw
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    const active = () => h.store.getMessages(conv.id).map((m) => m.content)
    const u1 = h.store.addMessage(conv.id, 'user', 'u1')
    const a1 = h.store.addMessage(conv.id, 'assistant', 'a1')
    h.store.deactivateMessage(a1.id)
    h.store.addMessage(conv.id, 'assistant', 'a1 again', { variantGroup: a1.id })
    h.store.addMessage(conv.id, 'user', 'u2')
    h.store.addMessage(conv.id, 'assistant', 'a2')
    const before = active()
    const diskFull = () => { throw new Error('database or disk is full') }

    const addMessage = h.store.addMessage
    h.store.addMessage = diskFull
    const edit = await h.app.request(`${base}/messages/${u1.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'u1 edited' }) })
    h.store.addMessage = addMessage
    assert.equal(edit.status, 500)
    assert.deepEqual(active(), before, 'the question and its tail are still shown')
    assert.equal(h.store.getMessage(u1.id)!.variantGroup, null)

    const setActiveVariant = h.store.setActiveVariant
    h.store.setActiveVariant = diskFull
    const sw = await h.app.request(`${base}/messages/${a1.id}/activate`, { method: 'POST' })
    h.store.setActiveVariant = setActiveVariant
    assert.equal(sw.status, 500)
    assert.deepEqual(active(), before, 'the tail is not frozen, nor the other version\'s restored')

    // Both work once the statements do.
    assert.equal((await h.app.request(`${base}/messages/${a1.id}/activate`, { method: 'POST' })).status, 200)
    assert.deepEqual(active(), ['u1', 'a1'])
  } finally {
    console.error = originalError
    h.cleanup()
  }
})

// A restored tail kept its branch_of tag, so a reply that /regenerate later replaced
// inside it was frozen-and-restored along with its replacement — two assistant turns in a row.
test('switching an older reply away and back after regenerating a later reply in its tail restores only the current version', async () => {
  const h = inFlightHarness()
  const replies = ['a1', 'a1 again', 'a2', 'a2 again']
  const engine = fakeEngine((_init, n) => sseReply(replies[n - 1]))
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    const active = () => h.store.getMessages(conv.id).map((m) => m.content)
    const activate = async (id: string) => (await h.app.request(`${base}/messages/${id}/activate`, { method: 'POST' })).status
    const regenerate = async () => {
      await h.app.request(`${base}/regenerate`, { method: 'POST' })
      await (await h.app.request(`${base}/continue`, json({}))).text()
    }
    const idOf = (content: string) => h.store.getMessages(conv.id).find((m) => m.content === content)!.id

    await (await h.app.request(`${base}/messages`, json({ content: 'u1' }))).text()
    const a1 = idOf('a1')
    await regenerate()
    const a1b = idOf('a1 again')
    await (await h.app.request(`${base}/messages`, json({ content: 'u2' }))).text()
    assert.equal(await activate(a1), 200)
    assert.equal(await activate(a1b), 200)
    assert.deepEqual(active(), ['u1', 'a1 again', 'u2', 'a2'])
    await regenerate()
    const a2b = idOf('a2 again')
    assert.equal(await activate(a1), 200)
    assert.deepEqual(active(), ['u1', 'a1'])
    assert.equal(await activate(a1b), 200)
    assert.deepEqual(active(), ['u1', 'a1 again', 'u2', 'a2 again'])

    // The a2 switcher still works within the restored tail, and another round trip keeps it.
    const a2 = h.store.getMessageVariants(h.store.getMessage(a2b)!.variantGroup!).find((m) => m.content === 'a2')!.id
    assert.equal(await activate(a2), 200)
    assert.deepEqual(active(), ['u1', 'a1 again', 'u2', 'a2'])
    assert.equal(await activate(a1), 200)
    assert.equal(await activate(a1b), 200)
    assert.deepEqual(active(), ['u1', 'a1 again', 'u2', 'a2'])
  } finally {
    engine.restore()
    h.cleanup()
  }
})

test('the same holds for an edited question: regenerating its restored reply, then switching away and back, shows one reply', async () => {
  const h = inFlightHarness()
  const replies = ['a1', 'reply to the edit', 'a1 again']
  const engine = fakeEngine((_init, n) => sseReply(replies[n - 1]))
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    const active = () => h.store.getMessages(conv.id).map((m) => m.content)
    const activate = async (id: string) => (await h.app.request(`${base}/messages/${id}/activate`, { method: 'POST' })).status

    await (await h.app.request(`${base}/messages`, json({ content: 'u1' }))).text()
    const u1 = h.store.getMessages(conv.id)[0].id
    await h.app.request(`${base}/messages/${u1}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'u1 edited' }) })
    await (await h.app.request(`${base}/continue`, json({}))).text()
    const u1b = h.store.getMessages(conv.id)[0].id
    assert.equal(await activate(u1), 200)
    assert.deepEqual(active(), ['u1', 'a1'])
    await h.app.request(`${base}/regenerate`, { method: 'POST' })
    await (await h.app.request(`${base}/continue`, json({}))).text()
    assert.equal(await activate(u1b), 200)
    assert.deepEqual(active(), ['u1 edited', 'reply to the edit'])
    assert.equal(await activate(u1), 200)
    assert.deepEqual(active(), ['u1', 'a1 again'])
  } finally {
    engine.restore()
    h.cleanup()
  }
})

// "Save & Resend" with the question left as it was: the PUT returned early for unchanged text, so
// the client's /continue answered the same turn a second time — two replies in a row that
// Regenerate could not undo, and a history that alternating-role templates (Gemma) reject.
test('Save & Resend with unchanged text branches like any edit: one reply per turn, the first one kept', async () => {
  const h = inFlightHarness()
  const replies = ['a1', 'a1 resent', 'a1 regenerated', 'a2']
  const engine = fakeEngine((_init, n) => sseReply(replies[n - 1]))
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    const active = () => h.store.getMessages(conv.id).map((m) => m.content)

    await (await h.app.request(`${base}/messages`, json({ content: 'u1' }))).text()
    const u1 = h.store.getMessages(conv.id)[0].id
    const put = await h.app.request(`${base}/messages/${u1}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'u1' }) })
    assert.equal(put.status, 200)
    await (await h.app.request(`${base}/continue`, json({}))).text()
    assert.deepEqual(active(), ['u1', 'a1 resent'])
    assert.deepEqual(engine.bodies[1].messages, [{ role: 'user', content: 'u1' }])

    // Regenerate replaces that reply instead of stacking another, and the next turn alternates.
    await h.app.request(`${base}/regenerate`, { method: 'POST' })
    await (await h.app.request(`${base}/continue`, json({}))).text()
    assert.deepEqual(active(), ['u1', 'a1 regenerated'])
    await (await h.app.request(`${base}/messages`, json({ content: 'u2' }))).text()
    assert.deepEqual(engine.bodies[3].messages.map((m) => m.role), ['user', 'assistant', 'user'])

    // The first reply is kept, as the other version of the question.
    assert.equal((await h.app.request(`${base}/messages/${u1}/activate`, { method: 'POST' })).status, 200)
    assert.deepEqual(active(), ['u1', 'a1'])
  } finally {
    engine.restore()
    h.cleanup()
  }
})

// Save & Resend was a PUT (the new question version, the old tail frozen) and then /continue. A
// /continue the client skipped (no model ready) or the daemon refused left the branch ending on
// the new question, unanswered, and the next send went out as user, user.
test('Save & Resend as one /continue { edit }: a refused turn changes nothing, an accepted one branches and answers', async () => {
  const h = inFlightHarness()
  const replies = ['a1', 'a1 to the edit', 'a2']
  const engine = fakeEngine((_init, n) => sseReply(replies[n - 1]))
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    const active = () => h.store.getMessages(conv.id).map((m) => `${m.role}:${m.content}`)
    await (await h.app.request(`${base}/messages`, json({ content: 'q1' }))).text()
    const q1 = h.store.getMessages(conv.id)[0].id

    const manager = h.d.manager as unknown as { status: () => unknown }
    const running = manager.status
    manager.status = () => ({ state: 'stopped', model: null }) // no model loaded
    const refused = await h.app.request(`${base}/continue`, json({ edit: { messageId: q1, content: 'q1 edited' } }))
    assert.equal(refused.status, 409)
    assert.deepEqual(active(), ['user:q1', 'assistant:a1'])
    assert.equal(h.store.getMessage(q1)!.variantGroup, null, 'no new version of the question')

    manager.status = running
    await (await h.app.request(`${base}/continue`, json({ edit: { messageId: q1, content: 'q1 edited' } }))).text()
    assert.deepEqual(active(), ['user:q1 edited', 'assistant:a1 to the edit'])
    assert.deepEqual(engine.bodies[1].messages, [{ role: 'user', content: 'q1 edited' }])
    await (await h.app.request(`${base}/messages`, json({ content: 'q2' }))).text()
    assert.deepEqual(engine.bodies[2].messages.map((m) => m.role), ['user', 'assistant', 'user'])

    // The first version keeps its reply, and a stale tab's edit of it is refused.
    const stale = await h.app.request(`${base}/continue`, json({ edit: { messageId: q1, content: 'q1 from a stale tab' } }))
    assert.equal(stale.status, 409)
    assert.equal(((await stale.json()) as { error: { code: string } }).error.code, 'stale_message')
    assert.equal((await h.app.request(`${base}/messages/${q1}/activate`, { method: 'POST' })).status, 200)
    assert.deepEqual(active(), ['user:q1', 'assistant:a1'])
    assert.equal(engine.bodies.length, 3)
  } finally {
    engine.restore()
    h.cleanup()
  }
})

// The test above covers a refusal before the turn starts. Once it had, a 503 while a model loads,
// a fetch that throws (a host asleep, an engine that died) or an error chunk left the new question
// shown with an empty reply, and the old version and its tail behind the switcher.
test('a Save & Resend the engine or linked host refuses once the turn has started keeps the question and the replies it would have replaced', async () => {
  const h = inFlightHarness()
  const failures: Array<[string, () => Response]> = [
    ['engine_error', () => new Response(JSON.stringify({ error: { message: 'Loading model' } }), { status: 503 })],
    ['engine_stopped', () => { throw new TypeError('fetch failed') }],
    ['engine_error', () => new Response(`data: ${JSON.stringify({ error: { message: 'out of memory' } })}\n\n`, { status: 200 })],
  ]
  const engine = fakeEngine((_init, n) => {
    if (n <= 2) return sseReply(`a${n}`)
    if (n <= failures.length + 2) return failures[n - 3][1]()
    if (n === failures.length + 3) return new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`,
      `data: ${JSON.stringify({ error: { message: 'out of memory' } })}\n\n`,
    ].join(''), { status: 200 })
    return sseReply('a1 to the edit')
  })
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    const active = () => h.store.getMessages(conv.id).map((m) => `${m.role}:${m.content}`)
    await (await h.app.request(`${base}/messages`, json({ content: 'q1' }))).text()
    await (await h.app.request(`${base}/messages`, json({ content: 'q2' }))).text()
    const q1 = h.store.getMessages(conv.id)[0].id
    const versions = () => h.store.getMessageVariants(h.store.getMessage(q1)!.variantGroup!).map((m) => `${m.content}:${m.isActive}`)

    for (const [code] of failures) {
      const sse = await (await h.app.request(`${base}/continue`, json({ edit: { messageId: q1, content: 'q1 edited' } }))).text()
      assert.match(sse, new RegExp(`"code":"${code}"`), 'the error still reaches the chat')
      assert.deepEqual(active(), ['user:q1', 'assistant:a1', 'user:q2', 'assistant:a2'], code)
      assert.deepEqual(versions(), ['q1:true'], 'no unanswered version left on its switcher')
      assert.deepEqual(inFlightChatIds(), [])
    }

    // A turn that streamed anything keeps the new version and its reply, as a Regenerate does.
    await (await h.app.request(`${base}/continue`, json({ edit: { messageId: q1, content: 'q1 edited' } }))).text()
    assert.deepEqual(active(), ['user:q1 edited', 'assistant:partial'])
    assert.equal((await h.app.request(`${base}/messages/${q1}/activate`, { method: 'POST' })).status, 200)
    assert.deepEqual(active(), ['user:q1', 'assistant:a1', 'user:q2', 'assistant:a2'])

    await (await h.app.request(`${base}/continue`, json({ edit: { messageId: q1, content: 'q1 edited again' } }))).text()
    assert.deepEqual(active(), ['user:q1 edited again', 'assistant:a1 to the edit'])
    assert.deepEqual(versions(), ['q1:false', 'q1 edited:false', 'q1 edited again:true'])
  } finally {
    engine.restore()
    h.cleanup()
  }
})

// A tool loop's later round the engine refuses with an HTTP error: round 2's request carries round
// 1's tool result, which can push it past n_ctx (llama-server answers 400 exceed_context_size_error),
// and a model swap or a linked host can answer 503 between rounds. runGeneration returned from that
// branch before its one save, so round 1's text, reasoning and tool call, all streamed to the chat,
// were never written: the reply stayed empty, and on a Regenerate or a Save & Resend the empty reply
// was shown in place of the old one (restoreReplaced declines once the turn produced anything).
test('a tool round the engine refuses with an HTTP error keeps what the earlier rounds streamed, on a send, a Regenerate and a Save & Resend', async () => {
  const h = inFlightHarness({
    buildToolDefinitions: async () => [{ type: 'function', function: { name: 'web_search', description: '', parameters: { type: 'object', properties: {} } } }],
    executeTool: async () => 'a long page of results',
  })
  const sseLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
  const toolRound = () => new Response([
    sseLine({ choices: [{ delta: { reasoning_content: 'I should search.' } }] }),
    sseLine({ choices: [{ delta: { content: 'Let me look that up for you right now.' } }] }),
    sseLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: 'web_search', arguments: '{"query":"x"}' } }] } }] }),
    sseLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ].join(''), { status: 200 })
  const refused = () => new Response(JSON.stringify({ error: { message: 'the request exceeds the available context size', type: 'exceed_context_size_error' } }), { status: 400 })
  // Each flow: one tool round, then the refusal. The Regenerate and the Save & Resend each start
  // from a chat answered once (a1).
  const script: Array<() => Response> = [toolRound, refused, () => sseReply('a1'), toolRound, refused, () => sseReply('a1'), toolRound, refused]
  const engine = fakeEngine((_init, n) => script[n - 1]())
  try {
    const flows: Array<[string, (base: string, conv: string) => Promise<string>]> = [
      ['send', async (base) => (await h.app.request(`${base}/messages`, json({ content: 'q1' }))).text()],
      ['regenerate', async (base, conv) => {
        await (await h.app.request(`${base}/messages`, json({ content: 'q1' }))).text()
        const a1 = h.store.getMessages(conv)[1].id
        return (await h.app.request(`${base}/continue`, json({ regenerate: true, messageId: a1 }))).text()
      }],
      ['save & resend', async (base, conv) => {
        await (await h.app.request(`${base}/messages`, json({ content: 'q1' }))).text()
        const q1 = h.store.getMessages(conv)[0].id
        return (await h.app.request(`${base}/continue`, json({ edit: { messageId: q1, content: 'q1 edited' } }))).text()
      }],
    ]
    for (const [flow, run] of flows) {
      const conv = h.store.createConversation()
      const sse = await run(`/api/v1/conversations/${conv.id}`, conv.id)
      assert.match(sse, /"code":"engine_error","message":"Engine returned 400: the request exceeds the available context size"/, `${flow}: the error still reaches the chat`)
      const reply = h.store.getMessages(conv.id).at(-1)!
      assert.equal(reply.role, 'assistant', flow)
      assert.equal(reply.content, 'Let me look that up for you right now.', `${flow}: round 1's text is kept`)
      assert.equal(reply.reasoning, 'I should search.', `${flow}: round 1's reasoning is kept`)
      assert.deepEqual(reply.toolCalls.map((t) => [t.name, t.result]), [['web_search', 'a long page of results']], `${flow}: round 1's tool call is kept`)
      assert.deepEqual(inFlightChatIds(), [])
    }
    assert.equal(engine.bodies.length, script.length)
  } finally {
    engine.restore()
    h.cleanup()
  }
})

// A send the engine refuses on its first round (400 exceed_context_size_error) reports no prompt
// size, and since the refused turn is saved (the test above) its reply was written with
// ctxUsed 0. The auto-compaction gate reads the last reply's ctxUsed, so it read 0 from then on
// and never compacted again: every later send went out with the same full history and was refused
// the same way until the user compacted by hand.
test('a send the engine refuses before it measures anything leaves the last measurement standing, so the next turn compacts', async () => {
  const h = inFlightHarness()
  const refused = () => new Response(JSON.stringify({ error: { message: 'the request exceeds the available context size', type: 'exceed_context_size_error' } }), { status: 400 })
  const summary = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  // Turn 1: its auto-compaction's summary call fails (best-effort, the turn goes on uncompacted)
  // and the engine refuses the turn. Turn 2: the compaction is tried again and succeeds.
  const script: Array<() => Response> = [() => new Response('busy', { status: 500 }), refused, () => summary('The user asked twice about x.'), () => sseReply('a3')]
  const engine = fakeEngine((_init, n) => script[n - 1]())
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    const long = 'x'.repeat(6000)
    h.store.addMessage(conv.id, 'user', long)
    h.store.addMessage(conv.id, 'assistant', long)
    h.store.addMessage(conv.id, 'user', long)
    h.store.addMessage(conv.id, 'assistant', long, { stats: { ctxUsed: 7500, ctxMax: 8192 } })

    const first = await (await h.app.request(`${base}/messages`, json({ content: 'q3' }))).text()
    assert.match(first, /"code":"engine_error","message":"Engine returned 400: the request exceeds the available context size"/)
    const refusedReply = h.store.getMessages(conv.id).at(-1)!
    assert.equal(refusedReply.role, 'assistant')
    assert.equal(refusedReply.stats?.ctxUsed, undefined, 'a turn the engine measured nothing of records no context size')
    assert.equal(h.store.getConversation(conv.id)!.compactionSummary, undefined)

    const second = await (await h.app.request(`${base}/messages`, json({ content: 'q4' }))).text()
    assert.equal(engine.bodies.length, 4, 'the second turn tried the compaction again')
    assert.equal((engine.bodies[2] as { stream?: boolean }).stream, false, 'the third call is the summary')
    assert.equal(h.store.getConversation(conv.id)!.compactionSummary, 'The user asked twice about x.')
    assert.match(second, /"phase":"end"[\s\S]*"delta":"a3"/)
  } finally {
    engine.restore()
    h.cleanup()
  }
})

test('after an edit freezes the compaction cut, the next turn does not send the abandoned branch\'s summary', async () => {
  const h = inFlightHarness()
  const engine = fakeEngine()
  try {
    const conv = h.store.createConversation()
    const u1 = h.store.addMessage(conv.id, 'user', 'Write a web scraper in Python')
    h.store.addMessage(conv.id, 'assistant', 'Here is a Python scraper using requests + bs4 ...')
    h.store.addMessage(conv.id, 'user', 'Add retries')
    const cut = h.store.addMessage(conv.id, 'assistant', 'Added tenacity-based retries ...')
    h.store.addMessage(conv.id, 'user', 'Now add a CLI')
    h.store.addMessage(conv.id, 'assistant', 'argparse CLI ...')
    h.store.setConversationCompaction(conv.id, { summary: 'User wants a PYTHON scraper.', upToMessageId: cut.id, tokensBefore: 500 })
    await h.app.request(`/api/v1/conversations/${conv.id}/messages/${u1.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Write a web scraper in Go' }) })
    await (await h.app.request(`/api/v1/conversations/${conv.id}/continue`, json({}))).text()
    assert.deepEqual(engine.bodies[0].messages, [{ role: 'user', content: 'Write a web scraper in Go' }])
  } finally {
    engine.restore()
    h.cleanup()
  }
})

// POST /compact only checked the in-flight slot, never took it: for the whole summary call a
// version switch, an edit or a Regenerate still ran, so the cut picked at the start was stored on
// a branch the chat had left, or a turn started a second summarization. Once it took the slot, the
// refusals read as a running turn's ('Stop generation first.') over a chat showing no Stop.
test('a manual compaction holds the in-flight slot: turns, edits and switches are refused until it ends', async () => {
  const h = inFlightHarness()
  let finish!: () => void
  const held = new Promise<void>((r) => { finish = r })
  const engine = fakeEngine(async () => {
    await held
    return new Response(JSON.stringify({ choices: [{ message: { content: 'The user asked twice about x.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    const long = 'x'.repeat(6000)
    const u1 = h.store.addMessage(conv.id, 'user', long)
    h.store.addMessage(conv.id, 'assistant', long)
    h.store.addMessage(conv.id, 'user', long)
    const a2 = h.store.addMessage(conv.id, 'assistant', long)
    h.store.deactivateMessage(a2.id) // a2 has a regenerated sibling, so /activate reaches its checks
    const a2b = h.store.addMessage(conv.id, 'assistant', `${long} again`, { variantGroup: a2.id })

    const compacting = h.app.request(`${base}/compact`, json({}))
    await waitFor(() => engine.bodies.length === 1, 'the summary call to start')
    assert.deepEqual(inFlightChatIds(), [conv.id])
    const put = (id: string, content: string) => h.app.request(`${base}/messages/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) })
    const refused = {
      regenerate: await h.app.request(`${base}/continue`, json({ regenerate: true })),
      send: await h.app.request(`${base}/messages`, json({ content: 'q3' })),
      edit: await put(u1.id, 'edited'),
      switch: await h.app.request(`${base}/messages/${a2.id}/activate`, { method: 'POST' }),
      compact: await h.app.request(`${base}/compact`, json({})),
      legacyRegenerate: await h.app.request(`${base}/regenerate`, { method: 'POST' }),
    }
    for (const [what, res] of Object.entries(refused)) {
      assert.equal(res.status, 409, what)
      assert.deepEqual(((await res.json()) as { error: unknown }).error, { code: 'compaction_in_progress', message: 'This chat is being compacted. Try again when it finishes.' }, what)
    }
    assert.equal(h.store.getMessage(a2b.id)!.isActive, true, 'the legacy /regenerate set no reply aside')
    assert.equal(engine.bodies.length, 1, 'nothing else reached the engine')

    finish()
    assert.equal((await compacting).status, 200)
    assert.deepEqual(inFlightChatIds(), [], 'released when it ends')
    assert.equal(h.store.getConversation(conv.id)!.compactionSummary, 'The user asked twice about x.')
    assert.equal((await put(a2b.id, 'fixed reply')).status, 200, 'the chat takes edits again')
  } finally {
    finish()
    engine.restore()
    h.cleanup()
  }
})

// A page that did not start the chat's turn (another tab or device, a reload) could not tell a running reply from a
// finished one, nor which reply was running, nor a running manual compaction: only the page that started it knew.
type SlotView = { runningReplyId: string | null; compacting: boolean }
function slotViews(h: ReturnType<typeof inFlightHarness>) {
  return {
    state: async (convId: string): Promise<SlotView> => {
      const b = await (await h.app.request(`/api/v1/conversations/${convId}`)).json() as SlotView
      return { runningReplyId: b.runningReplyId, compacting: b.compacting }
    },
    listed: async (): Promise<Record<string, boolean>> => {
      const b = await (await h.app.request('/api/v1/conversations')).json() as { conversations: Array<{ id: string; running: boolean }> }
      return Object.fromEntries(b.conversations.map((c) => [c.id, c.running]))
    },
  }
}

/** Ends the turn or compaction a test still holds and waits until its slot is free, so a failed assertion does not
 *  leave an in-flight entry behind for the tests after it. */
async function endHeldTurn(release: () => void): Promise<void> {
  release()
  abortAllInFlightChats()
  await waitFor(() => inFlightChatIds().length === 0, 'the held turn to end').catch(() => {})
}

test('a conversation names the reply its turn generates, and its list row says running, until the turn ends', async () => {
  const h = inFlightHarness()
  const engine = holdEngineReply()
  const { state, listed } = slotViews(h)
  try {
    const conv = h.store.createConversation()
    const other = h.store.createConversation()
    assert.deepEqual(await state(conv.id), { runningReplyId: null, compacting: false })
    const res = await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'hi' }))
    const reply = h.store.getMessages(conv.id).find((m) => m.role === 'assistant')!
    assert.deepEqual(await state(conv.id), { runningReplyId: reply.id, compacting: false })
    assert.deepEqual(await listed(), { [conv.id]: true, [other.id]: false })
    engine.finish()
    await res.text()
    assert.deepEqual(await state(conv.id), { runningReplyId: null, compacting: false })
    assert.deepEqual(await listed(), { [conv.id]: false, [other.id]: false })
  } finally {
    await endHeldTurn(engine.finish)
    engine.restore()
    h.cleanup()
  }
})

test('a conversation says it is compacting while a manual compaction holds it, with no running reply', async () => {
  const h = inFlightHarness()
  let finish!: () => void
  const held = new Promise<void>((r) => { finish = r })
  const engine = fakeEngine(async () => {
    await held
    return new Response(JSON.stringify({ choices: [{ message: { content: 'The user asked twice about x.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const { state, listed } = slotViews(h)
  try {
    const conv = h.store.createConversation()
    const long = 'x'.repeat(6000)
    for (const role of ['user', 'assistant', 'user', 'assistant'] as const) h.store.addMessage(conv.id, role, long)
    const compacting = h.app.request(`/api/v1/conversations/${conv.id}/compact`, json({}))
    await waitFor(() => engine.bodies.length === 1, 'the summary call to start')
    assert.deepEqual(await state(conv.id), { runningReplyId: null, compacting: true })
    assert.deepEqual(await listed(), { [conv.id]: false }, 'a compaction is not a running reply')
    finish()
    assert.equal((await compacting).status, 200)
    assert.deepEqual(await state(conv.id), { runningReplyId: null, compacting: false })
  } finally {
    await endHeldTurn(finish)
    engine.restore()
    h.cleanup()
  }
})

test('a Regenerate names its new reply as running, and a Stop clears it once the turn ends', async () => {
  const h = inFlightHarness()
  const engine = fakeEngine((init, n) => {
    if (n === 1) return sseReply('a1')
    // the Regenerate: a long generation, held open until it is aborted
    const signal = init?.signal
    return new Response(new ReadableStream({
      start(c) { signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))) },
    }), { status: 200 })
  })
  const { state, listed } = slotViews(h)
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    await (await h.app.request(`${base}/messages`, json({ content: 'q1' }))).text()
    const res = await h.app.request(`${base}/continue`, json({ regenerate: true }))
    const newReply = h.store.getMessages(conv.id).at(-1)!
    assert.equal(newReply.role, 'assistant')
    assert.equal(newReply.content, '', 'the new placeholder, not the reply it replaces')
    assert.deepEqual(await state(conv.id), { runningReplyId: newReply.id, compacting: false })
    await h.app.request('/api/v1/chat/stop', json({ conversationId: conv.id }))
    await res.text()
    assert.deepEqual(await state(conv.id), { runningReplyId: null, compacting: false })
    assert.deepEqual(await listed(), { [conv.id]: false })
  } finally {
    await endHeldTurn(() => {})
    engine.restore()
    h.cleanup()
  }
})

// Undo (DELETE /compact) checked nothing: one clicked while a compaction ran cleared the columns,
// and the compaction then stored its summary over them, so the Undo was undone.
test('a compaction Undo is refused while a compaction runs, manual or a turn\'s own, so it cannot be undone by it', async () => {
  const h = inFlightHarness()
  let finish!: () => void
  let held = new Promise<void>((r) => { finish = r })
  const engine = fakeEngine(async (init) => {
    if (!JSON.parse(String(init?.body)).stream) {
      await held
      return new Response(JSON.stringify({ choices: [{ message: { content: `summary ${engine.bodies.length}` } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return sseReply('a3')
  })
  try {
    const conv = h.store.createConversation()
    const base = `/api/v1/conversations/${conv.id}`
    const long = 'x'.repeat(6000)
    h.store.addMessage(conv.id, 'user', long)
    h.store.addMessage(conv.id, 'assistant', long)
    h.store.addMessage(conv.id, 'user', long)
    h.store.addMessage(conv.id, 'assistant', long, { stats: { ctxUsed: 7500, ctxMax: 8192 } })
    const summary = () => h.store.getConversation(conv.id)!.compactionSummary
    const undo = async () => {
      const res = await h.app.request(`${base}/compact`, { method: 'DELETE' })
      return { status: res.status, error: res.status === 200 ? undefined : ((await res.json()) as { error: unknown }).error }
    }
    const refusal = { status: 409, error: { code: 'compaction_in_progress', message: 'This chat is being compacted. Try again when it finishes.' } }

    // The manual Compact.
    const compacting = h.app.request(`${base}/compact`, json({}))
    await waitFor(() => engine.bodies.length === 1, 'the summary call to start')
    assert.deepEqual(await undo(), refusal)
    finish()
    assert.equal((await compacting).status, 200)
    assert.equal(summary(), 'summary 1')
    assert.deepEqual(await undo(), { status: 200, error: undefined })
    assert.equal(summary(), undefined, 'undone once it ends')

    // A turn's auto-compaction (the last reply measured 7500 of 8192 tokens).
    held = new Promise<void>((r) => { finish = r })
    const turn = (await h.app.request(`${base}/messages`, json({ content: 'q3' }))).text()
    await waitFor(() => engine.bodies.length === 2, 'the auto-compaction to start')
    assert.deepEqual(await undo(), refusal)
    finish()
    assert.match(await turn, /"phase":"end"[\s\S]*"delta":"a3"/)
    assert.equal(summary(), 'summary 2')
    assert.deepEqual(await undo(), { status: 200, error: undefined })
    assert.equal(summary(), undefined)
  } finally {
    finish()
    engine.restore()
    h.cleanup()
  }
})

test('deleting a conversation aborts its in-flight generation', async () => {
  const h = inFlightHarness()
  let engineSignal: AbortSignal | undefined
  let engineEntered!: () => void
  const generating = new Promise<void>((r) => { engineEntered = r })
  const engine = fakeEngine((init) => {
    engineSignal = init?.signal ?? undefined
    engineEntered()
    return new Response(new ReadableStream({
      start(c) { engineSignal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))) },
    }), { status: 200 })
  })
  try {
    const conv = h.store.createConversation()
    const res = await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'hi' }))
    await generating
    assert.equal(engineSignal?.aborted, false)
    assert.equal((await h.app.request(`/api/v1/conversations/${conv.id}`, { method: 'DELETE' })).status, 200)
    assert.equal(engineSignal?.aborted, true)
    await res.text()
    assert.deepEqual(inFlightChatIds(), [])
  } finally {
    engine.restore()
    h.cleanup()
  }
})

// ── share-url ─────────────────────────────────────────────────────────────────────────────────
// `--port`/`--addr` (the Android app's 7000, `turbollm --port 8080`) win over daemon.port, so the
// share link must carry the port the listener really bound, or it points at a dead port.
test('share-url: advertises the port really bound, not daemon.port', async () => {
  const dir = tmpDir('tllm-chat-share-')
  const store = new ConversationStore(dir)
  const savedAdvertised = process.env.TURBOLLM_ADVERTISED_HOST
  delete process.env.TURBOLLM_ADVERTISED_HOST
  try {
    const d = { db: store, store: { snapshot: () => ({ daemon: { port: 6996 } }) }, bindPort: 7000 } as unknown as Deps
    const app = new Hono()
    registerChatRoutes(app, d)
    const conv = store.createConversation()
    const { url } = await (await app.request(`/api/v1/conversations/${conv.id}/share-url`)).json() as { url: string }
    assert.match(url, new RegExp(`^http://[^/]+:7000/chat/${conv.id}$`))
  } finally {
    if (savedAdvertised === undefined) delete process.env.TURBOLLM_ADVERTISED_HOST
    else process.env.TURBOLLM_ADVERTISED_HOST = savedAdvertised
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// A custom agent's tool allow-list (Customize → Agents, conv.allowedTools) filtered only the tool
// definitions the model was offered. A model can name any tool, offered or not, and the loop ran
// the call whenever its policy allowed it, so an agent fixed to web_search still ran run_code.
test("a tool the conversation's agent does not list is refused like an unknown tool, not run", async () => {
  const ran: string[] = []
  const h = inFlightHarness({
    buildToolDefinitions: async () => ['web_search', 'run_code'].map((name) => ({ type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } } })),
    executeTool: async (call: { name: string }) => { ran.push(call.name); return `ran ${call.name}` },
  })
  const sseLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
  /** The model calls `name` once, then answers. */
  const calling = (name: string) => (_init: RequestInit | undefined, n: number) => n % 2 === 1
    ? new Response([
        sseLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: `tc${n}`, function: { name, arguments: '{"code":"print(1)"}' } }] } }] }),
        sseLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ].join(''), { status: 200 })
    : sseReply('done')
  try {
    const cases: Array<[string, string[] | undefined, string, boolean]> = [
      ['an agent fixed to web_search calling run_code', ['web_search'], 'run_code', false],
      ['an agent with no tools (the Blank persona) calling run_code', [], 'run_code', false],
      ['an agent calling a tool it lists', ['web_search', 'run_code'], 'run_code', true],
      ['a chat with no allow-list', undefined, 'run_code', true],
    ]
    for (const [what, allowedTools, name, runs] of cases) {
      ran.length = 0
      const engine = fakeEngine(calling(name))
      try {
        const conv = h.store.createConversation({ allowedTools })
        const sse = await (await h.app.request(`/api/v1/conversations/${conv.id}/messages`, json({ content: 'go' }))).text()
        const offered = (engine.bodies[0] as { tools?: Array<{ function: { name: string } }> }).tools?.map((t) => t.function.name) ?? []
        assert.equal(offered.includes(name), runs, `${what}: offered only when listed (unchanged)`)
        const want = runs ? `ran ${name}` : `Error: unknown tool "${name}"`
        assert.deepEqual(ran, runs ? [name] : [], `${what}: run only when listed`)
        const toolReply = engine.bodies[1].messages.at(-1)!
        assert.deepEqual([toolReply.role, toolReply.content], ['tool', want], `${what}: the model is told what happened`)
        assert.deepEqual(h.store.getMessages(conv.id).at(-1)!.toolCalls.map((t) => [t.name, t.result]), [[name, want]], `${what}: and so is the chat`)
        assert.ok(sse.includes(JSON.stringify(want).slice(1, -1)), `${what}: the stream shows it`)
      } finally {
        engine.restore()
      }
    }
  } finally {
    h.cleanup()
  }
})

// A text field (trimmed, resolved as a model id, or stored as text) that held a number, an object, an array or a boolean
// threw (`.trim is not a function`, a SQLite bind error): Hono's default handler answered a bare 500 text/plain.
test('the chat and folder routes refuse a text field that is not a string with 400, changing nothing', async () => {
  const h = inFlightHarness()
  const engine = fakeEngine()
  try {
    const folder = h.store.createFolder('Work')
    const conv = h.store.createConversation()
    const question = h.store.addMessage(conv.id, 'user', 'What is 2+2?')
    const c = `/api/v1/conversations/${conv.id}`
    const send = (method: string, url: string, body: unknown) =>
      h.app.request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const routes: Array<[string, string, Record<string, unknown>, string[]]> = [
      ['POST', '/api/v1/folders', {}, ['name']],
      ['PATCH', `/api/v1/folders/${folder.id}`, {}, ['name']],
      ['POST', `${c}/tool-calls/t1/approve`, { toolName: 'web_search', decision: 'allow' }, ['toolName']],
      ['POST', `${c}/messages`, { content: 'hi' }, ['content', 'model']],
      ['POST', `${c}/continue`, {}, ['model']],
      ['PUT', `${c}/messages/${question.id}`, { content: 'What is 3+3?' }, ['content']],
      ['POST', `${c}/compact`, {}, ['model']],
    ]
    for (const [method, url, base, fields] of routes) {
      for (const field of fields) {
        for (const bad of [7, { text: 'x' }, ['x'], true]) {
          const what = `${method} ${url} with ${field} ${JSON.stringify(bad)}`
          const res = await send(method, url, { ...base, [field]: bad })
          assert.equal(res.status, 400, `${what}: ${await res.clone().text()}`)
          assert.deepEqual(await res.json(), { error: { code: 'invalid_input', message: `${field} must be a string.` } }, what)
        }
      }
    }
    assert.deepEqual(h.store.listFolders().map((f) => f.name), ['Work'])
    assert.deepEqual(h.store.getMessages(conv.id).map((m) => m.content), ['What is 2+2?'], 'nothing stored or edited')
    assert.equal(engine.bodies.length, 0, 'no turn ran')
    assert.deepEqual(inFlightChatIds(), [])
    // Strings (and null for an absent field) still go through.
    assert.equal((await send('POST', '/api/v1/folders', { name: 'Home' })).status, 201)
    assert.equal((await send('PATCH', `/api/v1/folders/${folder.id}`, { name: 'Office' })).status, 200)
    const ok = await send('POST', `${c}/messages`, { content: 'hi', model: null })
    assert.equal(ok.status, 200)
    await ok.text()
    assert.deepEqual(h.store.getMessages(conv.id).map((m) => m.role), ['user', 'user', 'assistant'])
  } finally {
    engine.restore()
    h.cleanup()
  }
})
