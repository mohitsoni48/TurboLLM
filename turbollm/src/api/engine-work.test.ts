import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Deps } from '../deps'
import type { Engine } from '../config/config'
import { ReleaseInstallJob } from '../engines/release-install'
import {
  BACKEND_DELETE_BUSY,
  ENGINE_ENABLE_BUSY,
  autoTuneUpdateBlock,
  backendEnableBusy,
  createEngineJobs,
  engineBusy,
  engineWork,
  engineWorkBusy,
} from './engine-work'

function deps(opts: { provision?: { active: boolean; backend?: string }; build?: boolean; state?: string } = {}): Deps {
  return {
    provision: { get: () => opts.provision ?? { active: false } },
    build: { isActive: () => !!opts.build, isEngineBuildActive: () => !!opts.build },
    manager: { status: () => ({ state: opts.state ?? 'idle' }) },
  } as unknown as Deps
}

/** Holds one engineWork flag for the length of `run`, as the routes do across their await. */
function holding(flag: keyof typeof engineWork, run: () => void): void {
  engineWork[flag] = true
  try {
    run()
  } finally {
    engineWork[flag] = false
  }
}

test('engineWorkBusy is null while no engine job runs', () => {
  assert.equal(engineWorkBusy(deps()), null)
})

test('engineWorkBusy answers for each in-flight flag, a download and a build', () => {
  holding('engineEnableInFlight', () => assert.equal(engineWorkBusy(deps()), ENGINE_ENABLE_BUSY))
  holding('backendDeleteInFlight', () => assert.equal(engineWorkBusy(deps()), BACKEND_DELETE_BUSY))
  holding('zipUploadInFlight', () => assert.match(engineWorkBusy(deps()) ?? '', /zip upload/))
  assert.match(engineWorkBusy(deps({ provision: { active: true } })) ?? '', /download/)
  assert.match(engineWorkBusy(deps({ build: true })) ?? '', /build/)
})

test('backendEnableBusy refuses only while a backend Delete or Enable runs, or that backend downloads', () => {
  assert.equal(backendEnableBusy(deps(), 'cuda'), null)
  holding('backendDeleteInFlight', () => assert.equal(backendEnableBusy(deps(), 'cuda'), BACKEND_DELETE_BUSY))
  assert.equal(backendEnableBusy(deps({ provision: { active: true, backend: 'vulkan' } }), 'cuda'), null)
  assert.match(backendEnableBusy(deps({ provision: { active: true, backend: 'cuda' } }), 'cuda') ?? '', /downloaded or updated/)
})

test('autoTuneUpdateBlock refuses only the engine auto-tune is running on', () => {
  const tuned = { id: 'e1' } as Engine
  const d = { bench: { tuningEngine: () => tuned } } as unknown as Deps
  assert.equal(autoTuneUpdateBlock(d, (e) => e.id === 'e2'), null)
  assert.equal(autoTuneUpdateBlock(d, (e) => e.id === 'e1'), 'Stop auto-tune before updating this engine.')
})

test('engineBusy is true while a model runs, starts or stops', () => {
  for (const state of ['running', 'starting', 'stopping']) assert.equal(engineBusy(deps({ state })), true)
  assert.equal(engineBusy(deps({ state: 'idle' })), false)
})

test('createEngineJobs starts with no abort handle and an empty release slot', () => {
  const jobs = createEngineJobs()
  assert.equal(jobs.provisionAbort, null)
  assert.equal(jobs.releaseAbort, null)
  assert.equal(jobs.buildAbort, null)
  assert.ok(jobs.releaseJob instanceof ReleaseInstallJob)
  assert.notEqual(createEngineJobs().releaseJob, jobs.releaseJob)
})
