// GET /api/v1/engines/catalog: a catalog card owns a release-installed engine of its repo
// (ADR-453, founder decision). Pure matching rules are tested in engines/build-runner.test.ts;
// this file pins the wiring and the response fields (releaseEngineId / release / releaseBinPath).
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConfigStore, type CustomEngineSource, type Engine } from '../config/config'
import { Registry } from '../engines/registry'
import { writeReleaseMarker, type ReleaseProvenance } from '../engines/release-install'
import type { Deps } from '../deps'
import { registerApi } from './routes'
import { tmpDir } from '../test-support/tmp'

const serverExe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

function provenance(repo: string, tag = 'b1'): ReleaseProvenance {
  return { repo, tag, asset: 'a.zip', assetKey: 'a.zip', publishedAt: '2026-09-01T00:00:00Z', prerelease: false, companions: [] }
}

interface Harness {
  app: Hono
  enginesRoot: string
  cleanup: () => void
}

function harness(engines: (enginesRoot: string) => Array<Partial<Engine>>, sources: (enginesRoot: string) => CustomEngineSource[] = () => []): Harness {
  const dir = tmpDir('tllm-rel-catalog-')
  const store = ConfigStore.load(join(dir, 'config.json'))
  const enginesRoot = join(store.dir(), 'engines')
  store.update((c) => {
    for (const e of engines(enginesRoot)) {
      c.engines.push({
        id: e.id ?? 'e', name: e.name ?? 'e', binPath: e.binPath ?? '/x/llama-server', kind: 'llama-server',
        version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '2026-01-01T00:00:00Z', ...e,
      } as Engine)
    }
    c.customEngineSources.push(...sources(enginesRoot))
  })
  const d = {
    version: 'test',
    store,
    registry: new Registry(store),
    manager: { status: () => ({ state: 'stopped', model: null }), logPath: () => '' },
    provision: { get: () => ({ active: false }) },
    build: { isActive: () => false },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return { app, enginesRoot, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

interface CatalogItem {
  id: string
  installed?: boolean
  enabled?: boolean
  sourceBuilt?: boolean
  sourceEngineId?: string
  releaseEngineId?: string
  release?: { tag: string }
  releaseBinPath?: string
}

async function catalogItem(h: Harness, id: string, query = ''): Promise<CatalogItem> {
  const res = await h.app.request(`/api/v1/engines/catalog${query}`)
  assert.equal(res.status, 200)
  const item = ((await res.json()) as { engines: CatalogItem[] }).engines.find((e) => e.id === id)
  assert.ok(item, `catalog has no entry "${id}"`)
  return item
}

const PRISM = 'PrismML-Eng/llama.cpp'

test('a registered Prism release engine shows on the Prism card as installed and enabled', async () => {
  const h = harness(() => [{ id: 'rel', release: provenance(PRISM, 'prism-b1') }])
  try {
    const prism = await catalogItem(h, 'prism')
    assert.equal(prism.installed, true)
    assert.equal(prism.enabled, true)
    assert.equal(prism.releaseEngineId, 'rel')
    assert.equal(prism.release?.tag, 'prism-b1')
    assert.equal(prism.sourceBuilt, false)
    assert.equal(prism.sourceEngineId, undefined)
  } finally {
    h.cleanup()
  }
})

test('a source build of the default branch beats a release engine on the same card', async () => {
  const h = harness(() => [
    { id: 'rel', release: provenance(PRISM) },
    { id: 'src', sourceRepo: `https://github.com/${PRISM}`, sourceBranch: 'prism' },
  ])
  try {
    const prism = await catalogItem(h, 'prism')
    assert.equal(prism.sourceEngineId, 'src')
    assert.equal(prism.releaseEngineId, undefined)
  } finally {
    h.cleanup()
  }
})

test('a non-default branch request gets no release claim', async () => {
  const h = harness(() => [{ id: 'rel', release: provenance(PRISM) }])
  try {
    const prism = await catalogItem(h, 'prism', '?branch=master')
    assert.equal(prism.releaseEngineId, undefined)
    assert.notEqual(prism.installed, true)
  } finally {
    h.cleanup()
  }
})

test('BeeLlama is claimed by its own card and not by Prism', async () => {
  const h = harness(() => [{ id: 'bee', release: provenance('Anbeeld/beellama.cpp') }])
  try {
    assert.equal((await catalogItem(h, 'beellama')).releaseEngineId, 'bee')
    assert.equal((await catalogItem(h, 'prism')).releaseEngineId, undefined)
  } finally {
    h.cleanup()
  }
})

test('the llama.cpp, TurboQuant and Solar Open 2 cards never carry a release engine', async () => {
  const h = harness(() => [
    { id: 'o', release: provenance('ggml-org/llama.cpp') },
    { id: 't', release: provenance('AtomicBot-ai/atomic-llama-cpp-turboquant') },
  ])
  try {
    for (const id of ['llama.cpp', 'turboquant', 'solar-open2']) {
      assert.equal((await catalogItem(h, id)).releaseEngineId, undefined, id)
    }
  } finally {
    h.cleanup()
  }
})

function disabledPrismSource(enginesRoot: string, dirName: string, addedAt: string): CustomEngineSource {
  const dir = join(enginesRoot, 'build', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, serverExe), 'x')
  writeReleaseMarker(dir, provenance(PRISM))
  return { name: dirName, binPath: join(dir, serverExe), kind: 'llama-server', addedAt }
}

test('a disabled release source naming Prism shows installed but not enabled, with its binPath', async () => {
  let binPath = ''
  const h = harness(() => [], (root) => {
    const source = disabledPrismSource(root, 'Prism-rel-a', '2026-02-01T00:00:00Z')
    binPath = source.binPath
    return [source]
  })
  try {
    const prism = await catalogItem(h, 'prism')
    assert.equal(prism.installed, true)
    assert.equal(prism.enabled, false)
    assert.equal(prism.releaseBinPath, binPath)
    assert.equal(prism.releaseEngineId, undefined)
  } finally {
    h.cleanup()
  }
})

test('two disabled Prism release sources with the same addedAt pick the same binPath in either order', async () => {
  const stamp = '2026-02-01T00:00:00Z'
  const picks: string[] = []
  for (const order of [['Prism-rel-a', 'Prism-rel-b'], ['Prism-rel-b', 'Prism-rel-a']]) {
    const h = harness(() => [], (root) => order.map((name) => disabledPrismSource(root, name, stamp)))
    try {
      const prism = await catalogItem(h, 'prism')
      picks.push((prism.releaseBinPath ?? '').split(/[\\/]/).slice(-2, -1)[0] ?? '')
    } finally {
      h.cleanup()
    }
  }
  assert.deepEqual(picks, ['Prism-rel-a', 'Prism-rel-a'])
})

test('a registered release engine beats a disabled source build that is only on disk', async () => {
  const h = harness((root) => {
    const dir = join(root, 'build', 'prismml-eng-llama.cpp-prism')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, serverExe), 'x')
    return [{ id: 'rel', release: provenance(PRISM) }]
  })
  try {
    const prism = await catalogItem(h, 'prism')
    assert.equal(prism.releaseEngineId, 'rel')
    assert.equal(prism.enabled, true)
    assert.equal(prism.sourceBuilt, false)
  } finally {
    h.cleanup()
  }
})
