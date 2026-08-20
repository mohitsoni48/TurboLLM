// Tests for the BranchingStore + FolderStore capability groups (spec 27 §4.2), mixed
// into SqliteChatStore by ./capabilities.ts. SqliteChatStore has declared
// `branching: true, folders: true` since Phase 1 Task 3 — these tests close the gap
// between that declaration and an actual implementation.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../db.js'

const S = { tenant: 'acme', owner: 'u1' }

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-caps-'))
  const conv = new ConversationStore(dir)
  return { conv, store: conv.chatStore, cleanup: () => { conv.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('folders: create, list, rename, delete, and move a chat', async () => {
  const { store, cleanup } = make()
  try {
    const f = await store.createFolder(S, 'Work')
    assert.equal(f.name, 'Work')
    assert.equal((await store.listFolders(S)).length, 1)

    assert.equal(await store.renameFolder(S, f.id, 'Clients'), true)
    assert.equal((await store.getFolder(S, f.id))?.name, 'Clients')

    const c = await store.createChat(S, { title: 'Filed' })
    assert.equal(await store.moveChatToFolder(S, c.id, f.id), true)

    // Deleting a folder UNASSIGNS its chats rather than cascading — the guarantee
    // folders.test.ts pins for the UI path, and it must hold here identically.
    assert.equal(await store.deleteFolder(S, f.id), true)
    assert.equal((await store.getChat(S, c.id))?.title, 'Filed')
  } finally {
    cleanup()
  }
})

test('branching: variants share a group and only one is active', async () => {
  const { store, cleanup } = make()
  try {
    const c = await store.createChat(S, { title: 'Branch' })
    await store.addMessage(S, c.id, { role: 'user', content: 'q' })
    const first = await store.addMessage(S, c.id, { role: 'assistant', content: 'answer one' })

    assert.equal(await store.deactivateMessage(S, first.id), true)
    const second = await store.addMessage(S, c.id, { role: 'assistant', content: 'answer two' })

    const listed = (await store.listMessages(S, c.id, {})).data.map((m) => m.content)
    assert.ok(!listed.includes('answer one'))
    assert.ok(listed.includes('answer two'))

    assert.equal(await store.setActiveVariant(S, first.id), true)
    const after = (await store.listMessages(S, c.id, {})).data.map((m) => m.content)
    assert.ok(after.includes('answer one'))
    assert.ok(!after.includes('answer two'), 'activating a sibling deactivates the others')
    assert.ok(second.id)
  } finally {
    cleanup()
  }
})

test('branching: deactivateMessagesFrom and reactivateMessagesFrom are inverses', async () => {
  const { store, cleanup } = make()
  try {
    const c = await store.createChat(S, { title: 'Tail' })
    await store.addMessage(S, c.id, { role: 'user', content: 'a' })
    const cut = await store.addMessage(S, c.id, { role: 'assistant', content: 'b' })
    await store.addMessage(S, c.id, { role: 'user', content: 'c' })

    const off = await store.deactivateMessagesFrom(S, c.id, cut.id)
    assert.equal(off, 2)
    assert.deepEqual((await store.listMessages(S, c.id, {})).data.map((m) => m.content), ['a'])

    const on = await store.reactivateMessagesFrom(S, c.id, cut.id)
    assert.equal(on, 2)
    assert.deepEqual((await store.listMessages(S, c.id, {})).data.map((m) => m.content), ['a', 'b', 'c'])
  } finally {
    cleanup()
  }
})

test('capability methods are scoped like everything else', async () => {
  const { store, cleanup } = make()
  try {
    const f = await store.createFolder(S, 'Private')
    const other = { tenant: 'globex', owner: 'u1' }
    assert.equal(await store.getFolder(other, f.id), null)
    assert.equal((await store.listFolders(other)).length, 0)
    assert.equal(await store.deleteFolder(other, f.id), false)
  } finally {
    cleanup()
  }
})

test('moveChatToFolder rejects a folder id that does not exist in the caller\'s scope', async () => {
  const { conv, store, cleanup } = make()
  try {
    const other = { tenant: 'globex', owner: 'u1' }
    const foreignFolder = await store.createFolder(other, 'Their folder')
    const c = await store.createChat(S, { title: 'Mine' })

    const folderIdOf = () => (conv.handle.prepare('SELECT folder_id FROM conversations WHERE id = ?').get(c.id) as { folder_id: string | null }).folder_id

    // A folder from a different tenant must be rejected, not silently written.
    assert.equal(await store.moveChatToFolder(S, c.id, foreignFolder.id), false)
    assert.equal(folderIdOf(), null)

    // A folder id that does not exist anywhere must be rejected too.
    assert.equal(await store.moveChatToFolder(S, c.id, 'does-not-exist'), false)
    assert.equal(folderIdOf(), null)
  } finally {
    cleanup()
  }
})
