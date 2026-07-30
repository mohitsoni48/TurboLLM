import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyLoadFailure, classifyBenchFailure } from './classify'
import { FAIL_REASONS } from './schema'

function err(over: Partial<{ code: string; message: string; logTail: string[] }> = {}) {
  return { code: 'load_failed', message: '', exitCode: 1, logTail: [], ...over }
}

test('classifyLoadFailure: always returns a value from the enum, never raw text', () => {
  const inputs = [
    err({ message: 'CUDA error: out of memory' }),
    err({ code: 'readiness_timeout' }),
    err({ message: 'some entirely unfamiliar failure' }),
    err({ message: 'D:/models/private/secret.gguf could not be opened' }),
  ]
  for (const e of inputs) {
    assert.ok(
      (FAIL_REASONS as readonly string[]).includes(classifyLoadFailure(e)),
      `classified value must be in the enum, got ${classifyLoadFailure(e)}`,
    )
  }
})

test('classifyLoadFailure: recognises CUDA out-of-memory', () => {
  assert.equal(classifyLoadFailure(err({ message: 'CUDA error: out of memory' })), 'oom')
})

test('classifyLoadFailure: finds OOM in the log tail, not just the message', () => {
  // llama.cpp usually reports the real cause in the log, with a generic exit
  // message — so a message-only classifier would report every OOM as "other".
  const e = err({ message: 'engine exited with code 1', logTail: ['ggml_backend_cuda_buffer_type_alloc_buffer: allocating 4096 MiB failed: out of memory'] })
  assert.equal(classifyLoadFailure(e), 'oom')
})

test('classifyLoadFailure: recognises the vendor variants of OOM', () => {
  assert.equal(classifyLoadFailure(err({ message: 'ggml_vulkan: Device memory allocation of size 123 failed' })), 'oom')
  assert.equal(classifyLoadFailure(err({ message: 'hipErrorOutOfMemory' })), 'oom')
  assert.equal(classifyLoadFailure(err({ message: 'failed to allocate buffer' })), 'oom')
})

test('classifyLoadFailure: a readiness timeout is a timeout', () => {
  assert.equal(classifyLoadFailure(err({ code: 'readiness_timeout' })), 'timeout')
})

test('classifyLoadFailure: a missing or unusable engine is no_engine', () => {
  assert.equal(classifyLoadFailure(err({ code: 'engine_unsupported' })), 'no_engine')
  assert.equal(classifyLoadFailure(err({ message: 'no_active_engine' })), 'no_engine')
})

test('classifyLoadFailure: an unknown architecture is reported as such', () => {
  assert.equal(
    classifyLoadFailure(err({ message: 'llama_model_load: error loading model: unknown model architecture: bitnet' })),
    'unsupported_arch',
  )
})

test('classifyLoadFailure: a corrupt or unreadable gguf is bad_gguf', () => {
  assert.equal(classifyLoadFailure(err({ message: 'invalid magic characters in gguf file' })), 'bad_gguf')
  assert.equal(classifyLoadFailure(err({ message: 'llama_model_load: error loading model' })), 'bad_gguf')
})

test('classifyLoadFailure: OOM wins over the generic load-failure text it accompanies', () => {
  // Real llama.cpp OOM output contains BOTH "error loading model" and the
  // allocation failure. Reporting it as bad_gguf would send us hunting a
  // corruption bug that does not exist.
  const e = err({ message: 'llama_model_load: error loading model: failed to allocate buffer' })
  assert.equal(classifyLoadFailure(e), 'oom')
})

test('classifyLoadFailure: anything unrecognised is other, not a guess', () => {
  assert.equal(classifyLoadFailure(err({ message: 'something nobody has seen before' })), 'other')
})

test('classifyLoadFailure: a null error still classifies', () => {
  assert.equal(classifyLoadFailure(null), 'other')
})

test('classifyBenchFailure: OOM wins when present, even alongside other outcomes', () => {
  // Auto-tune's binary search is EXPECTED to hit OOM on some candidates before
  // finding one that fits — OOM among the attempts is the dominant, actionable
  // explanation for why the sweep as a whole failed, same precedence
  // classifyLoadFailure already uses for a single raw error.
  assert.equal(classifyBenchFailure([{ outcome: 'oom' }, { outcome: 'crash' }, { outcome: 'timeout' }]), 'oom')
  assert.equal(classifyBenchFailure([{ outcome: 'oom' }]), 'oom')
})

test('classifyBenchFailure: timeout when present and no OOM', () => {
  assert.equal(classifyBenchFailure([{ outcome: 'crash' }, { outcome: 'timeout' }]), 'timeout')
})

test('classifyBenchFailure: a crash-only sweep is other, not a guess', () => {
  assert.equal(classifyBenchFailure([{ outcome: 'crash' }]), 'other')
})

test('classifyBenchFailure: no candidates at all is other', () => {
  assert.equal(classifyBenchFailure([]), 'other')
})

test('classifyBenchFailure: always returns a value from the enum', () => {
  for (const outcomes of [[{ outcome: 'oom' as const }], [{ outcome: 'crash' as const }], []]) {
    assert.ok((FAIL_REASONS as readonly string[]).includes(classifyBenchFailure(outcomes)))
  }
})
