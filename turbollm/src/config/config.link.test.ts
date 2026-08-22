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

// ── The experimental gate (`daemon.experimental.turboLink`) ───────────────────
//
// Turbo Link ships off by default: it is fully built and green, but has never been
// verified against a real second machine. Normalisation is the whole migration story —
// an absent flag must read as `false` without disturbing one other field.

test('experimental.turboLink defaults to false on a config that predates the flag', () => {
  const c = loadRaw({ daemon: { experimental: { memory: true, cloudDeploy: true, routines: true } } })
  assert.equal(c.daemon.experimental.turboLink, false)
  // …and the siblings it shares the block with are untouched by its arrival.
  assert.equal(c.daemon.experimental.memory, true)
  assert.equal(c.daemon.experimental.cloudDeploy, true)
  assert.equal(c.daemon.experimental.routines, true)
})

test('a config with no experimental block at all still gets turboLink: false', () => {
  const c = loadRaw({ daemon: {} })
  assert.equal(c.daemon.experimental.turboLink, false)
})

test('experimental.turboLink survives a round trip when the user turns it on', () => {
  const c = loadRaw({ daemon: { experimental: { turboLink: true } } })
  assert.equal(c.daemon.experimental.turboLink, true)
})

test('only an exact `true` unlocks Turbo Link — a truthy string does not', () => {
  const c = loadRaw({ daemon: { experimental: { turboLink: 'yes' } } })
  assert.equal(c.daemon.experimental.turboLink, false)
})

test('adding the flag disturbs nothing else an existing user had configured', () => {
  // The R3 guard, restated for this change: links, granted keys and daemon settings all
  // come through a normalize() that now writes one extra boolean, and nothing else moves.
  const c = loadRaw({
    apiKeys: [{ id: 'a', name: 'peer', hash: 'h', prefix: 'tllm-abc', createdAt: 'x', lastUsedAt: null,
      grant: { capabilities: ['models:use'] } }],
    links: [{ id: 'l1', name: 'rig', baseUrl: 'http://rig:6996', token: 'tllm-t', machineId: 'm1',
      grantedCapabilities: ['models:use'], linkApiVersion: 1, status: 'online', lastSeenAt: null, lastError: null }],
    daemon: { theme: 'dark', autoGenerateTitles: false },
  })
  assert.equal(c.daemon.experimental.turboLink, false)
  // Turning the feature off must never cost the user their links or their granted keys.
  assert.equal(c.links.length, 1)
  assert.equal(c.links[0].name, 'rig')
  assert.deepEqual(c.apiKeys[0].grant, { capabilities: ['models:use'] })
  assert.equal(c.daemon.theme, 'dark')
  assert.equal(c.daemon.autoGenerateTitles, false)
})
