// `bench_result` identifier fields built from REAL hardware/model strings. `validateEvent` drops the
// whole event when any of them fails `isSafeIdent`, and very common names do (`@`, `/`, `[...]`),
// so the build sites normalize them with `toSafeIdent` — the validator itself stays as strict.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBenchResultConfig } from './perf'
import { toSafeIdent } from '../core/validate'
import { validateEvent, TELEMETRY_SCHEMA_VERSION } from '../schema'
import { deriveDefault } from '../../models/profile'
import type { ModelEntry } from '../../models/scanner'
import type { SysInfo } from '../../sysinfo/sysinfo'

const ENTRY = {
  key: 'm|q4|1', name: 'Mistral-7B-Instruct [v0.3]', path: '/models/m.gguf', dir: '/models', format: 'gguf',
  sizeBytes: 4_000_000_000, sizeLabel: '4 GB', arch: 'llama', quant: 'Q4_K_M',
  nativeCtx: 8192, blockCount: 32, headCountKv: 8, headDim: 0, moe: false, expertCount: 0,
  nextnLayers: 0, vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, reasoningEffort: false, embedding: false,
  incomplete: false, parseError: null, loaded: false, hasProfile: false, benchTps: null, mtime: '',
} as ModelEntry

function benchEvent(sys: SysInfo): unknown {
  const config = buildBenchResultConfig(ENTRY, deriveDefault(ENTRY, sys), 'b6123', sys)
  return {
    schema: TELEMETRY_SCHEMA_VERSION, event: 'bench_result', ts: '2026-10-13T00:00:00.000Z',
    machineId: '00000000-0000-0000-0000-000000000000', app: { version: '1.0.0', os: 'linux/x64' },
    hw: config.hw,
    payload: { source: 'chat', model: config.model, engine: config.engine, params: config.params, result: { tps: 40, ttftMs: 200, vramMb: null, outcome: 'ok' } },
  }
}

test('bench_result built from real-world CPU/GPU names validates instead of being dropped', () => {
  for (const sys of [
    { cpu: 'Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz', gpu: 'NVIDIA GeForce GTX 1080 Ti' },
    { cpu: 'AMD Ryzen 7 7840HS w/ Radeon 780M Graphics', gpu: 'Phoenix1 [Radeon 740M / 760M / 780M]' },
    { cpu: 'AMD Ryzen 9 7950X 16-Core Processor', gpu: 'Navi 48 [Radeon RX 9070/9070 XT]' },
  ]) {
    const info: SysInfo = { os: 'linux/x64', cpu: sys.cpu, cores: 8, ramMB: 32000, gpus: [{ name: sys.gpu, vramMb: 16000, vendor: 'amd' }] }
    const r = validateEvent(benchEvent(info))
    assert.equal(r.ok, true, r.ok ? '' : `${sys.cpu} / ${sys.gpu}: ${r.reason}`)
  }
})

test('toSafeIdent: an already-valid name is returned untouched, so existing join keys keep matching', () => {
  for (const v of ['NVIDIA GeForce RTX 4090', 'AMD Ryzen 9 5950X 16-Core Processor   ', 'Q4_K_M', 'b6123']) {
    assert.equal(toSafeIdent(v), v)
  }
})

test('toSafeIdent: normalizes the rest — readable, capped, never empty', () => {
  assert.equal(toSafeIdent('Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz'), 'Intel(R) Core(TM) i7-8700K CPU 3.70GHz')
  assert.equal(toSafeIdent('Navi 48 [Radeon RX 9070/9070 XT]'), 'Navi 48 Radeon RX 9070 9070 XT')
  const path = toSafeIdent('../../etc/passwd')
  assert.ok(!path.includes('/') && !path.includes('..'), path) // still never path-shaped
  assert.equal(toSafeIdent(''), 'unknown')
  assert.equal(toSafeIdent('@@@'), 'unknown')
  assert.ok(toSafeIdent(`${'x'.repeat(200)}@`).length <= 96)
})
