import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore } from '../config/config'
import { tmpDir } from '../test-support/tmp'
import { engineRequestHeaders } from './engine-headers'
import { Manager } from './manager'
import { Registry } from './registry'
import { checkStrataModel, strataCommand, strataPackages, STRATA_VERSION } from './strata'

test('the Strata installer requires a pinned control and GPU engine archive', () => {
  for (const [vendor, os, arch] of [
    ['nvidia', 'win32', 'x64'], ['nvidia', 'linux', 'x64'], ['nvidia', 'linux', 'arm64'], ['apple', 'darwin', 'arm64'],
  ] as const) {
    const assets = strataPackages(vendor, os, arch)
    assert.equal(assets?.length, 2)
    for (const asset of assets!) assert.match(asset.digest, /^[a-f0-9]{64}$/)
    assert.match(assets![1].name, /^strata-dsv41-/)
  }
  assert.equal(strataPackages('intel', 'linux', 'x64'), null)
  assert.equal(strataPackages('nvidia', 'win32', 'arm64'), null)
})

test('Strata receives the library path as one argument and has no credential in its command', () => {
  const model = '/models/a & b/weights.gguf'
  const { args } = strataCommand('/engines/control/strata.py', model, 'serve', 8123)
  assert.deepEqual(args.slice(-3), [model, '8123', '8192'])
})

// On a host provisioned from Engines, point these at control/strata.py and the first real library shard.
const binPath = process.env.TURBOLLM_STRATA_TEST_BIN
const modelPath = process.env.TURBOLLM_STRATA_TEST_GGUF
test('real Strata GPU streams, cancels a request, serves again and unloads', {
  skip: !(binPath && modelPath), timeout: 2 * 60 * 60_000,
}, async t => {
  const store = ConfigStore.load(join(tmpDir('strata-live-'), 'config.json'))
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const engine = new Registry(store).addStrata(binPath!, STRATA_VERSION)
  await checkStrataModel(engine.binPath, modelPath!)
  await manager.load({ engine, modelPath: modelPath!, model: { key: 'live', name: 'live', quant: '', ctx: 8192, vision: false }, extraArgs: [] })
  const target = manager.target()
  assert.ok(target, manager.status().err?.message)
  assert.equal((await fetch(target + '/v1/models')).status, 401)
  const headers = engineRequestHeaders('strata', new Headers({ 'content-type': 'application/json' }), undefined, target)
  const chat = (signal?: AbortSignal) => fetch(target + '/v1/chat/completions', {
    method: 'POST', headers, signal,
    body: JSON.stringify({ model: 'live', stream: true, max_tokens: 48, messages: [{ role: 'user', content: 'Name the capital of France.' }] }),
  })
  const abort = new AbortController()
  const first = await chat(abort.signal)
  assert.equal(first.status, 200)
  assert.ok((await first.body!.getReader().read()).value?.length)
  abort.abort()
  const second = await chat(AbortSignal.timeout(180_000))
  assert.equal(second.status, 200)
  const stream = await second.text()
  assert.match(stream, /"delta"/)
  assert.match(stream, /data: \[DONE\]/)
  await manager.stopAndWait()
  assert.equal(manager.status().state, 'stopped')
  await assert.rejects(fetch(target + '/health', { signal: AbortSignal.timeout(1500) }))
})
