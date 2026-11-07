// The first-run seed (seedDefaultEngines) installs and selects the default llama.cpp build once. It ran on every start
// that found no engine registered, so a user who had removed every engine (Disabled or Deleted the only one, or deleted
// a managed build's folder by hand, which the start unregisters) got the default build registered and selected again
// at the next start: the one left on disk, or a fresh download of several hundred MB. The next automatic load then ran
// on an engine the user never selected.
// The seed here runs for real (TURBOLLM_SEED_BACKEND=cpu), against a llama.cpp folder already provisioned on disk whose
// llama-server is a shell-script stand-in, so nothing is downloaded. POSIX only.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { ConfigStore, defaultConfig, type Engine } from '../config/config'
import { LLAMA_BUILD, fallbackChain } from './download'
import { ProvisionState } from './provision-state'
import { Registry } from './registry'
import { seedDefaultEngines } from './seed'
import { tmpDir } from '../test-support/tmp'

const posixOnly = process.platform === 'win32' && 'uses a shell-script stand-in for llama-server'
const WORKS = '#!/bin/sh\necho "version: 9608 (0123abc)"\n'
const FAILS = '#!/bin/sh\necho "libcuda.so.1: cannot open shared object file" >&2\nexit 127\n'

let savedBackend: string | undefined
beforeEach(() => {
  savedBackend = process.env.TURBOLLM_SEED_BACKEND
  process.env.TURBOLLM_SEED_BACKEND = 'cpu'
})
afterEach(() => {
  if (savedBackend === undefined) delete process.env.TURBOLLM_SEED_BACKEND
  else process.env.TURBOLLM_SEED_BACKEND = savedBackend
})

/** Every backend the cpu seed tries, provisioned on disk with `server` as its llama-server: the seed takes such a
 *  folder as it is (provisionBackend), so no download is attempted. */
function provision(enginesRoot: string, server: string): void {
  for (const backend of fallbackChain('cpu')) {
    const dir = join(enginesRoot, `llama.cpp-${LLAMA_BUILD}-${backend.id}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'llama-server'), server)
    chmodSync(join(dir, 'llama-server'), 0o755)
    writeFileSync(join(dir, '.turbollm-provisioned'), '{}')
  }
}

/** A daemon start: the config loaded from disk, and the seed run against it (cli.ts). */
async function boot(path: string): Promise<{ store: ConfigStore; registry: Registry }> {
  const store = ConfigStore.load(path)
  const registry = new Registry(store)
  await seedDefaultEngines(registry, join(store.dir(), 'engines'), new ProvisionState(), store)
  return { store, registry }
}

const SEEDED = `llama.cpp ${LLAMA_BUILD} (cpu)`

test('after the user removes every engine, the next start does not install the default build again', { skip: posixOnly }, async () => {
  const path = join(tmpDir('tllm-seed-'), 'config.json')
  provision(join(path, '..', 'engines'), WORKS)
  const first = await boot(path)
  const seeded = first.registry.active()
  assert.equal(seeded?.name, SEEDED, 'a first run installs and selects the default build, as before')

  first.registry.remove(seeded!.id) // the user Disables it
  const next = await boot(path)
  assert.deepEqual(next.registry.list().engines, [], 'nothing is registered for the user')
  assert.equal(next.registry.active(), undefined, 'and nothing is selected')
})

test('a config that already has an engine or a custom engine source is never seeded again once it has none', { skip: posixOnly }, async () => {
  for (const setUp of ['engine', 'custom source'] as const) {
    const path = join(tmpDir('tllm-seed-'), 'config.json')
    provision(join(path, '..', 'engines'), WORKS)
    // A config.json from before the seed was recorded: KoboldCpp registered and selected (or only a Disabled custom
    // build remembered), nothing on record about the seed.
    const cfg = defaultConfig() as unknown as Record<string, unknown>
    delete cfg.defaultEngineSeeded
    const kobold: Engine = {
      id: 'kobold', name: 'KoboldCpp', binPath: '/opt/koboldcpp/koboldcpp', kind: 'koboldcpp', version: '1.0',
      capabilities: { kvTypes: [], flags: [] }, addedAt: '',
    }
    if (setUp === 'engine') Object.assign(cfg, { engines: [kobold], activeEngineId: 'kobold' })
    else cfg.customEngineSources = [{ name: 'Fork', binPath: '/opt/fork/llama-server', kind: 'llama-server', addedAt: '' }]
    writeFileSync(path, JSON.stringify(cfg))

    const upgraded = await boot(path)
    assert.deepEqual(upgraded.registry.list().engines.map((e) => e.id), setUp === 'engine' ? ['kobold'] : [], setUp)
    if (setUp === 'engine') upgraded.registry.remove('kobold')
    const next = await boot(path)
    assert.deepEqual(next.registry.list().engines, [], `${setUp}: no default build is installed for the user`)
    assert.equal(next.registry.active(), undefined, setUp)
  }
})

test('a first run whose seed fails tries again at the next start', { skip: posixOnly }, async () => {
  const path = join(tmpDir('tllm-seed-'), 'config.json')
  const enginesRoot = join(path, '..', 'engines')
  provision(enginesRoot, FAILS) // offline, or no build that runs here
  const first = await boot(path)
  assert.deepEqual(first.registry.list().engines, [])

  provision(enginesRoot, WORKS)
  const next = await boot(path)
  assert.equal(next.registry.active()?.name, SEEDED, 'the next start seeds the default build')
})
