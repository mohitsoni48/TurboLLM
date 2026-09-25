// Route-level coverage for two things ADR-431 follow-ups changed in routes.ts:
//  - POST /api/v1/build/run refuses, BEFORE compiling anything, a request that can only end in
//    "Name already in use" (a 15-minute compile followed by a registration error was the bug), and
//    refuses to rebuild an engine that is running out of the very directory being rebuilt.
//  - GET /api/v1/engines/catalog finds a Disabled engine's build on disk, reports the branch it was
//    built for, and still finds builds made under the pre-ADR-387 directory name.
// The pure decisions are unit-tested in engines/build-runner.test.ts; this file pins the wiring and
// the HTTP shape. Only paths that return before a build starts are exercised, so nothing here
// touches git, a compiler or the network.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConfigStore, type Engine } from '../config/config'
import { Registry } from '../engines/registry'
import type { Deps } from '../deps'
import { registerApi } from './routes'
import { tmpDir } from '../test-support/tmp'

const serverExe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

interface Harness {
  app: Hono
  enginesRoot: string
  buildStarts: string[]
  cleanup: () => void
}

interface HarnessOpts {
  /** The engines to register; a function gets the daemon's engines root so a path can live inside it. */
  engines?: Array<Partial<Engine>> | ((enginesRoot: string) => Array<Partial<Engine>>)
  activeId?: string
  managerState?: string
}

function harness(opts: HarnessOpts = {}): Harness {
  const dir = tmpDir('tllm-build-routes-')
  const store = ConfigStore.load(join(dir, 'config.json'))
  const enginesRoot = join(store.dir(), 'engines')
  const engines = typeof opts.engines === 'function' ? opts.engines(enginesRoot) : (opts.engines ?? [])
  store.update((c) => {
    for (const e of engines) {
      c.engines.push({
        id: e.id ?? e.name ?? 'e',
        name: e.name ?? 'e',
        binPath: e.binPath ?? '/x/llama-server',
        kind: 'llama-server',
        version: '',
        capabilities: { kvTypes: [], flags: [] },
        ...e,
      } as Engine)
    }
    if (opts.activeId) c.activeEngineId = opts.activeId
  })
  const buildStarts: string[] = []
  const d = {
    version: 'test',
    store,
    registry: new Registry(store),
    manager: { status: () => ({ state: opts.managerState ?? 'stopped', model: null }), logPath: () => '' },
    provision: { get: () => ({ active: false }) },
    build: { isActive: () => false, start: (name: string) => void buildStarts.push(name) },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return { app, enginesRoot, buildStarts, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

interface ApiError {
  error?: { code: string; message: string }
}

async function postBuild(app: Hono, body: Record<string, string>): Promise<{ status: number; json: ApiError }> {
  const res = await app.request('/api/v1/build/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as ApiError }
}

const PRISM = { repoUrl: 'https://github.com/PrismML-Eng/llama.cpp', branch: 'prism', name: 'Prism' }

test('POST /build/run refuses a name held by an unrelated engine, without starting a build', async () => {
  const h = harness({ engines: [{ name: 'Prism', binPath: '/data/engines/llama.cpp-b10970-cuda/llama-server' }] })
  try {
    const { status, json } = await postBuild(h.app, PRISM)
    assert.equal(status, 400)
    assert.equal(json.error?.code, 'name_already_taken')
    assert.match(json.error?.message ?? '', /Name already in use by "Prism"/)
    assert.deepEqual(h.buildStarts, [], 'a doomed build must not start')
  } finally {
    h.cleanup()
  }
})

test('POST /build/run explains that another branch of the same repo is a separate engine', async () => {
  const h = harness({ engines: [{ name: 'Prism', binPath: '/x/other/llama-server', sourceRepo: PRISM.repoUrl, sourceBranch: 'main' }] })
  try {
    const { status, json } = await postBuild(h.app, PRISM)
    assert.equal(status, 400)
    assert.match(json.error?.message ?? '', /branch "main"/)
    assert.match(json.error?.message ?? '', /separate engine/i)
    assert.deepEqual(h.buildStarts, [])
  } finally {
    h.cleanup()
  }
})

test('POST /build/run refuses to rebuild an engine that is running out of that build directory', async () => {
  const h = harness({
    engines: (enginesRoot) => [
      {
        id: 'live',
        name: 'Prism live',
        binPath: join(enginesRoot, 'build', 'prismml-eng-llama.cpp-prism', 'build', 'bin', serverExe),
        sourceRepo: PRISM.repoUrl,
        sourceBranch: 'prism',
      },
    ],
    activeId: 'live',
    managerState: 'running',
  })
  try {
    const { status, json } = await postBuild(h.app, { ...PRISM, name: 'Prism live' })
    assert.equal(status, 409)
    assert.equal(json.error?.code, 'engine_in_use')
    assert.match(json.error?.message ?? '', /Stop "Prism live"/)
    assert.deepEqual(h.buildStarts, [])
  } finally {
    h.cleanup()
  }
})

function seedBuild(enginesRoot: string, dirName: string): void {
  const bin = join(enginesRoot, 'build', dirName, 'build', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, serverExe), '')
}

interface CatalogItem {
  id: string
  homepage: string
  installed?: boolean
  sourceBuilt?: boolean
  sourceBranch?: string
  sourceBinPath?: string
  sourceEngineId?: string
  sourceCommit?: string
  patchUrl?: string
}

async function catalogItem(h: Harness, id: string): Promise<CatalogItem> {
  const res = await h.app.request('/api/v1/engines/catalog')
  assert.equal(res.status, 200)
  const body = (await res.json()) as { engines: CatalogItem[] }
  const item = body.engines.find((e) => e.id === id)
  assert.ok(item, `catalog has no entry "${id}"`)
  return item
}

test('GET /engines/catalog: a Disabled card-built engine is found on disk and reports its branch', async () => {
  const h = harness()
  try {
    seedBuild(h.enginesRoot, 'prismml-eng-llama.cpp-prism')
    const prism = await catalogItem(h, 'prism')
    assert.equal(prism.installed, true)
    assert.equal(prism.sourceBuilt, true)
    assert.equal(prism.sourceBranch, 'prism', 'Enable must re-register with the branch the directory was built for')
    assert.match(prism.sourceBinPath ?? '', /prismml-eng-llama\.cpp-prism/)
  } finally {
    h.cleanup()
  }
})

test('GET /engines/catalog: a blank-branch build in the bare directory reports a blank branch', async () => {
  const h = harness()
  try {
    seedBuild(h.enginesRoot, 'prismml-eng-llama.cpp')
    const prism = await catalogItem(h, 'prism')
    assert.equal(prism.sourceBuilt, true)
    assert.equal(prism.sourceBranch, '')
  } finally {
    h.cleanup()
  }
})

test('GET /engines/catalog: a Disabled Solar Open 2 build under the pre-ADR-387 directory is still found', async () => {
  const h = harness()
  try {
    seedBuild(h.enginesRoot, 'llama.cpp-846e991ec3c7')
    const solar = await catalogItem(h, 'solar-open2')
    assert.equal(solar.installed, true)
    assert.match(solar.sourceBinPath ?? '', /llama\.cpp-846e991ec3c7/)
  } finally {
    h.cleanup()
  }
})

test('POST /engines keeps the commit and patch of a pinned build, so its card recognises the engine it registered', async () => {
  // A pinned card (Solar Open 2) matches on repo + commit + patch. Enable used to send only repo +
  // branch, so the engine it registered belonged to no card and the card still read "not installed".
  const h = harness()
  try {
    const card = await catalogItem(h, 'solar-open2')
    assert.ok(card.sourceCommit && card.patchUrl, 'the Solar Open 2 entry is pinned to a commit and a patch')
    assert.equal(card.sourceBuilt, false)

    const res = await h.app.request('/api/v1/engines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // process.execPath stands in for a built server: probe() only needs something native it can run.
      body: JSON.stringify({ name: 'Solar Open 2', binPath: process.execPath, sourceRepo: card.homepage, sourceCommit: card.sourceCommit, sourcePatchUrl: card.patchUrl }),
    })
    assert.equal(res.status, 201)
    const registered = (await res.json()) as { id: string; sourcePatchUrl?: string }
    assert.equal(registered.sourcePatchUrl, card.patchUrl)

    const after = await catalogItem(h, 'solar-open2')
    assert.equal(after.sourceBuilt, true)
    assert.equal(after.sourceEngineId, registered.id)
  } finally {
    h.cleanup()
  }
})

test('GET /engines/catalog: nothing on disk and nothing registered means not built', async () => {
  const h = harness()
  try {
    const prism = await catalogItem(h, 'prism')
    assert.equal(prism.sourceBuilt, false)
    assert.equal(prism.sourceBranch, '')
  } finally {
    h.cleanup()
  }
})
