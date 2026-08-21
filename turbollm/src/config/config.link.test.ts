import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from './config'

/** Write `raw` as a config.json in a fresh temp dir and load it the way the daemon
 *  does. Mirrors the existing config.test.ts pattern — migrate() + normalize() run for
 *  real, so this tests the actual upgrade path a user's file takes, not a helper. */
function loadRaw(raw: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-link-cfg-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify(raw), 'utf8')
  const store = ConfigStore.load(path)
  return store.snapshot()
}

// R3 guard in test form: an existing user's config.json must survive this feature
// untouched. An ApiKey written before Turbo Link has no `grant`, and absent MUST mean
// full access — anything else silently downgrades every key the user already has.
test('an existing key with no grant is left alone (absent = full access)', () => {
  const c = loadRaw({
    apiKeys: [{ id: 'a', name: 'old', hash: 'h', prefix: 'tllm-abc', createdAt: 'x', lastUsedAt: null }],
  })
  assert.equal(c.apiKeys[0].grant, undefined)
  assert.equal(c.apiKeys[0].name, 'old')
})

test('links defaults to an empty array on a config that predates the field', () => {
  assert.deepEqual(loadRaw({}).links, [])
})

test('an existing links array survives a load/normalize round trip', () => {
  const rec = {
    id: 'l1', name: 'workstation', baseUrl: 'http://192.168.1.9:6996', token: 'tllm-x',
    machineId: 'm1', grantedCapabilities: ['models:use'], linkApiVersion: 1,
    status: 'online', lastSeenAt: null, lastError: null,
  }
  assert.deepEqual(loadRaw({ links: [rec] }).links, [rec])
})

test('a link token in config.json survives a real write/read cycle unmangled', () => {
  // R3: this feature persists a credential to config.json. A BOM or an encoding slip
  // here silently breaks every link, and has wiped user settings in this project before.
  const c = loadRaw({
    links: [{
      id: 'l1', name: 'wörkstation', baseUrl: 'http://h:6996', token: 'tllm-AbC123',
      machineId: null, grantedCapabilities: [], linkApiVersion: null,
      status: 'unknown', lastSeenAt: null, lastError: null,
    }],
  })
  assert.equal(c.links[0].token, 'tllm-AbC123')
  assert.equal(c.links[0].name, 'wörkstation')
})
