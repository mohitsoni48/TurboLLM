// A release-installed engine remembers which GitHub release asset it is (ADR-453), so the update
// check needs no disk reads. This is the registry/config half: persist, replace, round-trip.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore, type Engine } from '../config/config'
import type { ReleaseProvenance } from './release-install'
import { NotFoundError, Registry } from './registry'
import { tmpDir } from '../test-support/tmp'

const PROVENANCE: ReleaseProvenance = {
  repo: 'PrismML-Eng/llama.cpp',
  tag: 'prism-b10770-6684606',
  asset: 'llama-prism-b10770-6684606-bin-win-cuda-13.3-x64.zip',
  assetKey: 'llama-bin-win-cuda-13.3-x64.zip',
  publishedAt: '2026-09-25T10:00:00Z',
  prerelease: false,
  companions: ['cudart-llama-bin-win-cuda-13.3-x64.zip'],
}

function freshRegistry(): { reg: Registry; store: ConfigStore; configPath: string } {
  const configPath = join(tmpDir('tllm-release-reg-'), 'config.json')
  const store = ConfigStore.load(configPath)
  return { reg: new Registry(store), store, configPath }
}

function seedEngine(store: ConfigStore, extra: Partial<Engine> = {}): void {
  store.update((c) => {
    c.engines.push({
      id: 'e1', name: 'Prism', binPath: '/x/llama-server', kind: 'llama-server', version: 'b1',
      capabilities: { kvTypes: [], flags: [] }, addedAt: new Date().toISOString(), ...extra,
    })
  })
}

// `node --version` stands in for a llama-server: probe() only needs a runnable binary.
const RUNNABLE_BINARY = process.execPath

test('add with release provenance persists it on the engine', async () => {
  const { reg } = freshRegistry()
  const { engine } = await reg.add('Prism', RUNNABLE_BINARY, { release: PROVENANCE })
  assert.deepEqual(engine.release, PROVENANCE)
  assert.deepEqual(reg.get(engine.id)?.release, PROVENANCE)
})

test('add without release provenance leaves the key absent', async () => {
  const { reg } = freshRegistry()
  const { engine } = await reg.add('Plain', RUNNABLE_BINARY)
  assert.equal('release' in engine, false)
})

test('setRelease replaces the provenance of an existing engine', () => {
  const { reg, store } = freshRegistry()
  seedEngine(store, { release: PROVENANCE })
  const newer = { ...PROVENANCE, tag: 'prism-b10800-aaaa' }
  const out = reg.setRelease('e1', newer)
  assert.equal(out.release?.tag, 'prism-b10800-aaaa')
  assert.equal(reg.get('e1')?.release?.tag, 'prism-b10800-aaaa')
})

test('setRelease on an unknown id throws NotFoundError', () => {
  const { reg } = freshRegistry()
  assert.throws(() => reg.setRelease('nope', PROVENANCE), NotFoundError)
})

test('a config file carrying release round-trips through the normaliser unchanged', () => {
  const { store, configPath } = freshRegistry()
  seedEngine(store, { release: PROVENANCE })
  const reloaded = ConfigStore.load(configPath)
  assert.deepEqual(reloaded.snapshot().engines[0].release, PROVENANCE)
})
