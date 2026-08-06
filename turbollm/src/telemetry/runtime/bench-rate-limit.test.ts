import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldEmitBenchResult, benchRateLimitKey, BENCH_RATE_LIMIT_MS } from './bench-rate-limit'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-bench-rate-limit-'))
}

test('shouldEmitBenchResult: the first measurement for a key is always allowed', () => {
  const dir = tempDir()
  try {
    assert.equal(shouldEmitBenchResult(dir, 'k1', 1_000), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shouldEmitBenchResult: a second measurement of the SAME key inside the window is dropped', () => {
  const dir = tempDir()
  try {
    assert.equal(shouldEmitBenchResult(dir, 'k1', 1_000), true)
    assert.equal(shouldEmitBenchResult(dir, 'k1', 1_000 + BENCH_RATE_LIMIT_MS - 1), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shouldEmitBenchResult: the same key is allowed again once the window has fully elapsed', () => {
  const dir = tempDir()
  try {
    assert.equal(shouldEmitBenchResult(dir, 'k1', 1_000), true)
    assert.equal(shouldEmitBenchResult(dir, 'k1', 1_000 + BENCH_RATE_LIMIT_MS), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shouldEmitBenchResult: distinct keys never block each other', () => {
  const dir = tempDir()
  try {
    assert.equal(shouldEmitBenchResult(dir, 'k1', 1_000), true)
    assert.equal(shouldEmitBenchResult(dir, 'k2', 1_000), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('benchRateLimitKey: differs whenever any field differs, including source', () => {
  const base = benchRateLimitKey('model-a', 'Q4_K_M', 8192, 99, 0, 'q8_0', 'chat')
  assert.notEqual(base, benchRateLimitKey('model-a', 'Q4_K_M', 8192, 99, 0, 'q8_0', 'gateway'))
  assert.notEqual(base, benchRateLimitKey('model-a', 'Q4_K_M', 4096, 99, 0, 'q8_0', 'chat'))
  assert.equal(base, benchRateLimitKey('model-a', 'Q4_K_M', 8192, 99, 0, 'q8_0', 'chat'))
})
