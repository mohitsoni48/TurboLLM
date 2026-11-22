// Settings → Chat, "Skills in new chats" (config.daemon.defaultChatSkillIds, GitHub #340): none by default, stored by
// PATCH /api/v1/settings and served by GET. The web UI pre-ticks them on a blank chat; the daemon never adds them to a
// conversation on its own.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { ConfigStore } from '../config/config'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

function app(store: ConfigStore) {
  const a = new Hono()
  registerApi(a, { version: 'test', store, manager: { status: () => ({ state: 'stopped', model: null }) } } as unknown as Deps)
  return a
}

const patch = (a: Hono, body: unknown) =>
  a.request('/api/v1/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test('defaultChatSkillIds is empty by default, and PATCH stores it trimmed and without repeats', async () => {
  const store = ConfigStore.load(join(tmpDir('tllm-default-skills-'), 'config.json'))
  const a = app(store)
  const get = async () => ((await (await a.request('/api/v1/settings')).json()) as { defaultChatSkillIds?: string[] }).defaultChatSkillIds

  assert.deepEqual(await get(), [])
  const res = await patch(a, { defaultChatSkillIds: [' web ', 'compose', 'web', ''] })
  assert.equal(res.status, 200)
  assert.deepEqual(store.snapshot().daemon.defaultChatSkillIds, ['web', 'compose'])
  assert.deepEqual(await get(), ['web', 'compose'])

  assert.equal((await patch(a, { defaultChatSkillIds: [] })).status, 200)
  assert.deepEqual(await get(), [])
})

test('defaultChatSkillIds refuses what is not a list of strings, and more than 50 skills', async () => {
  const store = ConfigStore.load(join(tmpDir('tllm-default-skills-'), 'config.json'))
  const a = app(store)
  for (const bad of ['web', 3, null, { id: 'web' }]) {
    assert.equal((await patch(a, { defaultChatSkillIds: bad })).status, 400, JSON.stringify(bad))
  }
  const tooMany = await patch(a, { defaultChatSkillIds: Array.from({ length: 51 }, (_, i) => `s${i}`) })
  assert.equal(tooMany.status, 400)
  assert.match(((await tooMany.json()) as { error: { message: string } }).error.message, /at most 50/)
  assert.equal(store.snapshot().daemon.defaultChatSkillIds, undefined, 'nothing stored')
})

test('a config written before the setting, or with garbage in it, reads as none', async () => {
  const dir = tmpDir('tllm-default-skills-')
  for (const value of [undefined, 'web', 7, ['web', 3]]) {
    const path = join(dir, 'config.json')
    const raw = JSON.parse(JSON.stringify(ConfigStore.load(join(dir, 'seed.json')).snapshot())) as { daemon: Record<string, unknown> }
    if (value === undefined) delete raw.daemon.defaultChatSkillIds
    else raw.daemon.defaultChatSkillIds = value
    writeFileSync(path, JSON.stringify(raw))
    const got = ((await (await app(ConfigStore.load(path)).request('/api/v1/settings')).json()) as { defaultChatSkillIds: string[] }).defaultChatSkillIds
    assert.deepEqual(got, [], JSON.stringify(value))
  }
})
