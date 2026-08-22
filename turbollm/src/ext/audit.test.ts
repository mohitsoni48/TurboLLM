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
    const rows = audit.list('acme', 'u1', {})
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
    assert.equal(audit.list('acme', 'u1', {}).length, 1)
    assert.equal(audit.list('globex', 'u1', {})[0].targetId, 'c2')
  } finally {
    cleanup()
  }
})

// Final-review security recheck: audit.list() had no owner parameter at all — the one read on
// this whole surface that broke the otherwise-universal tenant+owner scoping convention,
// live-reproduced as a real cross-owner leak (an audited owner's identity + real resource ids,
// chaining with the caller-supplied-owner design into full cross-owner content disclosure via
// the ordinary chat/message read routes). Mirrors the tenant-scoping test above, but for owner
// within the SAME tenant, which is the dimension that was actually missing.
test('the log is owner-scoped within a tenant, not just tenant-scoped', () => {
  const { audit, cleanup } = make()
  try {
    audit.record({ tenant: 'acme', owner: 'owner-a', action: 'chat.create', targetId: 'chat-a', requestId: 'r1', status: 201, keyPrefix: 'k' })
    audit.record({ tenant: 'acme', owner: 'owner-b', action: 'chat.create', targetId: 'chat-b', requestId: 'r2', status: 201, keyPrefix: 'k' })
    const asOwnerA = audit.list('acme', 'owner-a', {})
    assert.equal(asOwnerA.length, 1)
    assert.equal(asOwnerA[0].targetId, 'chat-a')
    assert.equal(asOwnerA[0].owner, 'owner-a')
    const asOwnerB = audit.list('acme', 'owner-b', {})
    assert.equal(asOwnerB.length, 1)
    assert.equal(asOwnerB[0].targetId, 'chat-b')
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

// Release-gate I3: list() bound `opts.limit ?? 200` straight into the SQL LIMIT clause with no
// clamp — a NaN (from the route layer's `Number('abc')`) or a valid-but-huge limit both reached
// SQLite unchecked. This is the defense-in-depth half of the fix (the route now also validates
// before calling in); list() itself must be safe against ANY caller, not just the one route.
test('list() sanitizes an invalid limit instead of forwarding it to SQLite', () => {
  const { audit, cleanup } = make()
  try {
    audit.record({ tenant: 'acme', owner: 'u1', action: 'chat.create', targetId: 'c1', requestId: 'r1', status: 201, keyPrefix: 'k' })
    assert.doesNotThrow(() => audit.list('acme', 'u1', { limit: NaN }))
    assert.doesNotThrow(() => audit.list('acme', 'u1', { limit: -5 }))
    assert.doesNotThrow(() => audit.list('acme', 'u1', { limit: 0 }))
    assert.equal(audit.list('acme', 'u1', { limit: NaN }).length, 1)
  } finally {
    cleanup()
  }
})

test('list() clamps an oversized limit to the same 200-row cap GET /capabilities advertises', () => {
  const { audit, cleanup } = make()
  try {
    for (let i = 0; i < 205; i++) {
      audit.record({ tenant: 'acme', owner: 'u1', action: 'chat.create', targetId: `c${i}`, requestId: `r${i}`, status: 201, keyPrefix: 'k' })
    }
    const rows = audit.list('acme', 'u1', { limit: 1_000_000 })
    assert.equal(rows.length, 200, 'a huge limit must be clamped, not honored outright')
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
    const rows = audit.list('acme', 'u1', {})
    assert.equal(rows.length, 1)
    assert.equal(rows[0].targetId, 'c2')
  } finally {
    cleanup()
  }
})
