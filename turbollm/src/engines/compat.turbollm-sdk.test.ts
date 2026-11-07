import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  engineAcceptsFormat,
  engineFormats,
  engineModelAlias,
  engineWithholdsTools,
  engineWithholdsVision,
  manualLoadRefusal,
  modelIncompatibility,
  readsOnlyLitertlm,
  shapeForEngine,
  type EngineFormatRef,
  type ModelFormat,
} from './compat'
import { unlistedForLoading, type Registry } from './registry'

const SDK = 'turbollm-sdk'
const OTHER_KINDS = [
  'llama-server', 'llamafile', 'koboldcpp', 'mlx', 'rapid-mlx', 'mlx-vlm', 'vllm', 'sglang', 'litert-lm', 'laya',
]

test('m-6: readsOnlyLitertlm is a format rule, true only for a row that reads .litertlm and not GGUF', () => {
  const sdkRow = (id: string, formats: ModelFormat[]): EngineFormatRef =>
    ({ kind: SDK, sdkEngine: { id, kind: id, formats, backends: [] } }) as EngineFormatRef
  const table: [string, EngineFormatRef, boolean][] = [
    ['desktop litert-lm', { kind: 'litert-lm' }, true],
    ['LiteRT-LM SDK row', sdkRow('litert-lm', ['litertlm']), true],
    ['llama.cpp SDK row', sdkRow('llama.cpp-cpu', ['gguf']), false],
    ['M1 legacy SDK row', { kind: SDK }, false],
    ['llama-server', { kind: 'llama-server' }, false],
  ]
  for (const [label, engine, expected] of table) assert.equal(readsOnlyLitertlm(engine), expected, label)
})

test('engineAcceptsFormat: the in-app SDK engine takes GGUF and .litertlm, not MLX', () => {
  assert.equal(engineAcceptsFormat({ kind: SDK }, 'gguf'), true)
  assert.equal(engineAcceptsFormat({ kind: SDK }, 'litertlm'), true)
  assert.equal(engineAcceptsFormat({ kind: SDK }, 'mlx'), false)
})

test('engineModelAlias: the SDK engine is addressed by the model file path', () => {
  assert.equal(engineModelAlias(SDK, '/models/qwen.gguf'), '/models/qwen.gguf')
  assert.equal(engineModelAlias(SDK), null)
})

test('engineWithholdsTools: only the SDK engine withholds tools', () => {
  assert.equal(engineWithholdsTools(SDK), true)
  for (const kind of OTHER_KINDS) assert.equal(engineWithholdsTools(kind), false, kind)
})

test('engineWithholdsVision: only the SDK engine withholds vision', () => {
  assert.equal(engineWithholdsVision(SDK), true)
  for (const kind of OTHER_KINDS) assert.equal(engineWithholdsVision(kind), false, kind)
})

test('a format refusal on the SDK engine names it TurboLLM SDK', () => {
  assert.equal(
    modelIncompatibility({ kind: SDK }, { format: 'mlx', audio: false })?.message,
    "TurboLLM SDK can't run this safetensors model.",
  )
})

test('shapeForEngine: the SDK engine is sent the first 4 stop strings, and the dropped ones are logged once', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const body = { stop: ['a', 'b', 'c', 'd', 'e'] }
  assert.deepEqual(shapeForEngine(SDK, body).stop, ['a', 'b', 'c', 'd'])
  assert.equal(warn.mock.callCount(), 1)
  assert.match(String(warn.mock.calls[0].arguments[0]), /e/)
  shapeForEngine(SDK, { stop: ['a', 'b', 'c', 'd', 'e', 'f'] })
  assert.equal(warn.mock.callCount(), 1)
})

test('shapeForEngine: up to 4 stop strings reach the SDK engine unchanged', () => {
  assert.deepEqual(shapeForEngine(SDK, { stop: ['a', 'b', 'c'] }).stop, ['a', 'b', 'c'])
})

test('shapeForEngine: a single string stop reaches the SDK engine unchanged', () => {
  assert.equal(shapeForEngine(SDK, { stop: '</answer>' }).stop, '</answer>')
})

test('shapeForEngine: other engines keep every stop string', () => {
  for (const kind of OTHER_KINDS) {
    assert.deepEqual(shapeForEngine(kind, { stop: ['a', 'b', 'c', 'd', 'e'] }).stop, ['a', 'b', 'c', 'd', 'e'], kind)
  }
})

// ADR-462 (plan D-8): each SDK row reads the formats its SDK engine reported, so the LiteRT-LM row and the llama.cpp
// row list, refuse and launch different models. A bare { kind: 'turbollm-sdk' } is the M1 legacy row, which keeps
// reading both until the Android reconciler adopts it.

const LITERT_ROW: EngineFormatRef = {
  kind: SDK, name: 'LiteRT-LM',
  sdkEngine: { id: 'litert-lm', kind: 'litert-lm', formats: ['litertlm'], backends: ['gpu', 'cpu'] },
}
const LLAMA_ROW: EngineFormatRef = {
  kind: SDK, name: 'llama.cpp (CPU)',
  sdkEngine: { id: 'llama.cpp-cpu', kind: 'llama.cpp', formats: ['gguf'], backends: ['cpu'] },
}
const LEGACY_ROW: EngineFormatRef = { kind: SDK }
const ALL_FORMATS: ModelFormat[] = ['gguf', 'mlx', 'litertlm']

/** engineAcceptsFormat's body before D-8, pasted verbatim: the kind table every non-SDK row still reads. */
function acceptedBefore(engineKind: string, format: ModelFormat): boolean {
  if (engineKind === 'mlx') return format === 'mlx'
  if (engineKind === 'rapid-mlx') return format === 'mlx'
  if (engineKind === 'mlx-vlm') return format === 'mlx'
  if (engineKind === 'vllm') return format === 'mlx'
  if (engineKind === 'sglang') return format === 'mlx'
  if (engineKind === 'laya') return false
  if (engineKind === 'litert-lm') return format === 'litertlm'
  if (engineKind === 'turbollm-sdk') return format === 'gguf' || format === 'litertlm'
  return format === 'gguf'
}

test('engineFormats: the LiteRT-LM row reads only .litertlm, the llama.cpp row only GGUF, the legacy row both', () => {
  assert.deepEqual(engineFormats(LITERT_ROW), ['litertlm'])
  assert.deepEqual(engineFormats(LLAMA_ROW), ['gguf'])
  assert.deepEqual(engineFormats(LEGACY_ROW), ['gguf', 'litertlm'])
  assert.equal(engineAcceptsFormat(LITERT_ROW, 'gguf'), false)
  assert.equal(engineAcceptsFormat(LLAMA_ROW, 'litertlm'), false)
})

test('engineFormats: every other kind reads exactly what the kind table said before', () => {
  for (const kind of [...OTHER_KINDS, SDK, 'a-future-kind']) {
    const expected = ALL_FORMATS.filter((format) => acceptedBefore(kind, format))
    assert.deepEqual(engineFormats({ kind }), expected, kind)
    for (const format of ALL_FORMATS) assert.equal(engineAcceptsFormat({ kind }, format), acceptedBefore(kind, format), `${kind} ${format}`)
  }
})

test('a GGUF on the LiteRT-LM row is a format refusal naming LiteRT-LM and no other engine', () => {
  const inc = modelIncompatibility(LITERT_ROW, { format: 'gguf', audio: false })
  assert.equal(inc?.code, 'format')
  assert.equal(inc?.message, "LiteRT-LM can't run this GGUF model.")
  assert.doesNotMatch(inc?.message ?? '', /llama|TurboLLM SDK/i)
  assert.equal(modelIncompatibility(LLAMA_ROW, { format: 'litertlm', audio: false })?.message, "llama.cpp (CPU) can't run this .litertlm model.")
})

test('manualLoadRefusal still refuses nothing but a Laya model on an SDK row', () => {
  assert.equal(manualLoadRefusal(LITERT_ROW, { format: 'gguf', audio: false }), null)
  assert.equal(manualLoadRefusal(LLAMA_ROW, { format: 'litertlm', audio: false }), null)
  assert.equal(manualLoadRefusal(LITERT_ROW, { format: 'gguf', audio: false, laya: { checkpoints: ['english'] } })?.code, 'needs_laya')
})

test('unlistedForLoading follows the active SDK row: the llama.cpp row hides .litertlm, the LiteRT-LM row hides GGUF', () => {
  const gguf = { format: 'gguf', audio: false } as const
  const litertlm = { format: 'litertlm', audio: false } as const
  const listed = (row: EngineFormatRef) => unlistedForLoading(false, registryWith(row))
  assert.equal(listed(LLAMA_ROW)(gguf), null)
  assert.equal(listed(LLAMA_ROW)(litertlm)?.code, 'format')
  assert.equal(listed(LITERT_ROW)(litertlm), null)
  assert.equal(listed(LITERT_ROW)(gguf)?.code, 'format')
  assert.equal(unlistedForLoading(true, registryWith(LITERT_ROW))(gguf), null, 'Show models for every engine')
})

function registryWith(row: EngineFormatRef): Pick<Registry, 'active' | 'layaEngine'> {
  const engine = { id: 'row', binPath: '', version: 'in-app', capabilities: { kvTypes: [], flags: [] }, addedAt: '', name: '', ...row }
  return { active: () => engine, layaEngine: () => undefined }
}
