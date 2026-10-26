// Settings → Tool permissions → "Wait for an answer" (config.tools.chatApprovalWaitMinutes): how long a chat reply
// waits for its tool calls set to Ask, all of them together. Whole minutes, 0-1440 (config-bounds.ts), default 30, 0
// waits until answered. Stored by PATCH /api/v1/settings and served by GET; a config written before it, or hand-edited
// out of range, loads with the default.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { ConfigStore } from '../config/config'
import { CHAT_APPROVAL_WAIT_MINUTES } from '../config/config-bounds'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

function app(store: ConfigStore) {
  const a = new Hono()
  registerApi(a, { version: 'test', store, manager: { status: () => ({ state: 'stopped', model: null }) } } as unknown as Deps)
  return a
}

const patch = (a: Hono, body: unknown) => a.request('/api/v1/settings', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

test('chatApprovalWaitMinutes is 30 by default, and PATCH /api/v1/settings stores any whole minute 0-1440', async () => {
  const store = ConfigStore.load(join(tmpDir('tllm-approval-wait-'), 'config.json'))
  const a = app(store)
  const get = async () => ((await (await a.request('/api/v1/settings')).json()) as { chatApprovalWaitMinutes?: number }).chatApprovalWaitMinutes

  assert.equal(await get(), 30)
  for (const v of [0, 1, 90, 1440]) {
    const res = await patch(a, { chatApprovalWaitMinutes: v })
    assert.equal(res.status, 200, String(v))
    assert.equal(store.snapshot().tools.chatApprovalWaitMinutes, v)
    assert.equal(await get(), v)
  }
})

test('PATCH /api/v1/settings refuses a wait outside 0-1440, a fraction, or another JSON type, and stores nothing', async () => {
  const store = ConfigStore.load(join(tmpDir('tllm-approval-wait-'), 'config.json'))
  const a = app(store)
  for (const v of [-1, 1441, 2.5, '30', null, true]) {
    const before = store.snapshot().autoLoadOnStart
    const res = await patch(a, { chatApprovalWaitMinutes: v, autoLoadOnStart: !before })
    assert.equal(res.status, 400, JSON.stringify(v))
    const { error } = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(error.code, 'invalid_config_value')
    assert.equal(error.message, CHAT_APPROVAL_WAIT_MINUTES.message)
    assert.equal(store.snapshot().tools.chatApprovalWaitMinutes, 30, `${JSON.stringify(v)}: unchanged`)
    assert.equal(store.snapshot().autoLoadOnStart, before, `${JSON.stringify(v)}: nothing else is written either`)
  }
})

test('a config written before the setting, or with a value out of range or of another type, loads with 30; a fraction is floored', () => {
  const dir = tmpDir('tllm-approval-wait-')
  const cases: Array<[unknown, number]> = [[undefined, 30], [0, 0], [1440, 1440], [12.7, 12], [-5, 30], [1441, 30], ['10', 30], [null, 30], [Number.NaN, 30]]
  for (const [value, expected] of cases) {
    const path = join(dir, 'config.json')
    const raw = JSON.parse(JSON.stringify(ConfigStore.load(join(dir, 'seed.json')).snapshot())) as { tools: Record<string, unknown> }
    if (value === undefined) delete raw.tools.chatApprovalWaitMinutes
    else raw.tools.chatApprovalWaitMinutes = value
    writeFileSync(path, JSON.stringify(raw))
    assert.equal(ConfigStore.load(path).snapshot().tools.chatApprovalWaitMinutes, expected, String(value))
  }
})
