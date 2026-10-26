// An engine update during auto-tune. A run stops its model between two probes, which the update routes' engineBusy read
// as idle, so the Update of the engine being tuned got through mid-run: it stopped the probe it caught and swapped the
// build under the rest of the run (later probes ran the new build with flags tuned on the old one, or a binary the
// update had deleted; an official backend's new id stopped the run as "another engine was selected"). Each route that
// replaces the files of a llama-server build or of llamafile, the kinds whose launches take the llama.cpp flags a run
// sweeps, now refuses that one engine while the run lasts, and leaves every other engine alone: the four update routes,
// and a release install, zip re-upload or rebuild into its folder. The scheduler's side is in engines/update.test.ts.
// No network: GitHub is a stubbed fetch that answers 404 (but for the one release tag the install looks up), so an
// update or install that goes ahead fails at its first lookup or download.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConfigStore, type Engine } from '../config/config'
import { buildDirName } from '../engines/build-runner'
import { availableBackends } from '../engines/download'
import { llamafileBinPath } from '../engines/llamafile'
import { Registry } from '../engines/registry'
import { assetKey } from '../engines/release-assets'
import { RELEASE_INSTALL_MARKER, releaseInstallDirName } from '../engines/release-install'
import { serverBinName } from '../engines/scan'
import { ZIP_BUILD_MARKER, zipBuildDirName } from '../engines/zip-install'
import type { Deps } from '../deps'
import { registerApi } from './routes'
import { tmpDir } from '../test-support/tmp'

const backend = availableBackends()[0]
const skip = (!backend || !['win32', 'darwin', 'linux'].includes(process.platform)) && 'needs a llama.cpp backend and the TurboQuant and llamafile catalog platforms'
const REFUSAL = 'Stop auto-tune before updating this engine.'
// A newer tag (b1) of an installed release: it lands in the same folder as b0 (assetKey drops the tag).
const OS_TOKEN = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : 'ubuntu'
const INSTALL_REPO = 'o/inst'
const INSTALL_ASSET = `llama-b1-bin-${OS_TOKEN}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`
const ZIP_NAME = 'myfork.zip'
// Never contacted: the rebuild is refused, or (in the other test) not posted.
const SOURCE_REPO = 'https://127.0.0.1:9/owner/fork.git'

function harness(t: { after: (fn: () => void) => void }) {
  const store = ConfigStore.load(join(tmpDir('tllm-update-autotune-'), 'config.json'))
  const root = join(store.dir(), 'engines')
  // The official backend's installed build, found on disk by the route (installedBackendBuild).
  const backendDir = join(root, `llama.cpp-b100-${backend!.id}`)
  mkdirSync(backendDir, { recursive: true })
  writeFileSync(join(backendDir, serverBinName), '')
  writeFileSync(join(backendDir, '.turbollm-provisioned'), '')
  // A release install, a zip upload and a source build, each with what marks its folder as its own.
  const installDir = join(root, 'build', releaseInstallDirName({ repo: INSTALL_REPO, assetKey: assetKey(INSTALL_ASSET, 'b1') }))
  const zipDir = join(root, 'build', zipBuildDirName(ZIP_NAME))
  const sourceDir = join(root, 'build', buildDirName(SOURCE_REPO))
  for (const [dir, marker] of [[installDir, RELEASE_INSTALL_MARKER], [zipDir, ZIP_BUILD_MARKER], [sourceDir, '']]) {
    mkdirSync(dir, { recursive: true })
    if (marker) writeFileSync(join(dir, marker), '{}')
  }
  const eng = (id: string, binPath: string, extra: Partial<Engine> = {}): Engine =>
    ({ id, name: id, binPath, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '', ...extra }) as Engine
  store.update((c) => {
    c.engines.push(
      eng('cuda', '/opt/cuda/llama-server'),
      eng('old', join(backendDir, serverBinName)),
      eng('rel', join(root, 'rel', serverBinName), {
        release: { repo: 'o/r', tag: 'b0', asset: 'r.zip', assetKey: 'r', publishedAt: '2026-09-01T00:00:00Z', prerelease: false, companions: [] },
      }),
      eng('tq', join(root, 'turboquant', serverBinName)),
      eng('lf', llamafileBinPath(root), { kind: 'llamafile', version: '0.10.2' }),
      eng('inst', join(installDir, serverBinName), {
        release: { repo: INSTALL_REPO, tag: 'b0', asset: INSTALL_ASSET.replace('b1', 'b0'), assetKey: assetKey(INSTALL_ASSET, 'b1'), publishedAt: '2026-09-01T00:00:00Z', prerelease: false, companions: [] },
      }),
      eng('zip', join(zipDir, serverBinName)),
      eng('src', join(sourceDir, 'build', 'bin', serverBinName), { sourceRepo: SOURCE_REPO }),
    )
    c.activeEngineId = 'cuda'
  })
  let fetches = 0
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetches++
    if (String(input) === `https://api.github.com/repos/${INSTALL_REPO}/releases/tags/b1`) {
      const asset = { name: INSTALL_ASSET, browser_download_url: `https://cdn.test/${INSTALL_ASSET}`, size: 10 }
      return Response.json({ tag_name: 'b1', published_at: '2026-10-01T00:00:00Z', prerelease: false, assets: [asset] })
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
  const registry = new Registry(store)
  const log: string[] = []
  let tuned: Engine | null = null
  const d = {
    version: 'test',
    store,
    registry,
    manager: { status: () => ({ state: 'stopped', err: null, model: null }), currentOpts: () => null, stopAndWait: async () => {}, logPath: () => '' },
    provision: {
      get: () => ({ active: false }),
      startCount: () => log.filter((l) => l.startsWith('start')).length,
      start: (b: string) => { log.push(`start:${b}`) },
      progress() {},
      done: () => { log.push('done') },
      fail: () => { log.push('fail') },
    },
    // A rebuild that went ahead would start a real one in the background: none is started here.
    build: { isActive: () => false, start: (name: string) => { log.push(`build:${name}`); throw new Error('no build in this test') } },
    modelRouter: { poolEngineIds: () => new Set(), poolSlotsOnEngine: () => 0, stopPoolSlotsOnEngine: async () => {} },
    // Between two probes: the run's model is stopped (the manager above), and the run names its engine.
    bench: { isRunning: () => tuned !== null, tuningEngine: () => tuned },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return {
    app, log,
    fetches: () => fetches,
    tune: (id: string | null) => { tuned = id ? registry.get(id)! : null },
  }
}

/** Each update route with the engine it updates. */
const ROUTES: Array<[string, string]> = [
  ['/api/v1/engines/rel/update', 'rel'],
  [`/api/v1/engines/backends/${backend?.id}/update`, 'old'],
  ['/api/v1/engines/turboquant?update=1', 'tq'],
  ['/api/v1/engines/llamafile?update=1', 'lf'],
]

async function settle(lookedUp: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !lookedUp(); i++) await new Promise((r) => setTimeout(r, 20))
  await new Promise((r) => setTimeout(r, 50)) // the job's failure and the route's own finally, after the lookup
}

test('each engine update route refuses the engine auto-tune is running on, before it looks anything up', { skip }, async (t) => {
  const h = harness(t)
  for (const [route, id] of ROUTES) {
    h.tune(id)
    const res = await h.app.request(route, { method: 'POST' })
    assert.equal(res.status, 409, route)
    const { error } = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(error.code, 'engine_in_use', route)
    assert.equal(error.message, REFUSAL, route)
  }
  assert.equal(h.fetches(), 0, 'no update looked GitHub up')
  assert.deepEqual(h.log, [], 'no update started')
})

test('while auto-tune runs on one engine, an update of another still goes ahead', { skip }, async (t) => {
  const h = harness(t)
  h.tune('cuda')
  for (const [route] of ROUTES) {
    const fetchesBefore = h.fetches()
    const res = await h.app.request(route, { method: 'POST' })
    const body = (await res.json()) as { error?: { message: string } }
    assert.notEqual(body.error?.message, REFUSAL, route)
    // A 202 starts the update in the background (it fails at the stubbed lookup); the backend route looks up GitHub
    // before it answers, and answers 503 offline.
    if (res.status === 202) await settle(() => h.fetches() > fetchesBefore)
    else assert.equal(res.status, 503, route)
    assert.ok(h.fetches() > fetchesBefore, `${route} went on to look GitHub up`)
  }
})

/** Each route that replaces an engine's files in place without being its update, with the engine it would replace there
 *  and its refusal. The uploaded file is not a zip: the refusal comes before it is read, and an upload that goes ahead
 *  fails on it. */
const REPLACE_ROUTES: Array<[string, string, () => RequestInit, string]> = [
  ['/api/v1/engines/release/install', 'inst', () => ({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: INSTALL_REPO, tag: 'b1', asset: INSTALL_ASSET }),
  }), REFUSAL],
  ['/api/v1/engines/zip', 'zip', () => {
    const form = new FormData()
    form.append('file', new File([Buffer.from('not a zip')], ZIP_NAME))
    return { method: 'POST', body: form }
  }, "Stop auto-tune before replacing this engine's files."],
  ['/api/v1/build/run', 'src', () => ({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoUrl: SOURCE_REPO }),
  }), 'Stop auto-tune before rebuilding this engine.'],
]

test('a release install, zip re-upload or rebuild into the folder of the engine auto-tune is running on is refused', { skip }, async (t) => {
  const h = harness(t)
  for (const [route, id, init, refusal] of REPLACE_ROUTES) {
    h.tune(id)
    const res = await h.app.request(route, init())
    assert.equal(res.status, 409, route)
    const { error } = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(error.code, 'engine_in_use', route)
    assert.equal(error.message, refusal, route)
  }
  assert.deepEqual(h.log, [], 'no install, upload or build started')
})

test('while auto-tune runs on another engine, a release install and a zip re-upload into those folders still go ahead', { skip }, async (t) => {
  const h = harness(t)
  h.tune('cuda')
  const [[installRoute, , install], [zipRoute, , zip]] = REPLACE_ROUTES
  // Accepted, and the job fails at the stubbed download (not at the swap guard).
  const res = await h.app.request(installRoute, install())
  assert.equal(res.status, 202)
  let job: { state: string; error?: { code: string } } = { state: 'running' }
  for (let i = 0; i < 100 && job.state === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20))
    job = (await (await h.app.request(installRoute)).json()) as typeof job
  }
  assert.equal(job.state, 'error')
  assert.equal(job.error?.code, 'download_failed')
  // The upload reaches the archive, which is not a zip.
  const up = await h.app.request(zipRoute, zip())
  assert.equal(up.status, 400)
  assert.notEqual(((await up.json()) as { error: { message: string } }).error.message, REPLACE_ROUTES[1][3])
  // POST /build/run would start a real build here; its check is the same folder test as these two.
})
