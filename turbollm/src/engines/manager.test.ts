import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { needsShellWrapper, pyEngineEnv, shellWrapped } from './manager'

// Regression: llamafile ships as an "Actually Portable Executable" (Cosmopolitan libc) polyglot —
// spawning it directly via Node's execve()-based spawn() failed with ENOEXEC on macOS (confirmed
// live: the daemon accepted the start request but the process never actually spawned), while
// running the identical binary through a shell worked immediately. needsShellWrapper/shellWrapped
// fix this by routing llamafile through `/bin/sh -c 'exec "$0" "$@"'` on non-Windows platforms.

test('needsShellWrapper: true for llamafile on macOS/Linux', () => {
  const orig = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  try {
    assert.equal(needsShellWrapper('llamafile'), true)
  } finally {
    Object.defineProperty(process, 'platform', { value: orig })
  }
})

test('needsShellWrapper: false for llamafile on Windows (native MZ/PE header already works)', () => {
  const orig = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    assert.equal(needsShellWrapper('llamafile'), false)
  } finally {
    Object.defineProperty(process, 'platform', { value: orig })
  }
})

test('needsShellWrapper: false for every other engine kind', () => {
  for (const kind of ['llama-server', 'mlx', 'rapid-mlx', 'mlx-vlm', 'vllm', 'sglang', 'koboldcpp']) {
    assert.equal(needsShellWrapper(kind), false, `expected ${kind} to not need a shell wrapper`)
  }
})

test('shellWrapped: routes through /bin/sh with cmd/args as separate argv entries (no string concatenation)', () => {
  const { cmd, args } = shellWrapped('/path/to/llamafile', ['--server', '-m', '/path with spaces/model.gguf'])
  assert.equal(cmd, '/bin/sh')
  assert.deepEqual(args, ['-c', 'exec "$0" "$@"', '/path/to/llamafile', '--server', '-m', '/path with spaces/model.gguf'])
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
  const dataDir = mkdtempSync(join(tmpdir(), 'turbollm-pyenv-'))
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
