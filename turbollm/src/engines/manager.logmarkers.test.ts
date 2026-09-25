// Engine-log marker tests (B1b + B2). Reproduces the user-reported scenario: an
// engine that "connects to the listening port and then fails / closes". We drive
// the real Manager with a fake engine binary (node itself, which rejects the
// llama-server args and exits non-zero at once), then assert the engine log:
//   • opens with the internal-port header (B2 — kills the "says 8081" confusion)
//   • is capped with an explicit exit marker (B1b — so the live log can't keep
//     "looking connected" after the process dies)
//   • and that the engine never falsely reaches "running" (ends in "error").
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore } from '../config/config'
import { Manager, type StartOpts } from './manager'
import { tmpDir } from '../test-support/tmp'

const FAKE_MODEL_PATH = join(tmpDir('tllm-fake-model-'), 'does-not-need-to-exist.gguf')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fakeOpts(): StartOpts {
  return {
    // node rejects "-m <path> --host …" and exits immediately → mimics a crashing
    // engine without needing a real llama-server build or GPU.
    engine: {
      id: 'test', name: 'Fake Engine', binPath: process.execPath, kind: 'llama-server',
      version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '',
    },
    model: { key: 'm', name: 'Fake Model', quant: 'Q4', ctx: 4096, vision: false },
    modelPath: FAKE_MODEL_PATH,
    extraArgs: [],
  }
}

async function waitForState(m: Manager, want: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (m.status().state === want) return
    await sleep(50)
  }
  throw new Error(`state never became "${want}" (last: ${m.status().state})`)
}

test('engine log carries the port header + exit marker, and never falsely shows running', async () => {
  const dir = tmpDir('tllm-test-')
  const store = ConfigStore.load(join(dir, 'config.json'))
  const manager = new Manager(store)

  await manager.start(fakeOpts())
  // The fake engine exits at once → Manager must land in "error", never "running".
  await waitForState(manager, 'error')

  const log = readFileSync(manager.logPath(), 'utf8')
  assert.match(log, /\[turbollm\] starting engine "Fake Engine" on internal port \d+/, 'missing port header (B2)')
  assert.match(log, /NOT the TurboLLM app\/UI port/, 'header should disambiguate the app port (B2)')
  assert.match(log, /\[turbollm\] engine process exited unexpectedly \(exit/, 'missing crash marker (B1b)')
})
