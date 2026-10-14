// applyEngineUpdate end to end, without the network: GitHub is a stubbed fetch, and the new
// llama.cpp build is pre-staged on disk with its completion marker, which provisionBackend's
// fast path hands back as if just downloaded. The binaries are shell scripts (POSIX only).
//  - The scheduler also auto-updates engines that are merely installed: the update must not make
//    them the active engine, and the new build (a new engine id) must keep the `auto` policy.
//  - A new build that fails its probe must not stay on disk, where the newest-tag-wins lookups
//    would pick it over the working build.
// Also: the dispatch for engines without an automatic update source. The release branch is
// covered in update-apply.release.test.ts.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore, type Engine } from '../config/config'
import { tmpDir } from '../test-support/tmp'
import { availableBackends, installedBackendBuild } from './download'
import { koboldcppAssetName, koboldcppBinPath } from './koboldcpp'
import { Registry } from './registry'
import { applyEngineUpdate, type UpdateApplyDeps } from './update-apply'

const backend = availableBackends()[0]!
const posixOnly = (process.platform === 'win32' || !backend) && 'uses shell-script engine binaries and a llama.cpp backend for this OS'
const WORKING_SERVER = '#!/bin/sh\necho "version: 200 (abcdef1)"\necho "  --cache-type-k TYPE"\n'
const BROKEN_SERVER = '#!/bin/sh\necho "error while loading shared libraries: libvulkan.so.1" >&2\nexit 127\n'

const realFetch = globalThis.fetch
function stubFetch(t: { after: (fn: () => void) => void }, handle: (url: string) => Response): void {
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async (url: string | URL | Request) => handle(url instanceof Request ? url.url : String(url))) as typeof fetch
}

function writeExe(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o755)
}

function engine(e: Partial<Engine> & Pick<Engine, 'id' | 'binPath'>): Engine {
  return { name: e.id, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '2026-01-01T00:00:00Z', ...e }
}

/** A daemon whose active engine is an unrelated CUDA build, plus `engines` (built from the engines root). */
function setup(engines: (root: string) => Engine[]): { d: UpdateApplyDeps; root: string } {
  const store = ConfigStore.load(join(tmpDir('tllm-update-apply-'), 'config.json'))
  const root = join(store.dir(), 'engines')
  store.update((c) => {
    c.engines.push(engine({ id: 'cuda', binPath: '/opt/cuda/llama-server' }), ...engines(root))
    c.activeEngineId = 'cuda'
  })
  const d = {
    store,
    registry: new Registry(store),
    manager: { currentOpts: () => null, stopAndWait: async () => {} },
    provision: { start() {}, progress() {}, done() {}, fail() {} },
  } as unknown as UpdateApplyDeps
  return { d, root }
}

/** The installed b100 build (registered, policy auto) and a pre-staged b200 build running `newServer`. */
function llamaCppUpdate(t: { after: (fn: () => void) => void }, newServer: string) {
  const oldBin = (root: string) => join(root, `llama.cpp-b100-${backend.id}`, 'llama-server')
  const { d, root } = setup((root) => [engine({ id: 'old', binPath: oldBin(root), version: '100 (1234567)', updatePolicy: 'auto' })])
  writeExe(oldBin(root), WORKING_SERVER)
  writeFileSync(join(dirname(oldBin(root)), '.turbollm-provisioned'), '')
  const newDir = join(root, `llama.cpp-b200-${backend.id}`)
  writeExe(join(newDir, 'llama-server'), newServer)
  writeFileSync(join(newDir, '.turbollm-provisioned'), '')
  stubFetch(t, () => new Response(JSON.stringify([{ tag_name: 'b200' }, { tag_name: 'b100' }])))
  return { d, root, newDir, oldEngine: d.registry.get('old')! }
}

test('llama.cpp update of an engine that is not the active one: it stays inactive and keeps its update policy', { skip: posixOnly }, async (t) => {
  const { d, newDir, oldEngine } = llamaCppUpdate(t, WORKING_SERVER)
  await applyEngineUpdate(d, oldEngine)
  const updated = d.registry.list().engines.find((e) => e.binPath === join(newDir, 'llama-server'))
  assert.ok(updated, 'the new build is registered')
  assert.equal(d.registry.get('old'), undefined, 'the old build is unregistered')
  assert.equal(d.registry.active()?.id, 'cuda', "the user's active engine is unchanged")
  assert.equal(updated.updatePolicy, 'auto', 'auto-update keeps applying after the first update')
})

test('llama.cpp update of the active engine: the new build becomes active', { skip: posixOnly }, async (t) => {
  const { d, newDir, oldEngine } = llamaCppUpdate(t, WORKING_SERVER)
  d.registry.activate('old')
  await applyEngineUpdate(d, oldEngine)
  assert.equal(d.registry.active()?.binPath, join(newDir, 'llama-server'))
})

test('llama.cpp update whose new build fails its probe: the new build is removed, the working one stays installed', { skip: posixOnly }, async (t) => {
  const { d, root, newDir, oldEngine } = llamaCppUpdate(t, BROKEN_SERVER)
  await assert.rejects(applyEngineUpdate(d, oldEngine))
  assert.equal(existsSync(newDir), false)
  assert.equal(installedBackendBuild(root, backend.id)?.tag, 'b100')
  assert.ok(d.registry.get('old'))
})

const ALL_KOBOLD_ASSETS = ['koboldcpp.exe', 'koboldcpp-nocuda.exe', 'koboldcpp-linux-x64', 'koboldcpp-linux-x64-nocuda', 'koboldcpp-mac-arm64']
  .map((name) => ({ name, browser_download_url: `https://dl.test/${name}` }))

test('KoboldCpp update: a failed download keeps the binary; an update never activates an engine that was not active', {
  skip: (posixOnly || (!koboldcppAssetName(false) && !koboldcppAssetName(true))) && 'no KoboldCpp asset / POSIX only',
}, async (t) => {
  const { d, root } = setup((root) => [engine({ id: 'kobold', kind: 'koboldcpp', binPath: koboldcppBinPath(root), version: 'v1.0.0', updatePolicy: 'auto' })])
  const bin = koboldcppBinPath(root)
  writeExe(bin, 'kobold v1')
  let download = () => new Response(null, { status: 503 })
  stubFetch(t, (url) => (url.includes('api.github.com') ? new Response(JSON.stringify({ tag_name: 'v2.0.0', assets: ALL_KOBOLD_ASSETS })) : download()))
  await assert.rejects(applyEngineUpdate(d, d.registry.get('kobold')!))
  assert.equal(readFileSync(bin, 'utf8'), 'kobold v1', 'the working binary is never deleted before the new one is fetched')

  download = () => new Response('kobold v2')
  await applyEngineUpdate(d, d.registry.get('kobold')!)
  assert.equal(readFileSync(bin, 'utf8'), 'kobold v2')
  assert.equal(d.registry.get('kobold')?.version, 'v2.0.0')
  assert.equal(d.registry.active()?.id, 'cuda')
})

test('a custom llama-server with no release provenance has no automatic update source', async () => {
  const deps = { store: { dir: () => 'unused' } } as unknown as UpdateApplyDeps
  const custom = { id: 'c1', name: 'Custom', kind: 'llama-server', binPath: '/opt/custom/llama-server' } as Engine
  await assert.rejects(applyEngineUpdate(deps, custom), /no automatic update source/)
})
