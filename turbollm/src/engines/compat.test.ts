import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { engineAcceptsFormat, engineModelAlias, engineRejectsAudioModel, ENGINE_MODEL_ALIAS, modelIncompatibility } from './compat'
import type { JevInfo } from '../models/jev'
import { vllmServerCommand, vllmServeBlocker, classifyVllmBlocker } from './vllm'
import { UvloopPreflight } from './py-engine-blocker'
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

const OPENJEV: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}
const JEV_ENTRY = { format: 'mlx', audio: false, jev: OPENJEV } as const
const PLAIN_GGUF = { format: 'gguf', audio: false } as const
const PLAIN_MLX = { format: 'mlx', audio: false } as const
const AUDIO_MLX = { format: 'mlx', audio: true } as const
const NEEDS_VLLM_MESSAGE =
  'This is a Jev model — it runs only on vLLM (Linux or WSL2). Activate a vLLM engine to load it.'

for (const engineKind of ['llama-server', 'mlx', 'rapid-mlx', 'mlx-vlm', 'koboldcpp']) {
  test(`modelIncompatibility: a Jev model on ${engineKind} needs vLLM`, () => {
    assert.deepEqual(modelIncompatibility(engineKind, JEV_ENTRY), {
      code: 'needs_vllm',
      label: 'Needs vLLM (Linux or WSL2)',
      message: NEEDS_VLLM_MESSAGE,
    })
  })
}

test('modelIncompatibility: a Jev model on vLLM is loadable', () => {
  assert.equal(modelIncompatibility('vllm', JEV_ENTRY), null)
})

test('modelIncompatibility: a GGUF model on vLLM is a format mismatch that needs llama.cpp', () => {
  assert.deepEqual(modelIncompatibility('vllm', PLAIN_GGUF), {
    code: 'format',
    label: 'needs llama.cpp',
    message: 'The active engine is vLLM — pick a safetensors / HF model, or switch to a llama.cpp engine for GGUF.',
  })
})

test('modelIncompatibility: a safetensors model on llama.cpp is a format mismatch that needs MLX or vLLM', () => {
  assert.deepEqual(modelIncompatibility('llama-server', PLAIN_MLX), {
    code: 'format',
    label: 'needs MLX or vLLM',
    message: 'This is a safetensors model — activate an MLX or vLLM engine to load it.',
  })
})

test('modelIncompatibility: the format messages move verbatim for every engine kind', () => {
  const messageFor = (engineKind: string, entry: typeof PLAIN_GGUF | typeof PLAIN_MLX) =>
    modelIncompatibility(engineKind, entry)?.message
  assert.equal(
    messageFor('mlx', PLAIN_GGUF),
    'The active engine is MLX — pick a safetensors model, or switch to a llama.cpp engine for GGUF.',
  )
  assert.equal(
    messageFor('rapid-mlx', PLAIN_GGUF),
    'The active engine is Rapid-MLX — pick a safetensors model, or switch to a llama.cpp engine for GGUF.',
  )
  assert.equal(
    messageFor('mlx-vlm', PLAIN_GGUF),
    'The active engine is MLX-VLM — pick a safetensors model, or switch to a llama.cpp engine for GGUF.',
  )
  assert.equal(messageFor('koboldcpp', PLAIN_MLX), 'This is a safetensors model — activate an MLX or vLLM engine to load it.')
})

test('modelIncompatibility: an audio-tower model on Rapid-MLX fails, and needs MLX or vLLM', () => {
  assert.deepEqual(modelIncompatibility('rapid-mlx', AUDIO_MLX), {
    code: 'audio',
    label: 'needs MLX or vLLM',
    message:
      'Rapid-MLX cannot load models with an audio tower — the audio encoder fails due to an upstream mlx-vlm bug in the sanitizer for these architectures. Switch to the MLX engine instead.',
  })
})

test('modelIncompatibility: an audio-tower model on MLX-VLM is expected to fail', () => {
  assert.deepEqual(modelIncompatibility('mlx-vlm', AUDIO_MLX), {
    code: 'audio',
    label: 'needs MLX or vLLM',
    message:
      'MLX-VLM cannot load models with an audio tower — the audio encoder is expected to fail due to an upstream mlx-vlm bug in the sanitizer for these architectures. Switch to the MLX engine instead.',
  })
})

test('modelIncompatibility: an audio-tower model on plain MLX is loadable', () => {
  assert.equal(modelIncompatibility('mlx', AUDIO_MLX), null)
})

test('modelIncompatibility: needs vLLM wins over a format mismatch for a Jev model', () => {
  assert.equal(modelIncompatibility('llama-server', { ...JEV_ENTRY, audio: true })?.code, 'needs_vllm')
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

test('classifyVllmBlocker: Windows reports an unsupported platform (ADR-080)', () => {
  assert.match(classifyVllmBlocker('win32', new Error('boom')), /vLLM cannot run on Windows/)
})

test('classifyVllmBlocker: macOS reports a broken environment — uvloop ships macOS wheels, but vLLM is not first-class there', () => {
  const msg = classifyVllmBlocker('darwin', new Error('ModuleNotFoundError: no module named uvloop'))
  assert.doesNotMatch(msg, /cannot run on/i)
  // The catalog calls vLLM on macOS experimental: only uvloop's own support may be asserted.
  assert.doesNotMatch(msg, /macOS is a supported platform/i)
  assert.match(msg, /uvloop itself supports macOS/)
  assert.match(msg, /reinstall/i)
})

test('classifyVllmBlocker: an unverified platform is never claimed as supported', () => {
  const msg = classifyVllmBlocker('freebsd', new Error('ModuleNotFoundError: no module named uvloop'))
  assert.doesNotMatch(msg, /supported platform/i)
  assert.match(msg, /unverified/i)
  assert.match(msg, /reinstall/i)
})

test('classifyVllmBlocker: Linux reports a broken environment, never "no Linux build" (regression)', () => {
  // uvloop ships real manylinux wheels — a Linux import failure is an environment problem
  // (broken/incomplete venv), never a platform limitation. Conflating the two previously
  // told Linux users to switch engines or run under WSL2 for a fixable local install issue.
  const msg = classifyVllmBlocker('linux', new Error('ModuleNotFoundError: no module named uvloop'))
  assert.doesNotMatch(msg, /cannot run on/i)
  assert.match(msg, /reinstall/i)
})

test('classifyVllmBlocker: a missing interpreter (ENOENT) is a broken install, not an unsupported platform', () => {
  const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
  assert.match(classifyVllmBlocker('linux', enoent), /interpreter not found/i)
})

test('classifyVllmBlocker: CRLF stderr yields a clean last line, with no stray carriage return', () => {
  const stderr = 'Traceback (most recent call last):\r\n  File "<string>", line 1\r\n    ImportError: libcuda.so.1  \r\n\r\n'
  const msg = classifyVllmBlocker('linux', Object.assign(new Error('exit 1'), { stderr }))
  assert.match(msg, /uvloop failed to import: ImportError: libcuda\.so\.1\)/)
  assert.doesNotMatch(msg, /\r/)
})

test('classifyVllmBlocker: a huge stderr line is capped so it cannot bloat the UI message', () => {
  const stderr = `ImportError: ${'x'.repeat(5000)}`
  const msg = classifyVllmBlocker('linux', Object.assign(new Error('exit 1'), { stderr }))
  const detail = msg.slice(msg.indexOf('uvloop failed to import: '), msg.indexOf(')'))
  assert.ok(detail.length < 300, `detail was ${detail.length} chars`)
  assert.match(msg, /…\)/)
})

test('classifyVllmBlocker: the home directory is redacted out of the detail', () => {
  const home = homedir()
  const slashed = home.split('\\').join('/')
  const backslashed = home.split('/').join('\\')
  const stderr = `ImportError: ${slashed}/.turbollm/engines/vllm and ${backslashed}\\venv`
  const msg = classifyVllmBlocker('linux', Object.assign(new Error('exit 1'), { stderr }))
  assert.ok(!msg.includes(slashed), 'forward-slash home leaked')
  assert.ok(!msg.includes(backslashed), 'backslash home leaked')
  assert.match(msg, /~/)
})

// The home directory is injected, so none of these touch process.env (which every test in the
// process shares).
function brokenImport(home: () => string, stderr: string): string {
  return new UvloopPreflight('vLLM', home).classify('linux', Object.assign(new Error('exit 1'), { stderr }))
}

test('UvloopPreflight: a container with HOME=/ does not have every slash rewritten to ~', () => {
  const msg = brokenImport(() => '/', 'ImportError: /usr/lib/x86_64-linux-gnu/libcuda.so.1: cannot open shared object file')
  assert.match(msg, /\/usr\/lib\/x86_64-linux-gnu\/libcuda\.so\.1/)
})

test('UvloopPreflight: the home directory is redacted whatever case Python spelled it in', () => {
  // A case-insensitive filesystem lets Python print `c:\users\owner` for `C:\Users\Owner`.
  const msg = brokenImport(() => 'C:\\Users\\Owner', 'ImportError: c:\\users\\owner\\venv and C:/USERS/OWNER/.turbollm')
  assert.doesNotMatch(msg, /owner/i)
  assert.match(msg, /~/)
})

test('UvloopPreflight: an unreadable home directory does not crash the error message', () => {
  // os.homedir() throws (uv_os_homedir ENOENT) for a uid with no passwd entry and no HOME.
  const unreadable = () => {
    throw new Error('ENOENT: uv_os_homedir')
  }
  const msg = brokenImport(unreadable, 'ImportError: libcuda.so.1')
  assert.match(msg, /uvloop failed to import: ImportError: libcuda\.so\.1\)/)
})

test('vllmServeBlocker returns a clear message when the runtime cannot serve (ADR-080)', async () => {
  // A bogus interpreter path can't import uvloop → the preflight reports a blocker.
  // Only Windows frames that as an unsupported platform; elsewhere (Linux, macOS) it must
  // NOT claim "cannot run on <plat>" since uvloop ships wheels for both.
  const msg = await vllmServeBlocker(process.platform === 'win32' ? 'C:/no/such/python.exe' : '/no/such/python')
  assert.ok(msg)
  if (process.platform === 'win32') {
    assert.match(msg!, /cannot run on/i)
  } else {
    assert.doesNotMatch(msg!, /cannot run on/i)
  }
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
