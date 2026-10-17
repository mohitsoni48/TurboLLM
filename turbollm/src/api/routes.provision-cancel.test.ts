// The provision banner's Cancel (POST /engines/backends/cancel) can only stop runs that register
// the route's AbortController. The single-binary installs (TurboQuant, KoboldCpp, llamafile)
// accept a signal but never got one, so Cancel answered {ok:false} and the download ran on; the
// runs that take no signal at all (first-run seed, uv/pip runtimes) are now reported as
// `cancellable: false` on /status so the banner hides a Cancel that could only be a no-op.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { ProvisionState } from '../engines/provision-state'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

function app(provision: ProvisionState, dir: string) {
  const cfg: Record<string, unknown> = {
    daemon: { lanBind: false, requireApiKey: false, port: 6996, machineId: 'm', machineName: 'test' },
    apiKeys: [],
    links: [],
    telemetry: { level: 'off', machineId: 'm' },
  }
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dir },
    manager: {
      status: () => ({ state: 'stopped', err: null, port: 0, pid: 0, model: null }),
      launchCommand: () => undefined,
      currentOpts: () => null,
      parallelSlots: () => 1,
      sessionStats: () => null,
      liveGeneration: () => null,
    },
    modelRouter: { aliveSlots: () => [] },
    scanner: { get: () => undefined },
    registry: { active: () => undefined, list: () => ({ engines: [], activeEngineId: '' }) },
    bench: { status: () => ({ state: 'idle' }) },
    downloads: { activeCount: () => 0 },
    provision,
    build: { get: () => undefined, isActive: () => false },
  } as unknown as Deps
  const a = new Hono()
  registerApi(a, d)
  return a
}

async function provisionStatus(a: Hono): Promise<{ active: boolean; phase: string; cancellable?: boolean }> {
  const res = await a.request('/api/v1/status')
  assert.equal(res.status, 200)
  return ((await res.json()) as { engineProvision: { active: boolean; phase: string; cancellable?: boolean } }).engineProvision
}

const cancel = async (a: Hono) => (await (await a.request('/api/v1/engines/backends/cancel', { method: 'POST' })).json()) as { ok: boolean }

test('a llamafile install is cancellable from the banner; a run with no signal reports cancellable:false', {
  skip: !['win32', 'darwin', 'linux'].includes(process.platform), // llamafile's catalog platforms
}, async (t) => {
  const dir = tmpDir('tllm-provision-cancel-')
  // The release lookup hangs until its signal aborts — no network, and nothing else ends the run.
  const realFetch = globalThis.fetch
  globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
      if (init?.signal?.aborted) abort()
      init?.signal?.addEventListener('abort', abort)
    })) as typeof fetch
  t.after(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })
  const provision = new ProvisionState()
  const a = app(provision, dir)

  assert.equal((await a.request('/api/v1/engines/llamafile', { method: 'POST' })).status, 202)
  const running = await provisionStatus(a)
  assert.equal(running.active, true)
  assert.equal(running.cancellable, true)

  assert.deepEqual(await cancel(a), { ok: true })
  // The aborted run settles asynchronously: poll (bounded, ~2 s) rather than trust a fixed sleep
  // to be long enough on a loaded machine.
  let after = await provisionStatus(a)
  for (let i = 0; after.active && i < 200; i++) {
    await new Promise((r) => setTimeout(r, 10))
    after = await provisionStatus(a)
  }
  assert.equal(after.active, false)
  assert.equal(after.phase, 'idle', 'a cancel ends the run quietly, not as a failure')
  assert.equal(after.cancellable, false)

  // A run that registers no abort controller (the seed, the uv/pip installs) does exactly this.
  provision.start('vllm', 'runtime_env')
  assert.equal((await provisionStatus(a)).cancellable, false)
  assert.deepEqual(await cancel(a), { ok: false })
})
