// Regression tests for GGUF split-shard completeness in Scanner.build (spec 04 §2).
//
// Bug (b2ecd47 follow-up): a multi-part GGUF whose shards download correctly still got
// reported as "missing parts" and refused to load. The completeness check must judge a
// split complete by the distinct part INDICES present (1..total), so:
//   - both shards of a 2-of-2 split in a per-quant subfolder → incomplete=false
//     (mirrors the on-disk layout the gpt-oss-120b download produces);
//   - a genuinely missing part → incomplete=true;
//   - a stray duplicate of one shard must not mask a real hole, nor make a complete
//     split look "over-full".
//
// entryFor() runs parseGguf on each file; these dummy shards are not valid GGUFs, so
// parseError is set — but `incomplete` is computed independently of the header parse,
// which is exactly what these tests exercise.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ConfigStore } from '../config/config'
import { Scanner } from './scanner'

// walk() only records .gguf files >= 1 MiB — write shards just over that threshold.
const SHARD_BYTES = (1 << 20) + 16
const SHARD_BUF = Buffer.alloc(SHARD_BYTES)

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `turbollm-split-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Minimal ConfigStore stub: the Scanner only reads dir() (cache location) and
 *  snapshot().modelDirs (what to walk). Cache lives under the same temp root. */
function stubStore(root: string): ConfigStore {
  return {
    dir: () => root,
    snapshot: () => ({ modelDirs: [root] }),
  } as unknown as ConfigStore
}

function writeShards(dir: string, names: string[]): void {
  mkdirSync(dir, { recursive: true })
  for (const n of names) writeFileSync(join(dir, n), SHARD_BUF)
}

/** Scan a temp root and return the single GGUF entry (there is exactly one split group). */
async function scanOne(root: string): Promise<{ incomplete: boolean } | undefined> {
  const scanner = new Scanner(stubStore(root))
  await scanner.rescan()
  return scanner.list().models.find((m) => m.format === 'gguf')
}

test('gpt-oss-120b Q4_K_M: both shards of a 2-of-2 split in a per-quant subfolder → complete', async () => {
  const root = makeTmpRoot()
  try {
    // The exact on-disk layout the download produces: <owner>/<repo>/<quant-subdir>/<shards>.
    const dir = join(root, 'unsloth', 'gpt-oss-120b-GGUF', 'Q4_K_M')
    writeShards(dir, [
      'gpt-oss-120b-Q4_K_M-00001-of-00002.gguf',
      'gpt-oss-120b-Q4_K_M-00002-of-00002.gguf',
    ])
    const entry = await scanOne(root)
    assert.ok(entry, 'expected one GGUF split entry')
    assert.equal(entry.incomplete, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a genuinely missing part → incomplete=true', async () => {
  const root = makeTmpRoot()
  try {
    const dir = join(root, 'unsloth', 'gpt-oss-120b-GGUF', 'Q4_K_M')
    writeShards(dir, ['gpt-oss-120b-Q4_K_M-00001-of-00002.gguf']) // 2nd shard absent
    const entry = await scanOne(root)
    assert.ok(entry)
    assert.equal(entry.incomplete, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an out-of-range stray shard does not mask a missing in-range part', async () => {
  const root = makeTmpRoot()
  try {
    // A 3-part split with the real shard 3 missing, but a stray shard whose index (4)
    // exceeds `total` sits in the same folder. The old count-based check (files === total)
    // would see 3 files / total 3 and pass; the index-based check sees indices {1,2,4} —
    // index 3 is absent — and correctly flags it incomplete.
    const dir = join(root, 'repo', 'Q4_K_M')
    writeShards(dir, [
      'm-00001-of-00003.gguf',
      'm-00002-of-00003.gguf',
      'm-00004-of-00003.gguf', // stray / mislabeled part — index out of range
    ])
    const entry = await scanOne(root)
    assert.ok(entry)
    assert.equal(entry.incomplete, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
