import { test } from 'node:test'
import assert from 'node:assert/strict'
import { engineAcceptsFormat, engineModelAlias, engineRejectsAudioModel, ENGINE_MODEL_ALIAS } from './compat'
import { vllmServerCommand, vllmServeBlocker } from './vllm'
import { mlxServerCommand, mlxSamplingArgs } from './mlx'
import { mlxVlmServerCommand } from './mlx-vlm'

test('engineAcceptsFormat: gguf for llama.cpp forks, mlx for python engines', () => {
  assert.equal(engineAcceptsFormat('llama-server', 'gguf'), true)
  assert.equal(engineAcceptsFormat('llama-server', 'mlx'), false)
  assert.equal(engineAcceptsFormat('mlx', 'mlx'), true)
  assert.equal(engineAcceptsFormat('mlx', 'gguf'), false)
  assert.equal(engineAcceptsFormat('vllm', 'mlx'), true)
  assert.equal(engineAcceptsFormat('vllm', 'gguf'), false)
  assert.equal(engineAcceptsFormat('mlx-vlm', 'mlx'), true)
  assert.equal(engineAcceptsFormat('mlx-vlm', 'gguf'), false)
})

test('engineAcceptsFormat: koboldcpp + llamafile are GGUF engines (Phase 4)', () => {
  assert.equal(engineAcceptsFormat('koboldcpp', 'gguf'), true)
  assert.equal(engineAcceptsFormat('koboldcpp', 'mlx'), false)
  assert.equal(engineAcceptsFormat('llamafile', 'gguf'), true)
  assert.equal(engineAcceptsFormat('llamafile', 'mlx'), false)
})

// Regression: Rapid-MLX's bundled mlx_vlm double-transposes gemma4's audio-tower conv
// weights (confirmed live, reproduced even on the latest available mlx-vlm 0.6.4) — not
// a missing file, not fixable by re-downloading. mlx-vlm itself is excluded too — Rapid-MLX
// vendors the same mlx_vlm sanitizer code, so the bug is upstream in mlx-vlm, not something
// Rapid-MLX introduced (verified by reading the installed mlx-vlm package source; not yet
// reproduced live against plain mlx-vlm — see mlx-vlm.ts's docblock). Plain MLX never
// attempts VLM/audio loading and is unaffected; vision-only models (no audio tower) are
// not excluded either.
test('engineRejectsAudioModel: true for rapid-mlx and mlx-vlm only', () => {
  assert.equal(engineRejectsAudioModel('rapid-mlx'), true)
  assert.equal(engineRejectsAudioModel('mlx-vlm'), true)
  assert.equal(engineRejectsAudioModel('mlx'), false)
  assert.equal(engineRejectsAudioModel('vllm'), false)
  assert.equal(engineRejectsAudioModel('llama-server'), false)
})

test('engineModelAlias: fixed alias for mlx/vllm, null (keep caller value) for llama.cpp', () => {
  // mlx-lm / vLLM serve under a fixed name and 404 on TurboLLM's internal key.
  assert.equal(engineModelAlias('mlx'), ENGINE_MODEL_ALIAS)
  assert.equal(engineModelAlias('vllm'), ENGINE_MODEL_ALIAS)
  // llama.cpp ignores the request model field — keep whatever the caller sent.
  assert.equal(engineModelAlias('llama-server'), null)
  assert.equal(engineModelAlias(''), null)
})

test('engineModelAlias: null for koboldcpp + llamafile (they ignore the model field)', () => {
  // Both serve the single loaded model and ignore the request model field, like llama.cpp.
  assert.equal(engineModelAlias('koboldcpp'), null)
  assert.equal(engineModelAlias('llamafile'), null)
})

// mlx-vlm is a third shape, distinct from both the above: mlx_vlm.server resolves the
// request body's `model` field as a REAL, load-bearing model path/repo id on every request
// (passed straight to get_cached_model) — not a fixed serving alias like mlx-lm/vLLM, and
// not ignored like llama.cpp/koboldcpp/llamafile. Callers must thread through the real
// currently-loaded model path (Manager.currentOpts()?.modelPath), not TurboLLM's internal key.
test('engineModelAlias: mlx-vlm echoes the real model path through, not a fixed alias', () => {
  assert.equal(engineModelAlias('mlx-vlm', '/models/qwen2-vl-7b-mlx'), '/models/qwen2-vl-7b-mlx')
  // No path available (e.g. engine not running) — caller falls back to its own default.
  assert.equal(engineModelAlias('mlx-vlm'), null)
  assert.equal(engineModelAlias('mlx-vlm', null), null)
  assert.equal(engineModelAlias('mlx-vlm', undefined), null)
})

test('vllmServerCommand serves under the shared default_model alias', () => {
  const { args } = vllmServerCommand('py', '/models/some dir', 8000, '127.0.0.1')
  const i = args.indexOf('--served-model-name')
  assert.notEqual(i, -1)
  assert.equal(args[i + 1], ENGINE_MODEL_ALIAS)
})

test('vllmServeBlocker returns a clear message when the runtime cannot serve (ADR-080)', async () => {
  // A bogus interpreter path can't import uvloop → the preflight reports vLLM can't run here,
  // exactly as on Windows where uvloop has no build. (On Linux/macOS with a real venv it returns null.)
  const msg = await vllmServeBlocker(process.platform === 'win32' ? 'C:/no/such/python.exe' : '/no/such/python')
  assert.ok(msg && /vLLM cannot run/.test(msg))
})

test('mlxServerCommand passes model/host/port and appends MLX-only extraArgs (no alias flag)', () => {
  const { cmd, args } = mlxServerCommand('py', '/models/x', 8081, '127.0.0.1', ['--temp', '0.7'])
  assert.equal(cmd, 'py')
  assert.deepEqual(args, ['-m', 'mlx_lm', 'server', '--model', '/models/x', '--host', '127.0.0.1', '--port', '8081', '--temp', '0.7'])
  // mlx-lm serves under its built-in default_model alias — we must NOT pass an alias flag.
  assert.equal(args.includes('--model-name'), false)
})

test('mlxSamplingArgs emits only the 4 mlx-lm-supported sampling flags, skipping undefined', () => {
  assert.deepEqual(mlxSamplingArgs(undefined), [])
  assert.deepEqual(mlxSamplingArgs({ temp: 0.7, topP: 0.9 }), ['--temp', '0.7', '--top-p', '0.9'])
  assert.deepEqual(
    mlxSamplingArgs({ temp: 0, topP: 1, topK: 40, minP: 0.05 }),
    ['--temp', '0', '--top-p', '1', '--top-k', '40', '--min-p', '0.05'],
  )
  // Penalties/stop are not launch flags for mlx-lm — ignored here.
  assert.deepEqual(mlxSamplingArgs({ topK: 20 } as { topK: number }), ['--top-k', '20'])
})

test('mlxVlmServerCommand passes model/host/port with no alias or sampling flags (mlx_vlm.server has none)', () => {
  const { cmd, args } = mlxVlmServerCommand('py', '/models/qwen2-vl-7b-mlx', 8082, '127.0.0.1')
  assert.equal(cmd, 'py')
  assert.deepEqual(args, ['-m', 'mlx_vlm.server', '--model', '/models/qwen2-vl-7b-mlx', '--host', '127.0.0.1', '--port', '8082'])
})
