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
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore, getModelProfile, type Engine } from '../config/config'
import { tmpDir } from '../test-support/tmp'
import { availableBackends, installedBackendBuild } from './download'
import { koboldcppAssetName, koboldcppBinPath } from './koboldcpp'
import { llamafileBinPath } from './llamafile'
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
    manager: { status: () => ({ state: 'stopped' }), currentOpts: () => null, stopAndWait: async () => {} },
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

// The llama.cpp branch read "was the old build active" before stopping what runs on it. Stopping a pool slot leaves
// the manager idle, so the activate route allows a switch meanwhile; that switch must survive the update.
test('llama.cpp update of the active engine keeps a switch the user made while its pool slots stopped', { skip: posixOnly }, async (t) => {
  const { d, newDir, oldEngine } = llamaCppUpdate(t, WORKING_SERVER)
  d.registry.activate('old')
  d.modelRouter = { stopPoolSlotsOnEngine: async () => { d.registry.activate('cuda') }, poolSlotsOnEngine: () => 0 }
  await applyEngineUpdate(d, oldEngine)
  assert.equal(d.registry.active()?.id, 'cuda')
  assert.ok(d.registry.list().engines.some((e) => e.binPath === join(newDir, 'llama-server')), 'the update still happened')
})

// Disabling or Deleting the selected engine leaves none selected (Registry.remove). The new build, registered under a
// new id, filled that empty selection: the scheduler's auto-update of a backend merely installed made it the selected
// engine, and the next automatic load ran on it.
test('llama.cpp update with no engine selected leaves none selected', { skip: posixOnly }, async (t) => {
  const { d, newDir, oldEngine } = llamaCppUpdate(t, WORKING_SERVER)
  d.registry.remove('cuda') // the selected engine, Disabled
  await applyEngineUpdate(d, oldEngine)
  assert.ok(d.registry.list().engines.some((e) => e.binPath === join(newDir, 'llama-server')), 'the new build is registered')
  assert.equal(d.registry.get('old'), undefined, 'the old build is unregistered')
  assert.equal(d.registry.active(), undefined, 'the new build is not selected')
})

test('llama.cpp update started by the user is recorded as user_update', { skip: posixOnly }, async (t) => {
  const { d, oldEngine } = llamaCppUpdate(t, WORKING_SERVER)
  const starts: string[] = []
  d.provision = { start: (_b: string, trigger: string) => { starts.push(trigger) }, progress() {}, done() {}, fail() {} } as unknown as UpdateApplyDeps['provision']
  await applyEngineUpdate({ ...d, trigger: 'user_update' }, oldEngine)
  assert.deepEqual(starts, ['user_update'])
})

test('llama.cpp update whose new build fails its probe: the new build is removed, the working one stays installed', { skip: posixOnly }, async (t) => {
  const { d, root, newDir, oldEngine } = llamaCppUpdate(t, BROKEN_SERVER)
  await assert.rejects(applyEngineUpdate(d, oldEngine))
  assert.equal(existsSync(newDir), false)
  assert.equal(installedBackendBuild(root, backend.id)?.tag, 'b100')
  assert.ok(d.registry.get('old'))
})

// Once the new build is registered (and active, if the old one was), the update has happened: a Windows AV/indexer
// lock on the replaced build's folder must not report it as failed with "your existing build is unchanged".
// update-apply.ts imports rmSync by name: syncBuiltinESMExports carries the patch to that binding.
test('llama.cpp update whose old build folder is locked still ends in done(); the folder is left behind', { skip: posixOnly }, async (t) => {
  const { d, root, newDir, oldEngine } = llamaCppUpdate(t, WORKING_SERVER)
  d.registry.activate('old')
  const log: string[] = []
  d.provision = { start() {}, progress() {}, done: () => { log.push('done') }, fail: (m: string) => { log.push(`fail:${m}`) } } as unknown as UpdateApplyDeps['provision']
  const oldDir = dirname(oldEngine.binPath)
  const realRmSync = fs.rmSync
  const locked = t.mock.method(fs, 'rmSync', (p: fs.PathLike, o?: fs.RmOptions) => {
    if (String(p) === oldDir) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    return realRmSync(p, o)
  })
  syncBuiltinESMExports()
  try {
    await applyEngineUpdate(d, oldEngine)
  } finally {
    locked.mock.restore()
    syncBuiltinESMExports()
  }
  assert.deepEqual(log, ['done'])
  assert.equal(d.registry.active()?.binPath, join(newDir, 'llama-server'))
  assert.equal(installedBackendBuild(root, backend.id)?.tag, 'b200')
  assert.ok(existsSync(oldDir), 'the locked old build is left behind')
  const oldDirDelete = locked.mock.calls.find((c) => String(c.arguments[0]) === oldDir)
  assert.ok((oldDirDelete?.arguments[1] as fs.RmOptions | undefined)?.maxRetries, 'the delete retries, as a Windows lock is brief')
})

// Same, for the update policy the new build inherits: its config.json save can be refused by a Windows lock too.
test('llama.cpp update whose policy copy cannot be saved still ends in done(), and the old build is still removed', { skip: posixOnly }, async (t) => {
  const { d, root, newDir, oldEngine } = llamaCppUpdate(t, WORKING_SERVER)
  d.registry.activate('old')
  const log: string[] = []
  d.provision = { start() {}, progress() {}, done: () => { log.push('done') }, fail: (m: string) => { log.push(`fail:${m}`) } } as unknown as UpdateApplyDeps['provision']
  t.mock.method(d.registry, 'setUpdatePolicy', () => { throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }) })
  await applyEngineUpdate(d, oldEngine)
  assert.deepEqual(log, ['done'])
  assert.equal(d.registry.active()?.binPath, join(newDir, 'llama-server'))
  assert.equal(d.registry.get('old'), undefined, 'the old build is unregistered')
  assert.equal(existsSync(dirname(oldEngine.binPath)), false, 'the old build is deleted')
  assert.equal(installedBackendBuild(root, backend.id)?.tag, 'b200')
})

// The new build is a new engine id (its own tag-keyed folder), and the old id is unregistered. Everything saved under
// the old id stayed there: each model's tune (auto-tune's too), the presets tuned on it (a pinned one stopped applying)
// and the startup resume, so the next load on the updated backend ran untuned defaults; a name the user gave the
// backend went back to "llama.cpp b<tag> (<backend>)".
test('llama.cpp update carries the old build\'s profiles, presets, last-loaded record and custom name over to the new build', { skip: posixOnly }, async (t) => {
  for (const [name, expectedName] of [
    ['My CUDA build', 'My CUDA build'],
    [`llama.cpp b100 (${backend.id})`, `llama.cpp b200 (${backend.id})`], // the default name follows the new tag
  ]) {
    const { d, newDir, oldEngine } = llamaCppUpdate(t, WORKING_SERVER)
    d.registry.rename('old', name)
    const at = '2026-02-01T00:00:00Z'
    d.store.update((c) => {
      c.modelProfiles = {
        m: { old: { profile: { ctx: 8192 }, updatedAt: at }, cuda: { profile: { ctx: 4096 }, updatedAt: '2026-01-01T00:00:00Z' } },
        n: { old: { profile: { ctx: 2048 }, updatedAt: at } },
      }
      c.modelPresets = {
        m: [
          { id: 'tuned', name: 'Tuned', engineId: 'old', profile: { ctx: 16384 }, updatedAt: at, origin: 'autotune' },
          { id: 'any', name: 'Any', engineId: '', profile: { ctx: 1024 }, updatedAt: at, origin: 'manual' },
          { id: 'other', name: 'Other', engineId: 'cuda', profile: { ctx: 512 }, updatedAt: at, origin: 'manual' },
        ],
      }
      c.lastPresetId = { m: 'tuned' }
      c.lastLoaded = { modelKey: 'm', engineId: 'old' }
    })
    await applyEngineUpdate(d, oldEngine)
    const updated = d.registry.list().engines.find((e) => e.binPath === join(newDir, 'llama-server'))!
    assert.ok(updated && updated.id !== 'old', 'the new build is a new engine')
    const cfg = d.store.snapshot()
    assert.deepEqual(Object.keys(cfg.modelProfiles.m!).sort(), ['cuda', updated.id].sort(), name)
    assert.deepEqual(cfg.modelProfiles.m![updated.id]?.profile, { ctx: 8192 })
    assert.deepEqual(cfg.modelProfiles.n, { [updated.id]: { profile: { ctx: 2048 }, updatedAt: at } })
    assert.deepEqual(cfg.modelPresets.m!.map((p) => p.engineId), [updated.id, '', 'cuda'])
    assert.deepEqual(getModelProfile(cfg, 'm', updated.id), { ctx: 16384 }, 'the pinned preset still applies')
    assert.deepEqual(cfg.lastLoaded, { modelKey: 'm', engineId: updated.id })
    assert.equal(updated.name, expectedName)
    assert.equal(updated.updatePolicy, 'auto')
  }
})

// The scheduler passes workBusy: an auto-update must not start while another engine job (a download, build, zip upload
// or manual update) holds the engine-work slot. It would take over that job's progress and Cancel, and could write the
// same build folder. It returns quietly, as the release branch does; the next scheduler pass retries.
test('an auto-update with the engine-work slot taken starts nothing, whatever the update source', async (t) => {
  const fetched: string[] = []
  stubFetch(t, (url) => { fetched.push(url); return new Response(null, { status: 500 }) })
  const cases: Array<[string, (root: string) => Engine]> = [
    ['llama.cpp', (root) => engine({ id: 'llama', binPath: join(root, 'llama.cpp-b100-cpu', 'llama-server') })],
    ['turboquant', (root) => engine({ id: 'turboquant', binPath: join(root, 'turboquant', 'llama-server') })],
    ['koboldcpp', (root) => engine({ id: 'koboldcpp', kind: 'koboldcpp', binPath: koboldcppBinPath(root), version: 'v1.0.0' })],
    ['llamafile', (root) => engine({ id: 'llamafile', kind: 'llamafile', binPath: llamafileBinPath(root), version: '0.9.0' })],
    ['vllm', (root) => engine({ id: 'vllm', kind: 'vllm', binPath: join(root, 'vllm', 'venv', 'bin', 'python') })],
  ]
  for (const [id, make] of cases) {
    const { d } = setup((root) => [make(root)])
    const starts: string[] = []
    d.provision = { start: (b: string) => { starts.push(b) }, progress() {}, done() {}, fail() {} } as unknown as UpdateApplyDeps['provision']
    await applyEngineUpdate({ ...d, workBusy: () => 'A build is in progress — wait for it to finish.' }, d.registry.list().engines.find((e) => e.id !== 'cuda')!)
    assert.deepEqual(starts, [], id)
  }
  assert.deepEqual(fetched, [], 'not even the GitHub lookup runs')
})

// The scheduler lists its engines, then checks each one's status on GitHub holding no slot: a Delete, Disable or Purge
// in that check left nothing for workBusy, and the update then downloaded and registered again the engine just removed.
test('an auto-update of an engine removed after the scheduler listed it starts nothing', async (t) => {
  const fetched: string[] = []
  stubFetch(t, (url) => { fetched.push(url); return new Response(null, { status: 500 }) })
  const cases: Array<[string, (root: string) => Engine]> = [
    ['llama.cpp', (root) => engine({ id: 'llama', binPath: join(root, 'llama.cpp-b100-cpu', 'llama-server') })],
    ['turboquant', (root) => engine({ id: 'turboquant', binPath: join(root, 'turboquant', 'llama-server') })],
    ['koboldcpp', (root) => engine({ id: 'koboldcpp', kind: 'koboldcpp', binPath: koboldcppBinPath(root), version: 'v1.0.0' })],
    ['llamafile', (root) => engine({ id: 'llamafile', kind: 'llamafile', binPath: llamafileBinPath(root), version: '0.9.0' })],
  ]
  for (const [id, make] of cases) {
    const { d, root } = setup(() => []) // the scheduler's copy of the engine is all that is left of it
    const starts: string[] = []
    d.provision = { start: (b: string) => { starts.push(b) }, progress() {}, done() {}, fail() {} } as unknown as UpdateApplyDeps['provision']
    await assert.doesNotReject(applyEngineUpdate({ ...d, workBusy: () => null }, make(root)), id)
    assert.deepEqual(starts, [], id)
  }
  assert.deepEqual(fetched, [], 'not even the GitHub lookup runs')
})

test('a llama.cpp auto-update whose GitHub lookup let another engine job take the slot starts nothing', { skip: posixOnly }, async (t) => {
  const { d, oldEngine } = llamaCppUpdate(t, WORKING_SERVER)
  let busy: string | null = null
  stubFetch(t, () => {
    busy = 'An engine download is in progress — wait for it to finish.'
    return new Response(JSON.stringify([{ tag_name: 'b200' }, { tag_name: 'b100' }]))
  })
  const starts: string[] = []
  d.provision = { start: (b: string) => { starts.push(b) }, progress() {}, done() {}, fail() {} } as unknown as UpdateApplyDeps['provision']
  await applyEngineUpdate({ ...d, workBusy: () => busy }, oldEngine)
  assert.deepEqual(starts, [])
  assert.ok(d.registry.get('old'), 'the installed build is untouched')
})

// The scheduler holds no slot during its lookup, and a backend Delete with no engine to stop is over within it: it
// left nothing for workBusy to see, and the update then downloaded and registered the backend the user had deleted.
test('a llama.cpp auto-update whose GitHub lookup saw the backend deleted registers nothing', { skip: posixOnly }, async (t) => {
  const { d, oldEngine } = llamaCppUpdate(t, WORKING_SERVER)
  stubFetch(t, () => {
    d.registry.remove('old') // DELETE /engines/backends/:id meanwhile
    fs.rmSync(dirname(oldEngine.binPath), { recursive: true, force: true })
    return new Response(JSON.stringify([{ tag_name: 'b200' }, { tag_name: 'b100' }]))
  })
  const starts: string[] = []
  d.provision = { start: (b: string) => { starts.push(b) }, progress() {}, done() {}, fail() {} } as unknown as UpdateApplyDeps['provision']
  await applyEngineUpdate({ ...d, workBusy: () => null }, oldEngine)
  assert.deepEqual(starts, [])
  assert.deepEqual(d.registry.list().engines.map((e) => e.id), ['cuda'], 'the deleted backend is not registered again')
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

/** A TurboQuant release listing for this OS whose one asset is `archive` (a tar.gz holding a llama-server script). */
function stubTurboquantRelease(t: { after: (fn: () => void) => void }, archive: string): void {
  const osTag = process.platform === 'darwin' ? 'macos' : 'linux'
  const asset = `llama-b200-bin-${osTag}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`
  stubFetch(t, (url) =>
    url.includes('api.github.com')
      ? new Response(JSON.stringify([{ tag_name: `b200-${osTag}`, assets: [{ name: asset, browser_download_url: `https://cdn.test/${asset}` }] }]))
      : new Response(readFileSync(archive)),
  )
}

test('TurboQuant update re-probes the engine it keeps: the new build\'s version replaces the old one', {
  skip: process.platform === 'win32' && 'TurboQuant has no Windows prebuilt; shell-script binaries',
}, async (t) => {
  const bin = (root: string) => join(root, 'turboquant', 'llama-server')
  const { d, root } = setup((root) => [engine({ id: 'tq', binPath: bin(root), version: '100 (old1234)' })])
  writeExe(bin(root), '#!/bin/sh\necho "version: 100 (old1234)"\n')
  const src = tmpDir('tllm-tq-src-')
  writeExe(join(src, 'llama-server'), WORKING_SERVER)
  const archive = join(tmpDir('tllm-tq-'), 'tq.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', src, 'llama-server'])
  stubTurboquantRelease(t, archive)
  await applyEngineUpdate(d, d.registry.get('tq')!)
  assert.equal(readFileSync(bin(root), 'utf8'), WORKING_SERVER)
  assert.equal(d.registry.get('tq')?.version, '200 (abcdef1)')
  assert.deepEqual(d.registry.list().engines.filter((e) => e.binPath === bin(root)).map((e) => e.id), ['tq'])
})

// provisionTurboquant swapped the new release in and deleted the old build before anything ran the new binary; the
// re-probe came after. A new build that does not run here (a missing Vulkan loader) stayed in place under the old
// build's version string, so the same update kept being offered, and an `auto` engine downloaded it again every day.
test('a TurboQuant update whose new build fails its probe puts the old build back and keeps its version', {
  skip: process.platform === 'win32' && 'TurboQuant has no Windows prebuilt; shell-script binaries',
}, async (t) => {
  const OLD_SERVER = '#!/bin/sh\necho "version: 100 (old1234)"\n'
  const bin = (root: string) => join(root, 'turboquant', 'llama-server')
  const { d, root } = setup((root) => [engine({ id: 'tq', binPath: bin(root), version: '100 (old1234)' })])
  writeExe(bin(root), OLD_SERVER)
  const src = tmpDir('tllm-tq-src-')
  writeExe(join(src, 'llama-server'), BROKEN_SERVER)
  const archive = join(tmpDir('tllm-tq-'), 'tq.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', src, 'llama-server'])
  stubTurboquantRelease(t, archive)
  const log: string[] = []
  d.provision = { start() {}, progress() {}, done: () => { log.push('done') }, fail: (m: string) => { log.push(`fail:${m}`) } } as unknown as UpdateApplyDeps['provision']
  await assert.rejects(applyEngineUpdate(d, d.registry.get('tq')!), /Could not run the binary/)
  assert.equal(log.length, 1)
  assert.match(log[0]!, /^fail:Could not update TurboQuant — your existing build is unchanged: Could not run the binary/)
  assert.equal(readFileSync(bin(root), 'utf8'), OLD_SERVER, 'the old build is back in place')
  assert.equal(d.registry.get('tq')?.version, '100 (old1234)')
  assert.deepEqual(fs.readdirSync(root), ['turboquant'], 'neither the new build nor a parked copy is left behind')
})

// A release that moves the binary (bin/llama-server instead of llama-server at the archive root) lands at another path,
// so the entry was looked up by the NEW path, not found, and a second "TurboQuant" was added: refused as a taken name
// after the old build was already deleted, or, for an engine the user had renamed, registered beside an entry left
// pointing at a deleted binary. The kept entry is the updated engine's, moved to the new path.
test('a TurboQuant update whose binary moved within the archive moves the engine to it', {
  skip: process.platform === 'win32' && 'TurboQuant has no Windows prebuilt; shell-script binaries',
}, async (t) => {
  for (const name of ['TurboQuant', 'My TQ']) {
    const bin = (root: string) => join(root, 'turboquant', 'llama-server')
    const { d, root } = setup((root) => [engine({ id: 'tq', name, binPath: bin(root), version: '100 (old1234)', updatePolicy: 'auto' })])
    writeExe(bin(root), '#!/bin/sh\necho "version: 100 (old1234)"\n')
    const src = tmpDir('tllm-tq-src-')
    writeExe(join(src, 'bin', 'llama-server'), WORKING_SERVER)
    const archive = join(tmpDir('tllm-tq-'), 'tq.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', src, 'bin'])
    stubTurboquantRelease(t, archive)
    d.registry.activate('tq')
    await applyEngineUpdate(d, d.registry.get('tq')!)
    const moved = join(root, 'turboquant', 'bin', 'llama-server')
    assert.deepEqual(d.registry.list().engines.map((e) => e.id), ['cuda', 'tq'], `${name}: no second entry`)
    const eng = d.registry.get('tq')
    assert.equal(eng?.binPath, moved, name)
    assert.equal(eng?.version, '200 (abcdef1)', name)
    assert.equal(eng?.name, name)
    assert.equal(eng?.updatePolicy, 'auto', name)
    assert.equal(d.registry.active()?.id, 'tq', name)
    assert.equal(existsSync(bin(root)), false, `${name}: the old build is replaced`)
  }
})

// The KoboldCpp, llamafile, TurboQuant and pip branches read "is it the active engine" before the download or pip
// upgrade (minutes), and re-activated the updated engine from that snapshot afterwards. The activate route allows a
// switch while no model runs, so a switch the user made during the update was silently undone. Here the switch is made
// from the update's own progress callback, i.e. mid-download. vLLM stands for the pip kinds (MLX and its siblings need
// macOS): its uv and venv python are shell scripts, so `uv pip install -U` and the version probe run instantly.
function switchableUpdates(t: { after: (fn: () => void) => void }): Array<[string, (root: string) => Engine, (root: string) => void]> {
  const cases: Array<[string, (root: string) => Engine, (root: string) => void]> = []
  if (process.platform === 'win32') return cases // shell-script binaries
  if (koboldcppAssetName(false) || koboldcppAssetName(true)) {
    cases.push(['kobold', (root) => engine({ id: 'kobold', kind: 'koboldcpp', binPath: koboldcppBinPath(root), version: 'v1.0.0' }), (root) => {
      writeExe(koboldcppBinPath(root), 'kobold v1')
      stubFetch(t, (url) => (url.includes('api.github.com') ? new Response(JSON.stringify({ tag_name: 'v2.0.0', assets: ALL_KOBOLD_ASSETS })) : new Response('kobold v2')))
    }])
  }
  cases.push(['llamafile', (root) => engine({ id: 'llamafile', kind: 'llamafile', binPath: llamafileBinPath(root), version: '0.9.0' }), (root) => {
    writeExe(llamafileBinPath(root), 'llamafile v1')
    const assets = [{ name: 'llamafile-0.9.3', browser_download_url: 'https://dl.test/llamafile-0.9.3' }]
    stubFetch(t, (url) => (url.includes('api.github.com') ? new Response(JSON.stringify({ tag_name: '0.9.3', assets })) : new Response('llamafile v2')))
  }])
  cases.push(['tq', (root) => engine({ id: 'tq', binPath: join(root, 'turboquant', 'llama-server'), version: '100 (old1234)' }), (root) => {
    writeExe(join(root, 'turboquant', 'llama-server'), '#!/bin/sh\necho "version: 100 (old1234)"\n')
    const src = tmpDir('tllm-tq-src-')
    writeExe(join(src, 'llama-server'), WORKING_SERVER)
    const archive = join(tmpDir('tllm-tq-'), 'tq.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', src, 'llama-server'])
    stubTurboquantRelease(t, archive)
  }])
  cases.push(['vllm', (root) => engine({ id: 'vllm', kind: 'vllm', binPath: join(root, 'vllm', 'venv', 'bin', 'python'), version: 'vllm 0.9.0' }), (root) => {
    writeExe(join(root, 'uv', 'uv'), '#!/bin/sh\nexit 0\n')
    writeExe(join(root, 'vllm', 'venv', 'bin', 'python'), '#!/bin/sh\necho 0.9.1\n')
  }])
  return cases
}

test('an update keeps an engine switch the user made while it downloaded (KoboldCpp, llamafile, TurboQuant, pip)', { skip: posixOnly }, async (t) => {
  const cases = switchableUpdates(t)
  assert.ok(cases.length >= 3)
  for (const [id, make, stage] of cases) {
    const { d, root } = setup((root) => [make(root)])
    stage(root)
    d.registry.activate(id) // active when the update starts
    let switched = false
    d.provision = {
      start() {},
      progress: () => { if (!switched) { switched = true; d.registry.activate('cuda') } }, // the user picks another engine
      done() {},
      fail: (m: string) => { throw new Error(m) },
    } as unknown as UpdateApplyDeps['provision']
    await applyEngineUpdate(d, d.registry.get(id)!)
    assert.ok(switched, `${id}: the switch happened during the update`)
    assert.equal(d.registry.active()?.id, 'cuda', `${id}: the engine the user switched to stays active`)
  }
})

test('an update of the active KoboldCpp, llamafile, TurboQuant or pip engine keeps it active', { skip: posixOnly }, async (t) => {
  for (const [id, make, stage] of switchableUpdates(t)) {
    const { d, root } = setup((root) => [make(root)])
    stage(root)
    d.registry.activate(id)
    await applyEngineUpdate(d, d.registry.get(id)!)
    assert.equal(d.registry.active()?.id, id, id)
    assert.notEqual(d.registry.get(id)?.version, make(root).version, `${id}: it was updated`)
  }
})

// These branches stop what runs on the engine before the download, but the download takes minutes and nothing stopped
// the user from loading a model on it meanwhile. The swap then replaced the binary under the running model: on Windows
// the rename fails with an opaque EPERM after ~3 s. The release branch re-checks at the swap; so do these now, with the
// same "Stop ... before replacing its files" message, and the old binary stays.
test('a model started on a KoboldCpp, llamafile or TurboQuant engine during its update download blocks the swap', { skip: posixOnly }, async (t) => {
  const cases = switchableUpdates(t).filter(([id]) => id !== 'vllm')
  assert.ok(cases.length >= 2)
  for (const [id, make, stage] of cases) {
    const { d, root } = setup((root) => [make(root)])
    stage(root)
    const before = readFileSync(make(root).binPath, 'utf8')
    let running = false
    d.manager = {
      status: () => ({ state: running ? 'running' : 'stopped' }),
      currentOpts: () => (running ? { engine: d.registry.get(id) } : null),
      stopAndWait: async () => { running = false },
    } as unknown as UpdateApplyDeps['manager']
    const log: string[] = []
    d.provision = {
      start() {},
      progress: () => { running = true }, // the user loads a model on the engine mid-download
      done: () => { log.push('done') },
      fail: (m: string) => { log.push(`fail:${m}`) },
    } as unknown as UpdateApplyDeps['provision']
    await assert.rejects(applyEngineUpdate(d, d.registry.get(id)!), new RegExp(`Stop "${id}" before replacing its files`), id)
    assert.equal(log.length, 1, id)
    assert.match(log[0]!, new RegExp(`^fail:.*Stop "${id}" before replacing its files`), id)
    assert.equal(readFileSync(make(root).binPath, 'utf8'), before, `${id}: the binary the model runs is not replaced`)
    assert.equal(d.registry.get(id)?.version, make(root).version, id)
  }
})

// POST /engines/:id/update reaches these branches with the user's trigger and a Cancel signal (the scheduler passes
// neither). A Cancel is a quiet done(), never a failed update, and the run is recorded as the caller's trigger.
test('a cancelled KoboldCpp, llamafile or TurboQuant update ends in done() with the caller\'s trigger, never fail()', async (t) => {
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError')
    return new Response(null, { status: 500 })
  }) as typeof fetch
  const cancelled = new AbortController()
  cancelled.abort()
  const cases: Array<[string, (root: string) => Engine]> = [
    ['koboldcpp', (root) => engine({ id: 'koboldcpp', kind: 'koboldcpp', binPath: koboldcppBinPath(root), version: 'v1.0.0' })],
    ['llamafile', (root) => engine({ id: 'llamafile', kind: 'llamafile', binPath: llamafileBinPath(root), version: '0.9.0' })],
  ]
  // TurboQuant has no Windows prebuilt: there it fails before any request, so there is nothing to cancel.
  if (process.platform !== 'win32') cases.push(['turboquant', (root) => engine({ id: 'turboquant', binPath: join(root, 'turboquant', 'llama-server') })])
  for (const [id, make] of cases) {
    const { d } = setup((root) => [make(root)])
    const log: string[] = []
    d.provision = {
      start: (backend: string, trigger: string) => { log.push(`start:${backend}:${trigger}`) },
      progress() {},
      done: () => { log.push('done') },
      fail: (m: string) => { log.push(`fail:${m}`) },
    } as unknown as UpdateApplyDeps['provision']
    await assert.rejects(applyEngineUpdate({ ...d, trigger: 'user_update' }, d.registry.get(id)!, cancelled.signal), (e: Error) => e.name === 'AbortError', id)
    assert.deepEqual(log, [`start:${id}:user_update`, 'done'], id)
  }
})

test('a custom llama-server with no release provenance has no automatic update source', async () => {
  const custom = { id: 'c1', name: 'Custom', kind: 'llama-server', binPath: '/opt/custom/llama-server' } as Engine
  const deps = { store: { dir: () => 'unused' }, registry: { get: () => custom } } as unknown as UpdateApplyDeps
  await assert.rejects(applyEngineUpdate(deps, custom), /no automatic update source/)
})
