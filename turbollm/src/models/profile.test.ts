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

const cpuOnly: SysInfo = { ...sys, gpus: [] }

const denseModel: ModelEntry = {
  key: 'dense-test', name: 'Dense Test', path: 'x.gguf', dir: '.', format: 'gguf',
  sizeBytes: 1e9, sizeLabel: '1B', arch: 'llama', quant: 'Q4_K_M', nativeCtx: 8192,
  blockCount: 32, headCountKv: 8, headDim: 0, moe: false, expertCount: 0, nextnLayers: 0,
  vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, reasoningEffort: false, embedding: false,
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

test('profileToArgs: still emits --n-cpu-moe 0 explicitly when -ngl is also explicit, not just omits it (BeeLlama fit-abort regression)', () => {
  // Omitting --n-cpu-moe at nCpuMoe=0 used to be treated as equivalent to passing 0, since
  // mainline llama.cpp defaults to zero MoE CPU-offload anyway. But whenever -ngl is ALSO
  // explicit (p.ngl > 0, same gate as the -ngl push itself), BeeLlama.cpp's fork runs its own
  // implicit fit-placement pass whenever --n-cpu-moe is absent — which then aborts because -ngl
  // is already pinned ("n_gpu_layers already set by user to N, abort", live-reproduced
  // 2026-08-06) and falls through to loading every expert on GPU with no real offload, silently
  // spilling to system RAM. Auto-tune's own nCpuMoe=0 search candidate hit this exact path.
  // Passing --n-cpu-moe 0 explicitly (like every other tested value) avoids the ambiguity
  // outright.
  const p = { ...deriveDefault(moeModel, sys), ngl: 99, nCpuMoe: 0 }
  const args = profileToArgs(p, moeModel, caps)
  assert.deepEqual(args.slice(args.indexOf('--n-cpu-moe'), args.indexOf('--n-cpu-moe') + 2), ['--n-cpu-moe', '0'])
})

test('profileToArgs: nCpuMoe=0 stays omitted when ngl=0 on a box with no detected GPU — no -ngl to collide with', () => {
  // With no detected GPU, ngl=0 is deriveDefault's placeholder and -ngl itself stays absent (the
  // engine's own default), so there's no explicit -ngl on the command line for an absent
  // --n-cpu-moe to collide with — forcing --n-cpu-moe 0 here would needlessly suppress a fit pass
  // that runs cleanly on its own.
  const p = { ...deriveDefault(moeModel, cpuOnly), ngl: 0, nCpuMoe: 0 }
  const args = profileToArgs(p, moeModel, caps, 16, cpuOnly)
  assert.equal(args.includes('-ngl'), false)
  assert.equal(args.includes('--n-cpu-moe'), false)
})

test('profileToArgs: ngl=0 on a GPU box emits an explicit -ngl 0 — an absent -ngl means "auto" (GPU) to llama.cpp', () => {
  // Current llama.cpp defaults n_gpu_layers to -1 ("auto") with -fit on, so omitting -ngl
  // auto-fits the model onto the GPU: a user who set GPU layers to 0 (to keep the model's weights
  // and KV cache off the GPU) got a GPU load while the UI said "0 layers".
  const dense = profileToArgs({ ...deriveDefault(denseModel, sys), ngl: 0 }, denseModel, caps, 16, sys)
  assert.deepEqual(dense.slice(dense.indexOf('-ngl'), dense.indexOf('-ngl') + 2), ['-ngl', '0'])
  // MoE: -ngl is explicit now, so --n-cpu-moe follows it (the BeeLlama fit-abort rule above).
  const moe = profileToArgs({ ...deriveDefault(moeModel, sys), ngl: 0, nCpuMoe: 4 }, moeModel, caps, 16, sys)
  assert.deepEqual(moe.slice(moe.indexOf('-ngl'), moe.indexOf('-ngl') + 2), ['-ngl', '0'])
  assert.deepEqual(moe.slice(moe.indexOf('--n-cpu-moe'), moe.indexOf('--n-cpu-moe') + 2), ['--n-cpu-moe', '4'])
  // Auto-fit still omits it; and without a SysInfo (no detected GPU known) nothing changes.
  assert.equal(profileToArgs({ ...deriveDefault(denseModel, sys), ngl: 0, nglFit: true }, denseModel, caps, 16, sys).includes('-ngl'), false)
  assert.equal(profileToArgs({ ...deriveDefault(denseModel, sys), ngl: 0 }, denseModel, caps).includes('-ngl'), false)
})

test('profileToArgs: the no-GPU-detected default (ngl 0) still leaves -ngl to the engine, as before', () => {
  // deriveDefault/applyGlobalDefaults put 0 here only because no GPU was detected — not a user
  // choice — so a GPU the detection missed keeps the engine's own offload behaviour.
  const p = deriveDefault(denseModel, cpuOnly)
  assert.equal(p.ngl, 0)
  assert.equal(profileToArgs(p, denseModel, caps, 16, cpuOnly).includes('-ngl'), false)
})

test('profileToArgs: --n-cpu-moe stays gated by engine capability even at nCpuMoe=0', () => {
  // The capability gate (has('--n-cpu-moe')) must still win over the new always-explicit-at-0
  // behavior — an engine whose probed --help genuinely lacks --n-cpu-moe must never receive it,
  // at any value, same as every other flag in this function.
  const limited: Capabilities = { kvTypes: [], flags: ['-ngl', '--parallel'] }
  const p = { ...deriveDefault(moeModel, sys), ngl: 99, nCpuMoe: 0 }
  const args = profileToArgs(p, moeModel, limited)
  assert.equal(args.includes('--n-cpu-moe'), false)
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
