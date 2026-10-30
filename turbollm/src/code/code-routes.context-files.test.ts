// `contextFiles` is stored as the user row's textAttachments. A string or an object there was
// saved as is (POST /messages also threw on it in contextFilesBlock after storing it), and the
// chat/Code views then crash rendering that row. Both routes now refuse it with 400 invalid_input
// before anything is stored or any turn is started; absent or null is still accepted.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import { registerCodeRoutes } from './code-routes'
import type { CodeRunManager } from './code-run-manager'
import type { Deps } from '../deps'

function makeApp() {
  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const app = new Hono()
  const d = {
    db,
    version: 'test',
    store: { snapshot: () => ({ code: { defaultAgent: 'turbollm' } }) },
    manager: { status: () => ({ state: 'running', model: 'm' }), target: () => ({ host: '127.0.0.1', port: 1 }) },
  } as unknown as Deps
  const started: string[] = []
  const runs = {
    reconcileOnStartup() {},
    isActive: () => false,
    enqueue: (_id: string, p: { task: string }) => { started.push(p.task); return { queued: false } },
    steer: async (_id: string, p: { task: string }) => { started.push(p.task); return { steered: false, queued: false } },
  } as unknown as CodeRunManager
  registerCodeRoutes(app, d, runs)
  return { app, db, started }
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const BAD = ['src/a.ts', { path: 'src/a.ts' }, ['src/a.ts', 42]]

test('POST /code/sessions refuses a contextFiles that is not an array of strings, creating nothing', async () => {
  const { app, db } = makeApp()
  for (const contextFiles of BAD) {
    const res = await post(app, '/api/v1/code/sessions', { repoRoot: '/work/repo', task: 'do it', contextFiles })
    assert.equal(res.status, 400, JSON.stringify(contextFiles))
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'invalid_input')
  }
  assert.equal(db.listAgentRuns().length, 0, 'no session created')

  for (const contextFiles of [undefined, null, ['src/a.ts']]) {
    const res = await post(app, '/api/v1/code/sessions', { repoRoot: '/work/repo', task: 'do it', contextFiles })
    assert.equal(res.status, 201, JSON.stringify(contextFiles))
  }
})

test('POST /code/sessions/:id/messages refuses a contextFiles that is not an array of strings, storing and starting nothing', async () => {
  const { app, db, started } = makeApp()
  const res = await post(app, '/api/v1/code/sessions', { repoRoot: '/work/repo', task: 'do it' })
  const { sessionId, convId } = (await res.json()) as { sessionId: string; convId: string }
  const before = db.getConversation(convId, true)!.messages!.length

  for (const kind of ['followUp', 'steer']) {
    for (const contextFiles of BAD) {
      const r = await post(app, `/api/v1/code/sessions/${sessionId}/messages`, { content: 'next', kind, contextFiles })
      assert.equal(r.status, 400, `${kind} ${JSON.stringify(contextFiles)}`)
      assert.equal(((await r.json()) as { error: { code: string } }).error.code, 'invalid_input')
    }
  }
  assert.equal(db.getConversation(convId, true)!.messages!.length, before, 'no user row stored')
  assert.deepEqual(started, [], 'no turn started or steered')

  for (const contextFiles of [undefined, null, ['src/a.ts']]) {
    const r = await post(app, `/api/v1/code/sessions/${sessionId}/messages`, { content: 'next', contextFiles })
    assert.equal(r.status, 202, JSON.stringify(contextFiles))
  }
  assert.equal(started.length, 3)
})
