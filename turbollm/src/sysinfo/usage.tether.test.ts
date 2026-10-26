// The usage monitor's readers run through util/tether.ts: the streamed one (the WDDM counter stream, iostat) ended
// only at stop() and a polled one (nvidia-smi, ioreg, rocm-smi) only at its daemon-timer timeout, so a daemon that
// died without its teardown left them running, parented to init (a counter stream for good).
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { killRecorded, record, srcUrl, startStandInDaemon, waitGone, writtenTo } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'

const skip = process.platform === 'win32' ? 'POSIX shell stand-ins' : false

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

test('a daemon SIGKILLed with the usage monitor\'s stream running takes the stream with it', { skip }, async () => {
  const dir = tmpDir('tllm-usage-stream-')
  const pids = join(dir, 'stream.pids')
  const stream = join(dir, 'counter-stream')
  hanging(stream, pids)
  const d = await startStandInDaemon(`
import { createStreamingReader } from ${srcUrl('sysinfo/usage.ts')}
createStreamingReader('wddm', ${JSON.stringify(stream)}, [], () => null).start()
report({ started: true })
setInterval(() => {}, 1e9)
`)
  try {
    await d.next()
    const running = await pidsIn(pids)
    record(...running)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone(running, 1000), [], 'the stream and its child are gone within 1 s')
  } finally {
    killRecorded(d.pid)
  }
})

test('a daemon SIGKILLed while a GPU poll (nvidia-smi) hangs takes it with it', { skip }, async () => {
  const dir = tmpDir('tllm-usage-poll-')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const pids = join(dir, 'nvidia-smi.pids')
  hanging(join(bin, 'nvidia-smi'), pids)
  const d = await startStandInDaemon(`
import { pickReader } from ${srcUrl('sysinfo/usage.ts')}
void pickReader({ gpus: [{ vendor: 'nvidia' }] } as never).read()
report({ started: true })
setInterval(() => {}, 1e9)
`, { env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })
  try {
    await d.next()
    const running = await pidsIn(pids)
    record(...running)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone(running, 1000), [], 'nvidia-smi and its child are gone within 1 s')
  } finally {
    killRecorded(d.pid)
  }
})
