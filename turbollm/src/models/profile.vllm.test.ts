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
    nativeCtx: 32768, blockCount: 32, headCountKv: 8, moe: false, expertCount: 0,
    nextnLayers: 0, vision: false, audio: false, mmprojPath: null, hasChatTemplate: true, embedding: false,
    incomplete: false, parseError: null, loaded: false, hasProfile: false,
    benchTps: null, mtime: '', ...over,
  }
}

const sys: SysInfo = {
  os: 'linux/x64', cpu: 'test', cores: 16, ramMB: 64000,
  gpus: [{ name: 'gpu0', vramMb: 24000, vendor: 'nvidia' }],
}

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
  const args = vllmProfileToArgs(deriveDefault(model({ nativeCtx: 2048 }), sys))
  assert.deepEqual(args, [])
})

test('maxModelLen emitted only when > 0', () => {
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ maxModelLen: 0 })), '--max-model-len'), undefined)
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ maxModelLen: 16384 })), '--max-model-len'), '16384')
})

// Regression: vLLM's own --max-num-batched-tokens defaults to 2048, and its scheduler
// config validator refuses to start at all (pydantic ValidationError) if the effective
// max-model-len exceeds that — reproduced live on this Mac with a real model whose
// native context (8192, the model's own max_position_embeddings) exceeded vLLM's
// default. Since virtually every real model's context exceeds 2048, an unset
// maxModelLen must still raise --max-num-batched-tokens to match.
test('max-num-batched-tokens raised to match the effective max-model-len when it exceeds 2048', () => {
  const p = deriveDefault(model({ nativeCtx: 8192 }), sys) // p.ctx = min(8192, 8192) = 8192
  assert.equal(valAfter(vllmProfileToArgs(p), '--max-num-batched-tokens'), '8192')
})

test('max-num-batched-tokens follows an explicit maxModelLen override, not p.ctx', () => {
  const args = vllmProfileToArgs(withVllm({ maxModelLen: 16384 }))
  assert.equal(valAfter(args, '--max-num-batched-tokens'), '16384')
})

test('max-num-batched-tokens omitted when the effective max-model-len is at or below 2048', () => {
  const p = deriveDefault(model({ nativeCtx: 2048 }), sys)
  assert.equal(valAfter(vllmProfileToArgs(p), '--max-num-batched-tokens'), undefined)
})

test('gpuMemoryUtilization emitted only when it differs from vLLM default 0.9', () => {
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ gpuMemoryUtilization: 0.9 })), '--gpu-memory-utilization'), undefined)
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ gpuMemoryUtilization: 0.8 })), '--gpu-memory-utilization'), '0.8')
})

test('maxNumSeqs emitted only when > 0', () => {
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ maxNumSeqs: 0 })), '--max-num-seqs'), undefined)
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ maxNumSeqs: 64 })), '--max-num-seqs'), '64')
})

test('dtype emitted only when not auto', () => {
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ dtype: 'auto' })), '--dtype'), undefined)
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ dtype: 'bfloat16' })), '--dtype'), 'bfloat16')
})

test('kvCacheDtype emitted only when not auto', () => {
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ kvCacheDtype: 'auto' })), '--kv-cache-dtype'), undefined)
  assert.equal(valAfter(vllmProfileToArgs(withVllm({ kvCacheDtype: 'fp8' })), '--kv-cache-dtype'), 'fp8')
})

test('enforceEager and trustRemoteCode are boolean flags', () => {
  const off = vllmProfileToArgs(withVllm({ enforceEager: false, trustRemoteCode: false }))
  assert.ok(!off.includes('--enforce-eager'))
  assert.ok(!off.includes('--trust-remote-code'))
  const on = vllmProfileToArgs(withVllm({ enforceEager: true, trustRemoteCode: true }))
  assert.ok(on.includes('--enforce-eager'))
  assert.ok(on.includes('--trust-remote-code'))
})

test('user extraArgs pass through last', () => {
  const p = { ...withVllm({ dtype: 'float16' }), extraArgs: ['--seed', '7'] }
  const args = vllmProfileToArgs(p)
  assert.ok(args.includes('--dtype'))
  assert.deepEqual(args.slice(-2), ['--seed', '7'])
})
