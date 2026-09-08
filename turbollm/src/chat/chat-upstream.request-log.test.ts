// Coverage for `callChatUpstream`'s developer request log capture (issue #211 follow-up) — the
// SINGLE hook point this module's own docstring calls "the ONE outbound chat-completions call",
// which is exactly why it's tested here once rather than at each of chat-routes.ts's three call
// sites plus memory.ts's. Two things matter most: (1) an in-app chat turn produces a correct
// `source: 'chat'` entry, streaming and non-streaming; (2) capturing must never alter what the
// CALLER actually receives — same body, same status — since `d` is a late-added, optional
// parameter every pre-existing call site now passes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callChatUpstream, type ChatUpstream } from './chat-upstream'
import { RequestLog } from '../observability/request-log'
import type { RemoteTarget } from '../link/link-proxy'
import type { Deps } from '../deps'

function fakeDeps(requestLog: RequestLog | undefined, captureBodies = false, enabled = true): Deps {
  return {
    store: { snapshot: () => ({ requestLog: { enabled, captureBodies, maxEntries: 500 } }) },
    requestLog,
  } as unknown as Deps
}

const upstream: ChatUpstream = { modelField: 'qwen3-8b|Q4|123', modelName: 'Qwen3 8B', ctxMax: 8192, target: 'http://engine.invalid.local:1' }

function jsonFetch(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
}

function sseFetch(lines: string[]): typeof fetch {
  return (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        for (const l of lines) controller.enqueue(enc.encode(`data: ${l}\n\n`))
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
}

async function waitUntil(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('non-streaming: captures a source:"chat" entry with params, tokens, and no bodies when captureBodies is off', async () => {
  const requestLog = new RequestLog()
  const d = fakeDeps(requestLog, false)
  const body = { model: upstream.modelField, messages: [{ role: 'user', content: 'hi' }], stream: false, temperature: 0.6 }
  const engineReply = { choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4 } }

  const res = await callChatUpstream(upstream, body, undefined, jsonFetch(engineReply), d)
  const text = await res.text() // the CALLER's own read — must see the real, untouched body

  assert.deepEqual(JSON.parse(text), engineReply, 'the caller must receive the exact untouched response')
  await waitUntil(() => requestLog.list().length > 0)

  const [entry] = requestLog.list()
  assert.equal(entry.source, 'chat')
  assert.equal(entry.status, 200)
  assert.equal(entry.stream, false)
  assert.deepEqual(entry.params, { temperature: 0.6 })
  assert.equal(entry.tokens.prompt, 9)
  assert.equal(entry.tokens.completion, 4)
  assert.equal(entry.finishReason, 'stop')
  assert.equal(entry.bodies, null)
})

test('non-streaming: captureBodies on → both request and response text are captured', async () => {
  const requestLog = new RequestLog()
  const d = fakeDeps(requestLog, true)
  const body = { model: upstream.modelField, messages: [{ role: 'user', content: 'hi there' }], stream: false }
  const engineReply = { choices: [{ message: { content: 'hello back' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }

  await (await callChatUpstream(upstream, body, undefined, jsonFetch(engineReply), d)).text()
  await waitUntil(() => requestLog.list().length > 0)

  const entry = requestLog.get(requestLog.list()[0].id)!
  assert.match(entry.bodies!.request, /"hi there"/)
  assert.match(entry.bodies!.response, /"hello back"/)
})

test('streaming: captures tokens, finish reason, and TTFT from the SSE drain, and the client stream is unaffected', async () => {
  const requestLog = new RequestLog()
  const d = fakeDeps(requestLog, true)
  const body = { model: upstream.modelField, messages: [{ role: 'user', content: 'hi' }], stream: true }
  const fetchImpl = sseFetch([
    '{"choices":[{"delta":{"content":"he"}}]}',
    '{"choices":[{"delta":{"content":"llo"}}]}',
    '{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2},"timings":{"prompt_per_second":80,"predicted_per_second":40}}',
  ])

  const res = await callChatUpstream(upstream, body, undefined, fetchImpl, d)
  const clientText = await res.text()
  assert.match(clientText, /"hello"|"he"/, 'the caller must still receive the real SSE bytes') // sanity: some content arrived
  assert.ok(clientText.includes('data: '), 'the caller sees the raw SSE frames, not a transformed body')

  await waitUntil(() => {
    const [e] = requestLog.list()
    return !!e && e.status !== null
  })

  const entry = requestLog.get(requestLog.list()[0].id)!
  assert.equal(entry.source, 'chat')
  assert.equal(entry.stream, true)
  assert.equal(entry.tokens.prompt, 11)
  assert.equal(entry.tokens.completion, 2)
  assert.equal(entry.tokens.promptTps, 80)
  assert.equal(entry.tokens.genTps, 40)
  assert.equal(entry.finishReason, 'stop')
  assert.ok(entry.timings.ttftMs !== null && entry.timings.ttftMs >= 0)
  assert.deepEqual(JSON.parse(entry.bodies!.response), { content: 'hello' })
})

test('a remote (Turbo Link) turn is never captured — the host already logs it behind its own façade', async () => {
  const requestLog = new RequestLog()
  const d = fakeDeps(requestLog, false)
  const remote: RemoteTarget = { linkId: 'link1', baseUrl: 'http://peer.invalid.local:1', token: 'tok', modelKey: 'qwen3-8b|Q4|123' }
  const remoteUpstream: ChatUpstream = { ...upstream, remote, target: '' }
  const body = { model: 'qwen3-8b|Q4|123', messages: [], stream: false }

  await (await callChatUpstream(remoteUpstream, body, undefined, jsonFetch({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), d)).text()

  assert.equal(requestLog.list().length, 0)
})

test('requestLog.enabled: false → no capture, and the call still succeeds normally', async () => {
  const requestLog = new RequestLog()
  const d = fakeDeps(requestLog, false, /* enabled */ false)
  const body = { model: upstream.modelField, messages: [], stream: false }
  const res = await callChatUpstream(upstream, body, undefined, jsonFetch({ choices: [{ message: { content: 'ok' } }] }), d)
  assert.equal(res.status, 200)
  assert.equal(requestLog.list().length, 0)
})

test('no `d` argument at all (every pre-existing caller before this feature): behaves exactly as before', async () => {
  const body = { model: upstream.modelField, messages: [], stream: false }
  const res = await callChatUpstream(upstream, body, undefined, jsonFetch({ choices: [{ message: { content: 'ok' } }] }))
  assert.equal(res.status, 200)
  assert.equal(await res.text(), JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
})
