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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db.js'
import { ChatStoreRouter } from '../chat/store/router.js'
import { loadFullHistory } from './generation.js'

const SCOPE = { tenant: 'acme', owner: 'u1' }

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-ext-gen-'))
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
