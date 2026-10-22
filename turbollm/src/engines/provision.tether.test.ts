// A Python engine's install (uv venv, uv pip install), an engine binary's version probe and the other async probes
// run through util/tether.ts. Their timeouts (none for an install, which runs for minutes) are daemon timers, which
// nothing enforces once the daemon is gone: a SIGKILLed daemon left a multi-GB install, or a probe hung on a wedged
// driver, running, parented to init.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { killRecorded, record, srcUrl, startStandInDaemon, waitGone, writtenTo } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'

const skip = process.platform === 'win32' ? 'POSIX shell stand-ins' : false

/** A stand-in program at `path` that records its pid and a child's, then hangs. */
function hanging(path: string, pids: string): void {
  writeFileSync(path, `#!/bin/sh\nsleep 300 &\necho "$$ $!" > ${pids}\nwait\n`)
  chmodSync(path, 0o755)
}

async function pidsIn(file: string): Promise<number[]> {
  const deadline = Date.now() + 5000
  for (;;) {
    const pids = (await writtenTo(file)).trim().split(' ').map(Number)
    if (pids.length === 2 && pids.every((p) => p > 0)) return pids
    if (Date.now() >= deadline) throw new Error(`${file} holds no two pids`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function killedWithDaemon(snippet: string, pids: string): Promise<void> {
  const d = await startStandInDaemon(`${snippet}\nreport({ started: true })\nsetInterval(() => {}, 1e9)\n`)
  try {
    await d.next()
    const running = await pidsIn(pids)
    record(...running)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone(running, 1000), [], 'the program and its child are gone within 1 s')
  } finally {
    killRecorded(d.pid)
  }
}

test('a daemon SIGKILLed during a Python engine install takes uv with it', { skip }, async () => {
  const root = tmpDir('tllm-provision-tether-')
  mkdirSync(join(root, 'uv'))
  const pids = join(root, 'uv.pids')
  hanging(join(root, 'uv', 'uv'), pids) // ensureUv finds <root>/uv/uv and downloads nothing
  await killedWithDaemon(`
import { ensureVllmEnv } from ${srcUrl('engines/vllm.ts')}
void ensureVllmEnv(${JSON.stringify(root)}).catch(() => {})`, pids)
})

test('a daemon SIGKILLed while an engine binary\'s version probe hangs takes it with it', { skip }, async () => {
  const dir = tmpDir('tllm-probe-tether-')
  const pids = join(dir, 'engine.pids')
  const bin = join(dir, 'llama-server')
  hanging(bin, pids)
  await killedWithDaemon(`
import { probe } from ${srcUrl('engines/probe.ts')}
void probe(${JSON.stringify(bin)}).catch(() => {})`, pids)
})

test('a daemon SIGKILLed while the uvloop preflight hangs takes the Python with it', { skip }, async () => {
  const dir = tmpDir('tllm-uvloop-tether-')
  const pids = join(dir, 'python.pids')
  const python = join(dir, 'python')
  hanging(python, pids)
  await killedWithDaemon(`
import { UvloopPreflight } from ${srcUrl('engines/py-engine-blocker.ts')}
void new UvloopPreflight('vLLM').blockerFor(${JSON.stringify(python)})`, pids)
})
