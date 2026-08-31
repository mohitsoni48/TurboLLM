// Generation control tests (v0.4.0): sampling startup flags, context overflow,
// rope scaling, frequency_penalty, stop strings.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultSampling, deriveDefault, estimateVram, profileToArgs, resolveProfile } from './profile'
import type { LoadProfile } from './profile'
import type { ModelEntry } from './scanner'
import type { SysInfo } from '../sysinfo/sysinfo'

function model(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key: 'm|q4|1', name: 'm', path: '/models/m.gguf', dir: '/models', format: 'gguf',
    sizeBytes: 8_000_000_000, sizeLabel: '8 GB', arch: 'llama', quant: 'Q4_K_M',
    nativeCtx: 32768, blockCount: 32, headCountKv: 8, headDim: 0, moe: false, expertCount: 0,
    nextnLayers: 0, vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, reasoningEffort: false, embedding: false,
    incomplete: false, parseError: null, loaded: false, hasProfile: false,
    benchTps: null, mtime: '', ...over,
  }
}

function sys(gpus: Array<{ vramMb: number }> = [{ vramMb: 16000 }]): SysInfo {
  return {
    os: 'linux/x64', cpu: 'test', cores: 8, ramMB: 32000,
    gpus: gpus.map((g, i) => ({ name: `gpu${i}`, vramMb: g.vramMb, vendor: 'nvidia' as const })),
  }
}

const caps = { kvTypes: [], flags: [] } // empty = all flags allowed (graceful-degrade)

function base(): LoadProfile {
  return deriveDefault(model(), sys())
}

// ── Sampling flags ────────────────────────────────────────────────────────────

test('default sampling emits no sampling flags (engine defaults match)', () => {
  const args = profileToArgs(base(), model(), caps)
  for (const flag of ['--temp', '--top-p', '--top-k', '--min-p', '--repeat-penalty', '--presence-penalty', '--frequency-penalty']) {
    assert.equal(args.includes(flag), false, `${flag} should not appear for default value`)
  }
})

test('non-default temp is emitted', () => {
  const p = { ...base(), sampling: { ...defaultSampling(), temp: 0.5 } }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args[args.indexOf('--temp') + 1], '0.5')
})

test('non-default top-p, top-k, min-p are emitted', () => {
  const p = { ...base(), sampling: { ...defaultSampling(), topP: 0.9, topK: 20, minP: 0.02 } }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args[args.indexOf('--top-p') + 1], '0.9')
  assert.equal(args[args.indexOf('--top-k') + 1], '20')
  assert.equal(args[args.indexOf('--min-p') + 1], '0.02')
})

test('non-default repeat/presence/frequency penalties are emitted', () => {
  const p = { ...base(), sampling: { ...defaultSampling(), repeatPenalty: 1.2, presencePenalty: 0.5, frequencyPenalty: 0.3 } }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args[args.indexOf('--repeat-penalty') + 1], '1.2')
  assert.equal(args[args.indexOf('--presence-penalty') + 1], '0.5')
  assert.equal(args[args.indexOf('--frequency-penalty') + 1], '0.3')
})

test('sampling flags are gated by engine capability', () => {
  const limited = { kvTypes: [], flags: ['-ngl', '--parallel'] }
  const p = { ...base(), sampling: { ...defaultSampling(), temp: 0.3, frequencyPenalty: 0.5 } }
  const args = profileToArgs(p, model(), limited)
  assert.equal(args.includes('--temp'), false)
  assert.equal(args.includes('--frequency-penalty'), false)
})

test('non-f16 KV cache type is gated by engine kvTypes (turbo3 must not leak to llamafile)', () => {
  const flags = ['--cache-type-k', '--cache-type-v']
  const p = { ...base(), kvTypeK: 'turbo3', kvTypeV: 'turbo3' }
  // Engine has the FLAG but not the VALUE (standard llama.cpp / llamafile) → skip (else it crashes).
  const noTurbo = profileToArgs(p, model(), { kvTypes: ['f16', 'q8_0'], flags })
  assert.equal(noTurbo.includes('--cache-type-k'), false)
  assert.equal(noTurbo.includes('--cache-type-v'), false)
  // Engine supports the value (TurboQuant) → emitted.
  const turbo = profileToArgs(p, model(), { kvTypes: ['f16', 'turbo2', 'turbo3', 'turbo4'], flags })
  assert.equal(turbo[turbo.indexOf('--cache-type-k') + 1], 'turbo3')
  assert.equal(turbo[turbo.indexOf('--cache-type-v') + 1], 'turbo3')
})

test('stop strings do not appear in profileToArgs (they are per-request only)', () => {
  const p = { ...base(), sampling: { ...defaultSampling(), stop: ['</s>', '<|im_end|>'] } }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args.includes('--stop'), false)
  assert.equal(args.some((a) => a.includes('</s>')), false)
})

// ── KV cache offload (GPU vs RAM) ─────────────────────────────────────────────

test('kvOffload default (true) emits no --no-kv-offload', () => {
  const p = base()
  assert.equal(p.kvOffload, true)
  assert.equal(profileToArgs(p, model(), caps).includes('--no-kv-offload'), false)
})

test('kvOffload false emits --no-kv-offload (KV cache in RAM)', () => {
  const p = { ...base(), kvOffload: false }
  assert.equal(profileToArgs(p, model(), caps).includes('--no-kv-offload'), true)
})

test('--no-kv-offload gated by engine capability', () => {
  const limited = { kvTypes: [], flags: ['-ngl', '--parallel'] }
  const p = { ...base(), kvOffload: false }
  assert.equal(profileToArgs(p, model(), limited).includes('--no-kv-offload'), false)
})

test('kvOffload false excludes the KV cache from the VRAM estimate', () => {
  const m = model()
  const s = sys()
  const onGpu = estimateVram({ ...base(), kvOffload: true }, m, s)
  const inRam = estimateVram({ ...base(), kvOffload: false }, m, s)
  assert.ok(inRam.estMb < onGpu.estMb, 'KV in RAM should lower the GPU estimate')
})

// ── Real per-head dim + mmproj sizing (regression: both were flat guesses that
// systematically underestimated VRAM for GQA/MQA models and vision models) ────────────

test('a declared headDim (GQA/MQA real dim) scales the KV estimate — not the flat HEAD_DIM constant', () => {
  const s = sys()
  // Same model, only headDim differs: 256 is exactly 2x the 128 fallback, so the KV-cache
  // TERM must double (~1074 MB more at this test model's ctx/blocks/heads) — weights (8000
  // MB, dominates the total) and the flat overhead are unaffected, so assert the DELTA, not
  // the ratio of the full totals. Before this fix, headDim was ignored entirely: this delta
  // would have been exactly 0.
  const withKnownHeadDim = estimateVram(base(), model({ headDim: 256 }), s)
  const withFallbackHeadDim = estimateVram(base(), model({ headDim: 0 }), s)
  const delta = withKnownHeadDim.estMb - withFallbackHeadDim.estMb
  assert.ok(
    delta > 900,
    `headDim:256 should add ~1074 MB of extra KV over the headDim:0 (128-fallback) estimate — got a delta of ${delta} (${withFallbackHeadDim.estMb} -> ${withKnownHeadDim.estMb})`,
  )
})

test('mmproj VRAM scales with the real mmproj file size, not a flat constant', () => {
  const s = sys()
  const p = { ...base(), useMmproj: true, mmprojGpu: true }
  const smallProjector = estimateVram(p, model({ mmprojPath: '/models/mmproj.gguf', mmprojSizeBytes: 200_000_000 }), s)
  const largeProjector = estimateVram(p, model({ mmprojPath: '/models/mmproj.gguf', mmprojSizeBytes: 1_800_000_000 }), s)
  assert.ok(
    largeProjector.estMb - smallProjector.estMb > 1_400,
    `a ~1.6 GB larger mmproj file should add roughly that much to the estimate — got ${largeProjector.estMb} vs ${smallProjector.estMb}`,
  )
})

// ── Context overflow ──────────────────────────────────────────────────────────

test("contextOverflow 'shift' (default) emits no extra flags", () => {
  const p = base() // default is 'shift'
  assert.equal(p.contextOverflow, 'shift')
  const args = profileToArgs(p, model(), caps)
  assert.equal(args.includes('--n-keep'), false)
})

test("contextOverflow 'keep' with nKeep > 0 emits --n-keep", () => {
  const p = { ...base(), contextOverflow: 'keep' as const, nKeep: 512 }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args[args.indexOf('--n-keep') + 1], '512')
})

test("contextOverflow 'keep' with nKeep = 0 emits no flag", () => {
  const p = { ...base(), contextOverflow: 'keep' as const, nKeep: 0 }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args.includes('--n-keep'), false)
})

test('--n-keep is gated by engine capability', () => {
  const limited = { kvTypes: [], flags: ['-ngl', '--parallel'] }
  const p = { ...base(), contextOverflow: 'keep' as const, nKeep: 256 }
  assert.equal(profileToArgs(p, model(), limited).includes('--n-keep'), false)
})

// ── Rope scaling ──────────────────────────────────────────────────────────────

test("ropeScalingType 'none' (default) emits no rope flags", () => {
  const p = base()
  assert.equal(p.ropeScalingType, 'none')
  const args = profileToArgs(p, model(), caps)
  assert.equal(args.includes('--rope-scaling'), false)
})

test("ropeScalingType 'linear' emits --rope-scaling linear", () => {
  const p = { ...base(), ropeScalingType: 'linear' as const }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args[args.indexOf('--rope-scaling') + 1], 'linear')
})

test('ropeFreqBase and ropeFreqScale emitted when non-zero', () => {
  const p = { ...base(), ropeScalingType: 'yarn' as const, ropeFreqBase: 500000, ropeFreqScale: 0.25 }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args[args.indexOf('--rope-scaling') + 1], 'yarn')
  assert.equal(args[args.indexOf('--rope-freq-base') + 1], '500000')
  assert.equal(args[args.indexOf('--rope-freq-scale') + 1], '0.25')
})

test('ropeFreqBase = 0 is not emitted (model native)', () => {
  const p = { ...base(), ropeScalingType: 'linear' as const, ropeFreqBase: 0, ropeFreqScale: 0 }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args.includes('--rope-freq-base'), false)
  assert.equal(args.includes('--rope-freq-scale'), false)
})

test('rope flags gated by engine capability', () => {
  const limited = { kvTypes: [], flags: ['-ngl', '--parallel'] }
  const p = { ...base(), ropeScalingType: 'yarn' as const, ropeFreqBase: 100000, ropeFreqScale: 0.5 }
  assert.equal(profileToArgs(p, model(), limited).includes('--rope-scaling'), false)
})

// ── resolveProfile / defaults ─────────────────────────────────────────────────

test('defaultSampling includes frequencyPenalty and stop', () => {
  const s = defaultSampling()
  assert.equal(s.frequencyPenalty, 0.0)
  assert.deepEqual(s.stop, [])
})

test('deriveDefault sets contextOverflow shift and ropeScalingType none', () => {
  const p = deriveDefault(model(), sys())
  assert.equal(p.contextOverflow, 'shift')
  assert.equal(p.nKeep, 0)
  assert.equal(p.ropeScalingType, 'none')
  assert.equal(p.ropeFreqBase, 0)
  assert.equal(p.ropeFreqScale, 0)
})

test('resolveProfile deep-merges stop strings (override replaces, not appends)', () => {
  const m = model()
  const s = sys()
  const resolved = resolveProfile(m, s, { sampling: { ...defaultSampling(), stop: ['A'] } }, { sampling: { ...defaultSampling(), stop: ['B', 'C'] } })
  assert.deepEqual(resolved.sampling.stop, ['B', 'C'])
})

test('resolveProfile carries contextOverflow and rope from saved profile', () => {
  const m = model()
  const s = sys()
  const saved: Partial<LoadProfile> = { contextOverflow: 'keep', nKeep: 128, ropeScalingType: 'linear', ropeFreqBase: 500000, ropeFreqScale: 0.5 }
  const resolved = resolveProfile(m, s, saved)
  assert.equal(resolved.contextOverflow, 'keep')
  assert.equal(resolved.nKeep, 128)
  assert.equal(resolved.ropeScalingType, 'linear')
  assert.equal(resolved.ropeFreqBase, 500000)
  assert.equal(resolved.ropeFreqScale, 0.5)
})

// ── Embedding + grammar (v0.7.0) ──────────────────────────────────────────────

test('--embeddings flag emitted for embedding models', () => {
  const args = profileToArgs(base(), model({ embedding: true }), caps)
  assert.ok(args.includes('--embeddings'), '--embeddings should appear for embedding models')
})

test('--embeddings not emitted for chat models', () => {
  const args = profileToArgs(base(), model({ embedding: false }), caps)
  assert.equal(args.includes('--embeddings'), false)
})

test('--embeddings gated by engine capability', () => {
  const capNoEmbed = { kvTypes: [], flags: ['--some-other-flag'] }
  const args = profileToArgs(base(), model({ embedding: true }), capNoEmbed)
  assert.equal(args.includes('--embeddings'), false)
})

test('--grammar emitted when grammar is set', () => {
  const p = { ...base(), grammar: 'root ::= [a-z]+' }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args[args.indexOf('--grammar') + 1], 'root ::= [a-z]+')
})

test('--grammar not emitted when grammar is empty', () => {
  const p = { ...base(), grammar: '' }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args.includes('--grammar'), false)
})

test('--grammar gated by engine capability', () => {
  const capNoGrammar = { kvTypes: [], flags: ['--some-other-flag'] }
  const p = { ...base(), grammar: 'root ::= [a-z]+' }
  const args = profileToArgs(p, model(), capNoGrammar)
  assert.equal(args.includes('--grammar'), false)
})

test('deriveDefault grammar is empty string', () => {
  assert.equal(deriveDefault(model(), sys()).grammar, '')
})

// ── Speculative draft window (GitHub #35) ──────────────────────────────────────

test('draft mode defaults to --draft-max 16 --draft-min 1 when unset', () => {
  const p = { ...base(), speculative: 'draft' as const, draftModelPath: '/models/draft.gguf' }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args[args.indexOf('--draft-max') + 1], '16')
  assert.equal(args[args.indexOf('--draft-min') + 1], '1')
})

test('draft mode honors user draftMax/draftMin overrides', () => {
  const p = { ...base(), speculative: 'draft' as const, draftModelPath: '/models/draft.gguf', draftMax: 8, draftMin: 2 }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args[args.indexOf('--draft-max') + 1], '8')
  assert.equal(args[args.indexOf('--draft-min') + 1], '2')
})

test('draftMin 0 is emitted (not treated as unset)', () => {
  const p = { ...base(), speculative: 'draft' as const, draftModelPath: '/models/draft.gguf', draftMin: 0 }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args[args.indexOf('--draft-min') + 1], '0')
})

test('dflash mode emits --spec-type draft-dflash and --spec-draft-model', () => {
  const p = { ...base(), speculative: 'dflash' as const, draftModelPath: '/models/draft-dflash.gguf' }
  const args = profileToArgs(p, model(), caps)
  assert.equal(args[args.indexOf('--spec-type') + 1], 'draft-dflash')
  assert.equal(args[args.indexOf('--spec-draft-model') + 1], '/models/draft-dflash.gguf')
  assert.equal(args[args.indexOf('--draft-max') + 1], '16')
  assert.equal(args[args.indexOf('--draft-min') + 1], '1')
})

// Regression: dflash must be gated on the engine actually reporting spec-type:draft-dflash
// support (probed capability), same as every other speculative mode — an engine that only
// supports e.g. draft-simple must not silently get a --spec-type it will reject at launch.
test('dflash mode is gated on the engine accepting spec-type:draft-dflash', () => {
  const capNoDflash = { kvTypes: [], flags: ['--spec-type', '--spec-draft-model', 'spec-type:draft-simple'] }
  const p = { ...base(), speculative: 'dflash' as const, draftModelPath: '/models/draft-dflash.gguf' }
  const args = profileToArgs(p, model(), capNoDflash)
  assert.ok(!args.includes('--spec-draft-model'), '--spec-draft-model must not be passed when the engine lacks draft-dflash support')
})

// Regression: the draft window is a property of the speculation mechanism itself
// (llama.cpp's shared verify loop), not specific to how the draft is produced — it must
// apply to 'mtp' and 'nextn' modes too, not only the external-draft-model 'draft' mode
// (this was the actual GitHub #35 ask — "MTP control ... min and max MTP drafts").
test('mtp mode also honors draftMax/draftMin, not just draft mode', () => {
  const p = { ...base(), speculative: 'mtp' as const, mtpHeadPath: '/models/gemma4-mtp.gguf', draftMax: 4, draftMin: 0 }
  const args = profileToArgs(p, model(), caps)
  assert.ok(args.includes('--mtp-head'))
  assert.equal(args[args.indexOf('--draft-max') + 1], '4')
  assert.equal(args[args.indexOf('--draft-min') + 1], '0')
})

test('nextn mode also honors draftMax/draftMin, defaults to 16/1 when unset', () => {
  const p = { ...base(), speculative: 'nextn' as const, draftMax: 6 }
  const args = profileToArgs(p, model({ nextnLayers: 1 }), caps)
  assert.equal(args[args.indexOf('--draft-max') + 1], '6')
  assert.equal(args[args.indexOf('--draft-min') + 1], '1')
})

// Regression: mainline llama.cpp's native NextN/MTP (--spec-type draft-mtp) uses the
// model's own built-in head — it takes ONLY --spec-type, no --model-draft. Passing
// --model-draft pointing at the SAME GGUF (the previous unconditional behavior) makes
// llama.cpp load a full second copy of the model into RAM — measured +35GB RAM on a
// 35B MoE model for a 54% SLOWER generation, with no error printed at all.
test('nextn mode on mainline (spec-type:draft-mtp only) omits --model-draft', () => {
  const capMainline = { kvTypes: [], flags: ['--spec-type', '--model-draft', 'spec-type:draft-mtp'] }
  const p = { ...base(), speculative: 'nextn' as const }
  const args = profileToArgs(p, model({ nextnLayers: 1 }), capMainline)
  assert.ok(args.includes('--spec-type'))
  assert.equal(args[args.indexOf('--spec-type') + 1], 'draft-mtp')
  assert.ok(!args.includes('--model-draft'), '--model-draft must not be passed for mainline draft-mtp')
})

// The TurboQuant fork's own `nextn` spec-type value is a different codebase that DOES
// want --model-draft pointing at the same file — only mainline's draft-mtp is exempted.
test('nextn mode on the TurboQuant fork (spec-type:nextn) still includes --model-draft', () => {
  const capFork = { kvTypes: [], flags: ['--spec-type', '--model-draft', 'spec-type:nextn'] }
  const p = { ...base(), speculative: 'nextn' as const }
  const m = model({ nextnLayers: 1 })
  const args = profileToArgs(p, m, capFork)
  assert.equal(args[args.indexOf('--spec-type') + 1], 'nextn')
  assert.equal(args[args.indexOf('--model-draft') + 1], m.path)
})

test('off mode emits no draft-max/draft-min flags', () => {
  const p = { ...base(), speculative: 'off' as const, draftMax: 4, draftMin: 0 }
  const args = profileToArgs(p, model(), caps)
  assert.ok(!args.includes('--draft-max'))
  assert.ok(!args.includes('--draft-min'))
})

// Regression: llama.cpp removed --draft-max/--draft-min in favor of
// --spec-draft-n-max/--spec-draft-n-min (GitHub #43). A probe that correctly
// reports the old names as unsupported must fall back to the new ones instead
// of silently dropping draft-window control.
test('falls back to --spec-draft-n-max/--spec-draft-n-min when the engine only supports the new names', () => {
  const capNewOnly = { kvTypes: [], flags: ['--mtp-head', '--spec-draft-n-max', '--spec-draft-n-min'] }
  const p = { ...base(), speculative: 'mtp' as const, mtpHeadPath: '/models/gemma4-mtp.gguf', draftMax: 8, draftMin: 2 }
  const args = profileToArgs(p, model(), capNewOnly)
  assert.ok(!args.includes('--draft-max'))
  assert.ok(!args.includes('--draft-min'))
  assert.equal(args[args.indexOf('--spec-draft-n-max') + 1], '8')
  assert.equal(args[args.indexOf('--spec-draft-n-min') + 1], '2')
})

test('prefers --draft-max/--draft-min when the engine reports both old and new names', () => {
  const capBoth = { kvTypes: [], flags: ['--mtp-head', '--draft-max', '--draft-min', '--spec-draft-n-max', '--spec-draft-n-min'] }
  const p = { ...base(), speculative: 'mtp' as const, mtpHeadPath: '/models/gemma4-mtp.gguf', draftMax: 8, draftMin: 2 }
  const args = profileToArgs(p, model(), capBoth)
  assert.equal(args[args.indexOf('--draft-max') + 1], '8')
  assert.equal(args[args.indexOf('--draft-min') + 1], '2')
  assert.ok(!args.includes('--spec-draft-n-max'))
  assert.ok(!args.includes('--spec-draft-n-min'))
})

// ── GitHub #85 / ADR-324: --no-mmap on ROCm + AMD unified-memory APU for large models ──

const ROCM_BIN = '/home/u/.turbollm/engines/llama.cpp-b9608-rocm/llama-server'
const VULKAN_BIN = '/home/u/.turbollm/engines/llama.cpp-b9608-vulkan/llama-server'
const CUSTOM_BIN = '/home/u/my-own-build/llama-server' // not a managed install dir

function amdApuSys(): SysInfo {
  return {
    os: 'linux/x64', cpu: 'test', cores: 16, ramMB: 131072,
    gpus: [{ name: 'AMD Radeon Graphics', vramMb: 120000, vendor: 'amd', unified: true }],
  }
}

const bigModel = () => model({ sizeBytes: 40_000_000_000 }) // 40GB, above the 30GB gate
const smallModel = () => model({ sizeBytes: 20_000_000_000 }) // 20GB, below the 30GB gate

test('emits --no-mmap for a large model on ROCm + AMD unified APU', () => {
  const args = profileToArgs(base(), bigModel(), caps, 0, amdApuSys(), ROCM_BIN)
  assert.ok(args.includes('--no-mmap'))
})

test('does not emit --no-mmap below the 30GB threshold', () => {
  const args = profileToArgs(base(), smallModel(), caps, 0, amdApuSys(), ROCM_BIN)
  assert.equal(args.includes('--no-mmap'), false)
})

test('does not emit --no-mmap on a non-unified (discrete) AMD GPU', () => {
  const discreteAmd: SysInfo = {
    os: 'linux/x64', cpu: 'test', cores: 16, ramMB: 32000,
    gpus: [{ name: 'Radeon RX 7900', vramMb: 24000, vendor: 'amd', unified: false }],
  }
  const args = profileToArgs(base(), bigModel(), caps, 0, discreteAmd, ROCM_BIN)
  assert.equal(args.includes('--no-mmap'), false)
})

test('does not emit --no-mmap on non-AMD unified memory (e.g. Apple)', () => {
  const appleUnified: SysInfo = {
    os: 'darwin/arm64', cpu: 'test', cores: 12, ramMB: 65536,
    gpus: [{ name: 'Apple M-series', vramMb: 65536, vendor: 'apple', unified: true }],
  }
  const args = profileToArgs(base(), bigModel(), caps, 0, appleUnified, ROCM_BIN)
  assert.equal(args.includes('--no-mmap'), false)
})

test('does not emit --no-mmap on the Vulkan build of the same hardware', () => {
  const args = profileToArgs(base(), bigModel(), caps, 0, amdApuSys(), VULKAN_BIN)
  assert.equal(args.includes('--no-mmap'), false)
})

test('does not emit --no-mmap for a custom (non-managed) engine build — backend unknown', () => {
  const args = profileToArgs(base(), bigModel(), caps, 0, amdApuSys(), CUSTOM_BIN)
  assert.equal(args.includes('--no-mmap'), false)
})

test('does not emit --no-mmap when sys/binPath are omitted (existing callers keep working)', () => {
  const args = profileToArgs(base(), bigModel(), caps)
  assert.equal(args.includes('--no-mmap'), false)
})

test('is gated by engine capability like every other flag', () => {
  const noNoMmap = { kvTypes: [], flags: ['-c', '--parallel'] } // --no-mmap not advertised
  const args = profileToArgs(base(), bigModel(), noNoMmap, 0, amdApuSys(), ROCM_BIN)
  assert.equal(args.includes('--no-mmap'), false)
})

test('does not duplicate --no-mmap when the user already added it manually', () => {
  const p = { ...base(), extraArgs: ['--no-mmap'] }
  const args = profileToArgs(p, bigModel(), caps, 0, amdApuSys(), ROCM_BIN)
  assert.equal(args.filter((a) => a === '--no-mmap').length, 1)
})

test('does not auto-add --no-mmap when the user already added -dio manually', () => {
  const p = { ...base(), extraArgs: ['-dio'] }
  const args = profileToArgs(p, bigModel(), caps, 0, amdApuSys(), ROCM_BIN)
  assert.equal(args.includes('--no-mmap'), false)
  assert.ok(args.includes('-dio'))
})
