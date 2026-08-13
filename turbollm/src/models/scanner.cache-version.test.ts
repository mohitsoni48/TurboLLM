// Regression test for the CACHE_VERSION gap caught by pre-release review (v1.10.8, issue
// #165): parseGguf() started rejecting a bogus general.name like "Safetensors" (gguf.ts),
// but a model already sitting in models-cache.json under the OLD CACHE_VERSION would keep
// replaying that stale, wrong cached name forever — entryFor() only calls parseGguf again
// when the file's size/mtime changed, never on a code change. Bumping CACHE_VERSION is what
// forces every cached row to re-parse once, which is the only thing that makes a parseGguf
// fix actually reach a model a user already had scanned before upgrading.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ConfigStore } from '../config/config'
import { Scanner } from './scanner'

const T_UINT32 = 4
const T_STRING = 8

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

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `turbollm-cacheversion-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
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

test('a stale cache row from an OLDER CACHE_VERSION is re-parsed, not replayed', async () => {
  const root = makeTmpRoot()
  try {
    // walk() only records .gguf files >= 1 MiB — pad well past that with trailing bytes
    // parseGguf never reads (it stops once it has consumed kvCount keys).
    const header = buildGguf([
      ['general.architecture', 'qwen35moe'],
      ['general.name', 'Safetensors'], // the bogus value apex-quant actually writes
    ])
    const padded = Buffer.concat([header, Buffer.alloc((1 << 20) + 16)])
    const path = join(root, 'model-apex.gguf')
    writeFileSync(path, padded)
    const st = statSync(path)

    // Simulate a cache written by a build whose CACHE_VERSION predates the general.name
    // guard: it already has this exact file's size/mtime, with the un-guarded bogus name.
    writeFileSync(
      join(root, 'models-cache.json'),
      JSON.stringify({
        version: 4, // CACHE_VERSION as of v1.10.7, before the general.name guard shipped
        entries: {
          [path]: {
            size: st.size,
            mtime: st.mtimeMs,
            meta: {
              arch: 'qwen35moe', name: 'Safetensors', quant: 'Q6_K', sizeLabel: '', nativeCtx: 0,
              blockCount: 0, embedLen: 0, headCountKv: 0, headDim: 0, expertCount: 0, nextnLayers: 0,
              hasChatTemplate: false, slidingWindow: 0, slidingWindowPattern: [], headDimSwa: 0,
              headCountKvPerLayer: [], fullAttentionInterval: 0, ssmInnerSize: 0, ssmStateSize: 0,
              ssmConvKernel: 0,
            },
          },
        },
      }),
    )

    const scanner = new Scanner(stubStore(root))
    await scanner.rescan()
    const entry = scanner.list().models.find((m) => m.format === 'gguf')
    assert.ok(entry, 'expected one GGUF entry')
    assert.notEqual(entry.name, 'Safetensors', 'a version mismatch must force a re-parse, not replay the stale cached name')
    assert.equal(entry.name, 'model apex', 'falls back to the cleaned filename once re-parsed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
