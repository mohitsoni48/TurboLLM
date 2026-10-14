// Route-level tests for the GitHub-release engine install flow (ADR-453): list a repo's builds,
// start one install, watch it, discard an unconfirmed result, and update a release engine.
// Same "real Hono app, minimal Deps double" discipline as engines-zip-upload.test.ts. GitHub is
// a stubbed globalThis.fetch per test; nothing reaches the network. The happy-path install
// runs a shell script as the "binary", so it is POSIX only, as in the zip tests.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import type { Deps } from '../deps'
import { ProvisionState, type ProvisionTrigger } from '../engines/provision-state'
import { tmpDir } from '../test-support/tmp'
import { buildZipArchive } from '../test-support/zip-archive'
import { serverBinName } from '../engines/scan'
import { ZIP_BUILD_MARKER } from '../engines/zip-install'
import { RELEASE_INSTALL_MARKER, releaseInstallDirName, writeReleaseMarker, type ReleaseProvenance } from '../engines/release-install'

const REPO = 'o/r'
const OS_TOKEN = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : 'ubuntu'
const ARCH_TOKEN = process.arch === 'arm64' ? 'arm64' : 'x64'
const ZIP_ASSET = `llama-b1-bin-${OS_TOKEN}-${ARCH_TOKEN}.zip`
const TAR_ASSET = `llama-b1-bin-${OS_TOKEN}-${ARCH_TOKEN}.tar.gz`
const ASSET_KEY = `llama-bin-${OS_TOKEN}-${ARCH_TOKEN}.zip`
const SLUG = releaseInstallDirName({ repo: REPO, assetKey: ASSET_KEY })

interface Opts {
  dataDir?: string
  lanBind?: boolean
  busy?: 'download' | 'build'
  runningBinPath?: string
  /** Engine id an extra pool slot is running on (the primary is stopped). */
  poolEngineId?: string
  engines?: Array<{ id: string; name: string; binPath: string; release?: ReleaseProvenance }>
  customSources?: Array<{ name: string; binPath: string }>
}

interface Harness {
  app: Hono
  dataDir: string
  buildDir: string
  provisionLog: string[]
  settlements: Array<{ ok: boolean; trigger: string }>
  added: Array<{ name: string; binPath: string; release?: ReleaseProvenance; sourceRepo?: string }>
  recordedSources: Array<{ binPath: string; sourceRepo?: string }>
}

function harness(o: Opts = {}): Harness {
  const dataDir = o.dataDir ?? tmpDir('tllm-rel-route-')
  const provisionLog: string[] = []
  const settlements: Harness['settlements'] = []
  const added: Harness['added'] = []
  const recordedSources: Harness['recordedSources'] = []
  const realProvision = new ProvisionState()
  realProvision.onSettled = (ok, trigger) => { settlements.push({ ok, trigger }) }
  const engines = o.engines ?? []
  const cfg = {
    daemon: { lanBind: o.lanBind ?? false, requireApiKey: false, port: 6996, machineId: 'm', machineName: 'test' },
    apiKeys: [], links: [], telemetry: { level: 'off', machineId: 'm' },
  }
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, dir: () => dataDir },
    manager: { status: () => ({ state: o.runningBinPath ? 'running' : 'stopped', err: null, port: 0, pid: 0, model: null }) },
    provision: {
      get: () => ({ ...realProvision.get(), active: realProvision.get().active || o.busy === 'download' }),
      startCount: () => realProvision.startCount(),
      start: (backend: string, trigger: ProvisionTrigger) => { realProvision.start(backend, trigger); provisionLog.push(`start:${backend}:${trigger}`) },
      progress: () => {},
      done: () => { realProvision.done(); provisionLog.push('done') },
      fail: (m: string) => { realProvision.fail(m); provisionLog.push(`fail:${m}`) },
    },
    build: { isActive: () => o.busy === 'build' },
    modelRouter: {
      poolSlotsOnEngine: (id: string) => (id === o.poolEngineId ? 1 : 0),
      stopPoolSlotsOnEngine: async () => {},
    },
    registry: {
      active: () => (o.runningBinPath ? { id: 'e-run', name: 'Running', binPath: o.runningBinPath, kind: 'llama-server' } : undefined),
      list: () => ({ engines, activeEngineId: '' }),
      get: (id: string) => engines.find((e) => e.id === id),
      customSources: () => o.customSources ?? [],
      add: async (name: string, binPath: string, source?: { release?: ReleaseProvenance; sourceRepo?: string }) => {
        added.push({ name, binPath, release: source?.release, sourceRepo: source?.sourceRepo })
        return { engine: { id: 'new', name, binPath, release: source?.release }, warning: null }
      },
      recordCustomSource: (s: { binPath: string; sourceRepo?: string }) => { recordedSources.push({ binPath: s.binPath, sourceRepo: s.sourceRepo }) },
      refresh: () => ({}),
      setRelease: () => ({}),
    },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return { app, dataDir, buildDir: join(dataDir, 'engines', 'build'), provisionLog, settlements, added, recordedSources }
}

interface FakeRelease { tag: string; assets: Array<{ name: string; bytes?: Buffer }> }

function releaseJson(r: FakeRelease) {
  return {
    tag_name: r.tag, published_at: '2026-09-25T10:00:00Z', prerelease: false,
    assets: r.assets.map((a) => ({ name: a.name, browser_download_url: `https://cdn.test/${a.name}`, size: a.bytes?.length ?? 10 })),
  }
}

type Responder = (url: string, init?: RequestInit) => Response | Promise<Response> | null

/** Run `fn` with globalThis.fetch replaced; GitHub API + CDN served from `release`. */
async function withGithub<T>(release: FakeRelease | 'missing' | 'empty', fn: (requests: string[]) => Promise<T>, extra?: Responder): Promise<T> {
  const real = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push(url)
    const custom = extra?.(url, init)
    if (custom) return custom
    if (release === 'missing') return new Response('', { status: 404 })
    if (release === 'empty') return url.includes('/releases?') ? Response.json([]) : new Response('', { status: 404 })
    if (url.includes('/releases/latest') || url.includes('/releases/tags/')) return Response.json(releaseJson(release))
    if (url.includes('/releases?')) return Response.json([releaseJson(release)])
    const asset = release.assets.find((a) => url === `https://cdn.test/${a.name}`)
    if (asset?.bytes) return new Response(asset.bytes, { headers: { 'content-length': String(asset.bytes.length) } })
    return new Response('', { status: 404 })
  }) as typeof fetch
  try {
    return await fn(requests)
  } finally {
    globalThis.fetch = real
  }
}

const hangUntilAborted: Responder = (url, init) =>
  url.startsWith('https://cdn.test/')
    ? new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    : null

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error
}

const getAssets = (h: Harness, repo = REPO) => h.app.request(`/api/v1/engines/release/assets?repo=${encodeURIComponent(repo)}`)
const getJob = (h: Harness) => h.app.request('/api/v1/engines/release/install')
const postInstall = (h: Harness, b: object = { repo: REPO, tag: 'b1', asset: ZIP_ASSET }, headers: Record<string, string> = {}) =>
  h.app.request('/api/v1/engines/release/install', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b),
  })
const deleteInstall = (h: Harness, binPath?: string) =>
  h.app.request(`/api/v1/engines/release/install${binPath ? `?binPath=${encodeURIComponent(binPath)}` : ''}`, { method: 'DELETE' })

async function jobState(h: Harness, until: (s: string) => boolean = (s) => s !== 'running') {
  for (let i = 0; i < 100; i++) {
    const view = (await (await getJob(h)).json()) as { state: string; error?: { code: string }; result?: { binPath: string } }
    if (until(view.state)) return view
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('the release job never left its state')
}

function seedMarkedDir(h: Harness, marker: string, provenance?: ReleaseProvenance): string {
  const dir = join(h.buildDir, SLUG)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, serverBinName), 'x')
  if (provenance) writeReleaseMarker(dir, provenance)
  else writeFileSync(join(dir, marker), '{}')
  return dir
}

const PROVENANCE: ReleaseProvenance = {
  repo: REPO, tag: 'b0', asset: ZIP_ASSET, assetKey: ASSET_KEY,
  publishedAt: '2026-09-01T00:00:00Z', prerelease: false, companions: [],
}

const ALL_ROUTES: Array<[string, (h: Harness) => Response | Promise<Response>]> = [
  ['GET assets', (h) => getAssets(h)],
  ['POST install', (h) => postInstall(h)],
  ['GET install', (h) => getJob(h)],
  ['DELETE install', (h) => deleteInstall(h, join(h.buildDir, 'x', serverBinName))],
]

for (const [name, call] of ALL_ROUTES) {
  test(`${name}: 403 for a non-host caller on an open, keyless LAN`, async () => {
    const h = harness({ lanBind: true })
    const res = await call(h)
    assert.equal(res.status, 403)
    assert.equal((await errorOf(res)).code, 'forbidden')
  })
}

test('POST install: a cross-site request is refused', async () => {
  const res = await postInstall(harness(), undefined, { 'sec-fetch-site': 'cross-site' })
  assert.equal(res.status, 403)
})

test('POST install: 409 engine_already_running while a download is in flight', async () => {
  const res = await postInstall(harness({ busy: 'download' }))
  assert.equal(res.status, 409)
  assert.equal((await errorOf(res)).code, 'engine_already_running')
})

test('invalid_repo: 400 from the listing and from the install', async () => {
  const h = harness()
  const listing = await getAssets(h, 'not a repo')
  assert.equal(listing.status, 400)
  assert.equal((await errorOf(listing)).code, 'invalid_repo')
  const install = await postInstall(h, { repo: '../x', tag: 'b1', asset: ZIP_ASSET })
  assert.equal(install.status, 400)
  assert.equal((await errorOf(install)).code, 'invalid_repo')
})

test('GET assets: 404 repo_not_found / no_releases, 429 for rate limiting, 502 when GitHub is unreachable', async () => {
  const h = harness()
  await withGithub('missing', async () => {
    const res = await getAssets(h)
    assert.equal(res.status, 404)
    assert.equal((await errorOf(res)).code, 'repo_not_found')
  })
  await withGithub('empty', async () => {
    const res = await getAssets(h)
    assert.equal(res.status, 404)
    assert.equal((await errorOf(res)).code, 'no_releases')
  })
  await withGithub('missing', async () => {
    const res = await getAssets(h)
    assert.equal(res.status, 429)
    assert.equal((await errorOf(res)).code, 'github_rate_limited')
  }, () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))
  await withGithub('missing', async () => {
    const res = await getAssets(h)
    assert.equal(res.status, 502)
    assert.equal((await errorOf(res)).code, 'github_unreachable')
  }, () => { throw new TypeError('fetch failed') })
})

test('GET assets: no_compatible_asset still lists every build with a reason', async () => {
  const foreign = process.platform === 'win32' ? 'llama-b1-bin-ubuntu-x64.zip' : 'llama-b1-bin-win-x64.zip'
  await withGithub({ tag: 'b1', assets: [{ name: foreign }] }, async () => {
    const res = await getAssets(harness())
    assert.equal(res.status, 404)
    const body = (await res.json()) as { error: { code: string }; assets: Array<{ name: string; compatible: boolean; reason: string | null }> }
    assert.equal(body.error.code, 'no_compatible_asset')
    assert.equal(body.assets.length, 1)
    assert.equal(body.assets[0]?.compatible, false)
    assert.ok(body.assets[0]?.reason)
  })
})

test('GET assets: ranks the release for this machine and never exposes download URLs', async () => {
  await withGithub({ tag: 'b1', assets: [{ name: ZIP_ASSET }] }, async () => {
    const res = await getAssets(harness())
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.equal(text.includes('browser_download_url'), false)
    assert.equal(text.includes('cdn.test'), false)
    const body = JSON.parse(text) as { repo: string; tag: string; fellBack: boolean; assets: Array<{ name: string; recommended: boolean }> }
    assert.equal(body.tag, 'b1')
    assert.equal(body.repo, REPO)
    assert.equal(body.fellBack, false)
    assert.equal(body.assets.find((a) => a.name === ZIP_ASSET)?.recommended, true)
  })
})

test('POST install: 400 invalid_asset when the name is not in that release', async () => {
  await withGithub({ tag: 'b1', assets: [{ name: ZIP_ASSET }] }, async () => {
    const res = await postInstall(harness(), { repo: REPO, tag: 'b1', asset: 'nope.zip' })
    assert.equal(res.status, 400)
    assert.equal((await errorOf(res)).code, 'invalid_asset')
  })
})

test('POST install: 400 invalid_asset for a companion archive', async () => {
  const companion = 'cudart-llama-bin-win-cuda-13.3-x64.zip'
  await withGithub({ tag: 'b1', assets: [{ name: companion }, { name: ZIP_ASSET }] }, async () => {
    const res = await postInstall(harness(), { repo: REPO, tag: 'b1', asset: companion })
    assert.equal(res.status, 400)
    assert.equal((await errorOf(res)).code, 'invalid_asset')
  })
})

const slugDirOf = (dataDir: string) => join(dataDir, 'engines', 'build', SLUG)

function seededDir(dataDir: string, marker: string | null): string {
  const dir = slugDirOf(dataDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, serverBinName), 'x')
  if (marker === RELEASE_INSTALL_MARKER) writeReleaseMarker(dir, PROVENANCE)
  else if (marker) writeFileSync(join(dir, marker), '{}')
  return dir
}

test('POST install: 409 build_dir_taken when an unmarked registered engine owns the target dir', async () => {
  const dataDir = tmpDir('tllm-rel-route-')
  const dir = seededDir(dataDir, null)
  const h = harness({ dataDir, engines: [{ id: 'e1', name: 'Mine', binPath: join(dir, serverBinName) }] })
  await withGithub({ tag: 'b1', assets: [{ name: ZIP_ASSET }] }, async () => {
    const res = await postInstall(h)
    assert.equal(res.status, 409)
    assert.equal((await errorOf(res)).code, 'build_dir_taken')
  })
})

test('G-6: a release install into a zip-marked build dir is refused and the dir is untouched', async () => {
  const dataDir = tmpDir('tllm-rel-route-')
  const dir = seededDir(dataDir, ZIP_BUILD_MARKER)
  const h = harness({ dataDir, engines: [{ id: 'e1', name: 'Zip build', binPath: join(dir, serverBinName) }] })
  await withGithub({ tag: 'b1', assets: [{ name: ZIP_ASSET }] }, async () => {
    const res = await postInstall(h)
    assert.equal(res.status, 409)
    assert.equal((await errorOf(res)).code, 'build_dir_taken')
  })
  assert.ok(existsSync(join(dir, ZIP_BUILD_MARKER)))
  assert.equal(existsSync(join(dir, RELEASE_INSTALL_MARKER)), false)
})

test('G-6: a zip upload into a release-marked build dir is refused by the existing occupant check', async () => {
  const slug = 'PrismML-Eng-llama.cpp-llama-bin-win-cuda-13.3-x64'
  const dataDir = tmpDir('tllm-rel-route-')
  const dir = join(dataDir, 'engines', 'build', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, serverBinName), 'x')
  writeFileSync(join(dir, RELEASE_INSTALL_MARKER), '{}')
  const h = harness({ dataDir, engines: [{ id: 'e1', name: 'Prism', binPath: join(dir, serverBinName) }] })
  const form = new FormData()
  form.append('file', new File([buildZipArchive([{ name: serverBinName, data: Buffer.from('x') }])], slug + '.zip'))
  const res = await h.app.request('/api/v1/engines/zip', { method: 'POST', body: form })
  assert.equal(res.status, 409)
  assert.equal((await errorOf(res)).code, 'build_dir_taken')
  assert.ok(existsSync(join(dir, RELEASE_INSTALL_MARKER)))
})

test('G-4: a corrupt archive ends the job with extract_failed and leaves no staging dirs', async () => {
  const h = harness()
  await withGithub({ tag: 'b1', assets: [{ name: TAR_ASSET, bytes: Buffer.alloc(64, 7) }] }, async () => {
    const res = await postInstall(h, { repo: REPO, tag: 'b1', asset: TAR_ASSET })
    assert.equal(res.status, 202)
    const view = await jobState(h)
    assert.equal(view.state, 'error')
    assert.equal(view.error?.code, 'extract_failed')
  })
  const leftovers = existsSync(h.buildDir) ? readdirSync(h.buildDir) : []
  assert.deepEqual(leftovers, [])
  assert.match(h.provisionLog.at(-1) ?? '', /^(done|fail)/)
})

test('POST install: 409 engine_in_use when the occupant is the running engine', async () => {
  const dataDir = tmpDir('tllm-rel-route-')
  const running = join(seededDir(dataDir, RELEASE_INSTALL_MARKER), serverBinName)
  const h = harness({ dataDir, runningBinPath: running, engines: [{ id: 'e-run', name: 'Running', binPath: running, release: PROVENANCE }] })
  await withGithub({ tag: 'b1', assets: [{ name: ZIP_ASSET }] }, async () => {
    const res = await postInstall(h)
    assert.equal(res.status, 409)
    assert.equal((await errorOf(res)).code, 'engine_in_use')
  })
})

test('DELETE with binPath removes an unclaimed release-marked dir', async () => {
  const h = harness()
  const dir = seedMarkedDir(h, RELEASE_INSTALL_MARKER, PROVENANCE)
  const res = await deleteInstall(h, join(dir, serverBinName))
  assert.equal(res.status, 200)
  assert.equal(existsSync(dir), false)
})

test('DELETE with binPath: 404 without a marker, 409 when an engine claims the dir', async () => {
  const bare = harness()
  const bareDir = join(bare.buildDir, SLUG)
  mkdirSync(bareDir, { recursive: true })
  writeFileSync(join(bareDir, serverBinName), 'x')
  assert.equal((await deleteInstall(bare, join(bareDir, serverBinName))).status, 404)

  const dataDir = tmpDir('tllm-rel-route-')
  const dir = seededDir(dataDir, RELEASE_INSTALL_MARKER)
  const claimed = harness({ dataDir, engines: [{ id: 'e1', name: 'Mine', binPath: join(dir, serverBinName) }] })
  const res = await deleteInstall(claimed, join(dir, serverBinName))
  assert.equal(res.status, 409)
  assert.equal((await errorOf(res)).code, 'build_dir_taken')
  assert.ok(existsSync(dir))
})

test('DELETE without binPath aborts a running job; so does the engine-download cancel route', async () => {
  for (const abort of [
    (h: Harness) => deleteInstall(h),
    (h: Harness) => h.app.request('/api/v1/engines/backends/cancel', { method: 'POST' }),
  ]) {
    const h = harness()
    await withGithub({ tag: 'b1', assets: [{ name: ZIP_ASSET, bytes: Buffer.from('zip') }] }, async () => {
      assert.equal((await postInstall(h)).status, 202)
      assert.equal((await jobState(h, (s) => s === 'running')).state, 'running')
      await new Promise((r) => setTimeout(r, 100))
      assert.equal((await abort(h)).status, 200)
      const view = await jobState(h)
      assert.equal(view.state, 'error')
      assert.equal(view.error?.code, 'cancelled')
    }, hangUntilAborted)
  }
})

test('N-1: DELETE of an unrelated unclaimed dir leaves a running job untouched', async () => {
  const h = harness()
  const other = join(h.buildDir, 'Other-release-dir')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, serverBinName), 'x')
  writeReleaseMarker(other, { ...PROVENANCE, assetKey: 'other.zip' })
  await withGithub({ tag: 'b1', assets: [{ name: ZIP_ASSET, bytes: Buffer.from('zip') }] }, async () => {
    assert.equal((await postInstall(h)).status, 202)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal((await deleteInstall(h, join(other, serverBinName))).status, 200)
    assert.equal(existsSync(other), false)
    assert.equal(((await (await getJob(h)).json()) as { state: string }).state, 'running')
    await deleteInstall(h)
    await jobState(h)
  }, hangUntilAborted)
})

const posixOnly = { skip: process.platform === 'win32' }

function scriptZip(): Buffer {
  return buildZipArchive([{ name: serverBinName, data: Buffer.from('#!/bin/sh\necho "version: b1"\n') }])
}

test('install: 202, running, then ready with the scan-result shape', posixOnly, async () => {
  const h = harness()
  await withGithub({ tag: 'b1', assets: [{ name: ZIP_ASSET, bytes: scriptZip() }] }, async () => {
    assert.equal((await postInstall(h)).status, 202)
    assert.deepEqual(h.provisionLog[0], 'start:github-release:user_install')
    const view = (await jobState(h)) as { state: string; result?: { found: boolean; binPath: string; suggestedName: string } }
    assert.equal(view.state, 'ready')
    assert.equal(view.result?.found, true)
    assert.equal(view.result?.binPath, join(h.buildDir, SLUG, serverBinName))
  })
})

test('N-1: DELETE of the ready result resets the job; DELETE of another path does not', posixOnly, async () => {
  const h = harness()
  await withGithub({ tag: 'b1', assets: [{ name: ZIP_ASSET, bytes: scriptZip() }] }, async () => {
    await postInstall(h)
    const ready = await jobState(h)
    const other = join(h.buildDir, 'Other')
    mkdirSync(other, { recursive: true })
    writeReleaseMarker(other, { ...PROVENANCE, assetKey: 'other.zip' })
    await deleteInstall(h, join(other, serverBinName))
    assert.equal(((await (await getJob(h)).json()) as { state: string }).state, 'ready')
    assert.equal((await deleteInstall(h, ready.result!.binPath)).status, 200)
    assert.equal(((await (await getJob(h)).json()) as { state: string }).state, 'idle')
  })
})

test('POST /engines reads provenance from the on-disk marker and ignores a client-supplied release', async () => {
  const h = harness()
  const dir = seedMarkedDir(h, RELEASE_INSTALL_MARKER, PROVENANCE)
  const bin = join(dir, serverBinName)
  writeFileSync(bin, '#!/bin/sh\necho "version: b1"\n', { mode: 0o755 })
  const forged = { repo: 'evil/x', tag: 't', asset: 'a', assetKey: 'k', publishedAt: '', prerelease: false, companions: [] }
  const res = await h.app.request('/api/v1/engines', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rel', binPath: bin, release: forged }),
  })
  assert.equal(res.status, 201)
  assert.deepEqual(h.added[0]?.release, PROVENANCE)
})

test('POST /engines gives no provenance to a binPath outside a marked dir, whatever the body says', async () => {
  const h = harness()
  const dir = join(h.buildDir, 'plain')
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, serverBinName)
  writeFileSync(bin, '#!/bin/sh\necho "version: b1"\n', { mode: 0o755 })
  const forged = { repo: 'evil/x', tag: 't', asset: 'a', assetKey: 'k', publishedAt: '', prerelease: false, companions: [] }
  await h.app.request('/api/v1/engines', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Plain', binPath: bin, release: forged }),
  })
  assert.equal(h.added.length, 1)
  assert.equal(h.added[0]?.release, undefined)
})

test('a zip carrying a release marker, registered through POST /engines, has no release provenance', async () => {
  if (process.platform === 'win32') return // the probeable fixture is a POSIX script
  const h = harness()
  const forged = JSON.stringify({ ...PROVENANCE, repo: 'evil/x' })
  const zip = buildZipArchive([
    { name: serverBinName, data: Buffer.from('#!/bin/sh\necho "version: b1"\n') },
    { name: RELEASE_INSTALL_MARKER, data: Buffer.from(forged) },
  ])
  const form = new FormData()
  form.append('file', new File([zip], 'forged.zip'))
  const up = await h.app.request('/api/v1/engines/zip', { method: 'POST', body: form })
  assert.equal(up.status, 200)
  const { binPath } = (await up.json()) as { binPath: string }
  assert.equal(existsSync(join(binPath, '..', RELEASE_INSTALL_MARKER)), false)
  const res = await h.app.request('/api/v1/engines', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Forged', binPath }),
  })
  assert.equal(res.status, 201)
  assert.equal(h.added[0]?.release, undefined)
})

const postUpdate = (h: Harness, id: string, headers: Record<string, string> = {}) =>
  h.app.request(`/api/v1/engines/${id}/update`, { method: 'POST', headers })

const RELEASE_ENGINE = (dir: string) => ({ id: 'e1', name: 'Rel', binPath: join(dir, serverBinName), release: PROVENANCE })

test('POST /engines/:id/update: 403 for a non-host caller, 409 while engine work is in flight', async () => {
  assert.equal((await postUpdate(harness({ lanBind: true }), 'e1')).status, 403)
  const busy = await postUpdate(harness({ busy: 'download' }), 'e1')
  assert.equal(busy.status, 409)
  assert.equal((await errorOf(busy)).code, 'engine_already_running')
})

test('POST /engines/:id/update: 409 engine_in_use when that engine is running', async () => {
  const dataDir = tmpDir('tllm-rel-route-')
  const dir = seededDir(dataDir, RELEASE_INSTALL_MARKER)
  const engine = { ...RELEASE_ENGINE(dir), id: 'e-run' }
  const h = harness({ dataDir, runningBinPath: engine.binPath, engines: [engine] })
  const res = await postUpdate(h, 'e-run')
  assert.equal(res.status, 409)
  assert.equal((await errorOf(res)).code, 'engine_in_use')
})

test('POST /engines/:id/update: 404 engine_not_found, 409 no_update_source', async () => {
  const h = harness({ engines: [{ id: 'plain', name: 'Plain', binPath: join(tmpDir('tllm-rel-route-'), 'custom', serverBinName) }] })
  const missing = await postUpdate(h, 'nope')
  assert.equal(missing.status, 404)
  assert.equal((await errorOf(missing)).code, 'engine_not_found')
  const none = await postUpdate(h, 'plain')
  assert.equal(none.status, 409)
  assert.equal((await errorOf(none)).code, 'no_update_source')
})

test('POST /engines/:id/update: 202 starts a user_update job for a release engine', async () => {
  const dataDir = tmpDir('tllm-rel-route-')
  const dir = seededDir(dataDir, RELEASE_INSTALL_MARKER)
  const h = harness({ dataDir, engines: [RELEASE_ENGINE(dir)] })
  const newer = { tag: 'b9', assets: [{ name: ZIP_ASSET, bytes: Buffer.alloc(64, 7) }] }
  await withGithub(newer, async () => {
    const res = await postUpdate(h, 'e1')
    assert.equal(res.status, 202)
    for (let i = 0; i < 100 && !h.provisionLog.some((l) => /^(done|fail)/.test(l)); i++) await new Promise((r) => setTimeout(r, 50))
  })
  assert.equal(h.provisionLog[0], 'start:github-release:user_update')
})

const settled = (h: Harness) => h.provisionLog.some((l) => /^(done|fail)/.test(l))

async function waitUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 50))
}

test('POST /engines: a release-marked dir is registered without the body sourceRepo and remembered as a custom source', async () => {
  const h = harness()
  const dir = seedMarkedDir(h, RELEASE_INSTALL_MARKER, PROVENANCE)
  const bin = join(dir, serverBinName)
  writeFileSync(bin, '#!/bin/sh\necho "version: b1"\n', { mode: 0o755 })
  const res = await h.app.request('/api/v1/engines', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rel', binPath: bin, sourceRepo: 'https://github.com/ggml-org/llama.cpp' }),
  })
  assert.equal(res.status, 201)
  assert.deepEqual(h.added[0]?.release, PROVENANCE)
  assert.equal(h.added[0]?.sourceRepo, undefined)
  assert.deepEqual(h.recordedSources, [{ binPath: bin, sourceRepo: undefined }])
})

test('POST /engines/:id/update: a cross-site request is refused before anything else', async () => {
  const res = await postUpdate(harness(), 'e1', { 'sec-fetch-site': 'cross-site' })
  assert.equal(res.status, 403)
  assert.equal((await errorOf(res)).code, 'forbidden')
})

test('POST /engines/:id/update: a second request while the first is still looking up GitHub is refused', async () => {
  const dataDir = tmpDir('tllm-rel-route-')
  const h = harness({ dataDir, engines: [RELEASE_ENGINE(seededDir(dataDir, RELEASE_INSTALL_MARKER))] })
  let openListing = () => {}
  const gate = new Promise<void>((resolve) => { openListing = resolve })
  await withGithub('missing', async () => {
    assert.equal((await postUpdate(h, 'e1')).status, 202)
    const second = await postUpdate(h, 'e1')
    assert.equal(second.status, 409)
    assert.equal((await errorOf(second)).code, 'engine_already_running')
    openListing()
    await waitUntil(() => settled(h))
  }, (url) => (url.includes('api.github.com') ? gate.then(() => new Response('', { status: 404 })) : null))
})

test('POST /engines/:id/update: the slot frees once the update has settled', async () => {
  const dataDir = tmpDir('tllm-rel-route-')
  const h = harness({ dataDir, engines: [RELEASE_ENGINE(seededDir(dataDir, RELEASE_INSTALL_MARKER))] })
  await withGithub('missing', async () => {
    assert.equal((await postUpdate(h, 'e1')).status, 202)
    await waitUntil(() => settled(h))
    await new Promise((r) => setTimeout(r, 50))
    assert.equal((await postUpdate(h, 'e1')).status, 202)
    await new Promise((r) => setTimeout(r, 100))
  })
})

test('POST /engines/:id/update: a failure before provisioning starts is reported on the provision channel', async () => {
  const dataDir = tmpDir('tllm-rel-route-')
  const h = harness({ dataDir, engines: [RELEASE_ENGINE(seededDir(dataDir, RELEASE_INSTALL_MARKER))] })
  await withGithub('missing', async () => {
    assert.equal((await postUpdate(h, 'e1')).status, 202)
    await waitUntil(() => settled(h))
  }, () => { throw new TypeError('fetch failed') })
  assert.ok(h.provisionLog.some((l) => l.startsWith('fail:')), h.provisionLog.join('|'))
})

test('POST /engines/:id/update: a failure before provisioning starts settles as a user_update, not the previous run', async () => {
  const dataDir = tmpDir('tllm-rel-route-')
  const h = harness({ dataDir, engines: [RELEASE_ENGINE(seededDir(dataDir, RELEASE_INSTALL_MARKER))] })
  await withGithub('missing', async () => {
    assert.equal((await postUpdate(h, 'e1')).status, 202)
    await waitUntil(() => settled(h))
  }, () => { throw new TypeError('fetch failed') })
  assert.deepEqual(h.settlements, [{ ok: false, trigger: 'user_update' }])
})

test('POST /engines/:id/update: a failure after provisioning started is reported once, keeping the "unchanged" message', async () => {
  const dataDir = tmpDir('tllm-rel-route-')
  const h = harness({ dataDir, engines: [RELEASE_ENGINE(seededDir(dataDir, RELEASE_INSTALL_MARKER))] })
  const newer = { tag: 'b9', assets: [{ name: ZIP_ASSET, bytes: Buffer.alloc(64, 7) }] }
  await withGithub(newer, async () => {
    assert.equal((await postUpdate(h, 'e1')).status, 202)
    await waitUntil(() => settled(h))
    await new Promise((r) => setTimeout(r, 100))
  }, (url) => (url.startsWith('https://cdn.test/') ? new Response('', { status: 404 }) : null))
  const fails = h.provisionLog.filter((l) => l.startsWith('fail:'))
  assert.equal(fails.length, 1, h.provisionLog.join('|'))
  assert.match(fails[0]!, /unchanged/)
  assert.equal(h.settlements.length, 1)
})

test('POST install: an archive without a server binary ends the job with no_server_binary', async () => {
  const h = harness()
  const bytes = buildZipArchive([{ name: 'readme.txt', data: Buffer.from('hi') }])
  await withGithub({ tag: 'b1', assets: [{ name: ZIP_ASSET, bytes }] }, async () => {
    assert.equal((await postInstall(h)).status, 202)
    const view = await jobState(h)
    assert.equal(view.state, 'error')
    assert.equal(view.error?.code, 'no_server_binary')
  })
})

test('POST install: 409 engine_in_use when only an extra pool slot runs on the occupant', async () => {
  const dataDir = tmpDir('tllm-rel-route-')
  const dir = seededDir(dataDir, RELEASE_INSTALL_MARKER)
  const h = harness({ dataDir, poolEngineId: 'e1', engines: [RELEASE_ENGINE(dir)] })
  await withGithub({ tag: 'b1', assets: [{ name: ZIP_ASSET }] }, async () => {
    const res = await postInstall(h)
    assert.equal(res.status, 409)
    assert.equal((await errorOf(res)).code, 'engine_in_use')
  })
  assert.deepEqual(h.provisionLog, [])
})

test('POST /engines/:id/update: an extra pool slot on the engine ends the update as a refusal, never a swap', async () => {
  const dataDir = tmpDir('tllm-rel-route-')
  const dir = seededDir(dataDir, RELEASE_INSTALL_MARKER)
  const h = harness({ dataDir, poolEngineId: 'e1', engines: [RELEASE_ENGINE(dir)] })
  await withGithub({ tag: 'b9', assets: [{ name: ZIP_ASSET, bytes: Buffer.alloc(64, 7) }] }, async (requests) => {
    assert.equal((await postUpdate(h, 'e1')).status, 202)
    await waitUntil(() => settled(h))
    assert.equal(requests.some((u) => u.startsWith('https://cdn.test/')), false)
  })
  assert.match(h.provisionLog.find((l) => l.startsWith('fail:')) ?? '', /Stop "Rel"/)
})
