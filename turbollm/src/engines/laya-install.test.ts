import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installLayaEngine, layaEngineBusy, type LayaInstallDeps } from './laya-install'
import type { LayaRuntime } from './laya'

function recorder() {
  const events: string[] = []
  const added: Array<{ name: string; binPath: string; version: string }> = []
  const deps = {
    provision: {
      start: (backend: string, phase: string) => { events.push(`start ${backend} ${phase}`) },
      progress: (phase: string, pct: number) => { events.push(`progress ${phase} ${pct}`) },
      done: () => { events.push('done') },
      fail: (message: string) => { events.push(`fail ${message}`) },
    },
    registry: {
      addLaya: (name: string, binPath: string, version: string) => {
        added.push({ name, binPath, version })
        return { id: 'laya-1' }
      },
      activate: (id: string) => { events.push(`activate ${id}`) },
    },
  } as unknown as LayaInstallDeps
  return { deps, events, added }
}

const RUNTIME: LayaRuntime = { python: '/engines/laya/venv/bin/python', version: 'laya 0.3.20' }

test('installLayaEngine provisions the venv, registers the engine and reports done', async () => {
  const { deps, events, added } = recorder()
  const calls: Array<{ root: string; upgrade: boolean }> = []
  await installLayaEngine(deps, '/engines', false, async (root, onProgress, upgrade) => {
    calls.push({ root, upgrade: upgrade ?? false })
    onProgress?.({ phase: 'extracting', pct: -1 })
    return RUNTIME
  })
  assert.deepEqual(calls, [{ root: '/engines', upgrade: false }])
  assert.deepEqual(added, [{ name: 'Laya (laya 0.3.20)', binPath: RUNTIME.python, version: RUNTIME.version }])
  assert.deepEqual(events, ['start laya runtime_env', 'progress extracting -1', 'done'])
})

test('installLayaEngine never activates the Laya engine', async () => {
  const { deps, events } = recorder()
  await installLayaEngine(deps, '/engines', false, async () => RUNTIME)
  assert.equal(events.some((e) => e.startsWith('activate')), false)
})

test('installLayaEngine passes an update through as an upgrade', async () => {
  const { deps } = recorder()
  let upgraded: boolean | undefined
  await installLayaEngine(deps, '/engines', true, async (_root, _progress, upgrade) => {
    upgraded = upgrade
    return RUNTIME
  })
  assert.equal(upgraded, true)
})

test('installLayaEngine reports a failed install with its reason and registers nothing', async () => {
  const { deps, events, added } = recorder()
  await installLayaEngine(deps, '/engines', false, async () => { throw new Error('no wheel for this platform') })
  assert.deepEqual(added, [])
  assert.deepEqual(events, ['start laya runtime_env', 'fail Could not install Laya: no wheel for this platform'])
})

// An install or update rewrites the venv the running Laya engine is executing from; on Windows that breaks it.
test('layaEngineBusy: refuses while a Laya model is loaded or loading, and says what to do', () => {
  const alive = (state: string) => ({
    modelRouter: { aliveSlots: () => [{ modelKey: 'laya', state, primary: false, lastUsedMs: 0 }] },
    scanner: { get: () => ({ key: 'laya', name: 'laya', laya: { checkpoints: ['english'] } }) },
  }) as unknown as Parameters<typeof layaEngineBusy>[0]
  for (const state of ['running', 'starting']) {
    assert.equal(layaEngineBusy(alive(state)), 'Eject the Laya model before installing or updating the Laya engine.')
  }
})

test('layaEngineBusy: is null when no Laya model is alive, whatever else is', () => {
  const chatOnly = {
    modelRouter: { aliveSlots: () => [{ modelKey: 'qwen', state: 'running', primary: true, lastUsedMs: 0 }] },
    scanner: { get: () => ({ key: 'qwen', name: 'qwen' }) },
  } as unknown as Parameters<typeof layaEngineBusy>[0]
  assert.equal(layaEngineBusy(chatOnly), null)
})
