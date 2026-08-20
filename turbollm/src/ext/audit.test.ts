// turbollm/src/ext/audit.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db.js'
import { AuditLog } from './audit.js'

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-audit-'))
  const db = new ConversationStore(dir)
  return { audit: new AuditLog(db), db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('a mutation is recorded with actor, action, target and request id', () => {
  const { audit, cleanup } = make()
  try {
    audit.record({
      tenant: 'acme', owner: 'u1', action: 'chat.create', targetId: 'chat_1',
      requestId: 'req_1', status: 201, keyPrefix: 'tllm-ext',
    })
    const rows = audit.list('acme', {})
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, 'chat.create')
    assert.equal(rows[0].targetId, 'chat_1')
    assert.equal(rows[0].requestId, 'req_1')
    assert.ok(rows[0].at)
  } finally {
    cleanup()
  }
})

test('the log is tenant-scoped', () => {
  const { audit, cleanup } = make()
  try {
    audit.record({ tenant: 'acme', owner: 'u1', action: 'chat.delete', targetId: 'c1', requestId: 'r1', status: 204, keyPrefix: 'k' })
    audit.record({ tenant: 'globex', owner: 'u1', action: 'chat.delete', targetId: 'c2', requestId: 'r2', status: 204, keyPrefix: 'k' })
    assert.equal(audit.list('acme', {}).length, 1)
    assert.equal(audit.list('globex', {})[0].targetId, 'c2')
  } finally {
    cleanup()
  }
})

test('message CONTENT is never written to the audit log', () => {
  const { audit, db, cleanup } = make()
  try {
    audit.record({
      tenant: 'acme', owner: 'u1', action: 'message.create', targetId: 'msg_1',
      requestId: 'r1', status: 201, keyPrefix: 'k',
    })
    // An audit trail records THAT something happened, never what was said — otherwise it
    // becomes a second, unscoped copy of every conversation.
    const raw = db.handle.prepare('SELECT * FROM ext_audit').all() as Array<Record<string, unknown>>
    const serialized = JSON.stringify(raw)
    assert.ok(!serialized.includes('content'), 'no content column may exist')
  } finally {
    cleanup()
  }
})

test('reads are not audited, only mutations', () => {
  const { audit, cleanup } = make()
  try {
    assert.equal(audit.shouldAudit('GET'), false)
    assert.equal(audit.shouldAudit('POST'), true)
    assert.equal(audit.shouldAudit('PATCH'), true)
    assert.equal(audit.shouldAudit('DELETE'), true)
  } finally {
    cleanup()
  }
})

test('prune drops entries older than the retention window', () => {
  const { audit, db, cleanup } = make()
  try {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
    db.handle.prepare(`INSERT INTO ext_audit (id,tenant,owner,action,target_id,request_id,status,key_prefix,at) VALUES ('a','acme','u1','chat.create','c1','r1',201,'k',$at)`).run({ $at: old })
    audit.record({ tenant: 'acme', owner: 'u1', action: 'chat.create', targetId: 'c2', requestId: 'r2', status: 201, keyPrefix: 'k' })
    audit.prune(30)
    const rows = audit.list('acme', {})
    assert.equal(rows.length, 1)
    assert.equal(rows[0].targetId, 'c2')
  } finally {
    cleanup()
  }
})
