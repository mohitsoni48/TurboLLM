// An agent CLI install (`npm install -g …`, up to 180 s) and the daemon's CLI probes (cli-launch.ts realRunCommand,
// which the Routines preflight and prepareHermes run) end with the daemon (util/tether.ts): their timeouts are
// daemon timers, so a SIGKILLed daemon left them running, parented to init. Stand-ins record their pids in files.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { killRecorded, record, srcUrl, startStandInDaemon, waitGone } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'

const skip = process.platform === 'win32' ? 'POSIX shell stand-ins' : false
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A stand-in for `name` on PATH that records its pid and a child's, then hangs. */
function hangingBin(dir: string, name: string): { bin: string; pids: string } {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const pids = join(dir, `${name}.pids`)
  writeFileSync(join(bin, name), `#!/bin/sh\nsleep 300 &\necho "$$ $!" > ${pids}\nwait\n`)
  chmodSync(join(bin, name), 0o755)
  return { bin, pids }
}

async function pidsFrom(file: string): Promise<number[]> {
  const deadline = Date.now() + 5000
  while (!(existsSync(file) && readFileSync(file, 'utf8').trim().split(' ').length === 2) && Date.now() < deadline) await sleep(25)
  return readFileSync(file, 'utf8').trim().split(' ').map(Number)
}

test('a daemon SIGKILLed during an agent CLI install takes the install with it', { skip }, async () => {
  const dir = tmpDir('tllm-agent-install-')
  const { bin, pids } = hangingBin(dir, 'npm')
  const d = await startStandInDaemon(`
import { installAgent } from ${srcUrl('code/agent-availability.ts')}
void installAgent('claude')
report({ started: true })
setInterval(() => {}, 1e9)
`, { env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })
  try {
    await d.next()
    const running = await pidsFrom(pids)
    record(...running)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone(running, 1000), [], 'npm and its child are gone within 1 s')
  } finally {
    killRecorded(d.pid)
  }
})

test('a daemon SIGKILLed during a CLI probe (realRunCommand) takes the CLI with it', { skip }, async () => {
  const dir = tmpDir('tllm-run-command-')
  const { bin, pids } = hangingBin(dir, 'hermes')
  const d = await startStandInDaemon(`
import { realRunCommand } from ${srcUrl('cli-launch.ts')}
void realRunCommand('hermes', ['config', 'set', 'model.provider', 'custom'])
report({ started: true })
setInterval(() => {}, 1e9)
`, { env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })
  try {
    await d.next()
    const running = await pidsFrom(pids)
    record(...running)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone(running, 1000), [])
  } finally {
    killRecorded(d.pid)
  }
})
