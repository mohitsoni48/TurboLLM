import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigStore } from './config'
import { tmpDir } from '../test-support/tmp'

/** Load `raw` as a config.json the way the daemon does, so migrate() + normalize() run for real. */
function loadRaw(raw: unknown) {
  const dir = tmpDir('tllm-sandbox-cfg-')
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify(raw), 'utf8')
  return ConfigStore.load(path).snapshot()
}

test('experimental.sandbox reads false on a config that predates it', () => {
  const c = loadRaw({ daemon: { experimental: { memory: true, routines: true, turboLink: true, remoteAccess: true } } })
  assert.equal(c.daemon.experimental.sandbox, false)
  assert.equal(c.daemon.experimental.routines, true)
})

test('experimental.sandbox: true survives a reload', () => {
  assert.equal(loadRaw({ daemon: { experimental: { sandbox: true } } }).daemon.experimental.sandbox, true)
})

test('experimental.sandbox: anything but a literal true reads false', () => {
  for (const v of ['true', 1, null, {}]) assert.equal(loadRaw({ daemon: { experimental: { sandbox: v } } }).daemon.experimental.sandbox, false)
})
