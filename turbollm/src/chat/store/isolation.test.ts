// Adversarial scope isolation (spec 27 §13). Two tenants with DELIBERATELY overlapping
// owner ids, randomized interleaved operations, then an exhaustive cross-check: no scope
// may ever observe another scope's row through ANY read path.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../db.js'
import type { Scope } from './types.js'

// Deterministic PRNG so a failure is reproducible from the seed in the assertion message.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 }
}

test('no scope can observe another scope rows under randomized interleaving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-isolation-'))
  const conv = new ConversationStore(dir)
  const store = conv.chatStore
  try {
    // Overlapping owner ids across tenants is the trap: scoping by owner alone would pass.
    const scopes: Scope[] = [
      { tenant: 'acme', owner: 'u1' },
      { tenant: 'acme', owner: 'u2' },
      { tenant: 'globex', owner: 'u1' },
      { tenant: 'globex', owner: 'u2' },
    ]
    const seed = 20260818
    const rand = rng(seed)
    const owned = new Map<string, string[]>(scopes.map((s) => [`${s.tenant}/${s.owner}`, []]))

    for (let i = 0; i < 120; i++) {
      const s = scopes[Math.floor(rand() * scopes.length)]
      const key = `${s.tenant}/${s.owner}`
      const mine = owned.get(key)!
      if (mine.length === 0 || rand() < 0.4) {
        const c = await store.createChat(s, { title: `c${i}` })
        mine.push(c.id)
        await store.addMessage(s, c.id, { role: 'user', content: `m${i}` })
      } else {
        const id = mine[Math.floor(rand() * mine.length)]
        if (rand() < 0.5) await store.updateChat(s, id, { title: `t${i}` })
        else await store.addMessage(s, id, { role: 'assistant', content: `m${i}` })
      }
    }

    for (const viewer of scopes) {
      const visible = new Set((await store.listChats(viewer, { limit: 200 })).data.map((c) => c.id))
      const ownIds = new Set(owned.get(`${viewer.tenant}/${viewer.owner}`)!)

      for (const id of visible) {
        assert.ok(ownIds.has(id), `seed ${seed}: ${viewer.tenant}/${viewer.owner} listed foreign chat ${id}`)
      }
      for (const [key, ids] of owned) {
        if (key === `${viewer.tenant}/${viewer.owner}`) continue
        for (const id of ids) {
          assert.equal(await store.getChat(viewer, id), null,
            `seed ${seed}: ${viewer.tenant}/${viewer.owner} read foreign chat ${id}`)
          assert.equal(await store.deleteChat(viewer, id), false,
            `seed ${seed}: ${viewer.tenant}/${viewer.owner} deleted foreign chat ${id}`)
        }
      }
    }

    // Every chat created is still owned by exactly one scope — nothing was lost or leaked.
    const total = [...owned.values()].reduce((n, ids) => n + ids.length, 0)
    let counted = 0
    for (const s of scopes) counted += (await store.listChats(s, { limit: 200 })).data.length
    assert.equal(counted, total, `seed ${seed}: chats went missing across scopes`)
  } finally {
    conv.close(); rmSync(dir, { recursive: true, force: true })
  }
})
