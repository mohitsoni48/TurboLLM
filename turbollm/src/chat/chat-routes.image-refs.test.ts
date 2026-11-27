// A message's `images` take a stored reference only when it names an image (attachments.ts isImageAttachmentRef). The
// store is about to keep files made for download too (GitHub #52): a CSV named in `images` would be saved on the user
// row and sent to the engine as a picture. Refused before anything is stored.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ChatRuns } from './chat-runs.js'
import { ChatTurns } from './chat-turns.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'

function harness() {
  const dir = tmpDir('tllm-chat-image-refs-')
  const store = new ConversationStore(dir)
  const cfg = {
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: {}, autoAllowAll: false },
  }
  const d = {
    chatTurns: new ChatTurns(), chatRuns: new ChatRuns(),
    db: store,
    store: { snapshot: () => cfg, read: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dir },
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  return { app, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('POST /messages refuses a stored reference in images that is not an image, and stores nothing', async () => {
  const h = harness()
  try {
    const conv = h.store.createConversation({ title: 't', modelKey: '' })
    const hex = 'e'.repeat(64)
    for (const bad of [`attachment:${hex}.csv`, `attachment:${hex}.json`, `attachment:${hex}`, 'attachment:../turbollm.db']) {
      const res = await h.app.request(`/api/v1/conversations/${conv.id}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hi', images: [bad] }),
      })
      assert.equal(res.status, 400, `${bad}: ${await res.clone().text()}`)
      assert.deepEqual(await res.json(), { error: { code: 'invalid_input', message: 'Only images go in images.' } }, bad)
    }
    assert.equal(h.store.getConversation(conv.id, true)!.messages?.length ?? 0, 0, 'no message was stored')
  } finally {
    h.cleanup()
  }
})
