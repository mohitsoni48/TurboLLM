// Custom-engine identity persistence (GitHub: "a custom engine added from git url is treated
// as an outsider... should get the same UI as catalogue engines with disable/enable/delete/
// rebuild"). A catalog engine survives Disable→Enable because its fixed, hardcoded homepage
// URL lets the backend re-scan disk for a still-built binary; a custom repo has no such fixed
// identity anywhere else, so customSourceKey/recordCustomSource/forgetCustomSource are that
// memory instead. These tests cover the identity key and the record/forget lifecycle;
// GET /api/v1/engines' derived customDisabled list is exercised at the route level.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore } from '../config/config'
import { Registry, customSourceKey } from './registry'

function freshRegistry(): { reg: Registry; store: ConfigStore } {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-custom-src-'))
  const store = ConfigStore.load(join(dir, 'config.json'))
  return { reg: new Registry(store), store }
}

// ---- customSourceKey ---------------------------------------------------------

test('customSourceKey: git-sourced identity is keyed by repo+branch+commit, not binPath', () => {
  const a = { binPath: '/build/a/llama-server', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main' }
  const b = { binPath: '/build/b/llama-server', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main' }
  // A rebuild lands at a DIFFERENT binPath each time — the key must still match.
  assert.equal(customSourceKey(a), customSourceKey(b))
})

test('customSourceKey: repo URL normalization matches regardless of scheme/.git/case/slash', () => {
  const forms = [
    { binPath: 'x', sourceRepo: 'https://github.com/User/Fork', sourceBranch: '' },
    { binPath: 'x', sourceRepo: 'https://github.com/user/fork.git', sourceBranch: '' },
    { binPath: 'x', sourceRepo: 'https://github.com/user/fork/', sourceBranch: '' },
    { binPath: 'x', sourceRepo: 'HTTPS://GITHUB.COM/user/fork', sourceBranch: '' },
  ]
  const keys = forms.map(customSourceKey)
  assert.ok(keys.every((k) => k === keys[0]))
})

test('customSourceKey: different branches of the SAME repo get different keys', () => {
  const main = { binPath: 'x', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main' }
  const dev = { binPath: 'x', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'dev' }
  assert.notEqual(customSourceKey(main), customSourceKey(dev))
})

test('customSourceKey: a commit-pinned build is a DISTINCT identity from the plain branch build', () => {
  const branch = { binPath: 'x', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main' }
  const pinned = { binPath: 'x', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main', sourceCommit: 'abc1234' }
  assert.notEqual(customSourceKey(branch), customSourceKey(pinned))
})

test('customSourceKey: no sourceRepo falls back to binPath itself', () => {
  assert.equal(customSourceKey({ binPath: '/opt/my-server' }), '/opt/my-server')
  assert.notEqual(customSourceKey({ binPath: '/opt/a' }), customSourceKey({ binPath: '/opt/b' }))
})

// ---- recordCustomSource / customSources / forgetCustomSource -----------------

test('recordCustomSource: appears in customSources() with the given fields', () => {
  const { reg } = freshRegistry()
  reg.recordCustomSource({ name: 'My Fork', binPath: '/build/my-fork/llama-server', kind: 'llama-server', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main' })
  const sources = reg.customSources()
  assert.equal(sources.length, 1)
  assert.equal(sources[0].name, 'My Fork')
  assert.equal(sources[0].sourceRepo, 'https://github.com/user/fork')
  assert.ok(sources[0].addedAt)
})

test('recordCustomSource: recording the SAME identity twice overwrites in place, no duplicate', () => {
  const { reg } = freshRegistry()
  reg.recordCustomSource({ name: 'My Fork', binPath: '/build/v1/llama-server', kind: 'llama-server', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main' })
  // A rebuild: same repo+branch, new binPath (fresh compile output), possibly renamed.
  reg.recordCustomSource({ name: 'My Fork (renamed)', binPath: '/build/v2/llama-server', kind: 'llama-server', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main' })
  const sources = reg.customSources()
  assert.equal(sources.length, 1)
  assert.equal(sources[0].name, 'My Fork (renamed)')
  assert.equal(sources[0].binPath, '/build/v2/llama-server')
})

test('recordCustomSource: two DIFFERENT repos both persist as separate entries', () => {
  const { reg } = freshRegistry()
  reg.recordCustomSource({ name: 'Fork A', binPath: '/build/a/llama-server', kind: 'llama-server', sourceRepo: 'https://github.com/user/fork-a' })
  reg.recordCustomSource({ name: 'Fork B', binPath: '/build/b/llama-server', kind: 'llama-server', sourceRepo: 'https://github.com/user/fork-b' })
  assert.equal(reg.customSources().length, 2)
})

test('forgetCustomSource: removes exactly the matching entry, leaves others', () => {
  const { reg } = freshRegistry()
  reg.recordCustomSource({ name: 'Fork A', binPath: '/build/a/llama-server', kind: 'llama-server', sourceRepo: 'https://github.com/user/fork-a' })
  reg.recordCustomSource({ name: 'Fork B', binPath: '/build/b/llama-server', kind: 'llama-server', sourceRepo: 'https://github.com/user/fork-b' })
  reg.forgetCustomSource(customSourceKey({ binPath: '/build/a/llama-server', sourceRepo: 'https://github.com/user/fork-a' }))
  const sources = reg.customSources()
  assert.equal(sources.length, 1)
  assert.equal(sources[0].name, 'Fork B')
})

test('forgetCustomSource: forgetting an unknown key is a harmless no-op', () => {
  const { reg } = freshRegistry()
  reg.recordCustomSource({ name: 'Fork A', binPath: '/build/a/llama-server', kind: 'llama-server', sourceRepo: 'https://github.com/user/fork-a' })
  reg.forgetCustomSource('nothing-matches-this-key')
  assert.equal(reg.customSources().length, 1)
})

test('recordCustomSource: survives being re-loaded from disk (real persistence, not in-memory only)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-custom-src-'))
  const configPath = join(dir, 'config.json')
  const reg1 = new Registry(ConfigStore.load(configPath))
  reg1.recordCustomSource({ name: 'My Fork', binPath: '/build/my-fork/llama-server', kind: 'llama-server', sourceRepo: 'https://github.com/user/fork' })
  // A fresh Registry/ConfigStore instance over the SAME file — simulates a daemon restart.
  const reg2 = new Registry(ConfigStore.load(configPath))
  assert.equal(reg2.customSources().length, 1)
  assert.equal(reg2.customSources()[0].name, 'My Fork')
})

test('two engines from the same repo but different branches are both discoverable', () => {
  const { reg, store } = freshRegistry()
  // Seed two engines built from the same repo but different branches — mirrors what the
  // build endpoint does after a successful compile (registry.add + activate).
  store.update((c) => {
    c.engines.push(
      { id: 'e1', name: 'Llama-main', binPath: '/build/main/llama-server', kind: 'llama-server',
        version: '1.0', capabilities: { kvTypes: [], flags: [] }, addedAt: new Date().toISOString(),
        sourceRepo: 'https://github.com/ggml-org/llama.cpp', sourceBranch: 'main' },
      { id: 'e2', name: 'Llama-my-feature', binPath: '/build/my-feature/llama-server', kind: 'llama-server',
        version: '1.0', capabilities: { kvTypes: [], flags: [] }, addedAt: new Date().toISOString(),
        sourceRepo: 'https://github.com/ggml-org/llama.cpp', sourceBranch: 'my-feature' },
    )
  })
  const list = reg.list()
  assert.equal(list.engines.length, 2)
  // Both names survive — they are distinct engines, not a replace-in-place.
  const names = list.engines.map((e) => e.name).sort()
  assert.deepEqual(names, ['Llama-main', 'Llama-my-feature'])
  // Both sourceBranch values are preserved.
  const byBranch = Object.fromEntries(list.engines.map((e) => [e.sourceBranch ?? '', e.name]))
  assert.equal(byBranch['main'], 'Llama-main')
  assert.equal(byBranch['my-feature'], 'Llama-my-feature')
})

test('the whole point: Disable (registry.remove) does NOT erase the recorded custom source', () => {
  const { reg, store } = freshRegistry()
  reg.recordCustomSource({ name: 'My Fork', binPath: '/build/my-fork/llama-server', kind: 'llama-server', sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main' })
  // Seed a matching LIVE registry entry directly (bypassing add()'s real probe() call, which
  // would fail on a fake binPath) — mirrors what actually happens: build completion / manual
  // add calls both registry.add AND recordCustomSource, so a live entry normally coexists.
  const engineId = 'test-engine-id'
  store.update((c) => {
    c.engines.push({
      id: engineId, name: 'My Fork', binPath: '/build/my-fork/llama-server', kind: 'llama-server',
      version: '1.0', capabilities: { kvTypes: [], flags: [] }, addedAt: new Date().toISOString(),
      sourceRepo: 'https://github.com/user/fork', sourceBranch: 'main',
    })
  })
  reg.remove(engineId) // Disable
  // The remembered identity must survive — this is the record a catalog engine gets for free
  // from its fixed homepage URL; a custom repo has no other memory of it.
  const sources = reg.customSources()
  assert.equal(sources.length, 1)
  assert.equal(sources[0].sourceRepo, 'https://github.com/user/fork')
  // And the live engine is genuinely gone (Disable did its job).
  assert.equal(reg.list().engines.length, 0)
})
