// Direct coverage for the GGUF metadata parser — in particular headDim (regression: this
// project's own VRAM estimator assumed a flat 128 for every model until a real-hardware
// report showed it silently mis-sizing the KV cache for a GQA model whose real per-head
// dim is 256; see profile.ts's estimateVram).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseGguf } from './gguf'

const T_UINT32 = 4
const T_STRING = 8

/** Minimal valid GGUF v3 header: magic + version + tensorCount(0) + the given KV pairs.
 *  Only string and uint32 values are needed for this parser's fields. */
function buildGguf(kvs: Array<[string, string | number]>): Buffer {
  const parts: Buffer[] = []
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
  const str = (s: string) => { const body = Buffer.from(s, 'utf8'); return Buffer.concat([u64(body.length), body]) }

  parts.push(u32(0x46554747)) // magic "GGUF"
  parts.push(u32(3)) // version
  parts.push(u64(0)) // tensorCount
  parts.push(u64(kvs.length)) // kvCount
  for (const [key, value] of kvs) {
    parts.push(str(key))
    if (typeof value === 'string') {
      parts.push(u32(T_STRING))
      parts.push(str(value))
    } else {
      parts.push(u32(T_UINT32))
      parts.push(u32(value))
    }
  }
  return Buffer.concat(parts)
}

function withGgufFile(kvs: Array<[string, string | number]>, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gguf-test-'))
  const path = join(dir, 'model.gguf')
  try {
    writeFileSync(path, buildGguf(kvs))
    run(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('headDim reads attention.key_length directly (the field llama.cpp itself uses)', () => {
  withGgufFile(
    [
      ['general.architecture', 'qwen3'],
      ['qwen3.block_count', 65],
      ['qwen3.embedding_length', 4096],
      ['qwen3.attention.head_count_kv', 8],
      ['qwen3.attention.key_length', 256],
    ],
    (path) => {
      const meta = parseGguf(path)
      assert.equal(meta.headDim, 256)
    },
  )
})

test('headDim falls back to value_length when key_length is absent', () => {
  withGgufFile(
    [
      ['general.architecture', 'qwen3'],
      ['qwen3.attention.value_length', 128],
    ],
    (path) => {
      assert.equal(parseGguf(path).headDim, 128)
    },
  )
})

test('headDim is 0 (unknown — caller falls back) when the GGUF declares neither field', () => {
  withGgufFile([['general.architecture', 'llama']], (path) => {
    assert.equal(parseGguf(path).headDim, 0)
  })
})
