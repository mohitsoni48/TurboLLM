// Per-engine model profiles (issue #35). Covers:
//   1. the v2→v3 shape migration (flat { modelKey → profile } → nested
//      { modelKey → { '*' → ProfileEntry } }), driven through ConfigStore.load on a real
//      temp file so it exercises migrate() + normalize() exactly as production does,
//   2. that the migration is idempotent (a second load must NOT re-wrap the already
//      nested value), and preserves other v2 data (engines/benchResults/etc.),
//   3. the getModelProfile / setModelProfile / deleteModelProfile semantics — exact-engine
//      match wins, otherwise fall back to whichever engine's profile for the model was
//      saved most recently (there is no fixed "default engine"; mainline llama.cpp and
//      forks like ik_llama.cpp/TurboQuant are indistinguishable in this codebase),
//   4. the real bug scenario: two engine ids for the same model resolve to independent
//      profiles, and a model with no engine-specific profile falls back to the last-used one.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ANY_ENGINE,
  ConfigStore,
  SCHEMA_VERSION,
  defaultConfig,
  deleteModelProfile,
  getModelProfile,
  setModelProfile,
  type Config,
  type ProfileEntry,
} from './config'

/** A minimal but LoadProfile-shaped flat profile — the discriminator only needs a
 *  numeric `ctx` at the top level, but we carry a couple more fields to prove the whole
 *  object is preserved intact under '*'. */
function flatProfile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ctx: 8192, ngl: 99, tunedBy: 'user', ...over }
}

function tmpConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-cfg-'))
  return join(dir, 'config.json')
}

function cleanup(path: string): void {
  rmSync(join(path, '..'), { recursive: true, force: true })
}

test('v2→v3 migration wraps each flat profile into a single "*" entry', () => {
  const path = tmpConfigPath()
  try {
    // A realistic v2 config on disk: modelProfiles is the OLD flat shape.
    const v2 = {
      ...defaultConfig(),
      version: 2,
      modelProfiles: {
        'llama|q4|100': flatProfile({ ctx: 4096 }),
        'qwen|q8|200': flatProfile({ ctx: 16384 }),
      },
    }
    writeFileSync(path, JSON.stringify(v2))

    const store = ConfigStore.load(path)
    const cfg = store.snapshot()

    assert.equal(cfg.version, SCHEMA_VERSION)
    assert.equal(SCHEMA_VERSION, 4)
    // Each old profile is now a single ProfileEntry under '*', value preserved intact.
    const llamaEntry = cfg.modelProfiles['llama|q4|100'][ANY_ENGINE] as ProfileEntry
    assert.deepEqual(llamaEntry.profile, flatProfile({ ctx: 4096 }))
    assert.equal(typeof llamaEntry.updatedAt, 'string')
    const qwenEntry = cfg.modelProfiles['qwen|q8|200'][ANY_ENGINE] as ProfileEntry
    assert.deepEqual(qwenEntry.profile, flatProfile({ ctx: 16384 }))
  } finally {
    cleanup(path)
  }
})

test('v2→v3 migration is idempotent — a second load does not re-wrap', () => {
  const path = tmpConfigPath()
  try {
    const v2 = {
      ...defaultConfig(),
      version: 2,
      modelProfiles: { 'm|q4|1': flatProfile() },
    }
    writeFileSync(path, JSON.stringify(v2))

    // First load migrates + persists.
    ConfigStore.load(path)
    const afterFirst = JSON.parse(readFileSync(path, 'utf8')) as Config
    const firstEntry = afterFirst.modelProfiles['m|q4|1'][ANY_ENGINE] as ProfileEntry
    assert.deepEqual(firstEntry.profile, flatProfile())

    // Second load must see the already-nested value and leave it alone (no re-wrap into
    // { '*': { profile: { profile: …, updatedAt: … }, updatedAt: … } }), and must not
    // stamp a fresh updatedAt over the one written by the first load.
    const store2 = ConfigStore.load(path)
    const cfg2 = store2.snapshot()
    const secondEntry = cfg2.modelProfiles['m|q4|1'][ANY_ENGINE] as ProfileEntry
    assert.deepEqual(secondEntry.profile, flatProfile())
    assert.equal(secondEntry.updatedAt, firstEntry.updatedAt)
  } finally {
    cleanup(path)
  }
})

test('v2→v3 migration preserves other v2 config data (no data loss on version bump)', () => {
  const path = tmpConfigPath()
  try {
    const engineId = '11111111-1111-1111-1111-111111111111'
    const v2 = {
      ...defaultConfig(),
      version: 2,
      engines: [
        {
          id: engineId,
          name: 'llama.cpp',
          binPath: '/opt/llama-server',
          kind: 'llama-server',
          version: 'b1234',
          capabilities: { kvTypes: ['f16', 'q8_0'], flags: [] },
          addedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      activeEngineId: engineId,
      modelDirs: [process.platform === 'win32' ? 'C:\\models' : '/models'],
      benchResults: { 'm|q4|1': { modelKey: 'm|q4|1', tps: 42, ttftMs: 100, vramMb: 8000, params: { ctx: 4096, ngl: 99, nCpuMoe: 0, parallel: 1, kvTypeK: 'f16', flashAttn: 'auto' }, ts: '2026-01-01T00:00:00.000Z' } },
      modelProfiles: { 'm|q4|1': flatProfile() },
    }
    writeFileSync(path, JSON.stringify(v2))

    const cfg = ConfigStore.load(path).snapshot()
    // Engines / active / dirs / benchResults survived the migrate() rebuild.
    assert.equal(cfg.engines.length, 1)
    assert.equal(cfg.engines[0].id, engineId)
    assert.equal(cfg.activeEngineId, engineId)
    assert.equal(cfg.benchResults['m|q4|1']?.tps, 42)
    // Profile migrated in place.
    const entry = cfg.modelProfiles['m|q4|1'][ANY_ENGINE] as ProfileEntry
    assert.deepEqual(entry.profile, flatProfile())
  } finally {
    cleanup(path)
  }
})

test('getModelProfile: exact-engine match wins over any fallback', () => {
  const cfg = defaultConfig()
  const engineA = 'aaaa'
  cfg.modelProfiles = {
    'm|q4|1': {
      [engineA]: { profile: flatProfile({ ctx: 32768 }), updatedAt: '2026-01-01T00:00:00.000Z' },
      [ANY_ENGINE]: { profile: flatProfile({ ctx: 4096 }), updatedAt: '2026-06-01T00:00:00.000Z' },
    },
  }
  // Engine A has its own profile → exact match, even though '*' is the more recent entry.
  assert.equal((getModelProfile(cfg, 'm|q4|1', engineA) as { ctx: number }).ctx, 32768)
  // An engine with no slot → falls back to whichever is most recently updated ('*' here).
  assert.equal((getModelProfile(cfg, 'm|q4|1', 'bbbb') as { ctx: number }).ctx, 4096)
  // Unknown model → undefined.
  assert.equal(getModelProfile(cfg, 'nope|q4|1', engineA), undefined)
})

test('getModelProfile: falls back to whichever engine was saved most recently', () => {
  const cfg = defaultConfig()
  const cuda = 'cuda-engine-id'
  const vulkan = 'vulkan-engine-id'
  cfg.modelProfiles = {
    'm|q4|1': {
      [cuda]: { profile: flatProfile({ ctx: 4096 }), updatedAt: '2026-01-01T00:00:00.000Z' },
      [vulkan]: { profile: flatProfile({ ctx: 16384 }), updatedAt: '2026-06-01T00:00:00.000Z' },
    },
  }
  // A third engine with no slot of its own falls back to vulkan (the more recent save),
  // not cuda, even though cuda appears first in the object.
  const mlx = getModelProfile(cfg, 'm|q4|1', 'mlx-engine-id') as { ctx: number }
  assert.equal(mlx.ctx, 16384)

  // Re-saving cuda AFTER vulkan flips the fallback back to cuda.
  setModelProfile(cfg, 'm|q4|1', cuda, flatProfile({ ctx: 99999 }))
  const mlxAfter = getModelProfile(cfg, 'm|q4|1', 'mlx-engine-id') as { ctx: number }
  assert.equal(mlxAfter.ctx, 99999)
  // cuda's own exact match is unaffected either way.
  assert.equal((getModelProfile(cfg, 'm|q4|1', cuda) as { ctx: number }).ctx, 99999)
  // vulkan's own exact match is untouched by cuda's re-save.
  assert.equal((getModelProfile(cfg, 'm|q4|1', vulkan) as { ctx: number }).ctx, 16384)
})

test('getModelProfile: no entries at all for an unknown engine → undefined', () => {
  const cfg = defaultConfig()
  cfg.modelProfiles = {}
  assert.equal(getModelProfile(cfg, 'm|q4|1', 'aaaa'), undefined)
})

test('setModelProfile writes one engine slot only, leaving other engines untouched', () => {
  const cfg = defaultConfig()
  setModelProfile(cfg, 'm|q4|1', 'aaaa', flatProfile({ ctx: 1024 }))
  setModelProfile(cfg, 'm|q4|1', 'bbbb', flatProfile({ ctx: 2048 }))
  // Two independent slots under the same model.
  assert.equal((cfg.modelProfiles['m|q4|1'].aaaa.profile as { ctx: number }).ctx, 1024)
  assert.equal((cfg.modelProfiles['m|q4|1'].bbbb.profile as { ctx: number }).ctx, 2048)
  // Each write is stamped with a timestamp for the fallback comparison.
  assert.equal(typeof cfg.modelProfiles['m|q4|1'].aaaa.updatedAt, 'string')
  // Overwriting one slot leaves the other alone.
  setModelProfile(cfg, 'm|q4|1', 'aaaa', flatProfile({ ctx: 4096 }))
  assert.equal((cfg.modelProfiles['m|q4|1'].aaaa.profile as { ctx: number }).ctx, 4096)
  assert.equal((cfg.modelProfiles['m|q4|1'].bbbb.profile as { ctx: number }).ctx, 2048)
})

test('deleteModelProfile removes only the target slot, pruning the model when empty', () => {
  const cfg = defaultConfig()
  setModelProfile(cfg, 'm|q4|1', 'aaaa', flatProfile())
  setModelProfile(cfg, 'm|q4|1', 'bbbb', flatProfile())

  deleteModelProfile(cfg, 'm|q4|1', 'aaaa')
  assert.equal(cfg.modelProfiles['m|q4|1'].aaaa, undefined)
  assert.equal(cfg.modelProfiles['m|q4|1'].bbbb !== undefined, true) // sibling survives

  // Removing the last slot prunes the whole model entry (keeps hasProfile checks honest).
  deleteModelProfile(cfg, 'm|q4|1', 'bbbb')
  assert.equal(cfg.modelProfiles['m|q4|1'], undefined)

  // Deleting from an unknown model is a no-op (no throw).
  assert.doesNotThrow(() => deleteModelProfile(cfg, 'gone|q4|1', 'aaaa'))
})

test('bug #35 scenario: two engines for one model keep independent profiles; unknown falls back to the last-used one', () => {
  // Start from a migrated model: a single legacy profile lives under '*'.
  const cfg = defaultConfig()
  cfg.modelProfiles = {
    'm|q4|1': { [ANY_ENGINE]: { profile: flatProfile({ ctx: 8192 }), updatedAt: '2026-01-01T00:00:00.000Z' } },
  }

  const cuda = 'cuda-engine-id'
  const vulkan = 'vulkan-engine-id'

  // Before any per-engine save, BOTH engines resolve the shared legacy profile.
  assert.equal((getModelProfile(cfg, 'm|q4|1', cuda) as { ctx: number }).ctx, 8192)
  assert.equal((getModelProfile(cfg, 'm|q4|1', vulkan) as { ctx: number }).ctx, 8192)

  // Tune the model differently on each engine (vulkan second, so it's the most recent).
  setModelProfile(cfg, 'm|q4|1', cuda, flatProfile({ ctx: 65536 }))
  setModelProfile(cfg, 'm|q4|1', vulkan, flatProfile({ ctx: 16384 }))

  // Now each engine resolves its OWN profile — no cross-contamination (the original bug).
  assert.equal((getModelProfile(cfg, 'm|q4|1', cuda) as { ctx: number }).ctx, 65536)
  assert.equal((getModelProfile(cfg, 'm|q4|1', vulkan) as { ctx: number }).ctx, 16384)
  // A third, untuned engine falls back to whichever was saved most recently (vulkan).
  assert.equal((getModelProfile(cfg, 'm|q4|1', 'mlx-engine-id') as { ctx: number }).ctx, 16384)
})
