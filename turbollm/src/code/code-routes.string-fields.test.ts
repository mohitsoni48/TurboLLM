// The Code routes trim their text fields, hand them to git or the shell, or store them as text. A
// number, an object, an array or a boolean there (an API client's mistake) threw
// (`.trim is not a function`, a SQLite bind error, `message.trim` inside commitGitChanges) and
// answered a 500, or was stored as is. Each such field is refused with 400 invalid_input before
// anything is made, stored, started or run; absent or null still means "not given".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import { registerCodeRoutes } from './code-routes'
import type { CodeRunManager } from './code-run-manager'
import type { Deps } from '../deps'
import { WORKTREES_SUBDIR } from './worktree'
import { tmpGitRepo } from '../test-support/git-repo'

function makeApp() {
  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const app = new Hono()
  const d = {
    db,
    version: 'test',
    store: { snapshot: () => ({ code: { defaultAgent: 'turbollm' } }) },
    manager: { status: () => ({ state: 'running', model: 'm' }), target: () => ({ host: '127.0.0.1', port: 1 }) },
    modelRouter: { resolveRemoteTarget: () => undefined },
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

const send = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const NOT_STRINGS = [7, { name: 'x' }, ['x'], true]

async function assertRefused(res: Response, field: string, what: string) {
  assert.equal(res.status, 400, `${what}: ${await res.clone().text()}`)
  assert.deepEqual(((await res.json()) as { error: unknown }).error, { code: 'invalid_input', message: `${field} must be a string.` }, what)
}

test('POST /code/sessions refuses a text field that is not a string, creating nothing', async () => {
  const { app, db } = makeApp()
  const repoRoot = tmpGitRepo('tllm-code-strings-')
  const base = { repoRoot, task: 'do it' }
  for (const field of ['repoRoot', 'task', 'repoBranch', 'modelKey', 'worktreeBranch']) {
    for (const v of NOT_STRINGS) {
      for (const useWorktree of [false, true]) {
        await assertRefused(await send(app, '/api/v1/code/sessions', { ...base, useWorktree, [field]: v }), field, `${field}=${JSON.stringify(v)} useWorktree=${useWorktree}`)
      }
    }
  }
  assert.equal(db.listAgentRuns().length, 0, 'no session created')
  assert.ok(!existsSync(join(repoRoot, WORKTREES_SUBDIR)), 'no worktree made')

  const res = await send(app, '/api/v1/code/sessions', { ...base, repoBranch: null, modelKey: null, worktreeBranch: null, useWorktree: true })
  assert.equal(res.status, 201, await res.text())
  const res2 = await send(app, '/api/v1/code/sessions', { ...base, repoBranch: 'main', modelKey: 'm', worktreeBranch: 'feature', useWorktree: true })
  assert.equal(res2.status, 201, await res2.text())
  assert.equal(db.listAgentRuns().find((r) => r.worktreeBranch === 'feature')?.repoBranch, 'main')
})

test('POST /code/sessions/:id/messages, /compact, /revert, /git/commit and /exec refuse a text field that is not a string', async () => {
  const { app, db, started } = makeApp()
  const repoRoot = tmpGitRepo('tllm-code-strings-')
  const created = await send(app, '/api/v1/code/sessions', { repoRoot, task: 'do it' })
  const { sessionId, convId } = (await created.json()) as { sessionId: string; convId: string }
  const s = `/api/v1/code/sessions/${sessionId}`
  const rows = () => db.getConversation(convId, true)!.messages!.length
  const before = rows()
  writeFileSync(join(repoRoot, 'new.txt'), 'x\n') // something to commit, so the commit gets as far as its files

  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['/messages', 'content', {}],
    ['/messages', 'promptOverride', { content: 'next' }],
    ['/messages', 'model', { content: 'next' }],
    ['/compact', 'instructions', {}],
    ['/compact', 'model', {}],
    ['/revert', 'messageId', {}],
    ['/git/commit', 'message', {}],
    ['/exec', 'command', { feedToModel: true }],
  ]
  for (const [route, field, rest] of cases) {
    for (const v of NOT_STRINGS) {
      for (const kind of route === '/messages' ? ['followUp', 'steer'] : [undefined]) {
        await assertRefused(await send(app, `${s}${route}`, { ...rest, ...(kind ? { kind } : {}), [field]: v }), field, `${route} ${field}=${JSON.stringify(v)} ${kind ?? ''}`)
      }
    }
  }
  for (const files of ['new.txt', [1], [{ path: 'new.txt' }]]) {
    const res = await send(app, `${s}/git/commit`, { message: 'm', files })
    assert.equal(res.status, 400, JSON.stringify(files))
    assert.deepEqual(((await res.json()) as { error: unknown }).error, { code: 'invalid_input', message: 'files must be an array of strings.' })
  }
  assert.equal(rows(), before, 'no message stored')
  assert.deepEqual(started, [], 'no turn started or steered')

  // Text still works.
  assert.equal((await send(app, `${s}/messages`, { content: 'next', promptOverride: null, model: null })).status, 202)
  const commit = await send(app, `${s}/git/commit`, { message: 'add new.txt', files: ['new.txt'] })
  assert.equal(commit.status, 200, await commit.text())
})
