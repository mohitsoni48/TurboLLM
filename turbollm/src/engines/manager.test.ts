import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { detectPyLoadFailure, pyEngineEnv } from './manager'
import { tmpDir } from '../test-support/tmp'

// llamafile's shell fallback (an Actually Portable Executable that execve refuses with ENOEXEC) is the tether's own
// wrapper now: util/tether.test.ts "a file with no shebang runs through sh, as llamafile needs", and
// manager.tether.test.ts loads a shebang-less stand-in through a real Manager.

// Readiness runs the Python load-failure check for vLLM and SGLang too: the banner must name the
// engine that failed and its package, not always MLX / mlx-lm.
test('detectPyLoadFailure: the message names the engine and package that failed to load the model', () => {
  const traceback = [
    'Traceback (most recent call last):',
    '  File "/venv/lib/python3.12/site-packages/x/loader.py", line 10, in load_model',
    'ValueError: unsupported architecture Foo',
  ]
  const vllm = detectPyLoadFailure('vllm', traceback) ?? ''
  assert.match(vllm, /^vLLM could not load this model — ValueError: unsupported architecture Foo /)
  assert.match(vllm, /installed vllm version/)
  assert.doesNotMatch(vllm, /MLX|mlx-lm/)
  assert.match(detectPyLoadFailure('sglang', traceback) ?? '', /^SGLang could not load .* installed sglang version/)
  assert.match(detectPyLoadFailure('mlx', traceback) ?? '', /^MLX could not load .* installed mlx-lm version/)
})

// The child env is what actually reaches the spawned engine, so the vLLM model-runner choice
// (vllm.ts `vllmModelRunnerEnv`) is verified here, at the point where it is merged in.

function withDaemonEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]))
  assignDaemonEnv(vars)
  try {
    run()
  } finally {
    assignDaemonEnv(saved)
  }
}

function assignDaemonEnv(vars: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

function freshDataDir(t: TestContext): string {
  const dataDir = tmpDir('turbollm-pyenv-')
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

function venvPythonIn(dataDir: string): string {
  return join(dataDir, 'engines', 'vllm', 'venv', 'bin', 'python')
}

const ON_WSL = { WSL_DISTRO_NAME: 'Ubuntu-24.04', VLLM_USE_V2_MODEL_RUNNER: undefined }

test('pyEngineEnv: a vLLM child spawned on WSL runs the V1 model runner', (t) => {
  const dataDir = freshDataDir(t)
  withDaemonEnv(ON_WSL, () => {
    assert.equal(pyEngineEnv('vllm', dataDir, venvPythonIn(dataDir))?.VLLM_USE_V2_MODEL_RUNNER, '0')
  })
})

test('pyEngineEnv: the runner the user set on the daemon passes through to the vLLM child untouched', (t) => {
  const dataDir = freshDataDir(t)
  withDaemonEnv({ ...ON_WSL, VLLM_USE_V2_MODEL_RUNNER: '1' }, () => {
    assert.equal(pyEngineEnv('vllm', dataDir, venvPythonIn(dataDir))?.VLLM_USE_V2_MODEL_RUNNER, '1')
  })
})

test('pyEngineEnv: SGLang children on WSL never get the vLLM runner override', (t) => {
  const dataDir = freshDataDir(t)
  withDaemonEnv(ON_WSL, () => {
    assert.equal(pyEngineEnv('sglang', dataDir, venvPythonIn(dataDir))?.VLLM_USE_V2_MODEL_RUNNER, undefined)
  })
})
