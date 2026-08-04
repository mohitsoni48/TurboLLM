import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'
import { registerCodeRoutes } from './code-routes'
import { CodeRunManager } from './code-run-manager'
import type { Deps } from '../deps'

class CountingCodeRunManager extends CodeRunManager {
  reconcileCount = 0
  reconcileOnStartup(): void {
    this.reconcileCount++
    super.reconcileOnStartup()
  }
}

test('registerCodeRoutes uses an injected CodeRunManager, reconciled exactly once', () => {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'code-routes-reuse-test-')))
  const d = { db } as unknown as Deps
  const injected = new CountingCodeRunManager(d)
  const app = new Hono()

  registerCodeRoutes(app, d, injected)

  assert.equal(injected.reconcileCount, 1)
})

test('registerCodeRoutes still constructs its own instance when none is injected (unchanged default)', () => {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'code-routes-reuse-default-test-')))
  const d = { db } as unknown as Deps
  const app = new Hono()
  // Must not throw — the pre-existing no-arg call shape (every current call site) still works.
  assert.doesNotThrow(() => registerCodeRoutes(app, d))
})
