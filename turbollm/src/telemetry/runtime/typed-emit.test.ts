import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Emitter } from '../emit'
import { readQueue } from '../queue'
import { errorEvent } from '../events/meta'
import { appFirstRun } from '../events/lifecycle'
import { emit, emitOnce, emitBenchResult } from './typed-emit'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-typed-emit-'))
}

function makeEmitter(dir: string, level: string) {
  const cfg = { telemetry: { level, machineId: '33333333-3333-3333-3333-333333333333' } }
  const store = { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) }
  return new Emitter({ dataDir: dir, store: store as never, version: '1.10.2', os: 'win32/x64' })
}

function names(dir: string): string[] {
  return readQueue(dir).map((q) => (q.event as { event: string }).event)
}

test('emit: a per-action event with a payload reaches the queue exactly as Emitter.emit would produce it', () => {
  const dir = tempDir()
  try {
    const emitter = makeEmitter(dir, 'full')
    emit(emitter, errorEvent, { fingerprint: 'cuda_oom' })
    const queued = readQueue(dir)
    assert.equal(queued.length, 1)
    assert.equal(queued[0].event.event, 'error')
    assert.deepEqual(queued[0].event.payload, { fingerprint: 'cuda_oom' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('emit: still respects consent — a full-only event sent at anon is dropped, exactly like the untyped path', () => {
  const dir = tempDir()
  try {
    const emitter = makeEmitter(dir, 'anon')
    emit(emitter, errorEvent, { fingerprint: 'cuda_oom' })
    assert.deepEqual(names(dir), [], 'emit() adds no new bypass around Emitter.canSend')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('emitOnce: delegates to Emitter.once — fires once, a second call is a no-op', () => {
  const dir = tempDir()
  try {
    const emitter = makeEmitter(dir, 'anon')
    emitOnce(emitter, appFirstRun)
    emitOnce(emitter, appFirstRun)
    assert.deepEqual(names(dir), ['app_first_run'], 'the ledger claim, not this wrapper, enforces once-ness')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('emitBenchResult: type-checked payload AND hw both reach the queue — the one event Emitter.emit() cannot carry at all', () => {
  const dir = tempDir()
  try {
    const emitter = makeEmitter(dir, 'anon')
    emitBenchResult(
      emitter,
      {
        source: 'chat',
        model: { name: 'Test Model', quant: 'Q4_K_M', arch: 'llama', sizeBytes: 1, moe: false },
        engine: { version: 'b1234' },
        params: { ctx: 8192, ngl: 99, nCpuMoe: 0, parallel: 1, kvTypeK: 'q8_0', flashAttn: 'auto' },
        result: { tps: 42, ttftMs: 100, vramMb: null, outcome: 'ok' },
      },
      { cpu: 'Test CPU', ramMb: 65536, gpus: [{ name: 'Test GPU', vramMb: 16384 }] },
    )
    const queued = readQueue(dir)
    assert.equal(queued.length, 1)
    assert.equal((queued[0].event.payload as { source: string }).source, 'chat')
    assert.deepEqual(queued[0].event.hw, { cpu: 'Test CPU', ramMb: 65536, gpus: [{ name: 'Test GPU', vramMb: 16384 }] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
