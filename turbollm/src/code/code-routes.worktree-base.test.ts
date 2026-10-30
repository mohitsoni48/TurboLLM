// POST /code/sessions hands `worktreeBase` to createSessionWorktree, which trims it and asks git
// for the commit it names. A base that is not a string (an API client's number or object) threw
// there and answered an unhandled 500; it is refused with 400 invalid_input before anything is
// made. A string base, or none (absent or null), still creates the session.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
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
  } as unknown as Deps
  const runs = { reconcileOnStartup() {} } as unknown as CodeRunManager
  registerCodeRoutes(app, d, runs)
  return { app, db }
}

const post = (app: Hono, body: unknown) =>
  app.request('/api/v1/code/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('POST /code/sessions refuses a worktreeBase that is not a string, creating nothing', async () => {
  const { app, db } = makeApp()
  const repoRoot = tmpGitRepo('tllm-code-wt-base-')
  for (const worktreeBase of [123, { name: 'main' }, ['main'], true]) {
    const res = await post(app, { repoRoot, task: 'do it', useWorktree: true, worktreeBase })
    assert.equal(res.status, 400, JSON.stringify(worktreeBase))
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'invalid_input', JSON.stringify(worktreeBase))
  }
  assert.equal(db.listAgentRuns().length, 0, 'no session created')
  assert.ok(!existsSync(join(repoRoot, WORKTREES_SUBDIR)), 'no worktree made')

  for (const [i, worktreeBase] of ['main', null, undefined].entries()) {
    const res = await post(app, { repoRoot, task: 'do it', useWorktree: true, worktreeBranch: `feature-${i}`, worktreeBase })
    assert.equal(res.status, 201, `${JSON.stringify(worktreeBase)}: ${await res.text()}`)
  }
  assert.equal(db.listAgentRuns().length, 3)
})
