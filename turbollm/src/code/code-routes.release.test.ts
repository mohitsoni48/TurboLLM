// A Code session's background jobs (its agent's bash commands, held per session by util/tether.ts) end when the
// session is closed: archived, or deleted, and before a deleted one's worktree is removed (a job whose cwd is the
// worktree stops Windows from removing the directory, and on POSIX can keep writing into it, so `git worktree
// remove` without --force refused for its untracked files).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import { registerCodeRoutes } from './code-routes'
import { spawnHeld } from '../util/tether'
import type { Deps } from '../deps'
import { isGone, killRecorded, record, waitGone } from '../test-support/stand-in-daemon'

const skip = process.platform === 'win32' ? 'POSIX held groups (Windows holds through its job sentinel)' : false

function makeApp(seams: Parameters<typeof registerCodeRoutes>[3] = {}) {
  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const app = new Hono()
  const d = { db, version: 'test', store: { snapshot: () => ({ code: { defaultAgent: 'turbollm' } }) } } as unknown as Deps
  registerCodeRoutes(app, d, undefined, seams)
  return { app, db }
}

function session(db: ConversationStore, extra: { repoRoot?: string; worktreePath?: string } = {}): string {
  const conv = db.createConversation({ kind: 'code', modelKey: 'm' })
  return db.createAgentRun({ convId: conv.id, title: 'T', allowedTools: [], repoRoot: extra.repoRoot ?? '/work/repo', worktreePath: extra.worktreePath }).id
}

/** A background job left by one of the session's bash commands, held in its scope. */
async function heldJob(sessionId: string): Promise<number> {
  const { child, settled } = spawnHeld('sh', ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore'] }, { kind: 'code-bash', hold: `code-session:${sessionId}` })
  record(child.pid)
  let out = ''
  child.stdout?.on('data', (b: Buffer) => { out += b.toString() })
  await settled
  const job = Number(out.trim())
  record(job)
  return job
}

test('archiving a session ends its background jobs; another session\'s live on', { skip }, async () => {
  const { app, db } = makeApp()
  try {
    const a = session(db)
    const b = session(db)
    const jobA = await heldJob(a)
    const jobB = await heldJob(b)
    const res = await app.request(`/api/v1/code/sessions/${a}/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(res.status, 200)
    assert.deepEqual(await waitGone([jobA], 2000), [])
    assert.equal(isGone(jobB), false)
    const unarchive = await app.request(`/api/v1/code/sessions/${b}/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"archived":false}' })
    assert.equal(unarchive.status, 200)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(isGone(jobB), false, 'unarchiving ends nothing')
  } finally {
    killRecorded()
  }
})

test('deleting a session ends its background jobs before its worktree is removed', { skip }, async () => {
  let aliveAtRemoval: boolean | null = null
  let job = 0
  const { app, db } = makeApp({
    removeSessionWorktree: async () => {
      aliveAtRemoval = !isGone(job)
      return { ok: true }
    },
  })
  try {
    const id = session(db, { repoRoot: '/work/repo', worktreePath: '/work/repo/.turbollm/worktrees/t' })
    job = await heldJob(id)
    const res = await app.request(`/api/v1/code/sessions/${id}`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    assert.equal(aliveAtRemoval, false, 'the job was gone when the worktree removal ran')
    assert.equal(isGone(job), true)
  } finally {
    killRecorded()
  }
})
