// A routine's headless `claude` and the tool processes it starts end with the daemon (util/tether.ts). Its
// 10-minute timeout is a daemon timer, so a SIGKILLed or crashed daemon left the CLI and its tools running, parented
// to init. The stand-in `claude` reads its prompt from stdin, starts a tool child, records both pids in files and
// waits; it never writes to stdio after the daemon died.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { runClaudeCliProcess } from './cli-process'
import { stopTethered } from '../util/tether'
import { killRecorded, record, srcUrl, startStandInDaemon, waitGone } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'

const skip = process.platform === 'win32' ? 'a POSIX shell stand-in for claude' : false
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeClaude(dir: string): { bin: string; claudePid: string; toolPid: string } {
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const claudePid = join(dir, 'claude.pid')
  const toolPid = join(dir, 'tool.pid')
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat >/dev/null\nsleep 300 &\necho $! > ${toolPid}\necho $$ > ${claudePid}\nwait\n`)
  chmodSync(join(bin, 'claude'), 0o755)
  return { bin, claudePid, toolPid }
}

async function pidsFrom(...files: string[]): Promise<number[]> {
  const deadline = Date.now() + 5000
  while (!files.every((f) => existsSync(f) && readFileSync(f, 'utf8').trim()) && Date.now() < deadline) await sleep(25)
  return files.map((f) => Number(readFileSync(f, 'utf8')))
}

test('a daemon SIGKILLed during a routine run takes `claude` and its tool child with it', { skip }, async () => {
  const dir = tmpDir('tllm-routine-cli-')
  const { bin, claudePid, toolPid } = fakeClaude(dir)
  const d = await startStandInDaemon(`
import { runClaudeCliProcess } from ${srcUrl('routines/cli-process.ts')}
void runClaudeCliProcess(['-p', '--output-format', 'stream-json'], { cwd: process.cwd(), env: process.env, stdin: 'list the TODOs' })
report({ started: true })
setInterval(() => {}, 1e9)
`, { env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })
  try {
    await d.next()
    const pids = await pidsFrom(claudePid, toolPid)
    record(...pids)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone(pids, 1000), [], 'claude and its tool are gone within 1 s')
  } finally {
    killRecorded(d.pid)
  }
})

test('stopTethered() (the daemon\'s graceful stop) ends a running routine CLI and its tools, and the run resolves', { skip }, async () => {
  const dir = tmpDir('tllm-routine-cli-stop-')
  const { bin, claudePid, toolPid } = fakeClaude(dir)
  try {
    const running = runClaudeCliProcess(['-p'], { cwd: dir, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }, stdin: 'x' })
    const pids = await pidsFrom(claudePid, toolPid)
    record(...pids)
    await stopTethered(1000)
    const result = await Promise.race([running, sleep(3000).then(() => null)])
    assert.ok(result, 'the run resolved')
    assert.equal(result.timedOut, false)
    assert.deepEqual(await waitGone(pids, 1000), [])
  } finally {
    killRecorded()
  }
})

test('an unresolvable `claude` still fails as sh reports it: exit 127 and "not found"', { skip }, async () => {
  const dir = tmpDir('tllm-routine-cli-missing-')
  const result = await runClaudeCliProcess(['-p'], { cwd: dir, env: { ...process.env, PATH: join(dir, 'empty') }, stdin: 'x' })
  assert.equal(result.exitCode, 127)
  assert.match(result.stderr, /claude: (command )?not found/)
})
