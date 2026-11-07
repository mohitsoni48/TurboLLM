// GitHub #52: a Code session name the user chose is theirs. The create route already protects it from
// the one-time auto-generated title (code-run-manager.ts mirrors that title onto the run after the
// first successful turn, gated on `titleAutoSynced`). Renaming a session has to protect it the same
// way, or renaming while the first turn is still running (or after it was stopped) gets the new name
// replaced by the auto title on the next successful turn. The Session name box limits a name to 120
// characters in the browser, but the API is open to any client, so the server holds the same limit.
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

function rename(app: Hono, sessionId: string, title: unknown) {
  return app.request(`/api/v1/code/sessions/${sessionId}/title`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
}

test('PATCH /code/sessions/:id/title marks the session manually named, so the first turn cannot auto-title over it', async () => {
  const { app, db } = makeApp()
  const id = await createSession(app)
  assert.equal(db.getAgentRun(id)?.titleAutoSynced, false)

  const res = await rename(app, id, 'Load balancer health')

  assert.equal(res.status, 200)
  assert.equal(db.getAgentRun(id)?.title, 'Load balancer health')
  assert.equal(db.getAgentRun(id)?.titleAutoSynced, true)
})

test('PATCH /code/sessions/:id/title answers a title that is not a string with a 400, not a server error', async () => {
  const { app, db } = makeApp()
  const id = await createSession(app)

  const res = await rename(app, id, 42)

  assert.equal(res.status, 400)
  assert.equal(db.getAgentRun(id)?.title, TASK.slice(0, 60))
})

test('PATCH /code/sessions/:id/title keeps a name to one line of at most 120 characters', async () => {
  const { app, db } = makeApp()
  const id = await createSession(app)

  await rename(app, id, `first line\n\nsecond   line ${'x'.repeat(500)}`)

  const title = db.getAgentRun(id)?.title ?? ''
  assert.ok(title.startsWith('first line second line x'))
  assert.equal(title.includes('\n'), false)
  assert.equal(title.length, 120)
})

test('PATCH /code/sessions/:id/title does not leave the name ending in a space, or with half an emoji, where it is cut', async () => {
  const { app, db } = makeApp()
  const id = await createSession(app)

  await rename(app, id, `${'a'.repeat(119)} b`)
  assert.equal(db.getAgentRun(id)?.title, 'a'.repeat(119))

  await rename(app, id, `${'a'.repeat(119)}😀😀`)
  const title = db.getAgentRun(id)?.title ?? ''
  assert.equal(title, `${'a'.repeat(119)}😀`)
  assert.equal(Array.from(title).length, 120)
})

test('PATCH /code/sessions/:id/title never cuts through one visible character, only between them', async () => {
  const { app, db } = makeApp()
  const id = await createSession(app)
  // Each of these is ONE character to the reader but several code points, so a cut inside it leaves a
  // stray half: a lone regional letter, a dangling joiner, a bare base letter.
  const cases: Array<[string, string]> = [
    ['flag', '🇮🇳'],
    ['family', '👨‍👩‍👧'],
    ['skin tone', '👍🏽'],
    ['keycap', '1️⃣'],
    ['accent', 'é'],
  ]
  for (const [name, character] of cases) {
    await rename(app, id, `${'a'.repeat(118)}${character}`)
    const title = db.getAgentRun(id)?.title ?? ''
    assert.ok(title === 'a'.repeat(118) || title === `${'a'.repeat(118)}${character}`, `${name}: stored ${JSON.stringify(title)}`)
  }
})

test('PATCH /code/sessions/:id/title keeps the first 120 characters of an enormous title, and letters that look like whitespace escapes are untouched', async () => {
  const { app, db } = makeApp()
  const id = await createSession(app)

  await rename(app, id, `sss ${'a'.repeat(3_000_000)}`)

  assert.equal(db.getAgentRun(id)?.title, `sss ${'a'.repeat(116)}`)
})

test('PATCH /code/sessions/:id/title reports the name it actually stored', async () => {
  const { app } = makeApp()
  const id = await createSession(app)

  const res = await rename(app, id, `  ${'y'.repeat(300)}  `)

  assert.equal(((await res.json()) as { title: string }).title.length, 120)
})

test('POST /code/sessions keeps a chosen name to one line of at most 120 characters', async () => {
  const { app, db } = makeApp()

  const run = db.getAgentRun(await createSession(app, { title: `one\ntwo ${'z'.repeat(500)}` }))

  assert.equal(run?.title?.includes('\n'), false)
  assert.equal(run?.title?.length, 120)
})
