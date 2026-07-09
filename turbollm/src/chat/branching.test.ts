// Chat branching (GitHub #52 item 2): regenerate used to delete the previous reply
// outright. Now it's deactivated and kept as a sibling — these tests exercise the
// db-layer primitives (deactivateMessage / getMessageVariants / setActiveVariant)
// directly against a real sqlite instance, the same way scan.test.ts covers findFile.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from './db.js'

function tempStore(): { store: ConversationStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-branch-'))
  return { store: new ConversationStore(dir), dir }
}

test('a fresh message has no variant group and is active', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const msg = store.addMessage(conv.id, 'assistant', 'hello')
    assert.equal(msg.variantGroup, null)
    assert.equal(msg.isActive, true)
    assert.deepEqual(store.getMessages(conv.id).map((m) => m.id), [msg.id])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deactivateMessage hides it from getMessages but keeps the row (not deleted)', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    store.addMessage(conv.id, 'user', 'question')
    const reply = store.addMessage(conv.id, 'assistant', 'first answer')
    store.deactivateMessage(reply.id)

    assert.equal(store.getMessages(conv.id).some((m) => m.id === reply.id), false, 'deactivated message should not appear in the active list')
    const stillThere = store.getMessage(reply.id)
    assert.ok(stillThere, 'row must still exist — deactivate, not delete')
    assert.equal(stillThere!.isActive, false)
    assert.equal(stillThere!.variantGroup, reply.id, 'first deactivation establishes the group as its own id')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deactivateMessage is idempotent about variant_group on repeated regenerations', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const first = store.addMessage(conv.id, 'assistant', 'v1')
    store.deactivateMessage(first.id)
    const groupId = store.getMessage(first.id)!.variantGroup

    const second = store.addMessage(conv.id, 'assistant', 'v2', { variantGroup: groupId! })
    store.deactivateMessage(second.id)

    // Deactivating a message that ALREADY has a variant_group must not overwrite it
    // with its own id — COALESCE should preserve the original group across the chain.
    assert.equal(store.getMessage(second.id)!.variantGroup, groupId)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getLastMessageAnyStatus sees a deactivated tail message that getLastMessage (active-only) skips', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const user = store.addMessage(conv.id, 'user', 'question')
    const reply = store.addMessage(conv.id, 'assistant', 'first answer')
    store.deactivateMessage(reply.id)

    assert.equal(store.getLastMessage(conv.id)!.id, user.id, 'active-only view should now end at the user turn')
    assert.equal(store.getLastMessageAnyStatus(conv.id)!.id, reply.id, 'any-status view still finds the deactivated reply')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getNextMessageAfterSeq finds the specific message regenerate just deactivated, not an unrelated later branch (regression)', () => {
  // Live-verification bug found in QA: a conversation with more than one branch point
  // had /continue join a fresh regenerated reply to the WRONG variant group, because it
  // used to look for "whatever has the globally highest seq" instead of "the message
  // immediately after the current active tail." A later, unrelated branch's messages
  // (created after the one being regenerated, but on a different — currently inactive —
  // branch) have a higher seq and were incorrectly picked up instead.
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const a = store.addMessage(conv.id, 'user', 'A')
    const b = store.addMessage(conv.id, 'assistant', 'B') // the reply about to be "regenerated"

    // Build an entirely separate, LATER branch by editing an earlier point (simulating
    // the real editMessage flow) so its messages get a higher seq than B.
    store.freezeTail(conv.id, a.seq, a.id)
    store.deactivateMessage(a.id)
    const aGroup = store.getMessage(a.id)!.variantGroup!
    store.addMessage(conv.id, 'user', 'A2', { variantGroup: aGroup })
    const laterBranchReply = store.addMessage(conv.id, 'assistant', 'reply in the unrelated later branch')
    store.deactivateMessage(laterBranchReply.id) // now inactive, higher seq than B, role assistant — exactly what a naive "highest seq" query would wrongly grab

    // Switch back to the original A/B branch — B is active again.
    store.restoreTail(a.id)
    store.setActiveVariant(aGroup, a.id)
    assert.deepEqual(store.getMessages(conv.id).map((m) => m.id), [a.id, b.id])

    // Simulate /regenerate: deactivate B (the CURRENT active reply).
    store.deactivateMessage(b.id)

    // This is the fix under test: must resolve to B specifically, not laterBranchReply.
    const lastActiveUser = store.getLastMessage(conv.id)! // now resolves to `a` (B just got deactivated)
    const found = store.getNextMessageAfterSeq(conv.id, lastActiveUser.seq)
    assert.equal(found!.id, b.id, 'must find B (the message actually being regenerated), not the unrelated later branch reply')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getMessageVariants returns every sibling, active and inactive, oldest first', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const v1 = store.addMessage(conv.id, 'assistant', 'v1')
    store.deactivateMessage(v1.id)
    const groupId = store.getMessage(v1.id)!.variantGroup!
    const v2 = store.addMessage(conv.id, 'assistant', 'v2', { variantGroup: groupId })
    store.deactivateMessage(v2.id)
    const v3 = store.addMessage(conv.id, 'assistant', 'v3', { variantGroup: groupId })

    const variants = store.getMessageVariants(groupId)
    assert.deepEqual(variants.map((m) => m.id), [v1.id, v2.id, v3.id])
    assert.deepEqual(variants.map((m) => m.isActive), [false, false, true])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setActiveVariant switches which sibling is active and shown by getMessages', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const v1 = store.addMessage(conv.id, 'assistant', 'v1')
    store.deactivateMessage(v1.id)
    const groupId = store.getMessage(v1.id)!.variantGroup!
    const v2 = store.addMessage(conv.id, 'assistant', 'v2', { variantGroup: groupId }) // active by default

    assert.deepEqual(store.getMessages(conv.id).map((m) => m.id), [v2.id])

    const ok = store.setActiveVariant(groupId, v1.id)
    assert.equal(ok, true)
    assert.deepEqual(store.getMessages(conv.id).map((m) => m.id), [v1.id], 'switching back to v1 should hide v2')
    assert.equal(store.getMessage(v2.id)!.isActive, false)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setActiveVariant returns false for a message that is not a member of the group', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const v1 = store.addMessage(conv.id, 'assistant', 'v1')
    store.deactivateMessage(v1.id)
    const groupId = store.getMessage(v1.id)!.variantGroup!
    const unrelated = store.addMessage(conv.id, 'assistant', 'unrelated, different turn entirely')

    const ok = store.setActiveVariant(groupId, unrelated.id)
    assert.equal(ok, false)
    // Nothing should have changed — the unrelated message wasn't touched.
    assert.equal(store.getMessage(unrelated.id)!.isActive, true)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a never-regenerated message keeps variantGroup null forever (no branch UI for plain messages)', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    store.addMessage(conv.id, 'user', 'question')
    const reply = store.addMessage(conv.id, 'assistant', 'only answer, never regenerated')
    assert.equal(store.getMessage(reply.id)!.variantGroup, null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── User-message edit branching (freezeTail / restoreTail) ────────────────────

test('freezeTail deactivates everything after a seq and tags it with the anchor, leaving earlier messages untouched', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const a = store.addMessage(conv.id, 'user', 'A')
    const b = store.addMessage(conv.id, 'assistant', 'B')
    const c = store.addMessage(conv.id, 'user', 'C')

    store.freezeTail(conv.id, a.seq, a.id)

    assert.equal(store.getMessage(a.id)!.isActive, true, 'the anchor message itself is untouched by freezeTail — caller deactivates it separately')
    assert.equal(store.getMessage(b.id)!.isActive, false)
    assert.equal(store.getMessage(b.id)!.branchOf, a.id)
    assert.equal(store.getMessage(c.id)!.isActive, false)
    assert.equal(store.getMessage(c.id)!.branchOf, a.id)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restoreTail reactivates only messages tagged with that specific anchor', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const a = store.addMessage(conv.id, 'user', 'A')
    const b = store.addMessage(conv.id, 'assistant', 'B')
    store.freezeTail(conv.id, a.seq, a.id)

    // An unrelated message frozen under a DIFFERENT anchor must not come back.
    const other = store.addMessage(conv.id, 'assistant', 'unrelated')
    store.freezeTail(conv.id, other.seq - 1, 'some-other-anchor-id')

    store.restoreTail(a.id)
    assert.equal(store.getMessage(b.id)!.isActive, true)
    assert.equal(store.getMessage(other.id)!.isActive, false, 'restoring anchor A must not reactivate a message frozen under a different anchor')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('full round trip: editing an earlier user message freezes the whole downstream tail, and switching back restores it exactly', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const a = store.addMessage(conv.id, 'user', 'A original')
    const b = store.addMessage(conv.id, 'assistant', 'B')
    const c = store.addMessage(conv.id, 'user', 'C')
    const d = store.addMessage(conv.id, 'assistant', 'D')

    // Simulate the editMessage route's user-role branch: freeze tail, deactivate A,
    // add the edited replacement joined to A's variant group.
    store.freezeTail(conv.id, a.seq, a.id)
    store.deactivateMessage(a.id)
    const group = store.getMessage(a.id)!.variantGroup!
    const a2 = store.addMessage(conv.id, 'user', 'A edited', { variantGroup: group })

    assert.deepEqual(store.getMessages(conv.id).map((m) => m.id), [a2.id], 'only the edited message is active — B/C/D are frozen')

    // Continue the new branch with a fresh reply.
    const e = store.addMessage(conv.id, 'assistant', 'E, reply to the edited A')
    assert.deepEqual(store.getMessages(conv.id).map((m) => m.id), [a2.id, e.id])

    // Simulate the activate route's user-role branch: switch back to the ORIGINAL A.
    const currentActive = store.getMessageVariants(group).find((v) => v.isActive)!
    assert.equal(currentActive.id, a2.id)
    store.freezeTail(conv.id, currentActive.seq, currentActive.id) // freezes [e] under a2.id
    store.restoreTail(a.id) // restores [b, c, d]
    store.setActiveVariant(group, a.id)

    assert.deepEqual(store.getMessages(conv.id).map((m) => m.id), [a.id, b.id, c.id, d.id], 'switching back to A restores exactly the original conversation')

    // And switching forward again restores the edited branch, not a blank slate.
    store.freezeTail(conv.id, a.seq, a.id) // freezes [b, c, d] under a.id again
    store.restoreTail(a2.id) // restores [e]
    store.setActiveVariant(group, a2.id)

    assert.deepEqual(store.getMessages(conv.id).map((m) => m.id), [a2.id, e.id], 'switching forward restores the edited branch\'s own continuation')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a regenerated reply nested inside a frozen tail is restored as whichever sibling was active when frozen', () => {
  const { store, dir } = tempStore()
  try {
    const conv = store.createConversation()
    const a = store.addMessage(conv.id, 'user', 'A')
    const d1 = store.addMessage(conv.id, 'assistant', 'D v1')
    // Regenerate D before ever touching A — D2 becomes the active sibling.
    store.deactivateMessage(d1.id)
    const dGroup = store.getMessage(d1.id)!.variantGroup!
    const d2 = store.addMessage(conv.id, 'assistant', 'D v2', { variantGroup: dGroup })

    assert.deepEqual(store.getMessages(conv.id).map((m) => m.id), [a.id, d2.id])

    // Now edit A — freezeTail must capture D2 (whichever was active), not D1.
    store.freezeTail(conv.id, a.seq, a.id)
    store.deactivateMessage(a.id)
    const aGroup = store.getMessage(a.id)!.variantGroup!
    const a2 = store.addMessage(conv.id, 'user', 'A edited', { variantGroup: aGroup })
    assert.deepEqual(store.getMessages(conv.id).map((m) => m.id), [a2.id])

    // Switch back to the original A.
    store.restoreTail(a.id)
    store.setActiveVariant(aGroup, a.id)
    assert.deepEqual(store.getMessages(conv.id).map((m) => m.id), [a.id, d2.id], 'D2 (the active sibling at freeze time) comes back, not D1')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
