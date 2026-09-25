// KV prompt-cache persistence tests (F-014). The helpers' contract:
//   • slotCacheKey: same opts → same bare filename; any of modelPath/extraArgs/version
//     differing → a different filename (so we never restore a mismatched cache).
//   • cacheEligible: on only when enabled + cachePersist + llama-server + text + parallel 1.
//   • saveSlot: POSTs …/slots/0?action=save; true on ok, false on !ok / throw / timeout.
//   • restoreSlot: POSTs …/slots/0?action=restore; deletes the file + true on ok, false else.
import assert from 'node:assert/strict'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { StartOpts } from './manager'
import { cacheEligible, restoreSlot, saveSlot, slotCacheDir, slotCacheKey, sweepExpired } from './slot-cache'
import type { SlotHttp } from './slot-cache'
import { tmpDir } from '../test-support/tmp'

/** Records the slot POSTs so tests can assert URL + body, returning a scripted response.
 *  `throws` simulates a timeout / unreachable server. */
function fakeHttp(opts: { ok?: boolean; status?: number; throws?: boolean } = {}) {
  const calls: { url: string; init?: { body?: unknown } }[] = []
  const impl: SlotHttp = async (url, init) => {
    calls.push({ url, init: init as { body?: unknown } })
    if (opts.throws) throw new Error('AbortError')
    return { ok: opts.ok ?? true, status: opts.status ?? 200 }
  }
  return { impl, calls }
}

/** Build a StartOpts with overridable fields the key/eligibility logic reads. */
function opts(over: Partial<{
  modelPath: string
  extraArgs: string[]
  version: string
  kind: string
  vision: boolean
}> = {}): StartOpts {
  return {
    engine: {
      id: 'e',
      name: 'llama',
      binPath: '/x',
      kind: over.kind ?? 'llama-server',
      version: over.version ?? '1.0',
      capabilities: { kvTypes: [], flags: [] },
      addedAt: '',
    },
    model: { key: 'm', name: 'm', quant: 'Q4', ctx: 4096, vision: over.vision ?? false },
    modelPath: over.modelPath ?? '/models/m.gguf',
    extraArgs: over.extraArgs ?? [],
  }
}

// ── slotCacheKey ──────────────────────────────────────────────────────────────
test('slotCacheKey is a stable bare slot-<16hex>.bin filename', () => {
  const k = slotCacheKey(opts())
  assert.match(k, /^slot-[0-9a-f]{16}\.bin$/, 'bare name, no path/slashes')
  assert.equal(k, slotCacheKey(opts()), 'same opts → same filename')
})

test('slotCacheKey differs when modelPath, extraArgs, or engine.version differ', () => {
  const base = slotCacheKey(opts())
  assert.notEqual(base, slotCacheKey(opts({ modelPath: '/models/other.gguf' })), 'modelPath invalidates')
  assert.notEqual(base, slotCacheKey(opts({ extraArgs: ['--ctx-size', '8192'] })), 'extraArgs invalidates')
  assert.notEqual(base, slotCacheKey(opts({ version: '2.0' })), 'engine.version invalidates')
})

// ── cacheEligible (incl. parallelIsOne via extraArgs) ─────────────────────────
const ON = { enabled: true, cachePersist: true }

test('cacheEligible is true for the happy path (enabled + persist + llama text + parallel 1)', () => {
  assert.equal(cacheEligible(opts(), ON), true)
  assert.equal(cacheEligible(opts({ extraArgs: ['--parallel', '1'] }), ON), true, "--parallel 1 → ok")
})

test('cacheEligible is false when the feature is off in any way', () => {
  assert.equal(cacheEligible(opts(), { enabled: false, cachePersist: true }), false, 'comfyui disabled')
  assert.equal(cacheEligible(opts(), { enabled: true, cachePersist: false }), false, 'persist opt-out')
})

test('cacheEligible is false for non-llama engines, vision models, and parallel != 1', () => {
  assert.equal(cacheEligible(opts({ kind: 'vllm' }), ON), false, 'vLLM has no cross-restart persistence')
  assert.equal(cacheEligible(opts({ kind: 'mlx' }), ON), false, 'MLX has no cross-restart persistence')
  assert.equal(cacheEligible(opts({ vision: true }), ON), false, 'multimodal save 501s')
  assert.equal(cacheEligible(opts({ extraArgs: ['--parallel', '2'] }), ON), false, 'multi-stream splits the KV')
})

// ── saveSlot ──────────────────────────────────────────────────────────────────
test('saveSlot POSTs the save action with the filename and returns true on ok', async () => {
  const dir = tmpDir('slot-save-')
  try {
    const h = fakeHttp({ ok: true })
    const ok = await saveSlot({
      http: h.impl,
      base: 'http://127.0.0.1:8081',
      dir,
      filename: 'slot-abc.bin',
      capMs: 2500,
      ttlMs: 60_000,
      now: Date.now(),
    })
    assert.equal(ok, true)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url, 'http://127.0.0.1:8081/slots/0?action=save')
    assert.deepEqual(JSON.parse(String(h.calls[0].init?.body)), { filename: 'slot-abc.bin' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveSlot returns false on a non-ok response and on a thrown/timed-out request', async () => {
  const dir = tmpDir('slot-save-')
  try {
    const bad = fakeHttp({ ok: false, status: 501 }) // e.g. multimodal
    assert.equal(
      await saveSlot({ http: bad.impl, base: 'http://x', dir, filename: 'f.bin', capMs: 2500, ttlMs: 60_000, now: Date.now() }),
      false,
      'non-ok → false',
    )
    const thrown = fakeHttp({ throws: true }) // timeout / server down
    assert.equal(
      await saveSlot({ http: thrown.impl, base: 'http://x', dir, filename: 'f.bin', capMs: 2500, ttlMs: 60_000, now: Date.now() }),
      false,
      'throw → false',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── restoreSlot ───────────────────────────────────────────────────────────────
test('restoreSlot POSTs restore, deletes the file, and returns true on ok', async () => {
  const dir = tmpDir('slot-restore-')
  try {
    const file = 'slot-xyz.bin'
    writeFileSync(join(dir, file), 'kv-bytes')
    const h = fakeHttp({ ok: true })
    const ok = await restoreSlot({ http: h.impl, base: 'http://127.0.0.1:8081', dir, filename: file })
    assert.equal(ok, true)
    assert.equal(h.calls[0].url, 'http://127.0.0.1:8081/slots/0?action=restore')
    assert.deepEqual(JSON.parse(String(h.calls[0].init?.body)), { filename: file })
    assert.equal(existsSync(join(dir, file)), false, 'the single-use file is deleted on success')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restoreSlot returns false and keeps the file on a non-ok response', async () => {
  const dir = tmpDir('slot-restore-')
  try {
    const file = 'slot-keep.bin'
    writeFileSync(join(dir, file), 'kv-bytes')
    const h = fakeHttp({ ok: false, status: 400 }) // e.g. config mismatch
    const ok = await restoreSlot({ http: h.impl, base: 'http://x', dir, filename: file })
    assert.equal(ok, false)
    assert.equal(existsSync(join(dir, file)), true, 'a failed restore leaves the file for the TTL sweep')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── sweepExpired ──────────────────────────────────────────────────────────────
test('sweepExpired deletes only slot-*.bin files older than the TTL', () => {
  const dir = tmpDir('slot-sweep-')
  try {
    writeFileSync(join(dir, 'slot-old.bin'), 'x')
    writeFileSync(join(dir, 'slot-new.bin'), 'x')
    writeFileSync(join(dir, 'keep.txt'), 'x') // not a slot file
    const now = Date.now()
    // Treat slot-old.bin as ancient by using a now far in the future relative to a 1ms TTL.
    sweepExpired(dir, 1, now + 10_000)
    assert.equal(existsSync(join(dir, 'slot-old.bin')), false, 'expired slot file pruned')
    assert.equal(existsSync(join(dir, 'slot-new.bin')), false, 'both slot files are past a 1ms TTL → pruned')
    assert.equal(existsSync(join(dir, 'keep.txt')), true, 'non-slot files are never touched')
    // A missing dir is a no-op (best-effort, never throws).
    sweepExpired(join(dir, 'does-not-exist'), 1, now)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── slotCacheDir ──────────────────────────────────────────────────────────────
test('slotCacheDir nests under the data dir (never an arbitrary path)', () => {
  assert.equal(slotCacheDir(join('/data', 'turbollm')), join('/data', 'turbollm', 'slot-cache'))
})
