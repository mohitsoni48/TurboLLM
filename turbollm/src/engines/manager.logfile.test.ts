// The engine log file: a failed write must never take the daemon down or stall the engine, and a
// gateway pool slot on the primary's engine must not share (and truncate) the primary's file.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore } from '../config/config'
import { Manager, type StartOpts } from './manager'
import { tmpDir } from '../test-support/tmp'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** node rejects "-m <path> --host …" and exits at once: a crashing engine with no real build. */
function crashingEngine(binPath = process.execPath): StartOpts {
  return {
    engine: {
      id: 'test', name: 'Fake Engine', binPath, kind: 'llama-server',
      version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '',
    },
    model: { key: 'm', name: 'Fake Model', quant: 'Q4', ctx: 4096, vision: false },
    modelPath: join(tmpDir('tllm-fake-model-'), 'model.gguf'),
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

/** A data dir whose primary engine log can't be written: the path is a directory, so the stream errors. */
function unwritableLogStore(): ConfigStore {
  const dir = tmpDir('tllm-logerr-')
  mkdirSync(join(dir, 'logs', 'engine-test.log'), { recursive: true })
  return ConfigStore.load(join(dir, 'config.json'))
}

test('a log stream error (disk full, unwritable file) is not an unhandled error event', async (t) => {
  // The stream errors asynchronously, possibly after the engine has already exited: the test waits for the manager's
  // handler to report it, so an unhandled 'error' event fails THIS test while it runs, not just the file afterwards.
  let handled = false
  const warn = console.warn
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    if (String(args[0]).includes('log write failed')) handled = true
    else warn(...args)
  })
  const manager = new Manager(unwritableLogStore())

  await manager.start(crashingEngine())

  await waitForState(manager, 'error')
  assert.equal(manager.status().err?.code, 'engine_exited')
  const deadline = Date.now() + 5_000
  while (!handled && Date.now() < deadline) await sleep(20)
  assert.ok(handled, 'the log stream error reached the manager\'s error handler')
})

// pipe() unpipes on the stream error and pauses the engine's stdout: once the OS pipe buffer
// (64 KiB) fills, a native engine blocks on its next log line for good.
test('after a log stream error the engine output is still drained, so the engine never blocks on it', {
  skip: process.platform === 'win32' && 'uses a POSIX shell script as the fake engine',
}, async (t) => {
  const script = join(tmpDir('tllm-chatty-'), 'chatty-engine')
  writeFileSync(script, '#!/bin/sh\ni=0\nwhile [ $i -lt 4000 ]; do echo "log line $i ................................................"; i=$((i+1)); done\nexit 3\n')
  chmodSync(script, 0o755)
  const manager = new Manager(unwritableLogStore())
  t.after(() => manager.stopAndWait({ force: true })) // a blocked engine would otherwise outlive the test

  // Not awaited first: start() holds until the engine leaves 'starting', which a blocked engine never does.
  const started = manager.start(crashingEngine(script))

  await waitForState(manager, 'error')
  await started
  assert.equal(manager.status().err?.exitCode, 3)
})

test('a pool slot on the primary engine logs to its own file and leaves the primary log intact', async () => {
  const store = ConfigStore.load(join(tmpDir('tllm-slotlog-'), 'config.json'))
  const primary = new Manager(store)
  const slot = new Manager(store, { poolSlot: true })
  await primary.start(crashingEngine())
  await waitForState(primary, 'error')
  const primaryLog = readFileSync(primary.logPath(), 'utf8')

  await slot.start(crashingEngine())
  await waitForState(slot, 'error')

  assert.equal(primary.logPath(), join(store.dir(), 'logs', 'engine-test.log'), 'the primary keeps its log path')
  assert.notEqual(slot.logPath(), primary.logPath())
  assert.equal(readFileSync(primary.logPath(), 'utf8'), primaryLog)
  assert.match(readFileSync(slot.logPath(), 'utf8'), /\[turbollm\] starting engine "Fake Engine"/)
})
