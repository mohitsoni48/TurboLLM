// Folder CRUD + membership tests (v10). Exercises the ConversationStore folder
// methods directly against a real temp-dir SQLite DB — the folder route handlers in
// chat-routes.ts are thin pass-throughs to these methods, so this covers the actual
// create / list / rename / delete / move behavior, including the critical guarantee
// that deleting a folder UNASSIGNS its member conversations (folder_id → NULL) rather
// than cascade-deleting them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from './db.js'

function makeStore(): { store: ConversationStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-folders-test-'))
  const store = new ConversationStore(dir)
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

// ── create / list ─────────────────────────────────────────────────────────────

test('createFolder returns a folder and listFolders includes it', () => {
  const { store, cleanup } = makeStore()
  try {
    const f = store.createFolder('Work')
    assert.ok(f.id)
    assert.equal(f.name, 'Work')
    assert.equal(f.sortOrder, 0)
    assert.ok(f.createdAt)
    assert.ok(f.updatedAt)
    const list = store.listFolders()
    assert.equal(list.length, 1)
    assert.equal(list[0].id, f.id)
  } finally {
    cleanup()
  }
})

test('listFolders returns folders in insertion order', () => {
  const { store, cleanup } = makeStore()
  try {
    const a = store.createFolder('Alpha')
    const b = store.createFolder('Beta')
    const c = store.createFolder('Gamma')
    const ids = store.listFolders().map((f) => f.id)
    assert.deepEqual(ids, [a.id, b.id, c.id])
  } finally {
    cleanup()
  }
})

test('listFolders is empty on a fresh store', () => {
  const { store, cleanup } = makeStore()
  try {
    assert.deepEqual(store.listFolders(), [])
  } finally {
    cleanup()
  }
})

// ── rename ─────────────────────────────────────────────────────────────────────

test('renameFolder updates the name and returns true', () => {
  const { store, cleanup } = makeStore()
  try {
    const f = store.createFolder('Old')
    assert.equal(store.renameFolder(f.id, 'New'), true)
    assert.equal(store.getFolder(f.id)?.name, 'New')
  } finally {
    cleanup()
  }
})

test('renameFolder returns false for an unknown folder', () => {
  const { store, cleanup } = makeStore()
  try {
    assert.equal(store.renameFolder('does-not-exist', 'Whatever'), false)
  } finally {
    cleanup()
  }
})

// ── move membership ─────────────────────────────────────────────────────────────

test('moveConversationToFolder files a conversation under a folder', () => {
  const { store, cleanup } = makeStore()
  try {
    const f = store.createFolder('Projects')
    const conv = store.createConversation({ title: 'C1' })
    const res = store.moveConversationToFolder(conv.id, f.id)
    assert.deepEqual(res, { ok: true })
    assert.equal(store.getConversation(conv.id)?.folderId, f.id)
  } finally {
    cleanup()
  }
})

test('moveConversationToFolder with null unassigns the conversation', () => {
  const { store, cleanup } = makeStore()
  try {
    const f = store.createFolder('Projects')
    const conv = store.createConversation({ title: 'C1', folderId: f.id })
    assert.equal(store.getConversation(conv.id)?.folderId, f.id)
    const res = store.moveConversationToFolder(conv.id, null)
    assert.deepEqual(res, { ok: true })
    assert.equal(store.getConversation(conv.id)?.folderId, null)
  } finally {
    cleanup()
  }
})

test('moveConversationToFolder rejects a non-existent target folder', () => {
  const { store, cleanup } = makeStore()
  try {
    const conv = store.createConversation({ title: 'C1' })
    const res = store.moveConversationToFolder(conv.id, 'no-such-folder')
    assert.deepEqual(res, { ok: false, reason: 'folder_not_found' })
    // Conversation stays uncategorized (unchanged).
    assert.equal(store.getConversation(conv.id)?.folderId, null)
  } finally {
    cleanup()
  }
})

test('moveConversationToFolder reports a missing conversation', () => {
  const { store, cleanup } = makeStore()
  try {
    const f = store.createFolder('Projects')
    const res = store.moveConversationToFolder('no-such-conv', f.id)
    assert.deepEqual(res, { ok: false, reason: 'conversation_not_found' })
  } finally {
    cleanup()
  }
})

// ── delete: unassign, do NOT cascade ────────────────────────────────────────────

test('deleteFolder removes the folder and returns true', () => {
  const { store, cleanup } = makeStore()
  try {
    const f = store.createFolder('Temp')
    assert.equal(store.deleteFolder(f.id), true)
    assert.equal(store.getFolder(f.id), null)
    assert.deepEqual(store.listFolders(), [])
  } finally {
    cleanup()
  }
})

test('deleteFolder returns false for an unknown folder', () => {
  const { store, cleanup } = makeStore()
  try {
    assert.equal(store.deleteFolder('nope'), false)
  } finally {
    cleanup()
  }
})

test('deleteFolder UNASSIGNS member conversations — it does NOT cascade-delete them', () => {
  const { store, cleanup } = makeStore()
  try {
    const f = store.createFolder('Doomed')
    const c1 = store.createConversation({ title: 'Keep me 1', folderId: f.id })
    const c2 = store.createConversation({ title: 'Keep me 2', folderId: f.id })
    const outside = store.createConversation({ title: 'Unrelated' })

    assert.equal(store.deleteFolder(f.id), true)

    // The conversations must still exist …
    assert.ok(store.getConversation(c1.id), 'c1 must survive folder deletion')
    assert.ok(store.getConversation(c2.id), 'c2 must survive folder deletion')
    // … and be unassigned (folder_id → NULL) …
    assert.equal(store.getConversation(c1.id)?.folderId, null)
    assert.equal(store.getConversation(c2.id)?.folderId, null)
    // … the unrelated conversation is untouched …
    assert.equal(store.getConversation(outside.id)?.folderId, null)
    // … and they still show up in the conversation list.
    const listedIds = store.listConversations().map((c) => c.id)
    assert.ok(listedIds.includes(c1.id))
    assert.ok(listedIds.includes(c2.id))
    assert.ok(listedIds.includes(outside.id))
  } finally {
    cleanup()
  }
})

// ── createConversation folderId passthrough ─────────────────────────────────────

test('createConversation persists an optional folderId', () => {
  const { store, cleanup } = makeStore()
  try {
    const f = store.createFolder('Inbox')
    const conv = store.createConversation({ title: 'Filed', folderId: f.id })
    assert.equal(conv.folderId, f.id)
    assert.equal(store.getConversation(conv.id)?.folderId, f.id)
  } finally {
    cleanup()
  }
})

test('createConversation defaults folderId to null when omitted', () => {
  const { store, cleanup } = makeStore()
  try {
    const conv = store.createConversation({ title: 'Loose' })
    assert.equal(conv.folderId, null)
  } finally {
    cleanup()
  }
})
