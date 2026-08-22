// Startup composition (spec 27 §4.5): a broken adapter must ABORT, never degrade to
// SQLite — the daemon coming up "fine" while writing an integrator's data to the wrong
// database is the failure mode this test exists to prevent.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../db.js'
import { buildChatStore } from './startup.js'

test('with kind sqlite the router serves the local tenant and refuses others', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-startup-'))
  const conv = new ConversationStore(dir)
  try {
    const router = await buildChatStore({ kind: 'sqlite' }, conv.chatStore, dir)
    const c = await router.createChat({ tenant: 'local', owner: 'default' }, { title: 'ok' })
    assert.equal(c.title, 'ok')
    await assert.rejects(() => router.createChat({ tenant: 'acme', owner: 'u1' }, { title: 'x' }), /not_supported/)
  } finally {
    conv.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('a broken adapter aborts startup instead of silently degrading to sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-startup-bad-'))
  const conv = new ConversationStore(dir)
  const bad = join(dir, 'broken.mjs')
  writeFileSync(bad, 'throw new Error("boom")\n')
  try {
    await assert.rejects(
      () => buildChatStore({ kind: 'module', specifier: bad }, conv.chatStore, dir),
      /chat-store adapter/i,
    )
  } finally {
    conv.close(); rmSync(dir, { recursive: true, force: true })
  }
})
