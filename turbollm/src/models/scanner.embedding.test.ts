// Embedding-model detection (ADR-389). `Qwen3-Embedding-0.6B-Q8_0.gguf` — a real file, found
// live — was never flagged `embedding: true`: its arch is `qwen3` (shared with ordinary chat
// models, so EMBED_ARCHS can't include it) and its filename matched none of the curated
// sentence-transformer-style prefixes (bge-, e5-, gte-, …). With `entry.embedding` staying
// false, the model-router's embedding-coexistence logic (ADR-060/062, ADR-389) never engaged —
// loading it manually evicted whatever chat model was running, same as any ordinary model.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig, type Config, type ConfigStore } from '../config/config'
import { Scanner } from './scanner'

const T_UINT32 = 4
const T_STRING = 8

/** Minimal valid GGUF v3 header — same construction as gguf.test.ts's own helper, kept local
 *  per this codebase's convention of not sharing helpers across test files. */
function buildGguf(kvs: Array<[string, string | number]>): Buffer {
  const parts: Buffer[] = []
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
  const str = (s: string) => { const body = Buffer.from(s, 'utf8'); return Buffer.concat([u64(body.length), body]) }
  parts.push(u32(0x46554747), u32(3), u64(0), u64(kvs.length)) // magic, version, tensorCount, kvCount
  for (const [key, value] of kvs) {
    parts.push(str(key))
    if (typeof value === 'string') parts.push(u32(T_STRING), str(value))
    else parts.push(u32(T_UINT32), u32(value))
  }
  return Buffer.concat(parts)
}

// walk() only records .gguf files >= 1 MiB — pad past that floor, same as scanner.mmproj.test.ts.
const MIN_SIZE = (1 << 20) + 16

function writeGguf(dir: string, filename: string, kvs: Array<[string, string | number]>): string {
  const path = join(dir, filename)
  const header = buildGguf(kvs)
  const body = header.length >= MIN_SIZE ? header : Buffer.concat([header, Buffer.alloc(MIN_SIZE - header.length)])
  writeFileSync(path, body)
  return path
}

function memStore(root: string, seed: Partial<Config> = {}): ConfigStore {
  const cfg: Config = { ...defaultConfig(), modelDirs: [root], ...seed }
  return {
    dir: () => root,
    snapshot: () => cfg,
    update: (fn: (c: Config) => void) => { fn(cfg) },
  } as unknown as ConfigStore
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-embed-test-'))
}

test('a Qwen3-architecture embedding model is flagged embedding: true by filename', async () => {
  const root = makeRoot()
  try {
    writeGguf(root, 'Qwen3-Embedding-0.6B-Q8_0.gguf', [['general.architecture', 'qwen3']])
    const scanner = new Scanner(memStore(root))
    await scanner.rescan()
    const models = scanner.list().models
    assert.equal(models.length, 1)
    assert.equal(models[0].embedding, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an ordinary qwen3 chat model (no "embed" in the name) is NOT flagged as embedding', async () => {
  const root = makeRoot()
  try {
    writeGguf(root, 'Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf', [['general.architecture', 'qwen3']])
    const scanner = new Scanner(memStore(root))
    await scanner.rescan()
    assert.equal(scanner.list().models[0].embedding, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a curated-prefix embedding model (bge-) still matches, unaffected by the new catch-all', async () => {
  const root = makeRoot()
  try {
    writeGguf(root, 'bge-m3-Q8_0.gguf', [['general.architecture', 'bert']])
    const scanner = new Scanner(memStore(root))
    await scanner.rescan()
    assert.equal(scanner.list().models[0].embedding, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
