// Release-engine update application (ADR-453, ADR-085): a newer build of the same variant is
// installed into the same slug, keeps the engine's id, and leaves the old build alone on failure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../test-support/tmp'
import { buildZipArchive } from '../test-support/zip-archive'
import type { Engine } from '../config/config'
import type { ProbeResult } from './probe'
import { serverBinName } from './scan'
import { releaseInstallDirName, writeReleaseMarker, type ReleaseProvenance } from './release-install'
import { applyEngineUpdate, recordReleaseUpdate, type UpdateApplyDeps } from './update-apply'
import { UpdateChecker } from './update'

const REPO = 'o/r'
const ASSET_KEY = 'llama-bin-ubuntu-x64.zip'
const SLUG = releaseInstallDirName({ repo: REPO, assetKey: ASSET_KEY })
const PROBE_OK: ProbeResult = { version: 'b2', capabilities: { kvTypes: ['f16'], flags: [], flagInfo: [] } }

const INSTALLED: ReleaseProvenance = {
  repo: REPO,
  tag: 'b1',
  asset: 'llama-b1-bin-ubuntu-x64.zip',
  assetKey: ASSET_KEY,
  publishedAt: '2026-09-01T00:00:00Z',
  prerelease: false,
  companions: [],
}

function release(tag: string, publishedAt: string) {
  const name = `llama-${tag}-bin-ubuntu-x64.zip`
  return { tag_name: tag, published_at: publishedAt, prerelease: false, assets: [{ name, browser_download_url: `https://cdn.test/${name}`, size: 10 }] }
}

function fakeGithub(releases: ReturnType<typeof release>[]) {
  const requests: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    if (url.includes('/releases/tags/')) {
      const found = releases.find((r) => url.endsWith(encodeURIComponent(r.tag_name)))
      return found ? Response.json(found) : new Response('', { status: 404 })
    }
    if (url.includes('/releases?')) return Response.json(releases)
    return new Response(buildZipArchive([{ name: serverBinName }]))
  }) as typeof fetch
  return { fetchImpl, requests }
}

function harness(opts: { activeId?: string; probe?: () => Promise<ProbeResult> } = {}) {
  let managerState = 'stopped'
  const dataDir = tmpDir('upd-rel-')
  const slugDir = join(dataDir, 'engines', 'build', SLUG)
  mkdirSync(slugDir, { recursive: true })
  writeFileSync(join(slugDir, serverBinName), 'OLD')
  writeReleaseMarker(slugDir, INSTALLED)
  const engine = { id: 'e1', name: 'Rel', kind: 'llama-server', binPath: join(slugDir, serverBinName), release: INSTALLED } as Engine
  const calls: string[] = []
  const refreshed: { id: string; binPath?: string }[] = []
  const releases: { id: string; tag: string }[] = []
  const deps: UpdateApplyDeps = {
    store: { dir: () => dataDir } as unknown as UpdateApplyDeps['store'],
    registry: {
      active: () => (opts.activeId ? { id: opts.activeId } : undefined),
      list: () => ({ engines: [engine], activeEngineId: opts.activeId ?? '' }),
      refresh: (id: string, _pr: ProbeResult, binPath?: string) => { refreshed.push({ id, binPath }); return engine },
      setRelease: (id: string, p: ReleaseProvenance) => { releases.push({ id, tag: p.tag }); return engine },
    } as unknown as UpdateApplyDeps['registry'],
    manager: {
      stopAndWait: async () => { calls.push('stop'); managerState = 'stopped' },
      status: () => ({ state: managerState }),
    } as unknown as UpdateApplyDeps['manager'],
    provision: {
      start: (backend: string, trigger?: string) => { calls.push(`start:${backend}:${trigger}`) },
      progress: () => {},
      done: () => { calls.push('done') },
      fail: (m: string) => { calls.push(`fail:${m}`) },
    } as unknown as UpdateApplyDeps['provision'],
    probeFn: opts.probe ?? (async () => PROBE_OK),
  }
  return { deps, engine, slugDir, calls, refreshed, releases, startEngine: () => { managerState = 'running' } }
}

const NEWER = release('b2', '2026-09-10T00:00:00Z')
const SAME = release('b1', '2026-09-01T00:00:00Z')

test('nothing newer: no provision job, no refresh', async () => {
  const h = harness()
  const gh = fakeGithub([SAME])
  await applyEngineUpdate({ ...h.deps, fetchImpl: gh.fetchImpl }, h.engine)
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.refreshed, [])
})

test('a newer release refreshes the same engine id, records the new tag and forwards the trigger', async () => {
  const h = harness()
  const gh = fakeGithub([NEWER, SAME])
  await applyEngineUpdate({ ...h.deps, fetchImpl: gh.fetchImpl, trigger: 'user_update' }, h.engine)
  assert.deepEqual(h.calls, ['start:github-release:user_update', 'done'])
  assert.deepEqual(h.releases, [{ id: 'e1', tag: 'b2' }])
  assert.equal(h.refreshed[0]?.id, 'e1')
  assert.equal(h.refreshed[0]?.binPath, join(h.slugDir, serverBinName))
  assert.equal(readFileSync(join(h.slugDir, '.turbollm-release-install'), 'utf8').includes('"tag":"b2"'), true)
})

test('trigger defaults to auto_update', async () => {
  const h = harness()
  await applyEngineUpdate({ ...h.deps, fetchImpl: fakeGithub([NEWER]).fetchImpl }, h.engine)
  assert.equal(h.calls[0], 'start:github-release:auto_update')
})

test('the active engine is stopped before the install', async () => {
  const h = harness({ activeId: 'e1' })
  await applyEngineUpdate({ ...h.deps, fetchImpl: fakeGithub([NEWER]).fetchImpl }, h.engine)
  assert.deepEqual(h.calls.slice(0, 2), ['start:github-release:auto_update', 'stop'])
})

test('a probe failure fails the job as unchanged, rethrows, and leaves the old build', async () => {
  const h = harness({ probe: async () => { throw new Error('probe boom') } })
  await assert.rejects(applyEngineUpdate({ ...h.deps, fetchImpl: fakeGithub([NEWER]).fetchImpl }, h.engine), /probe boom/)
  assert.match(h.calls.at(-1) ?? '', /^fail:.*unchanged/)
  assert.equal(readFileSync(join(h.slugDir, serverBinName), 'utf8'), 'OLD')
  assert.deepEqual(h.refreshed, [])
})

test('an engine without release provenance still takes the llama.cpp branch', async () => {
  const h = harness()
  const plain = { ...h.engine, release: undefined, binPath: join(h.slugDir, serverBinName) } as Engine
  await assert.rejects(applyEngineUpdate(h.deps, plain), /no automatic update source/)
})

test('workBusy short-circuits before any network call or job', async () => {
  const h = harness()
  const gh = fakeGithub([NEWER])
  await applyEngineUpdate({ ...h.deps, fetchImpl: gh.fetchImpl, workBusy: () => 'An engine download is in progress' }, h.engine)
  assert.deepEqual(h.calls, [])
  assert.equal(gh.requests.length, 0)
  assert.deepEqual(h.refreshed, [])
})

test('workBusy returning null lets the update proceed', async () => {
  const h = harness()
  await applyEngineUpdate({ ...h.deps, fetchImpl: fakeGithub([NEWER]).fetchImpl, workBusy: () => null }, h.engine)
  assert.equal(h.refreshed.length, 1)
  assert.ok(existsSync(join(h.slugDir, serverBinName)))
})

test('a user starting the engine during the download blocks the swap and keeps the old build', async () => {
  const h = harness({ activeId: 'e1' })
  const probe = async () => { h.startEngine(); return PROBE_OK }
  await assert.rejects(applyEngineUpdate({ ...h.deps, probeFn: probe, fetchImpl: fakeGithub([NEWER]).fetchImpl }, h.engine), /Stop/)
  assert.equal(readFileSync(join(h.slugDir, serverBinName), 'utf8'), 'OLD')
  assert.deepEqual(h.refreshed, [])
})

test('a classification-fallback match updates into the original slug dir', async () => {
  const h = harness()
  const twin = { ...release('b2', '2026-09-10T00:00:00Z'), assets: [{ name: 'llama-b2-bin-linux-x64.zip', browser_download_url: 'https://cdn.test/t.zip', size: 10 }] }
  await applyEngineUpdate({ ...h.deps, fetchImpl: fakeGithub([twin]).fetchImpl }, h.engine)
  assert.equal(h.refreshed[0]?.binPath, join(h.slugDir, serverBinName))
  assert.equal(readdirSync(join(h.slugDir, '..')).filter((n) => !n.startsWith('.')).length, 1)
})

test('two sequential updates (fallback match, then exact match) keep the original dir', async () => {
  const h = harness()
  const twin = (tag: string, publishedAt: string) => ({ ...release(tag, publishedAt), assets: [{ name: `llama-${tag}-bin-linux-x64.zip`, browser_download_url: `https://cdn.test/${tag}.zip`, size: 10 }] })
  const original = h.engine.binPath
  // Mirror what the registry does with a finished update, so the next run sees the new state.
  h.deps.registry.refresh = ((id: string, _pr: ProbeResult, binPath?: string) => { h.refreshed.push({ id, binPath }); if (binPath) h.engine.binPath = binPath; return h.engine }) as typeof h.deps.registry.refresh
  h.deps.registry.setRelease = ((_id: string, p: ReleaseProvenance) => { h.engine.release = p; return h.engine }) as typeof h.deps.registry.setRelease

  await applyEngineUpdate({ ...h.deps, fetchImpl: fakeGithub([twin('b2', '2026-09-10T00:00:00Z')]).fetchImpl }, h.engine)
  await applyEngineUpdate({ ...h.deps, fetchImpl: fakeGithub([twin('b3', '2026-09-20T00:00:00Z')]).fetchImpl }, h.engine)

  assert.equal(h.engine.release?.tag, 'b3')
  assert.equal(h.engine.binPath, original)
  assert.equal(readdirSync(join(h.slugDir, '..')).filter((n) => !n.startsWith('.')).length, 1)
})

test('a completed release update forgets the cached update status of that engine', async () => {
  const h = harness()
  const updates = new UpdateChecker()
  const forgotten: string[] = []
  updates.forget = (id: string) => { forgotten.push(id) }
  await applyEngineUpdate({ ...h.deps, updates, fetchImpl: fakeGithub([NEWER]).fetchImpl }, h.engine)
  assert.deepEqual(forgotten, ['e1'])
})

test('recordReleaseUpdate refreshes, records provenance, and tolerates no checker', () => {
  const h = harness()
  const result = { found: true, version: 'b2', capabilities: PROBE_OK.capabilities, binPath: 'x', provenance: { ...INSTALLED, tag: 'b2' } } as unknown as Parameters<typeof recordReleaseUpdate>[3]
  recordReleaseUpdate(h.deps.registry, undefined, 'e1', result)
  assert.deepEqual(h.releases, [{ id: 'e1', tag: 'b2' }])
})

function poolRouter(engineId: string, calls: string[]): NonNullable<UpdateApplyDeps['modelRouter']> {
  return {
    poolSlotsOnEngine: (id: string) => (id === engineId ? 1 : 0),
    stopPoolSlotsOnEngine: async () => { calls.push('stop-pool') },
  }
}

test('an extra pool slot running on the engine refuses the update before any fetch or job, and never stops it', async () => {
  const h = harness()
  const gh = fakeGithub([NEWER])
  await assert.rejects(
    applyEngineUpdate({ ...h.deps, fetchImpl: gh.fetchImpl, modelRouter: poolRouter('e1', h.calls) }, h.engine),
    /Stop "Rel" before/,
  )
  assert.equal(gh.requests.length, 0)
  assert.deepEqual(h.calls, [])
  assert.equal(readFileSync(join(h.slugDir, serverBinName), 'utf8'), 'OLD')
})

test('a pool slot on a different engine does not block the update', async () => {
  const h = harness()
  await applyEngineUpdate({ ...h.deps, fetchImpl: fakeGithub([NEWER]).fetchImpl, modelRouter: poolRouter('other', h.calls) }, h.engine)
  assert.equal(h.refreshed.length, 1)
})

test('a pool slot started during the download blocks the swap and keeps the old build', async () => {
  const h = harness()
  let poolRunning = false
  const modelRouter = { poolSlotsOnEngine: () => (poolRunning ? 1 : 0), stopPoolSlotsOnEngine: async () => {} }
  const probe = async () => { poolRunning = true; return PROBE_OK }
  await assert.rejects(
    applyEngineUpdate({ ...h.deps, probeFn: probe, fetchImpl: fakeGithub([NEWER]).fetchImpl, modelRouter }, h.engine),
    /Stop/,
  )
  assert.equal(readFileSync(join(h.slugDir, serverBinName), 'utf8'), 'OLD')
  assert.deepEqual(h.refreshed, [])
})
