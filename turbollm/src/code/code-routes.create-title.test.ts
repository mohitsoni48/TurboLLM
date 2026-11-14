// GitHub #52 (b15hop): a Code session could only be named after it existed — its title was the first
// 60 characters of the task, and a rename came later. POST /api/v1/code/sessions now takes an optional
// `title`. A name given at creation is the user's own, so it must also switch off the one-time
// auto-generated title (code-run-manager.ts mirrors it onto the run after the first successful turn,
// gated on `titleAutoSynced`): without that, the first reply would silently replace the chosen name.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import { registerCodeRoutes } from './code-routes'
import type { Deps } from '../deps'

const TASK = 'Add a health check endpoint that reports the daemon version and uptime for the load balancer'

function makeApp() {
  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const app = new Hono()
  const d = { db, version: 'test', store: { snapshot: () => ({ code: { defaultAgent: 'turbollm' } }), read: () => ({ code: { defaultAgent: 'turbollm' } }) } } as unknown as Deps
  registerCodeRoutes(app, d)
  return { app, db }
}

async function createSession(app: Hono, extra: Record<string, unknown> = {}) {
  const res = await app.request('/api/v1/code/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoRoot: '/work/repo', mode: 'auto', task: TASK, ...extra }),
  })
  assert.equal(res.status, 201)
  return ((await res.json()) as { sessionId: string }).sessionId
}

test('POST /code/sessions without a title still names the session after the task, and leaves auto-titling on', async () => {
  const { app, db } = makeApp()

  const run = db.getAgentRun(await createSession(app))

  assert.equal(run?.title, TASK.slice(0, 60))
  assert.equal(run?.titleAutoSynced, false)
})

test('POST /code/sessions with a title uses it, trimmed, instead of the task text', async () => {
  const { app, db } = makeApp()

  const run = db.getAgentRun(await createSession(app, { title: '  Health check work  ' }))

  assert.equal(run?.title, 'Health check work')
})

test('POST /code/sessions with a title marks it manually named, so the first turn cannot auto-title over it', async () => {
  const { app, db } = makeApp()

  const run = db.getAgentRun(await createSession(app, { title: 'Health check work' }))

  assert.equal(run?.titleAutoSynced, true)
})

test('POST /code/sessions treats a blank title as no title', async () => {
  const { app, db } = makeApp()

  const run = db.getAgentRun(await createSession(app, { title: '   ' }))

  assert.equal(run?.title, TASK.slice(0, 60))
  assert.equal(run?.titleAutoSynced, false)
})

test('POST /code/sessions ignores a title that is not a string instead of failing the request', async () => {
  const { app, db } = makeApp()

  const run = db.getAgentRun(await createSession(app, { title: 42 }))

  assert.equal(run?.title, TASK.slice(0, 60))
})
