// F-027: vLLM load controls. Tests the profile → vLLM CLI arg mapping. Each flag is emitted
// only when it deviates from vLLM's own default, so a fresh profile is a no-op (launch unchanged).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveDefault, defaultVllm, vllmProfileToArgs } from './profile'
import type { LoadProfile, VllmProfile } from './profile'
import type { ModelEntry } from './scanner'
import type { SysInfo } from '../sysinfo/sysinfo'

function model(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key: 'm', name: 'm', path: '/models/m', dir: '/models', format: 'mlx',
    sizeBytes: 8_000_000_000, sizeLabel: '8 GB', arch: 'llama', quant: 'fp16',
    nativeCtx: 32768, blockCount: 32, headCountKv: 8, headDim: 0, moe: false, expertCount: 0,
    nextnLayers: 0, vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, embedding: false,
    incomplete: false, parseError: null, loaded: false, hasProfile: false,
    benchTps: null, mtime: '', ...over,
  }
}

const sys: SysInfo = {
  os: 'linux/x64', cpu: 'test', cores: 16, ramMB: 64000,
  gpus: [{ name: 'gpu0', vramMb: 24000, vendor: 'nvidia' }],
}

// model()'s default nativeCtx (32768) — the value vLLM itself derives when --max-model-len is
// left unset, and deliberately NOT what deriveDefault() puts in LoadProfile.ctx (capped at 8192
// for llama.cpp/MLX's KV-memory sizing, irrelevant to vLLM once --max-model-len is omitted).
const MODEL_NATIVE_CTX = 32768

function withVllm(over: Partial<VllmProfile>): LoadProfile {
  const base = deriveDefault(model(), sys)
  return { ...base, vllm: { ...defaultVllm(), ...over } }
}

/** Value emitted after `flag`, or undefined if the flag is absent. */
function valAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

test('default vLLM profile on a tiny-context model emits no flags (no behavior change)', () => {
  const args = vllmProfileToArgs(deriveDefault(model({ nativeCtx: 2048 }), sys), 2048)
  assert.deepEqual(args, [])
})

test('maxModelLen emitted only when > 0', () => {
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ maxModelLen: 0 }), MODEL_NATIVE_CTX), '--max-model-len'), undefined)
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ maxModelLen: 16384 }), MODEL_NATIVE_CTX), '--max-model-len'), '16384')
})

// Regression: vLLM's own --max-num-batched-tokens defaults to 2048, and its scheduler
// config validator refuses to start at all (pydantic ValidationError) if the effective
// max-model-len exceeds that — reproduced live with a real model whose native context
// exceeded vLLM's default. Since virtually every real model's context exceeds 2048, an
// unset maxModelLen must still raise --max-num-batched-tokens to match.
//
// Second regression (caught in code review): the first fix used LoadProfile.ctx as the
// proxy for "what vLLM will derive" — but deriveDefault() caps ctx at 8192 for every
// engine (llama.cpp/MLX KV-memory sizing), while vLLM itself derives its real max-model-
// len straight from the model's own uncapped max_position_embeddings when --max-model-len
// is left unset. For any model with native context > 8192 (the common case — 32768 here,
// matching this file's own model() default), that mismatch reproduced the exact crash this
// fix was meant to prevent: --max-num-batched-tokens 8192 emitted while vLLM's real
// max-model-len is 32768. Fixed by threading the model's real nativeCtx through explicitly
// instead of reading it off the capped profile.
test('max-num-batched-tokens matches the model real native context above the 8192 profile cap', () => {
  const p = deriveDefault(model({ nativeCtx: MODEL_NATIVE_CTX }), sys)
  assert.equal(p.ctx, 8192, 'sanity: deriveDefault caps LoadProfile.ctx regardless of native context')
  assert.equal(valAfter(vllmProfileToArgs(p, MODEL_NATIVE_CTX), '--max-num-batched-tokens'), String(MODEL_NATIVE_CTX))
})

test('max-num-batched-tokens raised to match a native context still above 2048 but below the profile cap', () => {
  const p = deriveDefault(model({ nativeCtx: 4096 }), sys)
  assert.equal(valAfter(vllmProfileToArgs(p, 4096), '--max-num-batched-tokens'), '4096')
})

test('max-num-batched-tokens follows an explicit maxModelLen override, not nativeCtx', () => {
  const args = vllmProfileToArgs(withVllm({ maxModelLen: 16384 }), MODEL_NATIVE_CTX)
  assert.equal(valAfter(args, '--max-num-batched-tokens'), '16384')
})

test('max-num-batched-tokens omitted when the effective max-model-len is at or below 2048', () => {
  const p = deriveDefault(model({ nativeCtx: 2048 }), sys)
  assert.equal(valAfter(vllmProfileToArgs(p, 2048), '--max-num-batched-tokens'), undefined)
})

test('gpuMemoryUtilization emitted only when it differs from vLLM default 0.9', () => {
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ gpuMemoryUtilization: 0.9 }), MODEL_NATIVE_CTX), '--gpu-memory-utilization'), undefined)
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ gpuMemoryUtilization: 0.8 }), MODEL_NATIVE_CTX), '--gpu-memory-utilization'), '0.8')
})

test('maxNumSeqs emitted only when > 0', () => {
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ maxNumSeqs: 0 }), MODEL_NATIVE_CTX), '--max-num-seqs'), undefined)
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ maxNumSeqs: 64 }), MODEL_NATIVE_CTX), '--max-num-seqs'), '64')
})

test('dtype emitted only when not auto', () => {
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ dtype: 'auto' }), MODEL_NATIVE_CTX), '--dtype'), undefined)
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ dtype: 'bfloat16' }), MODEL_NATIVE_CTX), '--dtype'), 'bfloat16')
})

test('kvCacheDtype emitted only when not auto', () => {
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ kvCacheDtype: 'auto' }), MODEL_NATIVE_CTX), '--kv-cache-dtype'), undefined)
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ kvCacheDtype: 'fp8' }), MODEL_NATIVE_CTX), '--kv-cache-dtype'), 'fp8')
})

test('enforceEager and trustRemoteCode are boolean flags', () => {
  const off = vllmProfileToArgs(withVllm({ enforceEager: false, trustRemoteCode: false }), MODEL_NATIVE_CTX)
  assert.ok(!off.includes('--enforce-eager'))
  assert.ok(!off.includes('--trust-remote-code'))
  const on = vllmProfileToArgs(withVllm({ enforceEager: true, trustRemoteCode: true }), MODEL_NATIVE_CTX)
  assert.ok(on.includes('--enforce-eager'))
  assert.ok(on.includes('--trust-remote-code'))
})

test('user extraArgs pass through last', () => {
  const p = { ...withVllm({ dtype: 'float16' }), extraArgs: ['--seed', '7'] }
  const args = vllmProfileToArgs(p, MODEL_NATIVE_CTX)
  assert.ok(args.includes('--dtype'))
  assert.deepEqual(args.slice(-2), ['--seed', '7'])
})
