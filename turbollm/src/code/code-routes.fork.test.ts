// POST /code/sessions/:id/fork (GitHub #323): a new session on the same repo with the transcript up to a message.
// A worktree session forks onto a worktree of its own, branched from the original's branch.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
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

// A Code session's compaction lives on its run, not its conversation: without it the fork replayed the full history.
test('a compacted session\'s fork keeps the compaction when its cut is copied, pointed at the copy', async () => {
  const { app, db } = makeApp()
  const conv = db.createConversation({ kind: 'code' })
  const run = db.createAgentRun({ convId: conv.id, title: 'T', allowedTools: [], repoRoot: '/work/repo' })
  const u1 = db.addMessage(conv.id, 'user', 'step one')
  const a1 = db.addMessage(conv.id, 'assistant', 'did one')
  const u2 = db.addMessage(conv.id, 'user', 'step two')
  db.updateAgentRun(run.id, { compactionSummary: 'Step one is done.', compactionUpToMessageId: a1.id, compactionTokensBefore: 1234 })

  const after = await post(app, `/api/v1/code/sessions/${run.id}/fork`, { messageId: u2.id })
  assert.equal(after.status, 201)
  const kept = db.getAgentRun(((await after.json()) as { sessionId: string }).sessionId)!
  const copies = db.getMessages(kept.convId)
  assert.equal(kept.compactionSummary, 'Step one is done.')
  assert.equal(kept.compactionTokensBefore, 1234)
  assert.equal(kept.compactionUpToMessageId, copies[1].id, 'the copy of the cut, not the original message')

  const before = await post(app, `/api/v1/code/sessions/${run.id}/fork`, { messageId: u1.id })
  assert.equal(before.status, 201)
  assert.equal(db.getAgentRun(((await before.json()) as { sessionId: string }).sessionId)!.compactionSummary, undefined, 'the cut is past the fork')
  db.close()
})

test('a reverted or cleared session forks only what it shows, and the fork carries no revert, clear or compaction marker', async () => {
  const { app, db } = makeApp()
  const conv = db.createConversation({ kind: 'code' })
  const run = db.createAgentRun({ convId: conv.id, title: 'T', allowedTools: [], repoRoot: '/work/repo' })
  const u1 = db.addMessage(conv.id, 'user', 'one')
  const a1 = db.addMessage(conv.id, 'assistant', 'did one')
  const u2 = db.addMessage(conv.id, 'user', 'two')
  db.addMessage(conv.id, 'assistant', 'did two')
  db.updateAgentRun(run.id, { compactionSummary: 'One.', compactionUpToMessageId: a1.id, compactionTokensBefore: 10 })

  db.deactivateMessagesFrom(conv.id, u2.id)
  db.setRevertedFromMessageId(run.id, u2.id)
  assert.equal((await post(app, `/api/v1/code/sessions/${run.id}/fork`, { messageId: u2.id })).status, 404, 'a reverted message is not forkable')
  const reverted = await post(app, `/api/v1/code/sessions/${run.id}/fork`, { messageId: a1.id })
  assert.equal(reverted.status, 201)
  const r = db.getAgentRun(((await reverted.json()) as { sessionId: string }).sessionId)!
  assert.deepEqual(db.getMessages(r.convId).map((m) => m.content), ['one', 'did one'])
  assert.equal(r.revertedFromMessageId, undefined)

  db.reactivateMessagesFrom(conv.id, u2.id)
  db.setRevertedFromMessageId(run.id, null)
  db.deactivateMessagesUpTo(conv.id, a1.id)
  db.setClearedUpToMessageId(run.id, a1.id)
  const last = db.getMessages(conv.id).at(-1)!
  const cleared = await post(app, `/api/v1/code/sessions/${run.id}/fork`, { messageId: last.id })
  assert.equal(cleared.status, 201)
  const cl = db.getAgentRun(((await cleared.json()) as { sessionId: string }).sessionId)!
  assert.deepEqual(db.getMessages(cl.convId).map((m) => m.content), ['two', 'did two'])
  assert.equal(cl.clearedUpToMessageId, undefined)
  assert.equal(cl.compactionSummary, undefined, 'a clear replays nothing before it, so no compaction comes along')
  assert.ok(u1)
  db.close()
})

test('a terminal agent\'s session is not forked: it would never see the copied transcript', async () => {
  const { app, db } = makeApp()
  const conv = db.createConversation({ kind: 'code' })
  const run = db.createAgentRun({ convId: conv.id, title: 'T', allowedTools: [], repoRoot: '/work/repo', codeAgent: 'claude' })
  const u = db.addMessage(conv.id, 'user', 'task')
  const before = db.listAgentRuns().length
  assert.equal((await post(app, `/api/v1/code/sessions/${run.id}/fork`, { messageId: u.id })).status, 400)
  assert.equal(db.listAgentRuns().length, before)
  db.close()
})

const branches = (repoRoot: string, pattern: string) =>
  execFileSync('git', ['-C', repoRoot, 'branch', '--list', pattern], { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean)

test('a worktree session with a bad message id makes no worktree or branch', async () => {
  const { app, db } = makeApp()
  const repoRoot = tmpGitRepo('tllm-code-fork-bad-')
  const created = await post(app, '/api/v1/code/sessions', { repoRoot, task: 'feature work', useWorktree: true, worktreeBranch: 'feature' })
  const { sessionId } = (await created.json()) as { sessionId: string }
  const res = await post(app, `/api/v1/code/sessions/${sessionId}/fork`, { messageId: 'nope' })
  assert.equal(res.status, 404)
  assert.deepEqual(branches(repoRoot, 'feature-fork*'), [])
  assert.equal(db.listAgentRuns().length, 1)
  db.close()
})

test('a fork that fails after its worktree is made takes the worktree, branch and copied conversation with it', async () => {
  const { app, db } = makeApp()
  const repoRoot = tmpGitRepo('tllm-code-fork-fail-')
  const created = await post(app, '/api/v1/code/sessions', { repoRoot, task: 'feature work', useWorktree: true, worktreeBranch: 'feature' })
  const { sessionId } = (await created.json()) as { sessionId: string }
  const task = db.getMessages(db.getAgentRun(sessionId)!.convId)[0]
  const conversations = db.listConversations().length
  const real = db.createAgentRun.bind(db)
  let madePath: string | undefined
  db.createAgentRun = (params) => { madePath = params.worktreePath; throw new Error('disk full') }

  const res = await post(app, `/api/v1/code/sessions/${sessionId}/fork`, { messageId: task.id })
  db.createAgentRun = real
  assert.equal(res.status, 500)
  assert.ok(madePath, 'the worktree was made before the failure')
  assert.ok(!existsSync(madePath!), 'and removed after it')
  assert.deepEqual(branches(repoRoot, 'feature-fork*'), [], 'its branch too')
  assert.equal(db.listConversations().length, conversations, 'no copied conversation left behind')
  assert.equal(db.listAgentRuns().length, 1)
  db.close()
})
