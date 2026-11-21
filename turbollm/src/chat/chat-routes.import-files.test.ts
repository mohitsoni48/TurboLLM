// An imported chat brings no files (chat-export.ts withoutFileRefs, GitHub #52). A .turbollm-chat.json is a file anyone
// can write, and the tool calls it carries were stored as they came, so a run_python call's `files` could name an image
// of another chat in the attachment store: shown on the imported chat's card, and later handed to its sandbox.
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
  const dir = tmpDir('tllm-chat-import-files-')
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
  const send = (body: unknown) =>
    app.request('/api/v1/conversations/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { store, send, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const OTHER_CHATS_IMAGE = `attachment:${'b'.repeat(64)}.png`

test('import leaves out the file references in tool calls and skips entries that are not objects', async () => {
  const h = harness()
  try {
    const res = await h.send({
      format: 'export', chat_id: 'c-old', title: 'Imported', model: '',
      messages: [
        { role: 'user', content: 'Plot it' },
        {
          role: 'assistant', content: 'Done',
          tool_calls: [{ id: 't1', name: 'run_python', args: { code: 'plot()' }, result: 'ok', files: [OTHER_CHATS_IMAGE] }, null, 7, ['x']],
        },
      ],
    })
    assert.equal(res.status, 201, await res.clone().text())
    const { id } = (await res.json()) as { id: string }
    const messages = h.store.getConversation(id, true)!.messages ?? []
    const reply = messages.find((m) => m.role === 'assistant')!
    assert.deepEqual(reply.toolCalls, [{ id: 't1', name: 'run_python', args: { code: 'plot()' }, result: 'ok' }])
    assert.ok(!JSON.stringify(messages).includes(OTHER_CHATS_IMAGE), 'no row names the other chat\'s file')
  } finally {
    h.cleanup()
  }
})
