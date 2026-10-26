// An extension's run on a LiteRT-LM model: TurboLLM's tools reach a model that calls tools (its bundle's template
// shows them to it: LFM2.5, Qwen3, Gemma 4), as on llama.cpp. They were withheld from every LiteRT-LM model, on the
// ground that its server did not take them; both servers do. A model whose template never shows them (Gemma3-1B,
// LFM2.5-VL) is sent none, and so is one whose context they do not fit with the conversation.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConversationStore } from '../chat/db.js'
import { ChatStoreRouter } from '../chat/store/router.js'
import { createMakeBody } from './generation.js'
import { ToolRegistry } from '../tools/tool-registry'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

const SCOPE = { tenant: 'acme', owner: 'u1' }

/** One run through the real createMakeBody against a loopback engine that answers "done"; returns the body the
 *  engine got. The loaded model 'm' is served by `engineKind`; its library entry says `toolCalls`. */
async function engineBody(engineKind: string, toolCalls: boolean | undefined, ctx = 8192): Promise<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = []
  const engine = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      bodies.push(JSON.parse(raw))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => engine.listen(0, '127.0.0.1', r))
  const dir = tmpDir('turbollm-ext-gen-litert-')
  const conv = new ConversationStore(dir)
  const chatStore = new ChatStoreRouter(conv.chatStore, conv.chatStore)
  try {
    const d = {
      chatStore,
      manager: {
        status: () => ({ state: 'running', model: { key: 'm', name: 'M', ctx } }),
        target: () => `http://127.0.0.1:${(engine.address() as AddressInfo).port}`,
        currentOpts: () => undefined,
        generationStart: () => {},
        generationEnd: () => {},
      },
      registry: { active: () => ({ id: engineKind, kind: engineKind }) },
      scanner: { get: (key: string) => (key === 'm' && toolCalls !== undefined ? { key: 'm', toolCalls } : undefined) },
      store: { snapshot: () => ({ tools: { toolPolicies: {}, autoAllowAll: false }, modelDefaults: {} }) },
      tools: new ToolRegistry({ search: {}, sandbox: {}, mcpServers: [] } as never),
    } as unknown as Deps
    const chat = await chatStore.createChat(SCOPE, { title: 't' })
    await chatStore.addMessage(SCOPE, chat.id, { role: 'user', content: 'go' })
    const placeholder = await chatStore.addMessage(SCOPE, chat.id, { role: 'assistant', content: '', status: 'streaming' })
    const body = createMakeBody(d)({ chatId: chat.id, messageId: placeholder.id, scope: SCOPE })
    assert.deepEqual(await body({ emit: () => {}, signal: new AbortController().signal }), { status: 'complete' })
    return bodies[0]
  } finally {
    conv.close()
    rmSync(dir, { recursive: true, force: true })
    engine.closeAllConnections()
    await new Promise<void>((r) => engine.close(() => r()))
  }
}

const toolNames = (body: Record<string, unknown>): string[] | undefined =>
  (body.tools as Array<{ function: { name: string } }> | undefined)?.map((t) => t.function.name)

test('an extension run sends its tools to a LiteRT-LM model that calls tools, and none to one that cannot', async () => {
  assert.deepEqual(toolNames(await engineBody('litert-lm', true)), ['fetch_url', 'run_code'])
  assert.deepEqual(toolNames(await engineBody('litert-lm', undefined)), ['fetch_url', 'run_code'], 'unknown: the engine decides')
  assert.equal(toolNames(await engineBody('litert-lm', false)), undefined)
  // Tools that do not fit in the model's context with the conversation are not sent either.
  assert.equal(toolNames(await engineBody('litert-lm', true, 700)), undefined)
  // llama.cpp is as it was.
  assert.deepEqual(toolNames(await engineBody('llama-server', undefined)), ['fetch_url', 'run_code'])
})
