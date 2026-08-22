// Adapter conformance suite (spec 27 §13). Any ChatStore implementation must pass this
// unmodified. It is deliberately written against the INTERFACE only — it may not import
// SqliteChatStore, node:sqlite, or anything else backend-specific.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOCAL_SCOPE, type ChatStore } from './chat-store.js'

export interface Harness { store: ChatStore; cleanup: () => void }

export function runConformanceSuite(name: string, factory: () => Promise<Harness>): void {
  const withStore = async (fn: (s: ChatStore) => Promise<void>): Promise<void> => {
    const h = await factory()
    try { await fn(h.store) } finally { h.cleanup() }
  }

  test(`[${name}] declares a capabilities object`, async () => {
    await withStore(async (s) => {
      assert.equal(typeof s.capabilities, 'object')
      assert.notEqual(s.capabilities, null)
    })
  })

  test(`[${name}] health() reports ok on a live store`, async () => {
    await withStore(async (s) => {
      assert.equal((await s.health()).ok, true)
    })
  })

  test(`[${name}] createChat then getChat round-trips every core field`, async () => {
    await withStore(async (s) => {
      const made = await s.createChat(LOCAL_SCOPE, {
        title: 'Round trip', model: 'm1', systemPrompt: 'be terse',
        sampling: { temperature: 0.4 },
      })
      const got = await s.getChat(LOCAL_SCOPE, made.id)
      assert.equal(got?.title, 'Round trip')
      assert.equal(got?.model, 'm1')
      assert.equal(got?.systemPrompt, 'be terse')
      assert.equal((got?.sampling as { temperature?: number }).temperature, 0.4)
    })
  })

  test(`[${name}] getChat returns null for an unknown id, never throws`, async () => {
    await withStore(async (s) => {
      assert.equal(await s.getChat(LOCAL_SCOPE, 'definitely-not-a-real-id'), null)
    })
  })

  test(`[${name}] seq is allocated atomically: 20 concurrent appends are gapless and distinct`, async () => {
    await withStore(async (s) => {
      const c = await s.createChat(LOCAL_SCOPE, { title: 'Concurrency' })
      const made = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          s.addMessage(LOCAL_SCOPE, c.id, { role: 'user', content: `m${i}` })),
      )
      const seqs = made.map((m) => m.seq).sort((a, b) => a - b)
      assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1))
    })
  })

  test(`[${name}] addMessage maintains messageCount and lastMessageAt`, async () => {
    await withStore(async (s) => {
      const c = await s.createChat(LOCAL_SCOPE, { title: 'Counters' })
      assert.equal(c.messageCount, 0)
      await s.addMessage(LOCAL_SCOPE, c.id, { role: 'user', content: 'x' })
      await s.addMessage(LOCAL_SCOPE, c.id, { role: 'assistant', content: 'y' })
      const after = await s.getChat(LOCAL_SCOPE, c.id)
      assert.equal(after?.messageCount, 2)
      assert.ok(after?.lastMessageAt)
    })
  })

  test(`[${name}] listMessages pages in seq order with no gaps or repeats`, async () => {
    await withStore(async (s) => {
      const c = await s.createChat(LOCAL_SCOPE, { title: 'Paging' })
      for (let i = 0; i < 7; i++) await s.addMessage(LOCAL_SCOPE, c.id, { role: 'user', content: `m${i}` })

      const seen: number[] = []
      let cursor: string | null | undefined
      do {
        const page = await s.listMessages(LOCAL_SCOPE, c.id, { limit: 3, cursor: cursor ?? undefined })
        seen.push(...page.data.map((m) => m.seq))
        cursor = page.nextCursor
      } while (cursor)

      assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7])
    })
  })

  test(`[${name}] a malformed cursor is rejected, never silently treated as page one`, async () => {
    await withStore(async (s) => {
      const c = await s.createChat(LOCAL_SCOPE, { title: 'Bad cursor' })
      await assert.rejects(() => s.listMessages(LOCAL_SCOPE, c.id, { cursor: '!!!not-a-cursor!!!' }))
    })
  })

  test(`[${name}] updateMessage with a stale ifVersion rejects instead of clobbering`, async () => {
    await withStore(async (s) => {
      const c = await s.createChat(LOCAL_SCOPE, { title: 'Versioned' })
      const m = await s.addMessage(LOCAL_SCOPE, c.id, { role: 'user', content: 'original' })
      await assert.rejects(() => s.updateMessage(LOCAL_SCOPE, m.id, { content: 'clobber' }, m.version - 1000))
      assert.equal((await s.getMessage(LOCAL_SCOPE, m.id))?.content, 'original')
    })
  })

  test(`[${name}] deleteChat removes its messages too`, async () => {
    await withStore(async (s) => {
      const c = await s.createChat(LOCAL_SCOPE, { title: 'Cascade' })
      const m = await s.addMessage(LOCAL_SCOPE, c.id, { role: 'user', content: 'x' })
      assert.equal(await s.deleteChat(LOCAL_SCOPE, c.id), true)
      assert.equal(await s.getChat(LOCAL_SCOPE, c.id), null)
      assert.equal(await s.getMessage(LOCAL_SCOPE, m.id), null)
    })
  })

  test(`[${name}] deleting a nonexistent chat returns false rather than throwing`, async () => {
    await withStore(async (s) => {
      assert.equal(await s.deleteChat(LOCAL_SCOPE, 'never-existed'), false)
    })
  })

  test(`[${name}] if search is declared, listChats filters by title`, async () => {
    await withStore(async (s) => {
      if (!s.capabilities.search) return
      await s.createChat(LOCAL_SCOPE, { title: 'Quarterly analysis' })
      await s.createChat(LOCAL_SCOPE, { title: 'Grocery list' })
      const hits = await s.listChats(LOCAL_SCOPE, { q: 'Quarterly' })
      assert.equal(hits.data.length, 1)
      assert.equal(hits.data[0].title, 'Quarterly analysis')
    })
  })
}
