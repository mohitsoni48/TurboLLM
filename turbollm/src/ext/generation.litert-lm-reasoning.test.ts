// An extension's run on a LiteRT-LM model: an earlier answer's reasoning goes as the message's reasoning_content, the
// field its bundle's template reads it from (LFM2.5's) or leaves out (Qwen3-0.6B's, Gemma's), where it was always
// folded into the answer's text as <think>…</think>, which most of those templates put in verbatim.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConversationStore } from '../chat/db.js'
import { ChatStoreRouter } from '../chat/store/router.js'
import { createMakeBody } from './generation.js'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

const SCOPE = { tenant: 'acme', owner: 'u1' }

/** One run, on `engineKind`, of a chat whose first answer came with reasoning: the messages the engine got. */
async function sentHistory(engineKind: string): Promise<Array<Record<string, unknown>>> {
  const bodies: Array<Record<string, unknown>> = []
  const engine = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      bodies.push(JSON.parse(raw))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'Rome.' }, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => engine.listen(0, '127.0.0.1', r))
  const dir = tmpDir('turbollm-ext-gen-litert-reasoning-')
  const conv = new ConversationStore(dir)
  const chatStore = new ChatStoreRouter(conv.chatStore, conv.chatStore)
  try {
    const d = {
      chatStore,
      manager: {
        status: () => ({ state: 'running', model: { key: 'm', name: 'M', ctx: 8192 } }),
        target: () => `http://127.0.0.1:${(engine.address() as AddressInfo).port}`,
        currentOpts: () => undefined,
        generationStart: () => {},
        generationEnd: () => {},
      },
      registry: { active: () => ({ id: engineKind, kind: engineKind }) },
      scanner: { get: () => undefined },
      store: { snapshot: () => ({ tools: { toolPolicies: {}, autoAllowAll: false }, modelDefaults: {} }) },
    } as unknown as Deps
    const chat = await chatStore.createChat(SCOPE, { title: 't' })
    await chatStore.addMessage(SCOPE, chat.id, { role: 'user', content: 'What is the capital of France?' })
    await chatStore.addMessage(SCOPE, chat.id, { role: 'assistant', content: 'Paris.', reasoning: 'Its capital is Paris.' })
    await chatStore.addMessage(SCOPE, chat.id, { role: 'user', content: 'And of Italy?' })
    const placeholder = await chatStore.addMessage(SCOPE, chat.id, { role: 'assistant', content: '', status: 'streaming' })
    const body = createMakeBody(d)({ chatId: chat.id, messageId: placeholder.id, scope: SCOPE })
    assert.deepEqual(await body({ emit: () => {}, signal: new AbortController().signal }), { status: 'complete' })
    return bodies[0].messages as Array<Record<string, unknown>>
  } finally {
    conv.close()
    rmSync(dir, { recursive: true, force: true })
    engine.closeAllConnections()
    await new Promise<void>((r) => engine.close(() => r()))
  }
}

test('an extension run sends a LiteRT-LM model past reasoning as reasoning_content, not <think> text; llama.cpp keeps the fold', async () => {
  const litert = await sentHistory('litert-lm')
  assert.deepEqual(litert.find((m) => m.role === 'assistant'), { role: 'assistant', content: 'Paris.', reasoning_content: 'Its capital is Paris.' })
  assert.ok(!litert.some((m) => String(m.content).includes('<think>')))
  const llama = await sentHistory('llama-server')
  assert.deepEqual(llama.find((m) => m.role === 'assistant'), { role: 'assistant', content: '<think>\nIts capital is Paris.\n</think>\n\nParis.' })
})
