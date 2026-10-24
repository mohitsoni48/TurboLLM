// An extension's run that the engine refuses says why, as the chat does. It reported only "Engine returned 400", and
// LiteRT-LM's servers give their reason in the status line ("400 Invalid sampler parameters: ...", the Android app's
// with a JSON body too, `litert-lm serve` with an HTML page); here, in the status line alone.
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

test('an extension run the engine refuses fails with the engine\'s reason, from its status line', async () => {
  const engine = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(400, 'Invalid sampler parameters: ValueError: top_p must be between 0 and 1, got 1.5')
      res.end()
    })
  })
  await new Promise<void>((r) => engine.listen(0, '127.0.0.1', r))
  const dir = tmpDir('turbollm-ext-gen-error-')
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
      registry: { active: () => ({ id: 'lrt', kind: 'litert-lm' }) },
      store: { snapshot: () => ({ tools: { toolPolicies: {}, autoAllowAll: false }, modelDefaults: {} }), dir: () => dir },
    } as unknown as Deps
    const chat = await chatStore.createChat(SCOPE, { title: 't' })
    await chatStore.addMessage(SCOPE, chat.id, { role: 'user', content: 'go' })
    const placeholder = await chatStore.addMessage(SCOPE, chat.id, { role: 'assistant', content: '', status: 'streaming' })
    // The run fails with the error its run record and its stream report.
    await assert.rejects(
      createMakeBody(d)({ chatId: chat.id, messageId: placeholder.id, scope: SCOPE })({ emit: () => {}, signal: new AbortController().signal }),
      /^Error: Engine returned 400: Invalid sampler parameters: ValueError: top_p must be between 0 and 1, got 1\.5$/,
    )
  } finally {
    conv.close()
    rmSync(dir, { recursive: true, force: true })
    engine.closeAllConnections()
    await new Promise<void>((r) => engine.close(() => r()))
  }
})
