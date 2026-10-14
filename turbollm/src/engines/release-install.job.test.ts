// ReleaseInstallJob: the single slot that remembers the running / ready / updated / failed
// release install for the HTTP flow. It owns no side effects; the route does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeReleaseJobFailure,
  ReleaseInstallError,
  ReleaseInstallJob,
  type ReleaseInstallPlan,
  type ReleaseInstallResult,
} from './release-install'
import { ProbeError } from './probe'
import { SwapBlockedError, ZipError } from './zip-install'

const PLAN: ReleaseInstallPlan = { repo: 'o/r', tag: 'b1', asset: 'llama-b1-bin-win-cpu-x64.zip' }
const RESULT: ReleaseInstallResult = { found: false }

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settle = () => new Promise((r) => setImmediate(r))

test('a new job is idle', () => {
  assert.deepEqual(new ReleaseInstallJob().get(), { state: 'idle' })
})

test('start is running synchronously and ready once the run resolves', async () => {
  const job = new ReleaseInstallJob()
  const run = deferred<{ kind: 'ready'; result: ReleaseInstallResult }>()
  job.start(PLAN, () => run.promise)
  assert.deepEqual(job.get(), { state: 'running', plan: PLAN })
  run.resolve({ kind: 'ready', result: RESULT })
  await settle()
  assert.deepEqual(job.get(), { state: 'ready', plan: PLAN, result: RESULT })
})

test('an update run ends in the updated state with the engine it refreshed', async () => {
  const job = new ReleaseInstallJob()
  job.start(PLAN, async () => ({ kind: 'updated', updated: { id: 'e1', name: 'Prism' }, result: RESULT }))
  await settle()
  assert.deepEqual(job.get(), { state: 'updated', plan: PLAN, result: RESULT, updated: { id: 'e1', name: 'Prism' } })
})

test('a rejection carrying a code becomes the error state', async () => {
  const job = new ReleaseInstallJob()
  job.start(PLAN, async () => {
    throw new ProbeError('probe_failed', 'probe failed')
  })
  await settle()
  assert.deepEqual(job.get(), { state: 'error', plan: PLAN, error: { code: 'probe_failed', message: 'probe failed' } })
})

test('an AbortError becomes the cancelled error', async () => {
  const job = new ReleaseInstallJob()
  job.start(PLAN, async () => {
    throw new DOMException('aborted', 'AbortError')
  })
  await settle()
  assert.equal(job.get().error?.code, 'cancelled')
})

test('clear returns to idle and a second start replaces a ready view', async () => {
  const job = new ReleaseInstallJob()
  job.start(PLAN, async () => ({ kind: 'ready', result: RESULT }))
  await settle()
  const next = { ...PLAN, tag: 'b2' }
  job.start(next, () => new Promise(() => {}))
  assert.deepEqual(job.get(), { state: 'running', plan: next })
  job.clear()
  assert.deepEqual(job.get(), { state: 'idle' })
})

test('a superseded run cannot overwrite the newer job', async () => {
  const job = new ReleaseInstallJob()
  const stale = deferred<{ kind: 'ready'; result: ReleaseInstallResult }>()
  job.start(PLAN, () => stale.promise)
  job.clear()
  stale.resolve({ kind: 'ready', result: RESULT })
  await settle()
  assert.deepEqual(job.get(), { state: 'idle' })
})

async function failureOf(e: unknown) {
  const job = new ReleaseInstallJob()
  job.start(PLAN, async () => {
    throw e
  })
  await settle()
  return job.get().error
}

const coded = (code: string, message = 'boom') => Object.assign(new Error(message), { code })

test('an errno-coded failure (EPERM) is internal, not leaked', async () => {
  assert.equal((await failureOf(coded('EPERM')))?.code, 'internal')
})

test('an uncoded failure is internal and keeps its message', async () => {
  assert.deepEqual(await failureOf(new Error('weird')), { code: 'internal', message: 'weird' })
})

test('the closed vocabulary passes through', async () => {
  for (const code of ['no_server_binary', 'download_failed', 'unsupported_archive', 'extract_failed', 'engine_in_use', 'invalid_asset']) {
    assert.equal((await failureOf(coded(code)))?.code, code)
  }
})

test('typed errors map to their vocabulary code', async () => {
  assert.equal((await failureOf(new SwapBlockedError('in use')))?.code, 'engine_in_use')
  assert.equal((await failureOf(new ProbeError('probe_timeout', 't')))?.code, 'probe_timeout')
  assert.equal((await failureOf(new ZipError('zip_too_large', 'z')))?.code, 'zip_too_large')
  assert.equal((await failureOf(new ZipError('zip_crc_mismatch', 'z')))?.code, 'bad_zip')
  assert.equal((await failureOf(new ReleaseInstallError('invalid_asset', 'x')))?.code, 'invalid_asset')
})

test('describeReleaseJobFailure is exported and classifies the same way', () => {
  assert.deepEqual(describeReleaseJobFailure(coded('ENOTDIR', 'm')), { code: 'internal', message: 'm' })
})
