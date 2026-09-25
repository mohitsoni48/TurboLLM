// The Laya engine is a Python engine like MLX and vLLM: offline Hugging Face, the TurboLLM hf-cache, and the venv
// on PATH — and it is launched through the laya launcher, never with llama.cpp flags.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { Engine } from '../config/config'
import { LAYA_LAUNCHER_SOURCE } from './laya'
import { engineCommand, pyEngineEnv, type StartOpts } from './manager'

function freshDataDir(t: TestContext): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'turbollm-laya-env-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

test('pyEngineEnv: a Laya child never reaches for the Hub and caches inside the TurboLLM data dir', (t) => {
  const dataDir = freshDataDir(t)
  const python = join(dataDir, 'engines', 'laya', 'venv', 'bin', 'python')
  const env = pyEngineEnv('laya', dataDir, python)
  assert.equal(env?.HF_HUB_OFFLINE, '1')
  assert.equal(env?.TRANSFORMERS_OFFLINE, '1')
  assert.equal(env?.HF_HOME, join(dataDir, 'hf-cache'))
  assert.ok(env?.PATH?.startsWith(join(dataDir, 'engines', 'laya', 'venv', 'bin')))
})

test('engineCommand: a Laya engine runs the launcher on loopback with the model folder, ignoring any extra args', () => {
  const engine = { id: 'laya', kind: 'laya', binPath: '/venv/bin/python', capabilities: { flags: [], kvTypes: [] } } as unknown as Engine
  const opts = { engine, modelPath: '/models/laya', extraArgs: ['--ctx-size', '4096'] } as unknown as StartOpts
  assert.deepEqual(engineCommand(opts, 6997), {
    cmd: '/venv/bin/python',
    args: ['-c', LAYA_LAUNCHER_SOURCE, '/models/laya', '127.0.0.1', '6997'],
  })
})

test('pyEngineEnv: a LAYA_API_KEY set on the daemon is not handed to the Laya engine, which would then refuse every forwarded request', (t) => {
  const dataDir = freshDataDir(t)
  const before = process.env.LAYA_API_KEY
  process.env.LAYA_API_KEY = 'secret'
  t.after(() => {
    if (before === undefined) delete process.env.LAYA_API_KEY
    else process.env.LAYA_API_KEY = before
  })
  const env = pyEngineEnv('laya', join(dataDir), join(dataDir, 'engines', 'laya', 'venv', 'bin', 'python'))
  assert.equal(env?.LAYA_API_KEY, undefined)
})
