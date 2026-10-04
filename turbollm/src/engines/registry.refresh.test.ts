// refresh() is the zip-upload update flow's registry half: a same-named re-upload replaced
// the files under a registered engine's build dir, and the registration must follow the new
// binary IN PLACE — keeping id, name and history — instead of a second add() that would put
// two engines on one binary (purging either deletes the files both use).
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { ConfigStore, type Engine } from '../config/config'
import { NotFoundError, Registry } from './registry'
import { tmpDir } from '../test-support/tmp'

function registryWith(engines: Partial<Engine>[]): Registry {
  const store = ConfigStore.load(join(tmpDir('tllm-refresh-'), 'config.json'))
  store.update((c) => {
    for (const e of engines) {
      c.engines.push({
        id: e.id ?? 'e1',
        name: e.name ?? 'My Fork',
        binPath: e.binPath ?? '/x/engines/build/myfork/llama-server',
        kind: 'llama-server',
        version: 'b4242',
        capabilities: { kvTypes: ['f16'], flags: ['--old-flag'], flagInfo: [] },
        ...e,
      } as Engine)
    }
  })
  return new Registry(store)
}

const PR = { version: 'b5000', capabilities: { kvTypes: ['f16', 'q8_0'], flags: ['--new-flag'], flagInfo: [] } }

test('refresh: updates version and capabilities in place, keeping id and name', () => {
  const dir = tmpDir('tllm-refresh-')
  try {
    const reg = registryWith([{ id: 'e1', name: 'My Fork' }])
    const out = reg.refresh('e1', PR)
    assert.equal(out.id, 'e1')
    assert.equal(out.name, 'My Fork', 'the name is kept — an update, not a new engine')
    assert.equal(out.version, 'b5000')
    assert.deepEqual(out.capabilities.flags, ['--new-flag'])
    assert.deepEqual(out.capabilities.kvTypes, ['f16', 'q8_0'])
    assert.equal(reg.get('e1')!.version, 'b5000', 'persisted, not just returned')
    assert.equal(reg.list().engines.length, 1, 'no second registration was created')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refresh: also re-points binPath when the caller supplies one', () => {
  const dir = tmpDir('tllm-refresh-')
  try {
    const reg = registryWith([{ id: 'e1', name: 'My Fork', binPath: '/old/path/llama-server' }])
    const out = reg.refresh('e1', PR, '/new/path/llama-server')
    assert.equal(out.binPath, '/new/path/llama-server')
    assert.equal(reg.get('e1')!.binPath, '/new/path/llama-server')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refresh: unknown id is a NotFoundError', () => {
  const dir = tmpDir('tllm-refresh-')
  try {
    assert.throws(() => registryWith([]).refresh('nope', PR), NotFoundError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
