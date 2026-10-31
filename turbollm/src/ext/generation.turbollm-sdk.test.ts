// An extension run's request to the in-app SDK engine carries the SDK's own per-process bearer (plan D-3); the engine
// answers nothing else.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db.js'
import { ChatStoreRouter } from '../chat/store/router.js'
import { createMakeBody } from './generation.js'
import type { Deps } from '../deps'

const SCOPE = { tenant: 'acme', owner: 'u1' }

/** Runs one extension turn on an engine of `engineKind` and returns the authorization header the engine received. */
async function authorizationSentTo(engineKind: string): Promise<string | null> {
  const conv = new ConversationStore(IN_MEMORY_DATA_DIR)
  const chatStore = new ChatStoreRouter(conv.chatStore, conv.chatStore)
  const realFetch = globalThis.fetch
  let sent: string | null | undefined
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent = new Headers(init?.headers).get('authorization')
    return new Response(null, { status: 400, statusText: 'refused' })
  }) as typeof fetch
  try {
    const d = {
      chatStore,
      manager: {
        status: () => ({ state: 'running', model: { key: 'm', name: 'M', ctx: 8192 } }),
        target: () => 'http://engine.invalid',
        currentOpts: () => undefined,
        generationStart: () => {},
        generationEnd: () => {},
      },
      registry: { active: () => ({ id: 'e', kind: engineKind }) },
      store: { snapshot: () => ({ tools: { toolPolicies: {}, autoAllowAll: false }, modelDefaults: {} }), dir: () => IN_MEMORY_DATA_DIR },
    } as unknown as Deps
    const chat = await chatStore.createChat(SCOPE, { title: 't' })
    await chatStore.addMessage(SCOPE, chat.id, { role: 'user', content: 'go' })
    const placeholder = await chatStore.addMessage(SCOPE, chat.id, { role: 'assistant', content: '', status: 'streaming' })
    await createMakeBody(d)({ chatId: chat.id, messageId: placeholder.id, scope: SCOPE })({ emit: () => {}, signal: new AbortController().signal })
      .catch(() => {})
  } finally {
    globalThis.fetch = realFetch
    conv.close()
  }
  assert.notEqual(sent, undefined, 'the engine was called')
  return sent ?? null
}

test('an extension run to the SDK engine carries its bearer; llama.cpp gets no authorization', async (t) => {
  const realToken = process.env.TURBOLLM_ANDROID_SDK_TOKEN
  process.env.TURBOLLM_ANDROID_SDK_TOKEN = 'sdk-process-token'
  t.after(() => {
    if (realToken === undefined) delete process.env.TURBOLLM_ANDROID_SDK_TOKEN
    else process.env.TURBOLLM_ANDROID_SDK_TOKEN = realToken
  })
  assert.equal(await authorizationSentTo('turbollm-sdk'), 'Bearer sdk-process-token')
  assert.equal(await authorizationSentTo('llama-server'), null)
})
