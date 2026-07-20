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
const T_BOOL = 7
const T_STRING = 8
const T_ARRAY = 9

/** A KV value: scalar string/uint32, or a per-layer uint32/bool array (real GGUFs use
 *  arrays for Gemma 4's head_count_kv and sliding_window_pattern). */
type KvValue = string | number | number[] | boolean[]

/** Minimal valid GGUF v3 header: magic + version + tensorCount(0) + the given KV pairs. */
function buildGguf(kvs: Array<[string, KvValue]>): Buffer {
  const parts: Buffer[] = []
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
  const u8 = (n: number) => { const b = Buffer.alloc(1); b.writeUInt8(n); return b }
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
    } else if (typeof value === 'number') {
      parts.push(u32(T_UINT32))
      parts.push(u32(value))
    } else if (typeof value[0] === 'boolean') {
      parts.push(u32(T_ARRAY), u32(T_BOOL), u64(value.length))
      for (const v of value as boolean[]) parts.push(u8(v ? 1 : 0))
    } else {
      parts.push(u32(T_ARRAY), u32(T_UINT32), u64(value.length))
      for (const v of value as number[]) parts.push(u32(v))
    }
  }
  return Buffer.concat(parts)
}

function withGgufFile(kvs: Array<[string, KvValue]>, run: (path: string) => void): void {
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

// ---- Attention layout ---------------------------------------------------------------
// Key names and shapes below are transcribed from the founder's real GGUF files, not
// guessed. Two families cache far less than "every layer at full context", and reading
// these fields is what lets the VRAM estimator stop over-counting them by 4-18x.

/** Repeats `period` until `layers` elements exist — how Gemma lays out its per-layer arrays. */
function cycle<T>(period: T[], layers: number): T[] {
  return Array.from({ length: layers }, (_, i) => period[i % period.length])
}

test('hybrid SSM: full_attention_interval and ssm.* are read (Qwen3.6-27B, arch "qwen35")', () => {
  withGgufFile(
    [
      ['general.architecture', 'qwen35'],
      ['qwen35.block_count', 64],
      ['qwen35.attention.head_count_kv', 4],
      ['qwen35.attention.key_length', 256],
      ['qwen35.attention.value_length', 256],
      ['qwen35.full_attention_interval', 4],
      ['qwen35.ssm.conv_kernel', 4],
      ['qwen35.ssm.state_size', 128],
      ['qwen35.ssm.inner_size', 6144],
      ['qwen35.ssm.group_count', 16],
      ['qwen35.ssm.time_step_rank', 48],
    ],
    (path) => {
      const meta = parseGguf(path)
      assert.equal(meta.blockCount, 64)
      assert.equal(meta.headCountKv, 4)
      assert.equal(meta.headDim, 256)
      // 64 / 4 = 16 full-attention layers actually hold a growing KV cache.
      assert.equal(meta.fullAttentionInterval, 4)
      assert.equal(meta.ssmConvKernel, 4)
      assert.equal(meta.ssmStateSize, 128)
      assert.equal(meta.ssmInnerSize, 6144)
      // No sliding window on this family.
      assert.equal(meta.slidingWindow, 0)
      assert.deepEqual(meta.slidingWindowPattern, [])
      assert.equal(meta.headDimSwa, 0)
      assert.deepEqual(meta.headCountKvPerLayer, [])
    },
  )
})

test('hybrid SSM without a declared layout stays unknown (Qwen3-Coder-Next)', () => {
  // ssm.* present but no full_attention_interval: the model IS hybrid, yet nothing here
  // says which layers are full attention. fullAttentionInterval must read 0 so callers
  // keep the conservative all-layers estimate rather than inventing an interval.
  withGgufFile(
    [
      ['general.architecture', 'qwen3next'],
      ['qwen3next.block_count', 48],
      ['qwen3next.attention.head_count_kv', 2],
      ['qwen3next.attention.key_length', 256],
      ['qwen3next.ssm.conv_kernel', 4],
      ['qwen3next.ssm.state_size', 128],
      ['qwen3next.ssm.inner_size', 4096],
    ],
    (path) => {
      const meta = parseGguf(path)
      assert.equal(meta.ssmInnerSize, 4096)
      assert.equal(meta.fullAttentionInterval, 0)
    },
  )
})

test('SWA with per-layer head_count_kv array (Gemma-4-26B-A4B)', () => {
  withGgufFile(
    [
      ['general.architecture', 'gemma4'],
      ['gemma4.block_count', 30],
      // 5 sliding layers (8 KV heads) then 1 global layer (2 KV heads), repeated.
      ['gemma4.attention.head_count_kv', cycle([8, 8, 8, 8, 8, 2], 30)],
      ['gemma4.attention.key_length', 512],
      ['gemma4.attention.value_length', 512],
      ['gemma4.attention.sliding_window', 1024],
      ['gemma4.attention.sliding_window_pattern', cycle([true, true, true, true, true, false], 30)],
      ['gemma4.attention.key_length_swa', 256],
      ['gemma4.attention.value_length_swa', 256],
    ],
    (path) => {
      const meta = parseGguf(path)
      assert.equal(meta.blockCount, 30)
      assert.equal(meta.headDim, 512)
      assert.equal(meta.headDimSwa, 256)
      assert.equal(meta.slidingWindow, 1024)
      // The scalar stays the max (unchanged behaviour) — but the max is exactly the trap:
      // applying 8 heads to the global layers, which really use 2, is what inflated the
      // old estimate. The per-layer array is the fix.
      assert.equal(meta.headCountKv, 8)
      assert.equal(meta.headCountKvPerLayer.length, 30)
      assert.deepEqual(meta.headCountKvPerLayer.slice(0, 7), [8, 8, 8, 8, 8, 2, 8])
      assert.equal(meta.slidingWindowPattern.length, 30)
      assert.deepEqual(meta.slidingWindowPattern.slice(0, 7), [true, true, true, true, true, false, true])
      // 25 sliding + 5 global.
      assert.equal(meta.slidingWindowPattern.filter(Boolean).length, 25)
      assert.equal(meta.slidingWindowPattern.filter((s) => !s).length, 5)
      // Hybrid-SSM fields must stay absent for a pure-SWA model.
      assert.equal(meta.fullAttentionInterval, 0)
      assert.equal(meta.ssmInnerSize, 0)
    },
  )
})

test('SWA with a SCALAR head_count_kv leaves headCountKvPerLayer empty (Gemma-4-E4B)', () => {
  withGgufFile(
    [
      ['general.architecture', 'gemma4'],
      ['gemma4.block_count', 42],
      ['gemma4.attention.head_count_kv', 2], // scalar on this variant
      ['gemma4.attention.key_length', 512],
      ['gemma4.attention.sliding_window', 512],
      ['gemma4.attention.sliding_window_pattern', cycle([true, true, true, true, true, false], 42)],
      ['gemma4.attention.key_length_swa', 256],
    ],
    (path) => {
      const meta = parseGguf(path)
      assert.equal(meta.headCountKv, 2)
      assert.deepEqual(meta.headCountKvPerLayer, [], 'scalar must not synthesize a per-layer array')
      assert.equal(meta.slidingWindow, 512)
      assert.equal(meta.headDimSwa, 256)
      // 35 sliding + 7 global.
      assert.equal(meta.slidingWindowPattern.filter(Boolean).length, 35)
      assert.equal(meta.slidingWindowPattern.filter((s) => !s).length, 7)
    },
  )
})

test('headDimSwa falls back to value_length_swa when key_length_swa is absent', () => {
  withGgufFile(
    [
      ['general.architecture', 'gemma4'],
      ['gemma4.attention.value_length_swa', 256],
    ],
    (path) => {
      assert.equal(parseGguf(path).headDimSwa, 256)
    },
  )
})

test('key_length_swa does not leak into headDim (suffix matching stays exact)', () => {
  withGgufFile(
    [
      ['general.architecture', 'gemma4'],
      ['gemma4.attention.key_length', 512],
      ['gemma4.attention.key_length_swa', 256],
    ],
    (path) => {
      const meta = parseGguf(path)
      assert.equal(meta.headDim, 512)
      assert.equal(meta.headDimSwa, 256)
    },
  )
})

test('a scalar sliding_window_pattern degrades to [] rather than a guessed mask', () => {
  // Some architectures write this key as a stride (every Nth layer is global) instead of
  // a per-layer mask. We can't tell the phase from a stride, and a wrong mask would
  // UNDER-count the KV cache — so report nothing and let the caller stay conservative.
  withGgufFile(
    [
      ['general.architecture', 'gemma3'],
      ['gemma3.block_count', 26],
      ['gemma3.attention.sliding_window', 1024],
      ['gemma3.attention.sliding_window_pattern', 6],
      // Deliberately written AFTER the skipped key: only a field that follows it can
      // prove the scalar was consumed at the right width. A field before it would still
      // read correctly even if the skip desynced the stream.
      ['gemma3.attention.head_count_kv', 4],
      ['gemma3.attention.key_length', 256],
    ],
    (path) => {
      const meta = parseGguf(path)
      assert.deepEqual(meta.slidingWindowPattern, [])
      assert.equal(meta.slidingWindow, 1024)
      assert.equal(meta.blockCount, 26)
      // The value must still have been consumed correctly — a mis-read would desync the
      // KV stream and corrupt every field after it.
      assert.equal(meta.headCountKv, 4)
      assert.equal(meta.headDim, 256)
    },
  )
})

test('a plain dense model reports no attention-layout metadata at all', () => {
  // The overwhelming majority of models. Every layout field must be 0/[] so the estimator
  // behaves EXACTLY as it did before these fields existed.
  withGgufFile(
    [
      ['general.architecture', 'llama'],
      ['general.name', 'Plain Dense'],
      ['llama.block_count', 32],
      ['llama.context_length', 8192],
      ['llama.embedding_length', 4096],
      ['llama.attention.head_count_kv', 8],
      ['llama.attention.key_length', 128],
    ],
    (path) => {
      const meta = parseGguf(path)
      assert.equal(meta.slidingWindow, 0)
      assert.deepEqual(meta.slidingWindowPattern, [])
      assert.equal(meta.headDimSwa, 0)
      assert.deepEqual(meta.headCountKvPerLayer, [])
      assert.equal(meta.fullAttentionInterval, 0)
      assert.equal(meta.ssmInnerSize, 0)
      assert.equal(meta.ssmStateSize, 0)
      assert.equal(meta.ssmConvKernel, 0)
      // Pre-existing fields untouched.
      assert.equal(meta.blockCount, 32)
      assert.equal(meta.headCountKv, 8)
      assert.equal(meta.headDim, 128)
      assert.equal(meta.nativeCtx, 8192)
    },
  )
})
