// The Code session delete's cleanup (code-routes.ts deleteCodeSessionWithCleanup) is one function, used by the
// DELETE route and, through Deps.deleteCodeSession, by the retention sweep (chat/retention.ts) when it prunes a
// Code routine's old runs: the session's background jobs, LSP clients and worktree go with it either way.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import { registerCodeRoutes } from './code-routes'
import type { CodeRunManager } from './code-run-manager'
import type { Deps } from '../deps'

function setup(active = new Set<string>()) {
  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const removed: Array<[string, string]> = []
  const d = { db, version: 'test', store: { snapshot: () => ({ code: { defaultAgent: 'turbollm' } }) } } as unknown as Deps
  const runs = { reconcileOnStartup: () => {}, isActive: (id: string) => active.has(id) } as unknown as CodeRunManager
  const app = new Hono()
  registerCodeRoutes(app, d, runs, {
    removeSessionWorktree: async (repoRoot, worktreePath) => { removed.push([repoRoot, worktreePath]); return { ok: true } },
  })
  const session = () => {
    const conv = db.createConversation({ kind: 'code', modelKey: 'm' })
    return db.createAgentRun({ convId: conv.id, title: 'T', allowedTools: [], repoRoot: '/work/repo', worktreePath: '/work/repo/.wt/t' })
  }
  return { db, d, app, removed, session, active }
}

test('registerCodeRoutes hands the delete cleanup to Deps.deleteCodeSession: worktree removed, session and conversation gone', async () => {
  const { db, d, removed, session } = setup()
  const run = session()
  assert.ok(d.deleteCodeSession, 'wired')
  assert.deepEqual(await d.deleteCodeSession(run.id), { deleted: true })
  assert.deepEqual(removed, [['/work/repo', '/work/repo/.wt/t']])
  assert.equal(db.getAgentRun(run.id), null)
  assert.equal(db.getConversation(run.convId), null)
  db.close()
})

test('Deps.deleteCodeSession refuses a session with an active run and reports one that is already gone', async () => {
  const active = new Set<string>()
  const { db, d, removed, session } = setup(active)
  const run = session()
  active.add(run.id)
  assert.deepEqual(await d.deleteCodeSession!(run.id), { deleted: false, reason: 'run_active' })
  assert.ok(db.getAgentRun(run.id), 'kept')
  assert.deepEqual(removed, [])
  assert.deepEqual(await d.deleteCodeSession!('no-such-session'), { deleted: false, reason: 'not_found' })
  db.close()
})

test('Deps.deleteCodeSession (the retention sweep\'s) keeps a session whose worktree cannot be removed, with the note', async () => {
  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const d = { db, version: 'test', store: { snapshot: () => ({ code: { defaultAgent: 'turbollm' } }) } } as unknown as Deps
  registerCodeRoutes(new Hono(), d, { reconcileOnStartup: () => {}, isActive: () => false } as unknown as CodeRunManager, {
    removeSessionWorktree: async () => ({ ok: false, code: 'dirty', message: 'has local changes' }),
  })
  const conv = db.createConversation({ kind: 'code', modelKey: 'm' })
  const run = db.createAgentRun({ convId: conv.id, title: 'T', allowedTools: [], repoRoot: '/r', worktreePath: '/r/wt' })
  assert.deepEqual(await d.deleteCodeSession!(run.id), { deleted: false, reason: 'worktree_kept', worktreeNote: 'has local changes' })
  assert.ok(db.getAgentRun(run.id), 'the session stays, so its worktree is still reachable')
  assert.ok(db.getConversation(conv.id))
  db.close()
})

test('the DELETE route goes through the same cleanup: 409 while active, 404 when missing, a worktree note when removal fails', async () => {
  const active = new Set<string>()
  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const d = { db, version: 'test', store: { snapshot: () => ({ code: { defaultAgent: 'turbollm' } }) } } as unknown as Deps
  const app = new Hono()
  registerCodeRoutes(app, d, { reconcileOnStartup: () => {}, isActive: (id: string) => active.has(id) } as unknown as CodeRunManager, {
    removeSessionWorktree: async () => ({ ok: false, code: 'dirty', message: 'has local changes' }),
  })
  const conv = db.createConversation({ kind: 'code', modelKey: 'm' })
  const run = db.createAgentRun({ convId: conv.id, title: 'T', allowedTools: [], repoRoot: '/r', worktreePath: '/r/wt' })
  active.add(run.id)
  assert.equal((await app.request(`/api/v1/code/sessions/${run.id}`, { method: 'DELETE' })).status, 409)
  active.delete(run.id)
  const res = await app.request(`/api/v1/code/sessions/${run.id}`, { method: 'DELETE' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, worktreeNote: 'has local changes' })
  assert.equal((await app.request(`/api/v1/code/sessions/${run.id}`, { method: 'DELETE' })).status, 404)
  db.close()
})
