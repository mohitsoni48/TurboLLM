// A name clash used to say only "Name already in use — choose a different name.", and for a build it
// arrived AFTER the compile finished. The message now names the holder, and says why when the holder
// is another branch of the same repo (which is a separate engine by design, ADR-431).
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore, type Engine } from '../config/config'
import { NameTakenError, Registry } from './registry'
import { tmpDir } from '../test-support/tmp'

function registryWith(engines: Partial<Engine>[]): Registry {
  const store = ConfigStore.load(join(tmpDir('tllm-name-taken-'), 'config.json'))
  store.update((c) => {
    for (const e of engines) {
      c.engines.push({
        id: e.id ?? e.name ?? 'x',
        name: e.name ?? 'x',
        binPath: e.binPath ?? '/x/llama-server',
        kind: 'llama-server',
        version: '',
        capabilities: { kvTypes: [], flags: [] },
        ...e,
      } as Engine)
    }
  })
  return new Registry(store)
}

const REPO = 'https://github.com/PrismML-Eng/llama.cpp'

async function clashMessage(reg: Registry, name: string, source?: { sourceRepo?: string; sourceBranch?: string }): Promise<string> {
  try {
    await reg.add(name, '/never/probed/llama-server', source)
  } catch (e) {
    assert.ok(e instanceof NameTakenError, `expected NameTakenError, got ${String(e)}`)
    return e.message
  }
  assert.fail('expected add() to throw NameTakenError')
}

test('NameTakenError names the engine that already holds the name', async () => {
  const msg = await clashMessage(registryWith([{ name: 'Prism' }]), 'Prism')
  assert.match(msg, /Name already in use by "Prism"/)
  assert.match(msg, /choose a different name/i)
})

test('NameTakenError reports the holder under its stored spelling, whatever case or spacing was submitted', async () => {
  const msg = await clashMessage(registryWith([{ name: 'Prism Fork' }]), '  prism fork ')
  assert.match(msg, /Name already in use by "Prism Fork"/)
})

test('NameTakenError explains a different branch of the same repo is a separate engine that needs its own name', async () => {
  const reg = registryWith([{ name: 'Prism', sourceRepo: 'https://github.com/PrismML-Eng/llama.cpp.git', sourceBranch: 'main' }])
  const msg = await clashMessage(reg, 'Prism', { sourceRepo: REPO, sourceBranch: 'prism' })
  assert.match(msg, /branch "main"/)
  assert.match(msg, /"prism"/)
  assert.match(msg, /separate engine/i)
})

test('NameTakenError adds no branch explanation for an unrelated holder or an unknown branch', async () => {
  const unrelated = registryWith([{ name: 'Prism', sourceRepo: 'https://github.com/a/b', sourceBranch: 'main' }])
  assert.doesNotMatch(await clashMessage(unrelated, 'Prism', { sourceRepo: REPO, sourceBranch: 'prism' }), /separate engine/i)
  const blank = registryWith([{ name: 'Prism', sourceRepo: REPO, sourceBranch: '' }])
  assert.doesNotMatch(await clashMessage(blank, 'Prism', { sourceRepo: REPO, sourceBranch: 'prism' }), /separate engine/i)
})
