// LiteRT-LM is a Python engine launched as a module with a --config file; its child env is the shared Python one.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { Engine } from '../config/config'
import { engineCommand, pyEngineEnv, type StartOpts } from './manager'
import { tmpDir } from '../test-support/tmp'

const engine = { id: 'lrt', kind: 'litert-lm', binPath: '/venv/bin/python', capabilities: { flags: [], kvTypes: [] } } as unknown as Engine

test('engineCommand: litert-lm launches the CLI module with the config path, loopback host and the port', () => {
  const opts = { engine, modelPath: '/models/m.litertlm', extraArgs: ['--verbose'] } as unknown as StartOpts
  assert.deepEqual(engineCommand(opts, 8090, undefined, '/data/engines/litert-lm/config-8090.json'), {
    cmd: '/venv/bin/python',
    args: ['-m', 'litert_lm_cli.main', 'serve', '--config', '/data/engines/litert-lm/config-8090.json', '--host', '127.0.0.1', '--port', '8090', '--verbose'],
  })
})

test('engineCommand: the model path is not a launch argument (it travels in each request)', () => {
  const opts = { engine, modelPath: '/models/m.litertlm', extraArgs: [] } as unknown as StartOpts
  const { args } = engineCommand(opts, 8090, undefined, 'c.json')
  assert.ok(!args.includes('/models/m.litertlm'))
})

test('pyEngineEnv: a LiteRT-LM child gets the Python-engine env (offline Hub, venv on PATH), not the native-engine one', (t: TestContext) => {
  const dataDir = tmpDir('turbollm-litert-env-')
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const python = join(dataDir, 'engines', 'litert-lm', 'venv', 'bin', 'python')
  const env = pyEngineEnv('litert-lm', dataDir, python)
  assert.equal(env?.HF_HUB_OFFLINE, '1')
  assert.equal(env?.HF_HOME, join(dataDir, 'hf-cache'))
  assert.ok(env?.PATH?.startsWith(join(dataDir, 'engines', 'litert-lm', 'venv', 'bin')))
  assert.equal(env?.LD_LIBRARY_PATH, process.env.LD_LIBRARY_PATH)
})
