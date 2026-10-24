// Restart (the UI button shown for an engine in 'error') retries the model whose load just failed, even
// when it failed before an engine process was spawned; it used to reload the PREVIOUS model, and the
// failed load's "show launch command" showed that previous model's command line.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore } from '../config/config'
import { Manager, type StartOpts } from './manager'
import { tmpDir } from '../test-support/tmp'

/** Model X on a "llama.cpp" engine that is node itself: it rejects the llama-server args and exits. */
const MODEL_X: StartOpts = {
  engine: {
    id: 'llama', name: 'llama.cpp', binPath: process.execPath, kind: 'llama-server',
    version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '',
  },
  model: { key: 'X', name: 'X', quant: '', ctx: 0, vision: false },
  modelPath: join(tmpDir('tllm-restart-'), 'X.gguf'),
  extraArgs: [],
}

/** Model Y on a vLLM engine whose interpreter is missing: the preflight refuses it before any spawn. */
const MODEL_Y: StartOpts = {
  engine: {
    id: 'vllm', name: 'vLLM', binPath: join(tmpDir('tllm-restart-'), 'no-venv', 'bin', 'python'), kind: 'vllm',
    version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '',
  },
  model: { key: 'Y', name: 'Y', quant: '', ctx: 0, vision: false },
  modelPath: '/models/Y',
  extraArgs: [],
}

test('restart after a load that failed before spawning retries that model, not the previous one', async () => {
  const manager = new Manager(ConfigStore.load(join(tmpDir('tllm-restart-'), 'config.json')))
  const attempts: string[] = []
  manager.onLoadSettled = (_ok, _err, opts) => attempts.push(opts.model.key)
  await manager.load(MODEL_X)
  assert.ok(manager.launchCommand(), 'X was spawned, so its command is shown')

  await manager.load(MODEL_Y)
  assert.equal(manager.status().err?.code, 'engine_unsupported')
  assert.equal(manager.launchCommand(), null, "Y's error must not show X's command line")

  await manager.restart()

  assert.deepEqual(attempts, ['X', 'Y', 'Y'])
  assert.equal(manager.status().err?.code, 'engine_unsupported')
})

test('restart after a load refused by its pre-start hook retries that model', async () => {
  const manager = new Manager(ConfigStore.load(join(tmpDir('tllm-restart-'), 'config.json')))
  await manager.load(MODEL_X)
  const refused = manager.load(MODEL_Y, { beforeStart: async () => { throw new Error('refused') } })
  await assert.rejects(refused, /refused/)

  const attempts: string[] = []
  manager.onLoadSettled = (_ok, _err, opts) => attempts.push(opts.model.key)
  await manager.restart()

  assert.deepEqual(attempts, ['Y'])
})
