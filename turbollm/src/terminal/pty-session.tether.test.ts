// A Code terminal is tied to the daemon (util/tether.ts tetherTerminal): closing the terminal, its shell exiting, or
// the daemon ending, however it ends, ends everything started in it. Before, the 'exit' handler and the next start's
// reaper killed the shell's pid alone, and nothing ran when the daemon was SIGKILLed: an agent CLI that ignores the
// hangup, a `nohup` server or a `(trap "" HUP; …) &` job ran on, parented to init, and closing the terminal (or
// typing `exit`) left them too. POSIX only: Windows terminals keep today's behaviour until the job sentinel.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { TerminalManager, killTrackedTerminalsSync, reapStaleTerminals } from './terminal-manager'
import { PTYSession } from './pty-session'
import { isGone, killRecorded, pidWrittenTo, record, srcUrl, startStandInDaemon, waitGone, writtenTo } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'
import { PTY_WATCH, closeAllLifelines, stopTethered } from '../util/tether'

const skip = process.platform === 'win32' ? 'POSIX sessions (Windows terminals are tied by the job sentinel)' : false
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The launch command: an agent CLI stand-in that ignores the hangup, in the shell's own group (as a CLI the
 *  terminal launches is), writing its pid. pty-session.ts runs it as `-lc "<this>; exec bash"`. */
const LAUNCH = `bash -c 'trap "" HUP; echo $$ > cli.pid; exec sleep 400' & sleep 0.2`

/** What the user types: a plain background job, a `nohup` one and one that ignores the hangup itself (each in a
 *  job-control group of its own), and the env check. Each writes its pid (or output) to a file in the cwd. */
const TYPED = [
  ['sleep 401 & echo $! > j1.pid', 'j1.pid'],
  ['nohup sleep 402 >/dev/null 2>&1 & echo $! > j2.pid', 'j2.pid'],
  ['(trap "" HUP; exec sleep 403) & echo $! > j3.pid', 'j3.pid'],
  ['env | grep "^GIT_CONFIG_" | sort > gc.env', 'gc.env'],
] as const

/** The watcher of the terminal whose shell is `shellPid` (its command line ends with `sh <shellPid>`). */
function watcherOf(shellPid: number): number {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' })
  for (const line of String(r.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m && m[2].includes('SID=$1') && m[2].trimEnd().endsWith(` sh ${shellPid}`)) return Number(m[1])
  }
  return 0
}

/** Start the jobs in a terminal whose shell runs in `dir`, typing through `write`. Returns every pid involved. */
async function startJobs(dir: string, shellPid: number, write: (data: string) => void): Promise<{ cli: number; jobs: number[]; watcher: number }> {
  const cli = await pidWrittenTo(join(dir, 'cli.pid'))
  record(cli)
  await sleep(300) // the interactive shell is up
  const jobs: number[] = []
  for (const [line, file] of TYPED) {
    write(`${line}\n`)
    const text = await writtenTo(join(dir, file))
    if (file.endsWith('.pid')) {
      jobs.push(Number(text.trim()))
      record(Number(text.trim()))
    }
  }
  const watcher = watcherOf(shellPid)
  record(watcher)
  return { cli, jobs, watcher }
}

function assertGcEnv(dir: string): void {
  const lines = readFileSync(join(dir, 'gc.env'), 'utf8').trim().split('\n')
  const n = Number(process.env.GIT_CONFIG_COUNT) > 0 ? Number(process.env.GIT_CONFIG_COUNT) : 0 // the shell inherits ours
  for (const want of [`GIT_CONFIG_COUNT=${n + 2}`, `GIT_CONFIG_KEY_${n}=gc.autoDetach`, `GIT_CONFIG_VALUE_${n}=false`,
    `GIT_CONFIG_KEY_${n + 1}=maintenance.autoDetach`, `GIT_CONFIG_VALUE_${n + 1}=false`]) {
    assert.ok(lines.includes(want), `the shell's env runs git's automatic gc in the foreground (${want}): ${lines.join(', ')}`)
  }
}

test('a SIGKILLed daemon takes everything its Code terminal started: a hangup-proof CLI, background and nohup jobs', { skip }, async () => {
  const dir = tmpDir('tllm-pty-tether-')
  const d = await startStandInDaemon(`
import { PTYSession } from ${srcUrl('terminal/pty-session.ts')}
const s = PTYSession.spawn(process.cwd(), 24, 80, ${JSON.stringify(LAUNCH)})
report({ shell: s.getPid() })
process.stdin.setEncoding('utf8')
process.stdin.on('data', (line: string) => s.write(line))
`, { cwd: dir })
  try {
    const { shell } = await d.next<{ shell: number }>()
    record(shell)
    const { cli, jobs, watcher } = await startJobs(dir, shell, (data) => d.child.stdin?.write(data))
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone([shell, cli, ...jobs], 3000), [], 'the shell, the CLI and every job are gone within 3 s')
    assert.ok(watcher > 0, 'the terminal had a watcher')
    assert.deepEqual(await waitGone([watcher], 1000), [], 'and the watcher is gone too')
    assertGcEnv(dir)
  } finally {
    killRecorded(d.pid)
  }
})

test('closing a Code terminal (TerminalManager.kill) ends everything started in it', { skip }, async () => {
  const dir = tmpDir('tllm-pty-tether-')
  const m = new TerminalManager(tmpDir('tllm-pty-data-'))
  let id = ''
  try {
    id = m.create(dir, null, 80, 24, LAUNCH)
    const shell = (m as unknown as { sessions: Map<string, PTYSession> }).sessions.get(id)?.getPid() ?? 0
    record(shell)
    const { cli, jobs, watcher } = await startJobs(dir, shell, (data) => m.write(id, data))
    await sleep(200)
    assert.deepEqual([cli, ...jobs].filter(isGone), [], 'all four outlive their commands while the terminal is open')
    m.kill(id)
    assert.deepEqual(await waitGone([shell, cli, ...jobs, watcher], 3000), [], 'the shell, the CLI, every job and the watcher are gone within 3 s')
  } finally {
    if (id) m.kill(id)
    killRecorded()
  }
})

test('a Code terminal whose shell exits takes what it left running with it', { skip }, async () => {
  const dir = tmpDir('tllm-pty-tether-')
  const m = new TerminalManager(tmpDir('tllm-pty-data-'))
  let id = ''
  try {
    id = m.create(dir, null, 80, 24, LAUNCH)
    const shell = (m as unknown as { sessions: Map<string, PTYSession> }).sessions.get(id)?.getPid() ?? 0
    record(shell)
    const { cli, jobs, watcher } = await startJobs(dir, shell, (data) => m.write(id, data))
    m.write(id, 'exit\n')
    assert.deepEqual(await waitGone([shell], 3000), [], 'the shell exited')
    assert.deepEqual(await waitGone([cli, ...jobs, watcher], 3000), [], 'the CLI, every job and the watcher went with it')
  } finally {
    if (id) m.kill(id)
    killRecorded()
  }
})

test('reapStaleTerminals and killTrackedTerminalsSync kill the shell\'s whole group', { skip }, async () => {
  /** A stand-in shell leading its own group (as node-pty's shell does), with a background job in that group. */
  const startShell = async (dir: string) => {
    const shell = spawn('/bin/sh', ['-c', `sleep 300 & echo $! > ${JSON.stringify(join(dir, 'member.pid'))}; exec sleep 301`], { detached: true, stdio: 'ignore' })
    record(shell.pid)
    const member = await pidWrittenTo(join(dir, 'member.pid'))
    record(member)
    return { pid: shell.pid as number, member }
  }
  const writePidfile = (dataDir: string, pid: number, owner: number) => {
    mkdirSync(join(dataDir, 'run'), { recursive: true })
    writeFileSync(join(dataDir, 'run', `terminal-${pid}.pid`), JSON.stringify({ pid, owner, startedAt: Date.now(), group: true }))
  }
  try {
    const reapDir = tmpDir('tllm-term-group-')
    const orphan = await startShell(reapDir)
    writePidfile(reapDir, orphan.pid, 0)
    assert.equal(reapStaleTerminals(reapDir), 1)
    assert.deepEqual(await waitGone([orphan.pid, orphan.member], 2000), [], 'the next start\'s reaper kills the group, not the shell alone')

    const ownDir = tmpDir('tllm-term-group-')
    const own = await startShell(ownDir)
    writePidfile(ownDir, own.pid, process.pid)
    killTrackedTerminalsSync(ownDir)
    assert.deepEqual(await waitGone([own.pid, own.member], 2000), [], 'the exit handler kills the group, not the shell alone')
  } finally {
    killRecorded()
  }
})

test('the daemon\'s graceful stop (stopTethered) and the restart keeper (closeAllLifelines) end every Code terminal', { skip }, async () => {
  const sessions: PTYSession[] = []
  try {
    for (const end of ['stopTethered', 'closeAllLifelines'] as const) {
      const dir = tmpDir('tllm-pty-tether-')
      const s = PTYSession.spawn(dir, 24, 80, LAUNCH)
      sessions.push(s)
      const shell = s.getPid() ?? 0
      record(shell)
      const { cli, jobs } = await startJobs(dir, shell, (data) => s.write(data))
      const t0 = Date.now()
      if (end === 'stopTethered') await stopTethered(500)
      else closeAllLifelines()
      assert.deepEqual(await waitGone([shell, cli, ...jobs], 3000), [], `${end}: the shell, the CLI and every job are gone`)
      if (end === 'stopTethered') assert.ok(Date.now() - t0 >= 900, 'the graceful stop waited for the terminal\'s sweep')
    }
  } finally {
    for (const s of sessions) s.dispose()
    killRecorded()
  }
})

test('an exported TMOUT ends no Code terminal where /bin/sh is bash: its watcher waits for the release, then ends it', { skip: skip || (spawnSync('sh', ['-c', 'command -v bash']).status === 0 ? false : 'needs bash') }, async () => {
  const dir = tmpDir('tllm-pty-tmout-')
  const bash = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
  // A link named sh runs bash as /bin/sh runs on macOS and Fedora.
  const asSh = join(dir, 'sh')
  symlinkSync(bash, asSh)
  const ties: Array<{ sh: string; shell: number; lifeline: Socket }> = []
  try {
    for (const sh of [asSh, bash, '/bin/sh']) {
      // A stand-in shell, a session leader as node-pty's is, and its watcher, started as tetherTerminal starts it.
      const shell = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
      record(shell.pid)
      const watcher = spawn(sh, ['-c', PTY_WATCH, 'sh', String(shell.pid)], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env: { ...process.env, TMOUT: '1' } })
      record(watcher.pid)
      ties.push({ sh: sh === asSh ? 'bash as /bin/sh' : sh, shell: shell.pid as number, lifeline: watcher.stdio[3] as Socket })
    }
    await sleep(2000)
    for (const t of ties) assert.equal(isGone(t.shell), false, `${t.sh}: the terminal outlived TMOUT=1`)
    for (const t of ties) t.lifeline.destroy()
    assert.deepEqual(await waitGone(ties.map((t) => t.shell), 3000), [], 'its release still ends each one')
  } finally {
    killRecorded()
  }
})
