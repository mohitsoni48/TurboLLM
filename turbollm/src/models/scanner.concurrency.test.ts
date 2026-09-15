// Concurrent Scanner.rescan() calls (ADR-425).
//
// The old guard (`if (this.scanning) return`) resolved a second rescan() immediately against a
// library walked BEFORE that call was made. Boot's auto-load therefore read an empty list and
// never fired, and delete() could leave the deleted model listed. These tests pin the policy
// that replaced it: one pass at a time, and every caller waits for a pass that started no
// earlier than its own call.
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

/** In-memory ConfigStore that counts snapshot() calls. The scanner reads the snapshot exactly
 *  once per pass (the first line of the pass), so `calls.snapshot` is the number of passes run. */
function memStore(root: string, opts: { throwOnSnapshot?: boolean } = {}) {
  const cfg: Config = { ...defaultConfig(), modelDirs: [root] }
  const calls = { snapshot: 0 }
  const store = {
    dir: () => root,
    snapshot: () => { calls.snapshot++; if (opts.throwOnSnapshot) throw new Error('boom'); return cfg },
    update: (fn: (c: Config) => void) => { fn(cfg) },
  } as unknown as ConfigStore
  return { store, calls }
}

async function withLibraryRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'turbollm-scan-conc-'))
  try {
    await body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeQwenModel(root: string): string {
  return writeGguf(root, 'model-Q4_K_M.gguf', [['general.architecture', 'qwen3']])
}

test('a rescan requested while a scan is running resolves with the model on disk listed (AC2)', async () => {
  await withLibraryRoot(async (root) => {
    writeQwenModel(root)
    const s = new Scanner(memStore(root).store)

    void s.rescan()
    await s.rescan()

    const models = s.list().models
    assert.equal(models.length, 1)
    assert.notEqual(s.get(models[0].key), undefined)
  })
})

test('delete during an in-flight scan that already walked the file leaves the model unlisted (AC3)', async () => {
  await withLibraryRoot(async (root) => {
    writeQwenModel(root)
    const s = new Scanner(memStore(root).store)
    await s.rescan()
    const { key, path } = s.list().models[0]

    void s.rescan() // walks the directory synchronously, so this pass has already seen the file
    await s.delete(key)

    const models = s.list().models
    assert.equal(models.length, 0)
    assert.equal(models.some((m) => m.path === path), false)
  })
})

test('rescans requested during one pass share a single follow-up pass (AC4)', async () => {
  await withLibraryRoot(async (root) => {
    writeQwenModel(root)
    const { store, calls } = memStore(root)
    const s = new Scanner(store)

    void s.rescan()
    await Promise.all([s.rescan(), s.rescan(), s.rescan()])

    // One snapshot() per pass: the first pass plus exactly one shared follow-up.
    assert.equal(calls.snapshot, 2)
    assert.equal(s.list().scanning, false)
  })
})

test('list().scanning is true while a rescan runs and false once it resolves', async () => {
  await withLibraryRoot(async (root) => {
    writeQwenModel(root)
    const s = new Scanner(memStore(root).store)

    const pass = s.rescan()
    assert.equal(s.list().scanning, true)
    await pass

    assert.equal(s.list().scanning, false)
  })
})

test('a failing scan resolves the rescan and logs "model scan failed" exactly once (AC8)', async (t) => {
  await withLibraryRoot(async (root) => {
    const warn = t.mock.method(console, 'warn', () => {})
    const s = new Scanner(memStore(root, { throwOnSnapshot: true }).store)

    await assert.doesNotReject(s.rescan())

    assert.equal(warn.mock.callCount(), 1)
    const message = String(warn.mock.calls[0].arguments[0])
    assert.match(message, /^model scan failed: /)
    assert.match(message, /boom/)
    assert.equal(s.list().scanning, false)
  })
})
