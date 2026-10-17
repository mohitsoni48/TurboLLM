// DELETE /api/v1/engines/:id (Disable, ?purge=1) and DELETE /api/v1/engines/backends/:id must not run while an engine
// update, download, upload or rebuild holds the engine-work slot (engineWorkBusy), as the install, update, zip and
// build routes already refuse. A purge under an update made its swap report "your existing build is unchanged" and
// left an orphan folder; under a rebuild the failing build moved its parked previous build back into the purged
// folder; a backend deleted mid-update was registered again. POST /api/v1/engines (Add, Enable) is refused too, as
// is DELETE /api/v1/engines/build (a Disabled source-built card's Delete). Same "real Hono app, minimal Deps double"
// style as engines-release.test.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs, { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { Hono } from 'hono'
import { engineWorkBusy, registerApi } from './routes'
import type { Deps } from '../deps'
import { availableBackends } from '../engines/download'
import { BuildState } from '../engines/build-state'
import { tmpDir } from '../test-support/tmp'

function harness(busy: 'download' | 'build' | null) {
  const dataDir = tmpDir('tllm-engine-delete-')
  const forkDir = join(dataDir, 'engines', 'build', 'myfork')
  mkdirSync(forkDir, { recursive: true })
  writeFileSync(join(forkDir, 'llama-server'), 'bin')
  const otherForkDir = join(dataDir, 'engines', 'build', 'otherfork')
  mkdirSync(otherForkDir, { recursive: true })
  writeFileSync(join(otherForkDir, 'llama-server'), 'bin')
  const backend = availableBackends()[0]!
  const backendDir = join(dataDir, 'engines', `llama.cpp-b1-${backend.id}`)
  mkdirSync(backendDir, { recursive: true })
  writeFileSync(join(backendDir, 'llama-server'), 'bin')
  const engines = [
    { id: 'fork', name: 'My fork', kind: 'llama-server', binPath: join(forkDir, 'llama-server') },
    { id: 'be', name: 'llama.cpp', kind: 'llama-server', binPath: join(backendDir, 'llama-server') },
    { id: 'other', name: 'Other fork', kind: 'llama-server', binPath: join(otherForkDir, 'llama-server') },
  ]
  const removed: string[] = []
  const added: string[] = []
  const sources: { binPath: string; sourceRepo?: string; sourceBranch?: string }[] = []
  const forgotten: string[] = []
  const failRemove = { on: false }
  // The active engine and how long stopping it takes: a model stop waits for the process to exit.
  const live = { activeId: '', stopping: null as Promise<void> | null, stops: 0 }
  const cfg = {
    daemon: { lanBind: false, requireApiKey: false, port: 6996, machineId: 'm', machineName: 'test' },
    apiKeys: [], links: [], telemetry: { level: 'off', machineId: 'm' },
    build: { toolchainDirs: [] as string[] },
  }
  // A real BuildState: a source build counts as engine work here, a CUDA Toolkit download or a prerequisite install
  // (started with toolInstall) does not.
  const build = new BuildState()
  if (busy === 'build') build.start('My fork')
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, dir: () => dataDir },
    manager: {
      status: () => ({ state: 'stopped', err: null, port: 0, pid: 0, model: null }),
      currentOpts: () => null,
      stopAndWait: async () => { live.stops++; await live.stopping },
    },
    provision: { get: () => ({ active: busy === 'download', phase: 'idle', backend: '', pct: 0, part: 1, parts: 1, error: null }) },
    build,
    modelRouter: { poolEngineIds: () => new Set<string>(), stopPoolSlotsOnEngine: async () => {} },
    registry: {
      active: () => engines.find((e) => e.id === live.activeId && !removed.includes(e.id)),
      list: () => ({ engines: engines.filter((e) => !removed.includes(e.id)), activeEngineId: live.activeId }),
      get: (id: string) => engines.find((e) => e.id === id && !removed.includes(id)),
      remove: (id: string) => {
        if (failRemove.on) throw Object.assign(new Error('EPERM: operation not permitted, rename config.json'), { code: 'EPERM' })
        removed.push(id)
      },
      forgetCustomSource: (key: string) => { forgotten.push(key) },
      add: async (name: string, binPath: string) => {
        added.push(binPath)
        return { engine: { id: 'fork2', name, binPath, kind: 'llama-server' }, warning: null }
      },
      recordCustomSource: () => {},
      customSources: () => sources,
    },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return { app, d, cfg, build, live, engines, removed, added, sources, forgotten, failRemove, dataDir, forkDir, otherForkDir, backendDir, backendId: backend.id }
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code
}

for (const busy of ['download', 'build'] as const) {
  test(`DELETE /engines/:id: Disable and Purge are 409 engine_already_running while a ${busy} runs, and remove nothing`, async () => {
    const h = harness(busy)
    for (const query of ['', '?purge=1']) {
      const res = await h.app.request(`/api/v1/engines/fork${query}`, { method: 'DELETE' })
      assert.equal(res.status, 409, query || 'disable')
      assert.equal(await errorCode(res), 'engine_already_running')
    }
    assert.deepEqual(h.removed, [])
    assert.equal(existsSync(h.forkDir), true)
  })

  test(`DELETE /engines/backends/:id is 409 engine_already_running while a ${busy} runs, and keeps its builds`, async () => {
    const h = harness(busy)
    const res = await h.app.request(`/api/v1/engines/backends/${h.backendId}`, { method: 'DELETE' })
    assert.equal(res.status, 409)
    assert.equal(await errorCode(res), 'engine_already_running')
    assert.deepEqual(h.removed, [])
    assert.equal(existsSync(h.backendDir), true)
  })

  test(`POST /engines (Add, Enable) is 409 engine_already_running while a ${busy} runs, and registers nothing`, async () => {
    const h = harness(busy)
    const res = await h.app.request('/api/v1/engines', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My fork', binPath: join(h.forkDir, 'llama-server') }),
    })
    assert.equal(res.status, 409)
    assert.equal(await errorCode(res), 'engine_already_running')
    assert.deepEqual(h.added, [])
  })

  test(`DELETE /engines/build is 409 engine_already_running while a ${busy} runs, and keeps the build`, async () => {
    const h = harness(busy)
    const bin = disabledBuild(h.dataDir, 'prismml-eng-llama.cpp-prism')
    const res = await h.app.request(`/api/v1/engines/build?binPath=${encodeURIComponent(bin)}`, { method: 'DELETE' })
    assert.equal(res.status, 409)
    assert.equal(await errorCode(res), 'engine_already_running')
    assert.equal(existsSync(bin), true)
  })
}

test('with no engine work running, a re-register, a purge and a backend delete still go through', async () => {
  const h = harness(null)
  const add = await h.app.request('/api/v1/engines', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'My fork', binPath: join(h.forkDir, 'llama-server') }),
  })
  assert.equal(add.status, 201)
  assert.deepEqual(h.added, [join(h.forkDir, 'llama-server')])
  assert.equal((await h.app.request('/api/v1/engines/fork?purge=1', { method: 'DELETE' })).status, 200)
  assert.equal(existsSync(h.forkDir), false)
  assert.equal((await h.app.request(`/api/v1/engines/backends/${h.backendId}`, { method: 'DELETE' })).status, 200)
  assert.equal(existsSync(h.backendDir), false)
  assert.deepEqual(h.removed, ['fork', 'be'])
})

// DELETE /engines/backends/:id stops whatever runs on the backend's builds before it unregisters them and deletes
// their folders, and a model stop waits seconds for the process to exit. The engine-work slot was checked only before
// that wait: an update of the backend (it is not refused for a running engine), the auto-update scheduler, a download
// or an upload could start in it, and an update then registered the deleted backend again once it finished.
test('DELETE /engines/backends/:id holds the engine-work slot while it stops the engine, so no update starts meanwhile', async (t) => {
  const h = harness(null)
  writeFileSync(join(h.backendDir, '.turbollm-provisioned'), '') // a finished install, so its Update is offered
  h.live.activeId = 'be'
  let stopped!: () => void
  h.live.stopping = new Promise<void>((resolve) => { stopped = resolve })
  // Not reached with the fix; without it the update went on to look up GitHub's latest build.
  t.mock.method(globalThis, 'fetch', (() => Promise.reject(new Error('offline'))) as typeof fetch)
  const del = h.app.request(`/api/v1/engines/backends/${h.backendId}`, { method: 'DELETE' })
  await eventually(() => assert.equal(h.live.stops, 1))
  assert.equal(engineWorkBusy(h.d), 'An engine is being deleted — wait for it to finish.', 'the scheduler and every engine job see it')
  const update = await h.app.request(`/api/v1/engines/backends/${h.backendId}/update`, { method: 'POST' })
  assert.equal(update.status, 409)
  assert.equal(await errorCode(update), 'engine_already_running')
  stopped()
  assert.equal((await del).status, 200)
  assert.deepEqual(h.removed, ['be'])
  assert.equal(existsSync(h.backendDir), false)
  assert.equal(engineWorkBusy(h.d), null, 'the slot is free again')
})

test('DELETE /engines/backends/:id frees the engine-work slot when stopping the engine fails', async () => {
  const h = harness(null)
  h.live.activeId = 'be'
  h.live.stopping = Promise.reject(new Error('the engine did not exit'))
  h.live.stopping.catch(() => {})
  const res = await h.app.request(`/api/v1/engines/backends/${h.backendId}`, { method: 'DELETE' })
  assert.equal(res.status, 500)
  assert.deepEqual(h.removed, [])
  assert.equal(existsSync(h.backendDir), true)
  assert.equal(engineWorkBusy(h.d), null)
})

// The other order: the backend's Update checked the slot, then looked up GitHub's latest build (up to 15 s) holding
// nothing. A Delete in that lookup, with no engine to stop, was over before the Update's re-check, so the Update went
// on to download and register the backend the user had just deleted.
test('DELETE /engines/backends/:id is refused while the backend\'s Update looks up its latest build', async (t) => {
  const h = harness(null)
  writeFileSync(join(h.backendDir, '.turbollm-provisioned'), '') // a finished install, so its Update is offered
  let answer!: (res: Response) => void
  const lookups: string[] = []
  t.mock.method(globalThis, 'fetch', ((url: string | URL | Request) => {
    lookups.push(String(url))
    return new Promise<Response>((resolve) => { answer = resolve })
  }) as typeof fetch)
  const update = h.app.request(`/api/v1/engines/backends/${h.backendId}/update`, { method: 'POST' })
  await eventually(() => assert.equal(lookups.length, 1))
  const del = await h.app.request(`/api/v1/engines/backends/${h.backendId}`, { method: 'DELETE' })
  assert.equal(del.status, 409)
  assert.equal(await errorCode(del), 'engine_already_running')
  assert.deepEqual(h.removed, [])
  assert.equal(existsSync(h.backendDir), true)
  answer(new Response(JSON.stringify([{ tag_name: 'b1' }]))) // already the latest: the Update ends here
  const done = await update
  assert.equal(done.status, 200)
  assert.equal(((await done.json()) as { alreadyLatest?: boolean }).alreadyLatest, true)
  assert.equal(engineWorkBusy(h.d), null, 'the lookup frees the slot')

  // A failed lookup frees it too, and the Delete then goes through.
  t.mock.method(globalThis, 'fetch', (() => Promise.reject(new Error('offline'))) as typeof fetch)
  assert.equal((await h.app.request(`/api/v1/engines/backends/${h.backendId}/update`, { method: 'POST' })).status, 503)
  assert.equal(engineWorkBusy(h.d), null)
  assert.equal((await h.app.request(`/api/v1/engines/backends/${h.backendId}`, { method: 'DELETE' })).status, 200)
  assert.deepEqual(h.removed, ['be'])
  assert.equal(existsSync(h.backendDir), false)
})

// The Windows CUDA Toolkit download (POST /build/cuda) and a build guide prerequisite install (POST
// /build/install-prereq: git, cmake, gcc, cuda) run through BuildState for their live log, but build no engine: they
// install into <dataDir>/cuda or through the host's package manager. They counted as a build here, so for as long as
// one ran every Enable, Disable, Add and Delete was refused with "A build is in progress".
for (const tool of ['CUDA Toolkit', 'git']) {
  test(`a ${tool} install leaves Disable, Enable, Purge, backend Delete and a Disabled build's Delete open`, async () => {
    const h = harness(null)
    h.build.start(tool, { toolInstall: true }) // as the routes start it
    h.build.phase('provisioning')
    const disable = await h.app.request('/api/v1/engines/other', { method: 'DELETE' })
    assert.equal(disable.status, 200)
    const enable = await h.app.request('/api/v1/engines', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Other fork', binPath: join(h.otherForkDir, 'llama-server') }),
    })
    assert.equal(enable.status, 201)
    assert.equal((await h.app.request('/api/v1/engines/fork?purge=1', { method: 'DELETE' })).status, 200)
    assert.equal(existsSync(h.forkDir), false)
    assert.equal((await h.app.request(`/api/v1/engines/backends/${h.backendId}`, { method: 'DELETE' })).status, 200)
    assert.equal(existsSync(h.backendDir), false)
    const bin = disabledBuild(h.dataDir, 'prismml-eng-llama.cpp-prism')
    assert.equal((await h.app.request(`/api/v1/engines/build?binPath=${encodeURIComponent(bin)}`, { method: 'DELETE' })).status, 200)
    assert.equal(existsSync(bin), false)
    assert.deepEqual(h.removed, ['other', 'fork', 'be'])
    assert.equal(h.build.isActive(), true, 'the install runs on')
  })
}

test('POST /build/install-prereq starts a run that leaves Disable open while it runs', { skip: process.platform !== 'linux' && process.platform !== 'darwin' && 'the route is Linux and macOS only' }, async () => {
  const h = harness(null)
  // git is found on build.toolchainDirs, so the install has nothing to do and no package manager ever runs.
  const fakeBin = join(h.dataDir, 'fakebin')
  mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, 'git'), '#!/bin/sh\necho "git version 2.43.0"\n')
  chmodSync(join(fakeBin, 'git'), 0o755)
  h.cfg.build.toolchainDirs = [fakeBin]
  const settled = new Promise<string>((resolve) => { h.build.onSettled = resolve })
  const res = await h.app.request('/api/v1/build/install-prereq', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'git' }),
  })
  assert.equal(res.status, 202)
  const disable = await h.app.request('/api/v1/engines/other', { method: 'DELETE' })
  assert.equal(h.build.isActive(), true, 'the prerequisite check was still running')
  assert.equal(disable.status, 200)
  assert.deepEqual(h.removed, ['other'])
  assert.equal(await settled, 'ok')
})

test('POST /build/cuda starts a run that leaves Disable open while it downloads', async (t) => {
  const h = harness(null)
  // The route and provisionCuda are Windows-only, so the request claims win32 (provisionCuda checks it before its
  // first await). NVIDIA's manifest is never fetched: the fetch waits for the Cancel below, so nothing is downloaded.
  t.mock.method(globalThis, 'fetch', ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason))
    })) as typeof fetch)
  const platform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  let res: Response
  try {
    res = await h.app.request('/api/v1/build/cuda', { method: 'POST' })
  } finally {
    Object.defineProperty(process, 'platform', { value: platform })
  }
  assert.equal(res.status, 202)
  const settled = new Promise<string>((resolve) => { h.build.onSettled = resolve })
  const disable = await h.app.request('/api/v1/engines/other', { method: 'DELETE' })
  assert.equal(h.build.isActive(), true, 'the CUDA download was still running')
  assert.equal(disable.status, 200)
  assert.deepEqual(h.removed, ['other'])
  assert.equal((await h.app.request('/api/v1/build/cancel', { method: 'POST' })).status, 200)
  assert.equal(await settled, 'cancelled')
})

// DELETE /api/v1/engines/build: the Engines screen's Delete on a Disabled source-built catalog card. That Delete used to
// re-register the build through POST /engines, which probes the binary, so a build whose binary no longer starts (a
// driver or toolkit change left it unable to load libcuda) answered probe_failed and its folder stayed on disk. This
// route runs nothing and deletes only an unclaimed build/<slug> folder.

/** A Disabled catalog build on disk: build/<slug>/build/bin/llama-server, a binary that no longer starts. */
function disabledBuild(dataDir: string, slug: string): string {
  const binDir = join(dataDir, 'engines', 'build', slug, 'build', 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'llama-server')
  writeFileSync(bin, "#!/bin/sh\necho 'error while loading shared libraries: libcuda.so.1' >&2\nexit 127\n", { mode: 0o755 })
  return bin
}

test('DELETE /engines/build deletes a Disabled source build whose binary no longer starts, and registers nothing', async () => {
  const h = harness(null)
  const bin = disabledBuild(h.dataDir, 'prismml-eng-llama.cpp-prism')
  const res = await h.app.request(`/api/v1/engines/build?binPath=${encodeURIComponent(bin)}`, { method: 'DELETE' })
  assert.equal(res.status, 200)
  assert.equal(existsSync(join(h.dataDir, 'engines', 'build', 'prismml-eng-llama.cpp-prism')), false)
  assert.deepEqual(h.added, [], 'no re-register, so no probe')
  assert.deepEqual(h.removed, [])
  assert.equal(existsSync(h.forkDir), true, 'the registered build beside it is untouched')
})

test('DELETE /engines/build refuses a folder an engine or a remembered source claims, and anything but a build/<slug> folder', async () => {
  const h = harness(null)
  const del = (binPath: string) => h.app.request(`/api/v1/engines/build?binPath=${encodeURIComponent(binPath)}`, { method: 'DELETE' })

  let res = await del(join(h.forkDir, 'llama-server')) // the registered "My fork"
  assert.equal(res.status, 409)
  assert.equal(await errorCode(res), 'build_dir_taken')
  assert.equal(existsSync(h.forkDir), true)

  const remembered = disabledBuild(h.dataDir, 'my-custom-build')
  h.sources.push({ binPath: remembered })
  res = await del(remembered)
  assert.equal(res.status, 409)
  assert.equal(await errorCode(res), 'build_dir_taken')
  assert.equal(existsSync(remembered), true)

  const parked = disabledBuild(h.dataDir, '.myfork-1700000000000.prev') // a rebuild's parked previous build
  for (const binPath of [parked, join(h.backendDir, 'llama-server'), join(h.dataDir, 'engines', 'build', 'gone', 'llama-server'), '']) {
    res = await del(binPath)
    assert.equal(res.status, 404, binPath)
    assert.equal(await errorCode(res), 'engine_not_found')
  }
  assert.equal(existsSync(parked), true)
  assert.equal(existsSync(h.backendDir), true)
  assert.deepEqual(h.removed, [])
})

test('DELETE /engines/build whose folder is locked is 409 engine_files_locked, keeps the build whole, and can be repeated', async (t) => {
  const h = harness(null)
  const bin = disabledBuild(h.dataDir, 'prismml-eng-llama.cpp-prism')
  const dir = join(h.dataDir, 'engines', 'build', 'prismml-eng-llama.cpp-prism')
  const lock = lockPaths(t, 'renameSync', (p) => p === dir)
  let res: Response
  try {
    res = await h.app.request(`/api/v1/engines/build?binPath=${encodeURIComponent(bin)}`, { method: 'DELETE' })
  } finally {
    lock.restore()
  }
  assert.equal(res.status, 409)
  assert.equal(await errorCode(res), 'engine_files_locked')
  assert.equal(existsSync(bin), true, 'nothing is deleted')
  const again = await h.app.request(`/api/v1/engines/build?binPath=${encodeURIComponent(bin)}`, { method: 'DELETE' })
  assert.equal(again.status, 200)
  assert.equal(existsSync(dir), false)
  await eventually(() => assert.deepEqual(fs.readdirSync(join(h.dataDir, 'engines', 'build')).sort(), ['myfork', 'otherfork']))
})

// Both deletes ran a recursive rmSync of the whole build tree on the daemon's only thread, and with maxRetries also
// slept on it between retries: every request, /status poll and token stream stalled until the delete ended. The
// folder is now renamed aside, the route replies, and the trash is deleted in the background with fs/promises rm.
// (Its callbacks still run on the thread; a fast disk's many small files can still hold it for a few hundred ms.)
// syncBuiltinESMExports carries the spies to routes.ts, which imports rm and rmSync by name.
test('DELETE /engines/build and DELETE /engines/:id?purge=1 reply first and delete the folder in the background', async (t) => {
  const h = harness(null)
  const bin = disabledBuild(h.dataDir, 'prismml-eng-llama.cpp-prism')
  const buildRoot = join(h.dataDir, 'engines', 'build')
  const deletedAsync = t.mock.method(fsp, 'rm')
  const deletedSync = t.mock.method(fs, 'rmSync')
  syncBuiltinESMExports()
  const trashOf = (name: string) => fs.readdirSync(buildRoot).filter((n) => n.startsWith(`.${name}.purge-`))
  let trash: string[]
  try {
    assert.equal((await h.app.request(`/api/v1/engines/build?binPath=${encodeURIComponent(bin)}`, { method: 'DELETE' })).status, 200)
    assert.equal(existsSync(join(buildRoot, 'prismml-eng-llama.cpp-prism')), false, 'the build is gone from its place at once')
    assert.equal((await h.app.request('/api/v1/engines/fork?purge=1', { method: 'DELETE' })).status, 200)
    assert.equal(existsSync(h.forkDir), false)
    trash = [...trashOf('prismml-eng-llama.cpp-prism'), ...trashOf('myfork')]
    assert.equal(trash.length, 2, 'both replies came before their delete ran')
  } finally {
    deletedAsync.mock.restore()
    deletedSync.mock.restore()
    syncBuiltinESMExports()
  }
  const isTrash = (c: { arguments: unknown[] }) => trash.some((n) => String(c.arguments[0]) === join(buildRoot, n))
  const deletes = deletedAsync.mock.calls.filter(isTrash)
  assert.equal(deletes.length, 2, 'each folder is deleted with fs/promises rm')
  for (const call of deletes) assert.ok((call.arguments[1] as fs.RmOptions | undefined)?.maxRetries, 'the delete retries, as a Windows lock is brief')
  assert.equal(deletedSync.mock.calls.filter((c) => isTrash(c) || String(c.arguments[0]).startsWith(h.forkDir)).length, 0, 'and not with rmSync')
  await Promise.all(deletes.map((c) => c.result))
  assert.deepEqual(fs.readdirSync(buildRoot), ['otherfork'])
})

test('a purge leaves a folder whose delete is still running to that delete, rather than delete it twice', async (t) => {
  const h = harness(null)
  const buildRoot = join(h.dataDir, 'engines', 'build')
  const realRm = fsp.rm
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  // The first purge's delete is held, as a multi-GB tree takes seconds to delete; the second purge's sweep finds it.
  const deletes = t.mock.method(fsp, 'rm', async (p: fs.PathLike, o?: fs.RmOptions) => {
    if (String(p).startsWith(join(buildRoot, '.myfork.purge-'))) await held
    return realRm(p, o)
  })
  syncBuiltinESMExports()
  try {
    assert.equal((await h.app.request('/api/v1/engines/fork?purge=1', { method: 'DELETE' })).status, 200)
    assert.equal((await h.app.request('/api/v1/engines/other?purge=1', { method: 'DELETE' })).status, 200)
  } finally {
    deletes.mock.restore()
    syncBuiltinESMExports()
  }
  const ofFork = deletes.mock.calls.filter((c) => String(c.arguments[0]).startsWith(join(buildRoot, '.myfork.purge-')))
  assert.equal(ofFork.length, 1, 'the sweep did not start a second delete of it')
  release()
  await Promise.all(deletes.mock.calls.map((c) => c.result))
  assert.deepEqual(fs.readdirSync(buildRoot), [])
})

// DELETE /engines/:id?purge=1 used to unregister the engine and then delete its folder with one recursive rmSync. A
// Windows AV or indexer lock (right after a Stop) made that throw part-way: a 500, the engine gone from the registry,
// its folder half deleted, its custom source kept, and a repeated purge a 404. The folder is now renamed aside first.

/** Make `fs[method]` throw EBUSY for every path `locked` matches, until `restore()`. routes.ts imports these by name:
 *  syncBuiltinESMExports carries the patch to that binding. */
function lockPaths(t: { mock: { method: typeof import('node:test').mock.method } }, method: 'renameSync' | 'rmSync', locked: (p: string) => boolean) {
  const real = fs[method] as (...args: unknown[]) => unknown
  const m = t.mock.method(fs, method, (...args: unknown[]) => {
    if (locked(String(args[0]))) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    return real(...args)
  })
  syncBuiltinESMExports()
  return { calls: () => m.mock.calls, restore: () => { m.mock.restore(); syncBuiltinESMExports() } }
}

test('DELETE /engines/:id?purge=1 whose folder is locked is 409 engine_files_locked, keeps the engine registered and its files whole, and can be repeated', async (t) => {
  const h = harness(null)
  const lock = lockPaths(t, 'renameSync', (p) => p === h.forkDir)
  let res: Response
  try {
    res = await h.app.request('/api/v1/engines/fork?purge=1', { method: 'DELETE' })
  } finally {
    lock.restore()
  }
  assert.equal(res.status, 409)
  assert.equal(await errorCode(res), 'engine_files_locked')
  assert.deepEqual(h.removed, [], 'still registered')
  assert.deepEqual(h.forgotten, [])
  assert.equal(existsSync(join(h.forkDir, 'llama-server')), true)

  const again = await h.app.request('/api/v1/engines/fork?purge=1', { method: 'DELETE' })
  assert.equal(again.status, 200)
  assert.deepEqual(h.removed, ['fork'])
  assert.equal(h.forgotten.length, 1)
  assert.equal(existsSync(h.forkDir), false)
})

test('DELETE /engines/:id?purge=1 whose renamed-aside folder stays locked still finishes the purge, and the next purge there sweeps it', async (t) => {
  const h = harness(null)
  const buildRoot = join(h.dataDir, 'engines', 'build')
  const realRm = fsp.rm
  // fs/promises rm rejects as it does once its retries are spent on a Windows lock.
  const lock = t.mock.method(fsp, 'rm', (p: fs.PathLike, o?: fs.RmOptions) =>
    String(p).startsWith(join(buildRoot, '.myfork.'))
      ? Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }))
      : realRm(p, o))
  syncBuiltinESMExports()
  let res: Response
  try {
    res = await h.app.request('/api/v1/engines/fork?purge=1', { method: 'DELETE' })
  } finally {
    lock.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(res.status, 200)
  assert.deepEqual(h.removed, ['fork'])
  assert.equal(h.forgotten.length, 1, 'the remembered source is dropped')
  assert.equal(existsSync(h.forkDir), false, 'nothing is left where the engine pointed')
  const leftover = fs.readdirSync(buildRoot).filter((n) => n.startsWith('.myfork.purge-'))
  assert.equal(leftover.length, 1, 'a hidden leftover')
  const trashDelete = lock.mock.calls.find((c) => String(c.arguments[0]) === join(buildRoot, leftover[0]!))
  assert.ok((trashDelete?.arguments[1] as fs.RmOptions | undefined)?.maxRetries, 'the delete retries, as a Windows lock is brief')
  await (trashDelete!.result as Promise<void>).catch(() => {})

  assert.equal((await h.app.request('/api/v1/engines/other?purge=1', { method: 'DELETE' })).status, 200)
  await eventually(() => assert.deepEqual(fs.readdirSync(buildRoot), [], 'the leftover is swept with the next purge'))
})

// POST /engines registers any server binary, so the same build can be added twice under two names (one per launch
// setup), or a binary in a TurboQuant or llama.cpp install added by hand. A purge of one renamed away the folder the
// other still ran from, and that engine stayed registered with its binary gone.
test('DELETE /engines/:id?purge=1 leaves the folder to another registered engine that runs from it, until that one goes too', async () => {
  const h = harness(null)
  h.engines.push({ id: 'twin', name: 'My fork (8 slots)', kind: 'llama-server', binPath: join(h.forkDir, 'llama-server') })
  const buildRoot = join(h.dataDir, 'engines', 'build')
  const res = await h.app.request('/api/v1/engines/fork?purge=1', { method: 'DELETE' })
  assert.equal(res.status, 200)
  assert.deepEqual(h.removed, ['fork'])
  assert.equal(h.forgotten.length, 1, 'the purged engine\'s remembered source is dropped as usual')
  assert.equal(existsSync(join(h.forkDir, 'llama-server')), true, 'the other engine still runs from it')
  assert.deepEqual(fs.readdirSync(buildRoot).sort(), ['myfork', 'otherfork'], 'nothing is renamed aside')

  assert.equal((await h.app.request('/api/v1/engines/twin?purge=1', { method: 'DELETE' })).status, 200)
  assert.deepEqual(h.removed, ['fork', 'twin'])
  assert.equal(existsSync(h.forkDir), false, 'the last engine on it takes the folder')
  await eventually(() => assert.deepEqual(fs.readdirSync(buildRoot), ['otherfork']))
})

// A Disabled custom engine is a remembered source with no registry entry, and its Enable re-registers it from its
// folder: DELETE /engines/build already counts one as a claim on the folder. The purge counted only registered engines.
test('DELETE /engines/:id?purge=1 leaves the folder to a Disabled custom engine that runs from it, not to its own remembered source', async () => {
  const bin = (h: ReturnType<typeof harness>) => join(h.forkDir, 'llama-server')
  const own = harness(null)
  own.sources.push({ binPath: bin(own) }) // the purged engine's own (keyed by its binPath), which the purge forgets
  assert.equal((await own.app.request('/api/v1/engines/fork?purge=1', { method: 'DELETE' })).status, 200)
  assert.deepEqual(own.forgotten, [bin(own)])
  assert.equal(existsSync(own.forkDir), false)

  const h = harness(null)
  h.sources.push({ binPath: bin(h) }, { binPath: bin(h), sourceRepo: 'https://github.com/me/fork', sourceBranch: 'cuda' })
  const res = await h.app.request('/api/v1/engines/fork?purge=1', { method: 'DELETE' })
  assert.equal(res.status, 200)
  assert.deepEqual(h.removed, ['fork'])
  assert.deepEqual(h.forgotten, [bin(h)])
  assert.equal(existsSync(bin(h)), true, 'the Disabled engine can still be enabled')
  assert.deepEqual(fs.readdirSync(join(h.dataDir, 'engines', 'build')).sort(), ['myfork', 'otherfork'], 'nothing is renamed aside')
})

test('DELETE /engines/:id?purge=1 whose unregister fails puts the folder back', async () => {
  const h = harness(null)
  h.failRemove.on = true // the config write behind registry.remove is refused
  const res = await h.app.request('/api/v1/engines/fork?purge=1', { method: 'DELETE' })
  assert.equal(res.status, 500)
  assert.equal(existsSync(join(h.forkDir, 'llama-server')), true, 'the still-registered engine keeps its files')
  assert.deepEqual(fs.readdirSync(join(h.dataDir, 'engines', 'build')).sort(), ['myfork', 'otherfork'])
  assert.deepEqual(h.forgotten, [])
})

/** Retries `check` until it passes, for up to 5 s: the folder a delete renamed aside is deleted in the background. */
async function eventually(check: () => void): Promise<void> {
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      return check()
    } catch (e) {
      if (Date.now() > deadline) throw e
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
