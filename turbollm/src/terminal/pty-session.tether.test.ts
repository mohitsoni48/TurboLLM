// A Code terminal is tied to the daemon (util/tether.ts tetherTerminal): closing the terminal, its shell exiting, or
// the daemon ending, however it ends, ends everything started in it. Before, the 'exit' handler and the next start's
// reaper killed the shell's pid alone, and nothing ran when the daemon was SIGKILLed: an agent CLI that ignores the
// hangup, a `nohup` server or a `(trap "" HUP; …) &` job ran on, parented to init, and closing the terminal (or
// typing `exit`) left them too. POSIX only: Windows terminals keep today's behaviour until the job sentinel.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { TerminalManager, killTrackedTerminalsSync, reapStaleTerminals } from './terminal-manager'
import { PTYSession } from './pty-session'
import { isGone, killRecorded, pidWrittenTo, record, srcUrl, startStandInDaemon, waitGone, writtenTo } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'
import { PTY_WATCH, _setPtyWatch, closeAllLifelines, stopTethered, tetherTerminal } from '../util/tether'

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

/** For a failure message: each of `pids` still running, as ps shows it (pid, ppid, pgid, state, command), so a run
 *  that fails says what was left and where it sat. */
function described(pids: number[]): string {
  if (pids.length === 0) return ''
  const r = spawnSync('ps', ['-o', 'pid=,ppid=,pgid=,stat=,command=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 10_000 })
  return `; still running: ${String(r.stdout ?? '').trim().split('\n').map((l) => l.trim()).join(' | ')}`
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
    const left = await waitGone([shell, cli, ...jobs], 3000)
    assert.deepEqual(left, [], `the shell, the CLI and every job are gone within 3 s${described(left)}`)
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
    const left = await waitGone([shell, cli, ...jobs, watcher], 3000)
    assert.deepEqual(left, [], `the shell, the CLI, every job and the watcher are gone within 3 s${described(left)}`)
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
    const left = await waitGone([cli, ...jobs, watcher], 3000)
    assert.deepEqual(left, [], `the CLI, every job and the watcher went with it${described(left)}`)
  } finally {
    if (id) m.kill(id)
    killRecorded()
  }
})

/** The number of getsid(2) for perl's syscall(): xnu's 310 on macOS (PTY_WATCH's own), elsewhere this system's,
 *  from perl's syscall.ph or the kernel's table; null where perl or the number is missing. `getpid` for a number
 *  that is not getsid's. */
function syscallNumber(name: 'getsid' | 'getpid'): number | null {
  if (process.platform === 'darwin') return name === 'getsid' ? 310 : 20
  const r = spawnSync('perl', ['-e', `require "syscall.ph"; print &SYS_${name}`], { encoding: 'utf8', timeout: 10_000 })
  if (r.status === 0 && /^\d+$/.test(r.stdout)) return Number(r.stdout)
  if (spawnSync('perl', ['-e', '1']).status !== 0) return null
  const table: Record<string, Record<string, number>> = { x64: { getsid: 124, getpid: 39 }, arm64: { getsid: 156, getpid: 172 } }
  return table[process.arch]?.[name] ?? null
}
const noPerl = skip || (syscallNumber('getsid') === null ? 'needs perl and the getsid syscall number' : false)

/** PTY_WATCH as macOS runs it, here too: its /proc branch never taken, and perl given this system's getsid number
 *  (or `nr`) for xnu's. Each edit must apply: a PTY_WATCH that changed shape fails here instead of testing nothing. */
function asOnMacos(nr: number, edits: Array<[string, string]> = []): string {
  let script = PTY_WATCH
  for (const [from, to] of [['[ -d /proc/self ]', 'false'], ['"$$" 310 ', `"$$" ${nr} `], ...edits] as Array<[string, string]>) {
    assert.ok(script.includes(from), `PTY_WATCH still has ${JSON.stringify(from)}`)
    script = script.replace(from, () => to) // a function: `$$` in a replacement string is one `$`
  }
  return script
}

/** A stand-in terminal for the sweep macOS takes: a session leader, as node-pty's shell is, that starts a job in its
 *  own group, one in a group of its own and one in a group of its own that ignores the hangup (as `nohup` and job
 *  control leave them), then exits, as a shell does at `exit`: from then on only the session id ties the last two to
 *  it. Returns its pid (alive) and, once it has exited, the jobs' pids. */
function startStandInTerminal(dir: string): { shell: number; exited: Promise<void>; jobs: () => Promise<number[]> } {
  const own = (file: string, ignoreHup: boolean) =>
    `perl -e '${ignoreHup ? '$SIG{HUP} = "IGNORE"; ' : ''}setpgrp(0, 0); exec @ARGV' sleep 300 & echo $! > ${file}`
  const shell = spawn('/bin/sh', ['-c', `sleep 300 & echo $! > g.pid; ${own('j1.pid', false)}; ${own('j2.pid', true)}; exec sleep 1`],
    { cwd: dir, detached: true, stdio: 'ignore' })
  record(shell.pid)
  const exited = new Promise<void>((resolve) => shell.once('exit', () => resolve()))
  const jobs = async () => {
    const pids = [await pidWrittenTo(join(dir, 'g.pid')), await pidWrittenTo(join(dir, 'j1.pid')), await pidWrittenTo(join(dir, 'j2.pid'))]
    record(...pids)
    return pids
  }
  return { shell: shell.pid as number, exited, jobs }
}

/** A `pkill` as macOS's is (Apple's takes no -s, and refuses it as an illegal option), first on PATH for the
 *  watcher, so the sweep macOS takes cannot pass here through Linux's pkill -s. */
function macosPkillFirst(dir: string): () => void {
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pkill'), '#!/bin/sh\necho "pkill: illegal option -- s" >&2\nexit 2\n', { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path ?? ''}`
  return () => { process.env.PATH = path }
}

test('on macOS a terminal whose shell has exited still takes its jobs in groups of their own with it, and nothing outside its session', { skip: noPerl }, async () => {
  const dir = tmpDir('tllm-pty-macsweep-')
  const restorePath = macosPkillFirst(dir)
  _setPtyWatch(asOnMacos(syscallNumber('getsid') as number))
  const outsider = spawn('sleep', ['300'], { stdio: 'ignore' }) // in the test's own session
  record(outsider.pid)
  const warned: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(args.join(' ')) }
  try {
    const t = startStandInTerminal(dir)
    const tie = tetherTerminal(t.shell)
    const watcher = watcherOf(t.shell)
    record(watcher)
    assert.ok(watcher > 0, 'the terminal has a watcher')
    const jobs = await t.jobs()
    await t.exited
    await sleep(200)
    assert.deepEqual(jobs.filter(isGone), [], 'the jobs outlive their shell until the terminal is released')
    tie.release()
    const left = await waitGone([...jobs, watcher], 3000)
    // What the watcher logged goes into the message: console.warn is held here, and a sweep that failed says why there.
    const logged = warned.filter((l) => l.includes('[tether]'))
    assert.deepEqual(left, [], `the job in the shell's group, both in groups of their own and the watcher are gone${described(left)}${
      logged.length > 0 ? `; logged: ${JSON.stringify(logged)}` : ''}`)
    assert.equal(isGone(outsider.pid as number), false, 'a process outside the terminal\'s session is left alone')
    assert.deepEqual(warned.filter((l) => l.includes('[tether]')), [], 'nothing was logged')
  } finally {
    console.warn = warn
    _setPtyWatch(null)
    restorePath()
    killRecorded()
  }
})

test('a terminal\'s watcher that cannot read session ids on macOS says why in the daemon\'s log', { skip: noPerl }, async () => {
  const cases: Array<{ what: string; script: string; says: string }> = [
    { what: 'no perl', says: 'no perl to read the session ids with',
      script: asOnMacos(syscallNumber('getsid') as number, [['P=/usr/bin/perl;', 'P=/nonexistent/perl;'], ['command -v perl)', 'command -v perl-not-installed)']]) },
    { what: 'a getsid that does not work', says: 'did not give its own session', script: asOnMacos(syscallNumber('getpid') as number) },
  ]
  const warned: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(args.join(' ')) }
  try {
    for (const c of cases) {
      const dir = tmpDir('tllm-pty-macsweep-')
      _setPtyWatch(c.script)
      const t = startStandInTerminal(dir)
      const tie = tetherTerminal(t.shell)
      const watcher = watcherOf(t.shell)
      record(watcher)
      const [inGroup, ...ownGroups] = await t.jobs()
      await t.exited
      tie.release()
      assert.deepEqual(await waitGone([inGroup, watcher], 3000), [], `${c.what}: the shell's group still ends, and the watcher exits`)
      await sleep(100) // its 'exit' event
      const line = warned.find((l) => l.includes(`[tether] terminal ${t.shell}:`))
      assert.ok(line?.includes(c.says), `${c.what}: the daemon logged why (${c.says}); got ${JSON.stringify(warned)}`)
      assert.deepEqual(ownGroups.filter(isGone), [], `${c.what}: and nothing it could not check was killed`)
    }
  } finally {
    console.warn = warn
    _setPtyWatch(null)
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
      const left = await waitGone([shell, cli, ...jobs], 3000)
      assert.deepEqual(left, [], `${end}: the shell, the CLI and every job are gone${described(left)}`)
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

// The watcher hung up the shell's pid. A shell that exited has been reaped by node-pty by the time the watcher fires
// (the exit is what releases it), so that pid could name another process by then. Here the watcher is handed the pid
// of a process outside any terminal, as a shell's reused pid would be: in the test's own group and session, leading
// neither. It must get no hangup.
test('a terminal\'s watcher hangs up no process outside its shell\'s group, such as one that got a reaped shell\'s pid', { skip }, async () => {
  const dir = tmpDir('tllm-pty-hup-')
  const hup = join(dir, 'hup')
  const other = spawn(process.execPath, ['-e', `const fs = require('fs'); process.on('SIGHUP', () => fs.writeFileSync(${JSON.stringify(hup)}, 'HUP'));
fs.writeFileSync(${JSON.stringify(join(dir, 'other.pid'))}, String(process.pid)); setInterval(() => {}, 1000)`], { stdio: 'ignore' })
  record(other.pid)
  try {
    await pidWrittenTo(join(dir, 'other.pid')) // its SIGHUP handler is in place
    const watcher = spawn('/bin/sh', ['-c', PTY_WATCH, 'sh', String(other.pid)], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
    record(watcher.pid)
    ;(watcher.stdio[3] as Socket).destroy() // the release
    assert.deepEqual(await waitGone([watcher.pid as number], 5000), [], 'the watcher fired and finished')
    assert.equal(existsSync(hup), false, 'the process got no hangup')
    assert.equal(isGone(other.pid as number), false, 'and runs on')
  } finally {
    killRecorded()
  }
})

/** How to run `unshare` here, as pid1.test.ts does: as root directly, through `sudo -n`, or not at all. */
function unshareVia(): string[] | null {
  if (process.platform !== 'linux') return null
  const works = (argv: string[]) => spawnSync(argv[0], argv.slice(1), { stdio: 'ignore', timeout: 10_000 }).status === 0
  const ns = ['unshare', '--pid', '--fork', '--mount-proc', 'true']
  if (process.getuid?.() === 0 && works(ns)) return []
  if (works(['sudo', '-n', ...ns])) return ['sudo', '-n']
  return null
}
const nsVia = skip ? null : unshareVia()

/** Run as PID 1 of a pid namespace of its own, where ns_last_pid can be set: a stand-in shell (a session leader, as
 *  node-pty's is) and its watcher; the shell exits and is reaped, then a new process is given the shell's pid,
 *  leading a group and session of its own (`leader`, as a job-control job or a daemon does) or not; then the
 *  release. Prints what that process got. */
const REUSED_PID = `
const { spawn } = require('child_process')
const fs = require('fs')
const [watch, mode, dir] = process.argv.slice(1)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  const shell = spawn('/bin/sh', ['-c', 'sleep 0.3'], { detached: true, stdio: 'ignore' })
  const pid = shell.pid
  const watcher = spawn('/bin/sh', ['-c', fs.readFileSync(watch, 'utf8'), 'sh', String(pid)], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
  await new Promise((r) => shell.once('exit', r))
  await sleep(100)
  fs.writeFileSync('/proc/sys/kernel/ns_last_pid', String(pid - 1))
  const other = spawn(process.execPath, ['-e', "process.on('SIGHUP', () => require('fs').writeFileSync(" + JSON.stringify(dir + '/hup') + ", 'HUP')); setInterval(() => {}, 1000)"], { detached: mode === 'leader', stdio: 'ignore' })
  let endedBy = null
  other.once('exit', (code, signal) => { endedBy = signal })
  await sleep(500)
  const stat = fs.readFileSync('/proc/' + other.pid + '/stat', 'utf8')
  const pgid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2])
  watcher.stdio[3].destroy()
  await new Promise((r) => watcher.once('exit', r))
  await sleep(300)
  console.log(JSON.stringify({ reused: other.pid === pid, leads: pgid === other.pid, hup: fs.existsSync(dir + '/hup'), endedBy }))
  try { process.kill(other.pid, 'SIGKILL') } catch {}
  process.exit(0)
})()
`

// A shell that exited has been reaped by node-pty by the time its watcher fires, and its pid can be given to a new
// process, which may lead a group and a session of that id: a job-control job, a daemon. The watcher's hangup to the
// shell's group, its kill and its session sweep then reached it. Now nothing is signalled once the pid names a process
// started at another time than the shell.
test('a terminal\'s watcher signals nothing once its shell\'s pid names another process, one leading its own group too', { skip: skip || (nsVia === null ? 'needs Linux and `unshare --pid --fork --mount-proc` (root, or passwordless sudo)' : false) }, () => {
  const dir = tmpDir('tllm-pty-reuse-')
  const watch = join(dir, 'watch.sh')
  writeFileSync(watch, PTY_WATCH)
  for (const mode of ['leader', 'not-leader']) {
    const run = join(dir, mode)
    mkdirSync(run)
    const argv = [...(nsVia ?? []), 'unshare', '--pid', '--fork', '--kill-child', '--mount-proc', process.execPath, '-e', REUSED_PID, watch, mode, run]
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' })
    const line = String(r.stdout ?? '').trim().split('\n').at(-1) ?? ''
    assert.ok(line.startsWith('{'), `${mode}: the namespace said ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`)
    const got = JSON.parse(line) as { reused: boolean; leads: boolean; hup: boolean; endedBy: string | null }
    assert.equal(got.reused, true, `${mode}: the new process got the shell's pid`)
    assert.equal(got.leads, mode === 'leader', mode)
    assert.deepEqual([got.hup, got.endedBy], [false, null], `${mode}: it got no hangup and was not killed`)
  }
})
