// An agent CLI install (`npm install -g …`, up to 180 s) and the CLI probes (cli-launch.ts realRunCommand, and
// realRunCommandWithin, which the Routines preflight and the Code agent picker run) end with the daemon
// (util/tether.ts): their timeouts are daemon timers, so a SIGKILLed daemon left them running, parented to init. A
// probe also ends at its own deadline. Stand-ins record their pids in files.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { groupMembers, isGone, killRecorded, record, srcUrl, startStandInDaemon, waitGone } from '../test-support/stand-in-daemon'
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

// The daemon's own probes (the Code agent picker's and the Routines preflights' `<bin> --version`) start their CLI
// through realRunCommandWithin, isCliAvailable's default, not realRunCommand: a daemon SIGKILLed while one runs, before
// its deadline, takes it with it too, its child and the tether's watcher included.
test('a daemon SIGKILLed during a CLI probe with a deadline (realRunCommandWithin) takes the CLI with it', { skip }, async () => {
  const dir = tmpDir('tllm-run-command-within-')
  const { bin, pids } = hangingBin(dir, 'claude')
  const d = await startStandInDaemon(`
import { isCliAvailable } from ${srcUrl('routines/cli-preflight.ts')}
void isCliAvailable('claude', undefined, 60_000)
report({ started: true })
setInterval(() => {}, 1e9)
`, { env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })
  try {
    await d.next()
    const running = await pidsFrom(pids)
    const group = groupMembers(running[0])
    record(...running, ...group)
    assert.equal(group.length, 3, `claude, its child and the tether's watcher in claude's group, got ${group}`)
    assert.ok(running.every((pid) => group.includes(pid)), `claude and its child (${running}) are in the group ${group}`)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone(group, 1000), [], 'everything in the group is gone within 1 s')
  } finally {
    killRecorded(d.pid)
  }
})

// GET /api/v1/code/agents awaited one `<bin> --version` per harness, which had no deadline: a `claude --version` that
// never returned (reproduced live) left the request unanswered for good, and the CLI running until the daemon ended.
test('a CLI whose `--version` never answers is ended at the probe deadline, and the agent picker still answers', { skip }, async () => {
  const dir = tmpDir('tllm-wedged-probe-')
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const pids = join(dir, 'claude.pids')
  // claude ignores SIGTERM, starts a child (which inherits that), and never exits; pi answers; opencode fails.
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ntrap '' TERM\nsleep 300 &\necho "$$ $!" > ${pids}\nwait\n`)
  writeFileSync(join(bin, 'pi'), '#!/bin/sh\necho 0.82.1\n')
  writeFileSync(join(bin, 'opencode'), '#!/bin/sh\nexit 1\n')
  for (const name of ['claude', 'pi', 'opencode']) chmodSync(join(bin, name), 0o755)
  const d = await startStandInDaemon(`
import { agentAvailability } from ${srcUrl('code/agent-availability.ts')}
import { isCliAvailable } from ${srcUrl('routines/cli-preflight.ts')}
const began = Date.now()
const agents = await agentAvailability(Date.now, (bin) => isCliAvailable(bin, undefined, 1000))
report({ ms: Date.now() - began, agents: agents.map((a) => [a.id, a.installed]) })
setInterval(() => {}, 1e9)
`, { env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })
  try {
    const wedged = await pidsFrom(pids)
    // claude leads its group (spawnTethered), which holds its child and the tether's watcher too.
    record(...wedged, ...groupMembers(wedged[0]))
    const { ms, agents } = await d.next<{ ms: number; agents: Array<[string, boolean]> }>(30_000)
    assert.ok(ms >= 1000 && ms < 6000, `answered at the 1 s deadline, not before it or long after: ${ms} ms`)
    assert.deepEqual(agents, [['claude', true], ['pi', true], ['opencode', false]], 'the wedged claude was found and started: installed')
    assert.deepEqual(await waitGone(wedged, 2000), [], 'the TERM-ignoring claude and its child are gone')
    assert.equal(isGone(d.pid), false, 'the stand-in daemon still runs: the deadline ended them, not its lifeline')
    const deadline = Date.now() + 1000
    while (groupMembers(wedged[0]).length > 0 && Date.now() < deadline) await sleep(25)
    assert.deepEqual(groupMembers(wedged[0]), [], "nothing is left in the probe's group, its watcher included")
    assert.match(d.stderr(), /`claude --version` did not answer within 1000 ms: it was ended, and claude counts as installed/)
  } finally {
    killRecorded(d.pid)
  }
})
