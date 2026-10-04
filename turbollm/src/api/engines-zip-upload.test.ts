// Route-level tests for POST /api/v1/engines/zip (and its DELETE cleanup companion) — the
// .zip-upload source of the Add-engine flow. Same "real Hono app, minimal Deps double"
// discipline as keys-network.test.ts: the route's guards (auth, W^X, busy, occupied
// build-folder replacement) and error envelope are only reachable through a real request
// Context. Happy paths run a shell script as the "binary" — probe.ts deliberately runs
// unrecognized formats instead of refusing them, so a script printing a llama.cpp version
// line installs end-to-end (POSIX only; Windows gets the wrong-platform and failure paths,
// which behave identically there).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'
import { buildZipArchive, type ZipMember } from '../test-support/zip-archive'
import { serverBinName } from '../engines/scan'
import { ZIP_BUILD_MARKER, type ZipScanResult } from '../engines/zip-install'

interface FakeOverrides {
  lanBind?: boolean
  requireApiKey?: boolean
  /** 'download' | 'build' — an engine work phase in flight. */
  busy?: 'download' | 'build'
  /** A live registered engine whose binary lives under the upload's target dir. */
  runningEngine?: { name: string; binPath: string }
  /** Registered (stopped or running) engines the occupant check must see. */
  engines?: Array<{ id: string; name: string; binPath: string }>
  /** Remembered custom sources (a Disabled engine's Enable path) the occupant check must see. */
  customSources?: Array<{ name: string; binPath: string }>
  /** Recorder for registry.refresh calls (the same-name update flow). */
  refreshLog?: Array<{ id: string; version: string; binPath?: string }>
}

function zipApp(o: FakeOverrides, dataDir: string): Hono {
  const cfg = {
    daemon: { lanBind: o.lanBind ?? false, requireApiKey: o.requireApiKey ?? false, port: 6996, machineId: 'm', machineName: 'test' },
    apiKeys: [],
    links: [],
    telemetry: { level: 'off', machineId: 'm' },
  }
  const refreshLog = o.refreshLog ?? []
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, dir: () => dataDir },
    manager: { status: () => ({ state: o.runningEngine ? 'running' : 'stopped', err: null, port: 0, pid: 0, model: null }) },
    provision: { get: () => ({ active: o.busy === 'download' }) },
    build: { isActive: () => o.busy === 'build' },
    registry: {
      active: () =>
        o.runningEngine
          ? { id: 'e-run', name: o.runningEngine.name, binPath: o.runningEngine.binPath, kind: 'llama-server' }
          : (o.engines ?? []).find((e) => e.id === 'e-active'),
      list: () => ({ engines: o.engines ?? [], activeEngineId: (o.engines ?? []).find((e) => e.id === 'e-active')?.id ?? '' }),
      customSources: () => o.customSources ?? [],
      refresh: (id: string, pr: { version: string }, binPath?: string) => { refreshLog.push({ id, version: pr.version, binPath }) },
    },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return app
}

async function postZip(app: Hono, bytes: Buffer, fileName = 'myfork.zip'): Promise<Response> {
  const form = new FormData()
  form.append('file', new File([bytes], fileName))
  return app.request('/api/v1/engines/zip', { method: 'POST', body: form })
}

async function errorBody(res: Response): Promise<{ code: string; message: string }> {
  assert.equal(res.headers.get('content-type')?.startsWith('application/json'), true)
  return ((await res.json()) as { error: { code: string; message: string } }).error
}

function member(name: string, data: Buffer | string): ZipMember {
  return { name, data: Buffer.isBuffer(data) ? data : Buffer.from(data) }
}

/** A zip whose llama-server is a shell script reporting `version: <v>` — probes successfully
 *  end-to-end on POSIX (probe runs unknown formats rather than refusing them). */
function scriptZip(version: string, prelude = ''): Buffer {
  return buildZipArchive([member(serverBinName, `#!/bin/sh\n${prelude}echo "version: ${version}"\n`)])
}

/** A Mach-O magic binary — the wrong-platform build on Linux and Windows (format mismatch,
 *  400 binary_not_executable) and an unrunnable one on macOS (400 probe_failed). */
const MACHO_BYTES = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01])

test('POST /api/v1/engines/zip: 403 for a non-host caller on an open, keyless LAN', async () => {
  // app.request() carries no TCP connection, so isLoopback fails closed to null — exactly
  // the "non-host viewer" case (see keys-network.test.ts for the same trick).
  const dir = tmpDir('tllm-zip-route-')
  try {
    const res = await postZip(zipApp({ lanBind: true, requireApiKey: false }, dir), Buffer.from('x'))
    assert.equal(res.status, 403)
    assert.equal((await errorBody(res)).code, 'forbidden')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: a cross-site chunked upload is refused before its body is read', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    // No Content-Length, and a body that never ends: the header guards must refuse the
    // cross-site POST before bodyLimit starts buffering it (a request that stayed chunked
    // under the cap would otherwise be fully read — gigabytes — before anyone checks who
    // sent it). With the guards behind bodyLimit this test sees 413, not 403.
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1024 * 1024).fill(0x78))
      },
    })
    const res = await zipApp({}, dir).request('/api/v1/engines/zip', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
      body,
      duplex: 'half',
    })
    assert.equal(res.status, 403)
    assert.equal((await errorBody(res)).code, 'forbidden')
    assert.ok(pulled < 4, `the body must not be read before the guards run (pulled ${pulled} MiB)`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: 400 when the form has no "file" field', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    const res = await zipApp({}, dir).request('/api/v1/engines/zip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'somewhere' }),
    })
    assert.equal(res.status, 400)
    assert.equal((await errorBody(res)).code, 'invalid_config_value')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: 400 bad_zip for a non-zip upload', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    const res = await postZip(zipApp({}, dir), Buffer.from('definitely not a zip archive'))
    assert.equal(res.status, 400)
    assert.equal((await errorBody(res)).code, 'bad_zip')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: 400 encrypted_zip for a password-protected archive', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    const zip = buildZipArchive([{ name: serverBinName, data: Buffer.from('x'), encrypted: true }])
    const res = await postZip(zipApp({}, dir), zip)
    assert.equal(res.status, 400)
    const e = await errorBody(res)
    assert.equal(e.code, 'encrypted_zip')
    assert.match(e.message, /encrypted/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: no server binary → {found:false}, and nothing is written to disk', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    const res = await postZip(zipApp({}, dir), buildZipArchive([member('docs/readme.txt', 'hi')]))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { found: false })
    assert.equal(existsSync(join(dir, 'engines', 'build')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: an unrunnable binary fails the probe with 400 and cleans the extraction', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    // Real probe, garbage bytes: detectFormat passes (unknown), execution fails on every
    // OS → ProbeError('probe_failed') — and the half-installed dir must be gone.
    const zip = buildZipArchive([member(`bin/${serverBinName}`, 'garbage — not an executable')])
    const res = await postZip(zipApp({}, dir), zip)
    assert.equal(res.status, 400)
    assert.equal((await errorBody(res)).code, 'probe_failed')
    assert.equal(existsSync(join(dir, 'engines', 'build', 'myfork')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: 409 while an engine download is in flight', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    const res = await postZip(zipApp({ busy: 'download' }, dir), Buffer.from('x'))
    assert.equal(res.status, 409)
    assert.equal((await errorBody(res)).code, 'engine_already_running')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: 409 while ANOTHER zip upload is in flight', async () => {
  if (process.platform === 'win32') return // the probeable fixture is a POSIX script
  const dir = tmpDir('tllm-zip-route-')
  try {
    // The first upload's probe sleeps, holding the upload slot; the second POST must be
    // refused synchronously rather than interleaving on the same build root.
    const r1 = postZip(zipApp({}, dir), scriptZip('b4242', 'sleep 1\n'))
    await new Promise((r) => setTimeout(r, 100))
    const r2 = await postZip(zipApp({}, dir), Buffer.from('x'))
    assert.equal(r2.status, 409)
    const e = await errorBody(r2)
    assert.equal(e.code, 'engine_already_running')
    assert.match(e.message, /zip upload/)
    assert.equal((await r1).status, 200)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: 409 when the upload would replace the RUNNING engine\'s build dir', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    const running = { name: 'My Fork', binPath: join(dir, 'engines', 'build', 'myfork', serverBinName) }
    const res = await postZip(zipApp({ runningEngine: running }, dir), Buffer.from('x'))
    assert.equal(res.status, 409)
    const e = await errorBody(res)
    assert.equal(e.code, 'engine_in_use')
    assert.match(e.message, /My Fork/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: 409 when a STOPPED engine owns the target dir and it is not a zip install', async () => {
  // The ik_llama.cpp case from the PR review: 1-click git builds made before ADR-387 slug to
  // the bare repo name, so ik_llama.cpp.zip would otherwise delete the build — clone
  // included — of an engine that is merely stopped.
  const dir = tmpDir('tllm-zip-route-')
  try {
    const buildDir = join(dir, 'engines', 'build', 'ik_llama.cpp')
    mkdirSync(buildDir, { recursive: true })
    const cloneFile = join(buildDir, 'CMakeLists.txt')
    writeFileSync(cloneFile, 'project(ik_llama)')
    const engines = [{ id: 'e2', name: 'ik_llama.cpp', binPath: join(buildDir, serverBinName) }]
    const res = await postZip(zipApp({ engines }, dir), Buffer.from('x'), 'ik_llama.cpp.zip')
    assert.equal(res.status, 409)
    const e = await errorBody(res)
    assert.equal(e.code, 'build_dir_taken')
    assert.match(e.message, /ik_llama\.cpp/)
    assert.equal(existsSync(cloneFile), true, 'the git build must be untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: 409 when only a DISABLED custom source (no live engine) owns the target dir', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    const buildDir = join(dir, 'engines', 'build', 'myfork')
    mkdirSync(buildDir, { recursive: true })
    const sources = [{ name: 'My Fork', binPath: join(buildDir, serverBinName) }]
    const res = await postZip(zipApp({ customSources: sources }, dir), scriptZip('b5000'))
    assert.equal(res.status, 409)
    assert.equal((await errorBody(res)).code, 'build_dir_taken')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: a failed re-upload over a marked install leaves the prior install intact', async () => {
  // The reviewer's repro: a working myfork install, then a myfork.zip holding a macOS
  // binary — the failed update must not destroy the files the registered engine points at.
  const dir = tmpDir('tllm-zip-route-')
  try {
    const buildDir = join(dir, 'engines', 'build', 'myfork')
    mkdirSync(buildDir, { recursive: true })
    const oldBin = join(buildDir, serverBinName)
    writeFileSync(oldBin, scriptZip('b4242').length ? 'old working binary' : '')
    writeFileSync(join(buildDir, ZIP_BUILD_MARKER), 'myfork.zip\n')
    const engines = [{ id: 'e1', name: 'My Fork', binPath: oldBin }]
    const res = await postZip(zipApp({ engines }, dir), buildZipArchive([member(serverBinName, MACHO_BYTES)]))
    assert.equal(res.status, 400)
    const e = await errorBody(res)
    assert.ok(e.code === 'binary_not_executable' || e.code === 'probe_failed', `unexpected code ${e.code}`)
    assert.equal(existsSync(oldBin), true, 'the working install must survive a failed re-upload')
    assert.equal(existsSync(join(buildDir, ZIP_BUILD_MARKER)), true)
    assert.deepEqual(readdirSync(join(dir, 'engines', 'build')), ['myfork'], 'no temporary dir may linger')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: a same-named re-upload UPDATES the existing engine in place', async () => {
  if (process.platform === 'win32') return // the probeable fixture is a POSIX script
  const dir = tmpDir('tllm-zip-route-')
  const refreshLog: Array<{ id: string; version: string; binPath?: string }> = []
  try {
    const buildDir = join(dir, 'engines', 'build', 'myfork')
    mkdirSync(buildDir, { recursive: true })
    writeFileSync(join(buildDir, serverBinName), 'old working binary')
    writeFileSync(join(buildDir, ZIP_BUILD_MARKER), 'myfork.zip\n')
    const engines = [{ id: 'e1', name: 'My Fork', binPath: join(buildDir, serverBinName) }]
    const res = await postZip(zipApp({ engines, refreshLog }, dir), scriptZip('b5000'))
    assert.equal(res.status, 200)
    const body = (await res.json()) as Extract<ZipScanResult, { found: true }> & { updated?: { id: string; name: string } }
    assert.equal(body.found, true)
    assert.equal(body.version, 'b5000')
    // The dialog is told it was an update, so it never POSTs a second registration.
    assert.deepEqual(body.updated, { id: 'e1', name: 'My Fork' })
    // The registration was refreshed in place — same id, new version, same final path.
    assert.equal(refreshLog.length, 1)
    assert.equal(refreshLog[0]!.id, 'e1')
    assert.equal(refreshLog[0]!.version, 'b5000')
    assert.equal(refreshLog[0]!.binPath, join(buildDir, serverBinName))
    // The old files were replaced by the new build, and no temporary dir lingers.
    assert.equal(existsSync(join(buildDir, ZIP_BUILD_MARKER)), true)
    assert.deepEqual(readdirSync(join(dir, 'engines', 'build')), ['myfork'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/engines/zip: a fresh upload lands in engines/build/<slug> and reports the final path', async () => {
  if (process.platform === 'win32') return // the probeable fixture is a POSIX script
  const dir = tmpDir('tllm-zip-route-')
  const refreshLog: Array<{ id: string; version: string; binPath?: string }> = []
  try {
    const res = await postZip(zipApp({ refreshLog }, dir), scriptZip('b4242'))
    assert.equal(res.status, 200)
    const body = (await res.json()) as Extract<ZipScanResult, { found: true }> & { updated?: unknown }
    assert.equal(body.found, true)
    assert.equal(body.binPath, join(dir, 'engines', 'build', 'myfork', serverBinName))
    assert.equal(body.suggestedName, 'myfork (b4242)')
    assert.equal(body.updated, undefined, 'no prior engine — this is a new install, not an update')
    assert.equal(refreshLog.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── DELETE /api/v1/engines/zip (unconfirmed-install cleanup) ───────────────────

function deleteZipInstall(app: Hono, binPath: string): Promise<Response> | Response {
  return app.request(`/api/v1/engines/zip?binPath=${encodeURIComponent(binPath)}`, { method: 'DELETE' })
}

test('DELETE /api/v1/engines/zip: removes an unconfirmed marked install', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    const buildDir = join(dir, 'engines', 'build', 'myfork')
    mkdirSync(buildDir, { recursive: true })
    writeFileSync(join(buildDir, serverBinName), 'extracted binary')
    writeFileSync(join(buildDir, ZIP_BUILD_MARKER), 'myfork.zip\n')
    const res = await deleteZipInstall(zipApp({}, dir), join(buildDir, serverBinName))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    assert.equal(existsSync(buildDir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DELETE /api/v1/engines/zip: refuses a dir a registered engine still uses, and unmarked dirs', async () => {
  const dir = tmpDir('tllm-zip-route-')
  try {
    // Claimed by a live engine: 409, files intact.
    const claimed = join(dir, 'engines', 'build', 'myfork')
    mkdirSync(claimed, { recursive: true })
    writeFileSync(join(claimed, serverBinName), 'binary')
    writeFileSync(join(claimed, ZIP_BUILD_MARKER), 'myfork.zip\n')
    const engines = [{ id: 'e1', name: 'My Fork', binPath: join(claimed, serverBinName) }]
    let res = await deleteZipInstall(zipApp({ engines }, dir), join(claimed, serverBinName))
    assert.equal(res.status, 409)
    assert.equal(existsSync(join(claimed, serverBinName)), true)
    // Unmarked (a git build): 404, files intact — only this flow's own dirs are removable.
    const gitBuild = join(dir, 'engines', 'build', 'ik_llama.cpp')
    mkdirSync(gitBuild, { recursive: true })
    writeFileSync(join(gitBuild, 'CMakeLists.txt'), 'project(ik_llama)')
    res = await deleteZipInstall(zipApp({}, dir), join(gitBuild, serverBinName))
    assert.equal(res.status, 404)
    assert.equal(existsSync(join(gitBuild, 'CMakeLists.txt')), true)
    // A path outside the engines root: 404, never a deletion.
    res = await deleteZipInstall(zipApp({}, dir), '/etc/passwd')
    assert.equal(res.status, 404)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
