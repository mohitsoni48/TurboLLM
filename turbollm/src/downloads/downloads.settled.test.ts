// The onSettled observer added for ADR-299's onboarding_step. The guarantee under
// test is DownloadManager's: a broken download and an abandoned one report
// DIFFERENT outcomes, and a throwing observer cannot affect a download.
//
// Follows downloads.enqueue.test.ts's harness (fake store + stubbed fetch, no
// network, no real files).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DownloadManager } from './downloads'

function fakeStore(modelDir: string, stateDir: string) {
  return {
    dir: () => stateDir,
    snapshot: () => ({ primaryModelDir: modelDir, modelDirs: [modelDir] }),
  } as unknown as ConstructorParameters<typeof DownloadManager>[0]
}

function newDirs() {
  const root = mkdtempSync(join(tmpdir(), 'tllm-dl-settled-'))
  const modelDir = join(root, 'models')
  const stateDir = join(root, 'state')
  mkdirSync(modelDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  return { modelDir, stateDir }
}

/** Make fetch fail the way a dead network does. */
function stubFetchRejecting(err: Error): () => void {
  const real = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(err)) as unknown as typeof fetch
  return () => {
    globalThis.fetch = real
  }
}

/** Wait for the observer to fire — run() is kicked off in the background by
 *  enqueue(), so the outcome lands a microtask or two later. */
async function settled(outcomes: string[]): Promise<void> {
  for (let i = 0; i < 200 && outcomes.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('DownloadManager.onSettled: a broken download reports fail', async () => {
  const { modelDir, stateDir } = newDirs()
  const restore = stubFetchRejecting(new Error('ECONNREFUSED'))
  try {
    const outcomes: string[] = []
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    dm.onSettled = (o) => outcomes.push(o)

    dm.enqueue({ url: 'https://example.invalid/model.gguf' })
    await settled(outcomes)

    assert.deepEqual(outcomes, ['fail'])
  } finally {
    restore()
  }
})

test('DownloadManager.onSettled: an aborted download reports cancelled, not fail', async () => {
  // Conflating these would read a user's deliberate choice as a product defect
  // in the onboarding funnel.
  const { modelDir, stateDir } = newDirs()
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  const restore = stubFetchRejecting(abort)
  try {
    const outcomes: string[] = []
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    dm.onSettled = (o) => outcomes.push(o)

    dm.enqueue({ url: 'https://example.invalid/model.gguf' })
    await settled(outcomes)

    assert.deepEqual(outcomes, ['cancelled'])
  } finally {
    restore()
  }
})

test('DownloadManager.onSettled: an observer that throws does not break the download', async () => {
  const { modelDir, stateDir } = newDirs()
  const restore = stubFetchRejecting(new Error('ECONNREFUSED'))
  try {
    let reached = false
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    dm.onSettled = () => {
      reached = true
      throw new Error('telemetry exploded')
    }

    dm.enqueue({ url: 'https://example.invalid/model.gguf' })
    for (let i = 0; i < 200 && !reached; i++) await new Promise((r) => setTimeout(r, 5))

    assert.equal(reached, true)
    // The record still reached its terminal error state despite the throw.
    const rec = dm.list().find((j) => j.url.includes('model.gguf'))
    assert.equal(rec?.status, 'error')
  } finally {
    restore()
  }
})

test('DownloadManager: no observer is fine', async () => {
  const { modelDir, stateDir } = newDirs()
  const restore = stubFetchRejecting(new Error('ECONNREFUSED'))
  try {
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    assert.doesNotThrow(() => dm.enqueue({ url: 'https://example.invalid/model.gguf' }))
    await new Promise((r) => setTimeout(r, 30))
  } finally {
    restore()
  }
})
