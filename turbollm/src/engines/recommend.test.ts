import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recommendEngines } from './recommend'
import { catalogForPlatform, llamaCppVariants } from './catalog'
import type { CatalogEngine, EngineVariant } from './catalog'
import type { HardwareProfile } from './hardware'

/** The whole catalog as plain CatalogEngine[] (drop the per-platform flag the
 *  recommendation endpoint also strips). Lets these tests classify EVERY engine,
 *  including OS-incompatible ones, mirroring the "grey + reason, don't hide" API. */
function fullCatalog(): CatalogEngine[] {
  return catalogForPlatform().map(({ supportedHere, ...e }) => e)
}

// ── Fake hardware ────────────────────────────────────────────────────────────
const nvidiaWin: HardwareProfile = {
  platform: 'win32',
  arch: 'x64',
  gpuVendor: 'nvidia',
  hasGpu: true,
  vramMb: 16384,
  gpuName: 'RTX 5070 Ti',
}
const appleMac: HardwareProfile = {
  platform: 'darwin',
  arch: 'arm64',
  gpuVendor: 'apple',
  hasGpu: true,
  vramMb: 0,
  gpuName: 'Apple M3 Max',
}
const noGpu: HardwareProfile = {
  platform: 'linux',
  arch: 'x64',
  gpuVendor: 'unknown',
  hasGpu: false,
  vramMb: 0,
}

// ── A small, deterministic fake catalog ─────────────────────────────────────
// We mirror the real id 'llama.cpp' but give it inline variants so the test is
// independent of the host's availableBackends(). (A separate test below covers
// the real llamaCppVariants() derivation.) The ranking/bias logic is what we're
// asserting here, and it reads engine.id === 'llama.cpp' → would derive; so we
// use a distinct id for the inline-variant llama-like engine and assert bias via
// speed instead. To still exercise the llama.cpp bias path deterministically, we
// override by using a stub engine whose variants we control.

const v = (over: Partial<EngineVariant> & Pick<EngineVariant, 'id'>): EngineVariant => ({
  label: over.id,
  repo: 'x/y',
  requires: {},
  stability: 'stable',
  hasPrebuilt: true,
  ...over,
})

const fakeLlama: CatalogEngine = {
  id: 'fake-llama',
  name: 'Fake llama',
  kind: 'llama-server',
  description: '',
  provision: 'github-release',
  homepage: '',
  platforms: ['win32', 'darwin', 'linux'],
  support: 'stable',
  installEndpoint: '',
  variants: [
    v({ id: 'l-cuda', requires: { gpuVendor: ['nvidia'], backend: 'cuda' }, speed: 'fast' }),
    v({ id: 'l-metal', requires: { platform: ['darwin'], gpuVendor: ['apple'], backend: 'metal' }, speed: 'fast' }),
    v({ id: 'l-vulkan', requires: { backend: 'vulkan' }, speed: 'baseline' }),
    v({ id: 'l-cpu', requires: { backend: 'cpu' }, speed: 'baseline' }),
  ],
}

const fakeTurbo: CatalogEngine = {
  id: 'turboquant',
  name: 'TurboQuant',
  kind: 'llama-server',
  description: '',
  provision: 'github-release',
  homepage: '',
  platforms: ['darwin'],
  support: 'experimental',
  installEndpoint: '',
  variants: [
    v({
      id: 'turboquant-metal',
      requires: { platform: ['darwin'], gpuVendor: ['apple'] },
      stability: 'experimental',
      speed: 'fast',
    }),
  ],
}

const catalog = [fakeLlama, fakeTurbo]

test('recommendEngines: NVIDIA box picks the cuda variant', () => {
  const rec = recommendEngines(nvidiaWin, catalog)
  assert.deepEqual(rec.recommended, { engineId: 'fake-llama', variantId: 'l-cuda' })
  const turbo = rec.fits.find((f) => f.engine.id === 'turboquant')!
  assert.equal(turbo.compatible.length, 0)
  assert.ok(turbo.incompatibleReason, 'incompatible engine carries a reason')
  assert.match(turbo.incompatibleReason!, /macOS only/)
})

test('recommendEngines: mac recommends a metal variant', () => {
  const rec = recommendEngines(appleMac, catalog)
  assert.ok(rec.recommended, 'mac should have a recommendation')
  // Headline must be a STABLE variant — TurboQuant metal is experimental, so the
  // stable fake-llama metal wins.
  assert.equal(rec.recommended!.engineId, 'fake-llama')
  assert.equal(rec.recommended!.variantId, 'l-metal')
  // TurboQuant is compatible on mac (just not the stable headline).
  const turbo = rec.fits.find((f) => f.engine.id === 'turboquant')!
  assert.equal(turbo.compatible.length, 1)
})

test('recommendEngines: no-GPU box falls back to a cpu/vulkan variant', () => {
  const rec = recommendEngines(noGpu, catalog)
  assert.ok(rec.recommended, 'cpu/vulkan keeps a no-GPU box recommendable')
  assert.equal(rec.recommended!.engineId, 'fake-llama')
  assert.match(rec.recommended!.variantId, /l-(cpu|vulkan)/)
})

test('recommendEngines: every engine fit carries its full variant list', () => {
  const rec = recommendEngines(nvidiaWin, catalog)
  const llama = rec.fits.find((f) => f.engine.id === 'fake-llama')!
  assert.equal(llama.variants.length, 4)
  assert.equal(llama.recommended, true)
})

test('recommendEngines: safe-default bias toward llama.cpp on a speed tie', () => {
  // The real 'llama.cpp' engine derives its variants from the host backend list,
  // which always includes a stable baseline 'cpu' variant. Pit it against a fake
  // engine whose only compatible stable variant is ALSO baseline-speed: a tie.
  // The bias rule must hand the headline to llama.cpp.
  const realLlama: CatalogEngine = {
    id: 'llama.cpp',
    name: 'llama.cpp',
    kind: 'llama-server',
    description: '',
    provision: 'github-release',
    homepage: '',
    platforms: ['win32', 'darwin', 'linux'],
    support: 'stable',
    installEndpoint: '',
  }
  const rival: CatalogEngine = {
    ...fakeLlama,
    id: 'rival',
    variants: [v({ id: 'r-cpu', requires: { backend: 'cpu' }, speed: 'baseline' })],
  }
  // Order rival first so a naive "first wins" would pick rival — the bias must
  // still choose llama.cpp.
  const rec = recommendEngines(noGpu, [rival, realLlama])
  assert.equal(rec.recommended!.engineId, 'llama.cpp')
})

test('recommendEngines: MLX is classified compatible on an Apple-Silicon Mac', () => {
  const rec = recommendEngines(appleMac, fullCatalog())
  const mlx = rec.fits.find((f) => f.engine.id === 'mlx')
  assert.ok(mlx, 'mlx must appear in the fits over the full catalog')
  assert.ok(mlx!.compatible.length > 0, 'mlx is runnable on mac (Apple GPU)')
  assert.equal(mlx!.incompatibleReason, undefined)
})

test('recommendEngines: vLLM is incompatible on Windows/NVIDIA, with a reason', () => {
  const rec = recommendEngines(nvidiaWin, fullCatalog())
  const vllm = rec.fits.find((f) => f.engine.id === 'vllm')
  assert.ok(vllm, 'vllm must appear in the fits over the full catalog')
  assert.equal(vllm!.compatible.length, 0, 'vLLM needs Linux — not runnable on Windows')
  assert.ok(vllm!.incompatibleReason, 'incompatible engine carries a reason (grey + reason, not hide)')
  assert.match(vllm!.incompatibleReason!, /Linux only/)
})

test('recommendEngines: every catalog engine is classified (none left unclassified)', () => {
  // The whole point of Part A: MLX/vLLM now have variants, so the recommender can
  // reason about all four engines (compatible OR incompatible-with-reason).
  const rec = recommendEngines(nvidiaWin, fullCatalog())
  for (const fit of rec.fits) {
    assert.ok(fit.variants.length > 0, `${fit.engine.id} should have variants to classify`)
    const classified = fit.compatible.length > 0 || fit.incompatibleReason !== undefined
    assert.ok(classified, `${fit.engine.id} must be either compatible or carry an incompatibleReason`)
  }
})

test('llamaCppVariants: derives a non-empty, well-formed set from the backend list', () => {
  const vs = llamaCppVariants()
  assert.ok(vs.length > 0)
  for (const variant of vs) {
    assert.ok(variant.id.startsWith('llama.cpp-'))
    assert.equal(variant.repo, 'ggml-org/llama.cpp')
    assert.equal(variant.stability, 'stable')
    assert.equal(variant.hasPrebuilt, true)
    assert.ok(variant.backendId, 'derived variant carries its backendId')
  }
  // Every host ships a cpu variant.
  assert.ok(vs.some((variant) => variant.backendId === 'cpu'))
})
