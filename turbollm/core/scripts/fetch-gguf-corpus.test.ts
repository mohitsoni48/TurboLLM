// Run from turbollm/: npx tsx --test core/scripts/fetch-gguf-corpus.test.ts (rust-core plan T4, QA E-23).
// Every fetch is a stub: this file never touches the network.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from '../../src/test-support/tmp'
import { ensureSlice, sliceUrl } from './fetch-gguf-corpus.mjs'

const SLICE = Buffer.from('GGUF header bytes, then more header bytes')
const BYTES = 16

interface Call {
  url: string
  headers: Record<string, string>
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'demo',
    repo: 'org/Demo-GGUF',
    revision: 'a'.repeat(40),
    file: 'sub/Demo-Q4_K_M.gguf',
    bytes: BYTES,
    sha256: sha256(SLICE.subarray(0, BYTES)),
    fileSize: 123_456,
    ...overrides,
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A fetch that answers every request with `status` and `body`, recording what was asked. */
function recordingFetch(status: number, body: Buffer) {
  const calls: Call[] = []
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } })
    return new Response(new Uint8Array(body), { status })
  }
  return { calls, fetchImpl }
}

test('a Hugging Face entry resolves at its pinned revision', () => {
  assert.equal(sliceUrl(entry()), `https://huggingface.co/org/Demo-GGUF/resolve/${'a'.repeat(40)}/sub/Demo-Q4_K_M.gguf`)
})

test('a github: entry maps to raw.githubusercontent.com at its pinned revision', () => {
  const url = sliceUrl(entry({ repo: 'github:ggml-org/llama.cpp', file: 'models/ggml-vocab-llama-bpe.gguf' }))
  assert.equal(url, `https://raw.githubusercontent.com/ggml-org/llama.cpp/${'a'.repeat(40)}/models/ggml-vocab-llama-bpe.gguf`)
})

test('the slice is requested with a Range header and no token', async () => {
  const cacheDir = tmpDir('corpus-')
  const { calls, fetchImpl } = recordingFetch(206, SLICE.subarray(0, BYTES))
  assert.equal(await ensureSlice(entry(), cacheDir, fetchImpl), 'fetched')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers.Range, `bytes=0-${BYTES - 1}`)
  assert.ok(!Object.keys(calls[0].headers).some((h) => h.toLowerCase() === 'authorization'))
  assert.deepEqual(readFileSync(join(cacheDir, 'demo.gguf')), SLICE.subarray(0, BYTES))
})

test('a 200 full body is cut to the entry bytes', async () => {
  const cacheDir = tmpDir('corpus-')
  const { fetchImpl } = recordingFetch(200, SLICE)
  assert.equal(await ensureSlice(entry(), cacheDir, fetchImpl), 'fetched')
  assert.equal(readFileSync(join(cacheDir, 'demo.gguf')).length, BYTES)
})

test('bytes that moved upstream fail on the sha256, naming the id, and leave no file', async () => {
  const cacheDir = tmpDir('corpus-')
  const { fetchImpl } = recordingFetch(206, Buffer.from('GGUF different bytes!!').subarray(0, BYTES))
  await assert.rejects(ensureSlice(entry(), cacheDir, fetchImpl), /demo: sha256/)
  assert.equal(existsSync(join(cacheDir, 'demo.gguf')), false)
  assert.equal(existsSync(join(cacheDir, 'demo.gguf.tmp')), false)
})

test('a body shorter than the entry bytes fails naming the id', async () => {
  const cacheDir = tmpDir('corpus-')
  const { fetchImpl } = recordingFetch(206, SLICE.subarray(0, BYTES - 1))
  await assert.rejects(ensureSlice(entry(), cacheDir, fetchImpl), /demo: got 15 bytes, want 16/)
})

test('an error status fails naming the id', async () => {
  const cacheDir = tmpDir('corpus-')
  const { fetchImpl } = recordingFetch(404, Buffer.from('not found'))
  await assert.rejects(ensureSlice(entry(), cacheDir, fetchImpl), /demo: HTTP 404/)
})

test('a cached slice with the right sha256 is not refetched', async () => {
  const cacheDir = tmpDir('corpus-')
  writeFileSync(join(cacheDir, 'demo.gguf'), SLICE.subarray(0, BYTES))
  const { calls, fetchImpl } = recordingFetch(206, SLICE.subarray(0, BYTES))
  assert.equal(await ensureSlice(entry(), cacheDir, fetchImpl), 'cached')
  assert.equal(calls.length, 0)
})

test('a cached slice with the wrong sha256 is refetched', async () => {
  const cacheDir = tmpDir('corpus-')
  writeFileSync(join(cacheDir, 'demo.gguf'), Buffer.from('stale stale stale'))
  const { calls, fetchImpl } = recordingFetch(206, SLICE.subarray(0, BYTES))
  assert.equal(await ensureSlice(entry(), cacheDir, fetchImpl), 'fetched')
  assert.equal(calls.length, 1)
})
