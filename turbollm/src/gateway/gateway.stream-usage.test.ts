// The OpenAI pass-through injects `stream_options.include_usage` into a streaming chat request that left it unset,
// so its own stats drain sees token counts (GitHub #71). The engine then ends the stream with a `choices: []` usage
// chunk — OpenAI's contract only for a caller that opted in, and the standard `chunk.choices[0].delta` loop (the
// OpenAI SDK docs' own) throws IndexError on it. The client's copy must not carry that chunk; the drain still reads it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import type { Deps } from '../deps'

/** A real engine socket mirroring llama.cpp's to_json_oaicompat_chat_stream: the empty-`choices` usage chunk is sent
 *  only when the request asked for it — written in fragments, so the client-side filter has to reassemble lines. */
async function withLlamaLikeEngine(): Promise<{ url: string; requests: Array<Record<string, unknown>>; close: () => Promise<void> }> {
  const requests: Array<Record<string, unknown>> = []
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      requests.push(body)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n')
      res.write('data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n')
      // llama.cpp hangs its final `timings` on the LAST chunk it sends: the usage chunk when one was asked for, the
      // finish chunk otherwise.
      const timings = '"timings":{"prompt_per_second":100,"predicted_per_second":50}'
      if ((body.stream_options as { include_usage?: boolean } | undefined)?.include_usage) {
        res.write('data: {"choices":[{"index":0,"finish_reason":"stop","delta":{}}]}\n\n')
        res.write('data: {"choices":[],"usage":{"prompt_tok')
        res.write(`ens":7,"completion_tokens":2,"total_tokens":9},${timings}}\n`)
        res.write('\n')
      } else {
        res.write(`data: {"choices":[{"index":0,"finish_reason":"stop","delta":{}}],${timings}}\n\n`)
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

function fakeDeps(target: string, usage: Array<{ promptTokens: number; genTokens: number }>): Deps {
  return {
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    modelRouter: { targetEntry: () => undefined, route: async () => ({ target }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap: false } }) },
    manager: {
      status: () => ({ state: 'running', model: { name: 'Qwen3 8B', key: 'qwen3-8b|Q4|123' } }),
      target: () => target,
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      recordCompletion: () => {},
      setLiveGen: () => {},
    },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    db: { recordApiUsage: (u: { promptTokens: number; genTokens: number }) => { usage.push(u) } },
  } as unknown as Deps
}

async function waitUntil(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Every `data:` payload of an SSE body, in order. */
function dataLines(text: string): string[] {
  return text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
}

test('a streaming client that did not ask for usage never sees the injected `choices: []` chunk; stats still get it', async () => {
  const engine = await withLlamaLikeEngine()
  const usage: Array<{ promptTokens: number; genTokens: number }> = []
  try {
    const app = new Hono()
    registerGateway(app, fakeDeps(engine.url, usage))
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    const text = await res.text()
    assert.deepEqual(engine.requests[0].stream_options, { include_usage: true }, 'the gateway still asks the engine for usage')
    const lines = dataLines(text)
    assert.equal(lines.at(-1), '[DONE]')
    for (const l of lines.slice(0, -1)) {
      const chunk = JSON.parse(l) as { choices: unknown[] }
      assert.ok(chunk.choices.length > 0, `client got a chunk with no choices: ${l}`)
    }
    assert.equal(lines.length, 4, 'three content/finish chunks and [DONE], nothing else')
    assert.ok(!/\n\n\n/.test(text), 'the dropped event leaves no stray blank line behind')
    await waitUntil(() => usage.length === 1)
    assert.equal(usage[0].promptTokens, 7)
    assert.equal(usage[0].genTokens, 2)
  } finally { await engine.close() }
})

test('a streaming client that did not ask for usage gets the stream the engine would have sent it, timings included', async () => {
  // Dropping the usage chunk whole dropped llama.cpp's final `timings` with it: without the injected option they ride
  // on the finish chunk, which is where the client must find them.
  const engine = await withLlamaLikeEngine()
  try {
    const app = new Hono()
    registerGateway(app, fakeDeps(engine.url, []))
    const body = { model: 'qwen3-8b|Q4|123', messages: [{ role: 'user', content: 'hi' }], stream: true }
    const viaGateway = await (await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })).text()
    const direct = await (await fetch(`${engine.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })).text()
    assert.deepEqual(engine.requests.map((r) => r.stream_options), [{ include_usage: true }, undefined])
    assert.match(direct, /"finish_reason":"stop".*"timings"/)
    assert.equal(viaGateway, direct)
  } finally { await engine.close() }
})

test('a streaming client that asked for usage itself still gets the usage chunk', async () => {
  const engine = await withLlamaLikeEngine()
  try {
    const app = new Hono()
    registerGateway(app, fakeDeps(engine.url, []))
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-8b|Q4|123', messages: [], stream: true, stream_options: { include_usage: true } }),
    })
    const lines = dataLines(await res.text())
    const usageChunk = lines.find((l) => l.includes('"usage"'))
    assert.ok(usageChunk, 'the opted-in usage chunk is passed through')
    assert.deepEqual((JSON.parse(usageChunk!) as { choices: unknown[] }).choices, [])
  } finally { await engine.close() }
})
