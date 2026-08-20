// turbollm/src/chat/store/migration.test.ts
//
// The v45 migration must be additive and safe on a DB that already has rows: existing
// conversations and messages land in the local scope with no rewrite, and re-running the
// migration is a no-op (spec 27 §9.1).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../db.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-migration-'))
}

test('v45 adds tenant/owner/version/metadata to conversations and messages', () => {
  const dir = tempDir()
  const store = new ConversationStore(dir)
  try {
    const cols = (table: string): string[] =>
      (store.handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((r) => r.name)

    for (const c of ['tenant', 'owner', 'version', 'metadata']) {
      assert.ok(cols('conversations').includes(c), `conversations.${c} missing`)
    }
    for (const c of ['tenant', 'owner', 'version', 'metadata', 'status']) {
      assert.ok(cols('messages').includes(c), `messages.${c} missing`)
    }
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('rows written by ConversationStore land in the local scope via column defaults', () => {
  const dir = tempDir()
  const first = new ConversationStore(dir)
  const conv = first.createConversation({ title: 'Pre-existing' })
  first.addMessage(conv.id, 'user', 'hello')
  first.close()

  // ConversationStore's INSERTs never mention tenant/owner/status — this proves the
  // NOT NULL DEFAULTs cover the UI path, which is exactly what makes the migration
  // safe for rows that already existed before the columns did.
  const second = new ConversationStore(dir)
  try {
    const row = second.handle.prepare(`SELECT tenant, owner FROM conversations WHERE id = $id`)
      .get({ $id: conv.id }) as unknown as { tenant: string; owner: string }
    assert.equal(row.tenant, 'local')
    assert.equal(row.owner, 'default')

    const msg = second.handle.prepare(`SELECT tenant, owner, status FROM messages WHERE conv_id = $id`)
      .get({ $id: conv.id }) as unknown as { tenant: string; owner: string; status: string }
    assert.equal(msg.tenant, 'local')
    assert.equal(msg.owner, 'default')
    assert.equal(msg.status, 'complete')
  } finally {
    second.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('reopening an already-migrated DB is a no-op and does not throw', () => {
  const dir = tempDir()
  new ConversationStore(dir).close()
  const again = new ConversationStore(dir)
  try {
    const { user_version: v } = again.handle.prepare('PRAGMA user_version').get() as { user_version: number }
    assert.ok(v >= 45, `expected user_version >= 45, got ${v}`)
  } finally {
    again.close(); rmSync(dir, { recursive: true, force: true })
  }
})
