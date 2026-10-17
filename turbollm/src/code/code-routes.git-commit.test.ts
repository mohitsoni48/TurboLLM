// POST /git/commit in a session opened at a repo subfolder: changes already staged outside the
// folder (the dialog lists only the folder) refuse the commit with 409 staged_outside_folder, not
// a 500, and nothing is committed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import { registerCodeRoutes } from './code-routes'
import type { CodeRunManager } from './code-run-manager'
import type { Deps } from '../deps'
import { tmpGitRepo } from '../test-support/git-repo'

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true }).trim()

test('POST /code/sessions/:id/git/commit answers 409 staged_outside_folder for changes staged outside a subfolder session', async () => {
  const dir = tmpGitRepo('tllm-code-git-commit-')
  const sub = join(dir, 'packages', 'web')
  mkdirSync(sub, { recursive: true })
  mkdirSync(join(dir, 'secret'))
  writeFileSync(join(sub, 'a.ts'), 'a\n')
  writeFileSync(join(dir, 'secret', 'b.txt'), 'b\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'files'], dir)
  const head = git(['rev-parse', 'HEAD'], dir)
  appendFileSync(join(sub, 'a.ts'), 'more\n')
  appendFileSync(join(dir, 'secret', 'b.txt'), 'more\n')
  git(['add', '-A'], sub)

  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const app = new Hono()
  const d = {
    db,
    version: 'test',
    store: { snapshot: () => ({ code: { defaultAgent: 'turbollm' } }) },
    manager: { status: () => ({ state: 'running', model: 'm' }), target: () => ({ host: '127.0.0.1', port: 1 }) },
  } as unknown as Deps
  const runs = {
    reconcileOnStartup() {},
    isActive: () => false,
    enqueue: () => ({ queued: false }),
  } as unknown as CodeRunManager
  registerCodeRoutes(app, d, runs)
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  const created = await post('/api/v1/code/sessions', { repoRoot: sub, task: 'do it' })
  assert.equal(created.status, 201)
  const { sessionId } = (await created.json()) as { sessionId: string }

  const res = await post(`/api/v1/code/sessions/${sessionId}/git/commit`, { message: 'm' })
  assert.equal(res.status, 409)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'staged_outside_folder')
  assert.equal(git(['rev-parse', 'HEAD'], dir), head, 'nothing committed')
})
