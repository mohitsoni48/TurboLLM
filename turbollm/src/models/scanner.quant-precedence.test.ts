// Filename beats a misleading `general.file_type` (2026-08-16, live report).
//
// Two real files on the founder's box: `Qwen3.8-27B-UD-IQ2_M.gguf` (a 10.3 GB, 2-bit-class
// unsloth "dynamic" quant) and `Muse-Glimmer-30B-UD-Q2_K_XL.gguf` (also 2-bit) both carried a
// `general.file_type` of Q4_K_S / Q4_K_M — llama.cpp's own single-enum "most common tensor type"
// summary, which for a dynamic quant is dominated by the many small attention/norm tensors kept
// at 4-bit, not the few huge MoE/FFN tensors actually pushed to 2-bit to hit the file's size. The
// scanner used to trust that field over the filename whenever it was present, so both models
// displayed as roughly twice their real bit-width — the one number users rely on to judge output
// quality. Checked against the whole local catalog before flipping the precedence: every one of
// 26 GGUFs where filename and metadata disagreed either matched at the same bit-width (filename
// just carried MORE information, e.g. "Q4_K_XL" vs "Q4_K_M") or was this exact bug — zero cases
// favored metadata (see ADR in decision-log for the full comparison).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig, migrateModelKey, type Config, type ConfigStore } from '../config/config'
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

// FTYPE ordinals actually seen on the mislabeled files (spill.ts's sibling table, gguf.ts).
const FTYPE_Q4_K_S = 14
const FTYPE_Q4_K_M = 15

// walk() only records .gguf files >= 1 MiB — pad past that floor, same as scanner.mmproj.test.ts.
const MIN_SIZE = (1 << 20) + 16

function writeGguf(dir: string, filename: string, kvs: Array<[string, string | number]>): string {
  const path = join(dir, filename)
  const header = buildGguf(kvs)
  const body = header.length >= MIN_SIZE ? header : Buffer.concat([header, Buffer.alloc(MIN_SIZE - header.length)])
  writeFileSync(path, body)
  return path
}

/** In-memory stand-in for ConfigStore: `update()` mutates the same object `snapshot()` returns —
 *  real ConfigStore also validates + persists to disk, neither of which this test needs, only the
 *  read-your-own-write semantics the scanner's migration path depends on. */
function memStore(root: string, seed: Partial<Config> = {}): ConfigStore {
  const cfg: Config = { ...defaultConfig(), modelDirs: [root], ...seed }
  return {
    dir: () => root,
    snapshot: () => cfg,
    update: (fn: (c: Config) => void) => { fn(cfg) },
  } as unknown as ConfigStore
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'turbollm-quant-test-'))
  return root
}

test('filename wins when it disagrees with a present general.file_type (the real bug)', async () => {
  const root = makeRoot()
  try {
    writeGguf(root, 'Qwen3.8-27B-UD-IQ2_M.gguf', [
      ['general.architecture', 'qwen3'],
      ['general.file_type', FTYPE_Q4_K_S], // the misleading metadata actually observed
    ])
    const scanner = new Scanner(memStore(root))
    await scanner.rescan()
    const models = scanner.list().models
    assert.equal(models.length, 1)
    assert.equal(models[0].quant, 'IQ2_M') // NOT "Q4_K_S"
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('metadata is still used when the filename carries no recognizable quant token', async () => {
  const root = makeRoot()
  try {
    writeGguf(root, 'custom-export.gguf', [
      ['general.architecture', 'qwen3'],
      ['general.file_type', FTYPE_Q4_K_M],
    ])
    const scanner = new Scanner(memStore(root))
    await scanner.rescan()
    const models = scanner.list().models
    assert.equal(models.length, 1)
    assert.equal(models[0].quant, 'Q4_K_M') // metadata is the only source available here
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('filename and metadata agreeing (the common case) is unaffected', async () => {
  const root = makeRoot()
  try {
    writeGguf(root, 'model-Q4_K_M.gguf', [
      ['general.architecture', 'qwen3'],
      ['general.file_type', FTYPE_Q4_K_M],
    ])
    const scanner = new Scanner(memStore(root))
    await scanner.rescan()
    assert.equal(scanner.list().models[0].quant, 'Q4_K_M')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a rescan migrates a saved profile/preset/bench-result from the old (mislabeled) key to the new one', async () => {
  const root = makeRoot()
  try {
    writeGguf(root, 'Qwen3.8-27B-UD-IQ2_M.gguf', [
      ['general.architecture', 'qwen3'],
      ['general.file_type', FTYPE_Q4_K_S],
    ])
    // Learn the real key the scanner derives for this exact file (name-cleaning is an
    // implementation detail of `cleanName`, not something this test should have to reproduce) —
    // an empty-config scan first, then derive the pre-fix key by swapping only the quant segment.
    const probe = new Scanner(memStore(root))
    await probe.rescan()
    const newKey = probe.list().models[0].key
    const oldKey = newKey.replace('|IQ2_M|', '|Q4_K_S|')
    assert.notEqual(oldKey, newKey, 'sanity: the key actually contains the quant segment we expect')

    const store = memStore(root)
    store.update((cfg) => {
      cfg.modelProfiles[oldKey] = { 'engine-a': { profile: { ctx: 200000 }, updatedAt: '2026-08-15T00:00:00.000Z' } }
      cfg.benchResults[oldKey] = {
        modelKey: oldKey, tps: 41.65, ttftMs: 18797, vramMb: 15328,
        params: { ctx: 200000, ngl: 65, nCpuMoe: 0, parallel: 1, kvTypeK: 'q4_0', flashAttn: 'on' },
        ts: '2026-08-15T09:51:16.751Z',
      }
    })

    const scanner = new Scanner(store)
    await scanner.rescan()

    const cfg = store.snapshot()
    assert.equal(cfg.modelProfiles[oldKey], undefined, 'old key cleared')
    assert.equal(cfg.benchResults[oldKey], undefined, 'old key cleared')
    assert.equal((cfg.modelProfiles[newKey]?.['engine-a']?.profile as { ctx: number } | undefined)?.ctx, 200000)
    assert.equal(cfg.benchResults[newKey]?.tps, 41.65)
    assert.equal(cfg.benchResults[newKey]?.modelKey, newKey)

    // A second rescan (the normal steady state) finds nothing left to migrate and stays stable.
    await scanner.rescan()
    const cfg2 = store.snapshot()
    assert.equal(cfg2.benchResults[newKey]?.tps, 41.65)
    assert.equal(Object.keys(cfg2.benchResults).length, 1) // no duplicate/second entry created
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('migrateModelKey is exported and usable standalone (sanity — full behavior covered in config.test.ts)', () => {
  const cfg = defaultConfig()
  cfg.benchResults['old|Q4_K_S|1'] = { modelKey: 'old|Q4_K_S|1', tps: 1, ttftMs: 1, vramMb: 1, params: { ctx: 1, ngl: 1, nCpuMoe: 0, parallel: 1, kvTypeK: 'f16', flashAttn: 'on' }, ts: 't' }
  assert.equal(migrateModelKey(cfg, 'old|Q4_K_S|1', 'new|IQ2_M|1'), true)
  assert.equal(cfg.benchResults['new|IQ2_M|1'].tps, 1)
})
