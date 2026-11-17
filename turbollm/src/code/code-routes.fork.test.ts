// POST /code/sessions/:id/fork (GitHub #323): a new session on the same repo with the transcript up to a message.
// A worktree session forks onto a worktree of its own, branched from the original's branch.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import { registerCodeRoutes } from './code-routes'
import type { CodeRunManager } from './code-run-manager'
import type { Deps } from '../deps'
import { tmpGitRepo } from '../test-support/git-repo'

function makeApp(active = new Set<string>()) {
  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const app = new Hono()
  const d = {
    db,
    version: 'test',
    store: { snapshot: () => ({ code: { defaultAgent: 'turbollm' } }), read: () => ({ code: { defaultAgent: 'turbollm' } }) },
  } as unknown as Deps
  const runs = { reconcileOnStartup() {}, isActive: (id: string) => active.has(id) } as unknown as CodeRunManager
  registerCodeRoutes(app, d, runs)
  return { app, db, active }
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('a fork is a new session on the same repo, with the transcript up to the message and the same mode', async () => {
  const { app, db } = makeApp()
  const conv = db.createConversation({ kind: 'code', modelKey: 'm|Q4|1' })
  db.setConversationMode(conv.id, 'plan')
  const run = db.createAgentRun({ convId: conv.id, title: 'Add login', allowedTools: [], repoRoot: '/work/repo', repoBranch: 'main', codeAgent: 'turbollm' })
  db.addMessage(conv.id, 'user', 'add a login page')
  const a1 = db.addMessage(conv.id, 'assistant', 'done, using sessions')
  db.addMessage(conv.id, 'user', 'now add tests')

  const res = await post(app, `/api/v1/code/sessions/${run.id}/fork`, { messageId: a1.id })
  assert.equal(res.status, 201)
  const { sessionId, convId } = (await res.json()) as { sessionId: string; convId: string }
  const fork = db.getAgentRun(sessionId)!
  assert.notEqual(sessionId, run.id)
  assert.equal(fork.title, 'Add login (fork)')
  assert.equal(fork.repoRoot, '/work/repo')
  assert.equal(fork.repoBranch, 'main')
  assert.equal(fork.codeAgent, 'turbollm')
  assert.equal(fork.convId, convId)
  const forkConv = db.getConversation(convId, true)!
  assert.equal(forkConv.kind, 'code')
  assert.equal(forkConv.agentMode, 'plan')
  assert.deepEqual(forkConv.messages!.map((m) => m.content), ['add a login page', 'done, using sessions'])
  assert.equal(db.getMessages(conv.id).length, 3, 'the original is unchanged')
  db.close()
})

test('a session with a run going, or no such message, is not forked', async () => {
  const { app, db, active } = makeApp()
  const conv = db.createConversation({ kind: 'code' })
  const run = db.createAgentRun({ convId: conv.id, title: 'T', allowedTools: [], repoRoot: '/work/repo' })
  const u = db.addMessage(conv.id, 'user', 'task')
  const before = db.listAgentRuns().length

  assert.equal((await post(app, `/api/v1/code/sessions/${run.id}/fork`, {})).status, 400)
  assert.equal((await post(app, '/api/v1/code/sessions/nope/fork', { messageId: u.id })).status, 404)
  assert.equal((await post(app, `/api/v1/code/sessions/${run.id}/fork`, { messageId: 'nope' })).status, 404)
  active.add(run.id)
  const busy = await post(app, `/api/v1/code/sessions/${run.id}/fork`, { messageId: u.id })
  assert.equal(busy.status, 409)
  assert.equal(((await busy.json()) as { error: { code: string } }).error.code, 'run_active')
  assert.equal(db.listAgentRuns().length, before, 'nothing created')
  db.close()
})

test('a worktree session forks onto a new worktree of its own, branched from the original\'s branch', async () => {
  const { app, db } = makeApp()
  const repoRoot = tmpGitRepo('tllm-code-fork-wt-')
  const created = await post(app, '/api/v1/code/sessions', { repoRoot, task: 'feature work', useWorktree: true, worktreeBranch: 'feature' })
  assert.equal(created.status, 201, await created.clone().text())
  const { sessionId } = (await created.json()) as { sessionId: string }
  const original = db.getAgentRun(sessionId)!
  const task = db.getMessages(original.convId)[0]

  const res = await post(app, `/api/v1/code/sessions/${sessionId}/fork`, { messageId: task.id })
  assert.equal(res.status, 201, await res.clone().text())
  const fork = db.getAgentRun(((await res.json()) as { sessionId: string }).sessionId)!
  assert.ok(fork.worktreePath && existsSync(fork.worktreePath), 'its own worktree exists')
  assert.notEqual(fork.worktreePath, original.worktreePath)
  assert.notEqual(fork.worktreeBranch, original.worktreeBranch)
  assert.match(fork.worktreeBranch ?? '', /^feature-fork/)
  assert.equal(fork.worktreeBase, original.worktreeBranch)
  db.close()
})
