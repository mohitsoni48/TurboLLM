// Deleting a skill takes it off the "On by default" list too: the library shows no card for a missing skill, so a stale id
// could never be switched off, and a skill later imported under the same id would turn up on by default unasked.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConfigStore } from '../config/config.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'
import { registerAgentRoutes } from './agent-routes.js'

test('deleting a skill removes its id from the default skills, leaving the others', async () => {
  const dir = tmpDir('tllm-skill-delete-defaults-')
  try {
    const store = ConfigStore.load(join(dir, 'config.json'))
    const app = new Hono()
    registerAgentRoutes(app, { store } as unknown as Deps)
    const json = { 'content-type': 'application/json' }
    for (const id of ['one', 'two']) {
      const made = await app.request('/api/v1/skills', { method: 'POST', headers: json, body: JSON.stringify({ id, name: id, instructions: 'do it' }) })
      assert.equal(made.status, 201)
    }
    store.update((c) => { c.defaultSkillIds = ['one', 'two'] })

    const res = await app.request('/api/v1/skills/one', { method: 'DELETE' })

    assert.equal(res.status, 200)
    assert.deepEqual(store.snapshot().defaultSkillIds, ['two'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
