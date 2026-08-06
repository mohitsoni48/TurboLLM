import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveDefault, profileToArgs } from './profile'
import type { ModelEntry } from './scanner'
import type { SysInfo } from '../sysinfo/sysinfo'
import type { Capabilities } from '../config/config'

const sys: SysInfo = {
  os: 'win32/x64',
  cpu: 'Test CPU',
  cores: 16,
  ramMB: 65536,
  gpus: [{ name: 'Test GPU', vramMb: 16000, vendor: 'nvidia' }],
}

const denseModel: ModelEntry = {
  key: 'dense-test', name: 'Dense Test', path: 'x.gguf', dir: '.', format: 'gguf',
  sizeBytes: 1e9, sizeLabel: '1B', arch: 'llama', quant: 'Q4_K_M', nativeCtx: 8192,
  blockCount: 32, headCountKv: 8, headDim: 0, moe: false, expertCount: 0, nextnLayers: 0,
  vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, embedding: false,
  incomplete: false, parseError: null, loaded: false, hasProfile: false,
  benchTps: null, mtime: '',
}

const moeModel: ModelEntry = { ...denseModel, key: 'moe-test', name: 'MoE Test', moe: true, expertCount: 8 }

// Empty flags/kvTypes = unprobed → `has()` and `kvOk()` in profileToArgs graceful-degrade to
// "allow" (see profile.ts comments), so every flag under test is actually emitted when expected.
const caps: Capabilities = { kvTypes: [], flags: [] }

test('profileToArgs: emits -ngl by default', () => {
  const p = { ...deriveDefault(denseModel, sys), ngl: 20 }
  const args = profileToArgs(p, denseModel, caps)
  assert.deepEqual(args.slice(args.indexOf('-ngl'), args.indexOf('-ngl') + 2), ['-ngl', '20'])
})

test('profileToArgs: nglFit omits -ngl entirely, regardless of the stale ngl value', () => {
  const p = { ...deriveDefault(denseModel, sys), ngl: 20, nglFit: true }
  const args = profileToArgs(p, denseModel, caps)
  assert.equal(args.includes('-ngl'), false)
})

test('profileToArgs: nglFit false/absent keeps emitting -ngl (backward compat)', () => {
  const p = { ...deriveDefault(denseModel, sys), ngl: 99 }
  const args = profileToArgs(p, denseModel, caps)
  assert.equal(args.includes('-ngl'), true)
})

test('profileToArgs: emits --n-cpu-moe by default on an MoE model', () => {
  const p = { ...deriveDefault(moeModel, sys), nCpuMoe: 4 }
  const args = profileToArgs(p, moeModel, caps)
  assert.deepEqual(args.slice(args.indexOf('--n-cpu-moe'), args.indexOf('--n-cpu-moe') + 2), ['--n-cpu-moe', '4'])
})

test('profileToArgs: still emits --n-cpu-moe 0 explicitly, not just omits it (BeeLlama fit-abort regression)', () => {
  // Omitting --n-cpu-moe at nCpuMoe=0 used to be treated as equivalent to passing 0, since
  // mainline llama.cpp defaults to zero MoE CPU-offload anyway. But -ngl is ALWAYS emitted
  // alongside it (see the -ngl block above), and BeeLlama.cpp's fork runs its own implicit
  // fit-placement pass whenever --n-cpu-moe is absent — which then aborts because -ngl is
  // already pinned ("n_gpu_layers already set by user to N, abort", live-reproduced 2026-08-06)
  // and falls through to loading every expert on GPU with no real offload, silently spilling to
  // system RAM. Auto-tune's own nCpuMoe=0 search candidate hit this exact path. Passing
  // --n-cpu-moe 0 explicitly (like every other tested value) avoids the ambiguity outright.
  const p = { ...deriveDefault(moeModel, sys), ngl: 99, nCpuMoe: 0 }
  const args = profileToArgs(p, moeModel, caps)
  assert.deepEqual(args.slice(args.indexOf('--n-cpu-moe'), args.indexOf('--n-cpu-moe') + 2), ['--n-cpu-moe', '0'])
})

test('profileToArgs: nCpuMoeFit omits --n-cpu-moe entirely, regardless of the stale value', () => {
  const p = { ...deriveDefault(moeModel, sys), nCpuMoe: 4, nCpuMoeFit: true }
  const args = profileToArgs(p, moeModel, caps)
  assert.equal(args.includes('--n-cpu-moe'), false)
})

test('profileToArgs: nCpuMoeFit on a MoE model ALSO omits -ngl (2026-08-03 OOM fix)', () => {
  // llama.cpp's own -fit (fit.cpp `common_params_fit_params`) throws the instant -ngl is
  // explicit, before it ever reaches the MoE tensor-placement step — leaving -ngl in place
  // while only omitting --n-cpu-moe doesn't get a partial fit, it gets NO fit at all, and the
  // engine falls through to loading -ngl layers (every expert included) with zero MoE offload.
  const p = { ...deriveDefault(moeModel, sys), ngl: 43, nCpuMoe: 4, nCpuMoeFit: true }
  const args = profileToArgs(p, moeModel, caps)
  assert.equal(args.includes('-ngl'), false)
  assert.equal(args.includes('--n-cpu-moe'), false)
})

test('profileToArgs: nCpuMoeFit false/absent on a MoE model keeps emitting -ngl (backward compat)', () => {
  const p = { ...deriveDefault(moeModel, sys), ngl: 43, nCpuMoe: 4 }
  const args = profileToArgs(p, moeModel, caps)
  assert.deepEqual(args.slice(args.indexOf('-ngl'), args.indexOf('-ngl') + 2), ['-ngl', '43'])
})

test('profileToArgs: --n-cpu-moe never emitted for a non-MoE model even without nCpuMoeFit', () => {
  const p = { ...deriveDefault(denseModel, sys), nCpuMoe: 4 }
  const args = profileToArgs(p, denseModel, caps)
  assert.equal(args.includes('--n-cpu-moe'), false)
})

test('profileToArgs: nglFit is ignored for MoE models — -ngl still emitted (pre-release review, Finding D)', () => {
  // The UI hides "Auto-fit GPU layers" and force-shows the slider for MoE models (nCpuMoeFit
  // is the real MoE offload control there); a stray nglFit:true on a MoE profile must not
  // silently turn that still-visible slider into a no-op.
  const p = { ...deriveDefault(moeModel, sys), ngl: 20, nglFit: true }
  const args = profileToArgs(p, moeModel, caps)
  assert.deepEqual(args.slice(args.indexOf('-ngl'), args.indexOf('-ngl') + 2), ['-ngl', '20'])
})
