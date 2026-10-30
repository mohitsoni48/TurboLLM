// A stand-in daemon for the tests that kill one: a TS snippet run as a process of its own
// (`process.execPath --import tsx`), which starts children the way the daemon does and reports their pids, so a
// test can SIGKILL it (TerminateProcess on Windows) and check that nothing it started is left.
//
// Rules every test that uses it keeps (the processes are real, and other test files share the machine):
//   - every pid it learns is recorded, and killed by pid in a `finally` (killRecorded), never by name;
//   - a stand-in child never writes to stdio after the daemon died: a dead daemon's pipe turns that write into
//     SIGPIPE or EPIPE, which kills the child before its own TERM handling can run (a git stand-in died that way,
//     as strace showed), and the test would pass or fail for the wrong reason.
// `TURBOLLM_TEST_STANDIN_NODE` names another node binary to run the snippet with (the Node 18.20.4 run by hand,
// the runtime the Android bundle ships).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpDir } from './tmp'

const require = createRequire(import.meta.url)
const SRC = fileURLToPath(new URL('..', import.meta.url))
const TSX_LOADER = pathToFileURL(require.resolve('tsx')).href

/** The file URL of a module under src/, for a snippet's imports: `import { x } from ${srcUrl('util/tether.ts')}`. */
export function srcUrl(relative: string): string {
  return JSON.stringify(pathToFileURL(join(SRC, relative)).href)
}

export interface StandInDaemon {
  child: ChildProcess
  pid: number
  /** The next message the snippet sent with `report(...)` (in order), within `ms`. */
  next<T = Record<string, unknown>>(ms?: number): Promise<T>
  /** Everything the daemon wrote to stderr so far. */
  stderr(): string
  /** Kill the daemon itself (SIGKILL; TerminateProcess on Windows) and wait for its exit. */
  kill(signal?: NodeJS.Signals): Promise<void>
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

/** Every pid a test learned (daemons included), for killRecorded. */
const recorded = new Set<number>()
export function record(...pids: Array<number | undefined | null>): void {
  for (const p of pids) if (typeof p === 'number' && p > 0) recorded.add(p)
}

/** The prefix of a report line: whatever else the modules a snippet loads print to stdout is ignored. */
const REPORT = '@@stand-in-daemon '

/** Run `snippet` (a TS module body) as a stand-in daemon. It has `report(value)`, which sends `value` to the test
 *  as one JSON line on stdout, and `reportSync(value)`, which has written it when it returns. */
export async function startStandInDaemon(snippet: string, opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<StandInDaemon> {
  const dir = tmpDir('tllm-stand-in-daemon-')
  // .mts: an ES module wherever the temp directory is, so a snippet may await at its top level.
  const file = join(dir, 'daemon.mts')
  writeFileSync(file, [
    `import { writeSync as __reportWriteSync } from 'node:fs'`,
    `const report = (value: unknown): void => { process.stdout.write(${JSON.stringify(REPORT)} + JSON.stringify(value) + '\\n') }`,
    // For a snippet that kills itself right after: written before the next line runs.
    `const reportSync = (value: unknown): void => { __reportWriteSync(1, ${JSON.stringify(REPORT)} + JSON.stringify(value) + '\\n') }`,
    snippet,
    '',
  ].join('\n'))
  const node = process.env.TURBOLLM_TEST_STANDIN_NODE || process.execPath
  const child = spawn(node, ['--import', TSX_LOADER, file], {
    cwd: opts.cwd ?? dir,
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  record(child.pid)
  const queue: unknown[] = []
  const waiters: Array<(v: unknown) => void> = []
  let buf = ''
  let err = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buf += chunk
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.startsWith(REPORT)) continue
      const msg: unknown = JSON.parse(line.slice(REPORT.length))
      const w = waiters.shift()
      if (w) w(msg)
      else queue.push(msg)
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { err += chunk })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  if (child.pid === undefined) throw new Error(`could not start the stand-in daemon with ${node}`)
  const daemon: StandInDaemon = {
    child,
    pid: child.pid,
    exited,
    stderr: () => err,
    next<T>(ms = 15_000): Promise<T> {
      if (queue.length > 0) return Promise.resolve(queue.shift() as T)
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(take)
          if (i >= 0) waiters.splice(i, 1)
          reject(new Error(`the stand-in daemon sent nothing within ${ms} ms; its stderr:\n${err}`))
        }, ms)
        const take = (v: unknown) => { clearTimeout(timer); resolve(v as T) }
        waiters.push(take)
        void exited.then(({ code, signal }) => {
          if (waiters.includes(take)) {
            waiters.splice(waiters.indexOf(take), 1)
            clearTimeout(timer)
            reject(new Error(`the stand-in daemon exited (${code ?? signal}) before reporting; its stderr:\n${err}`))
          }
        })
      })
    },
    async kill(signal: NodeJS.Signals = 'SIGKILL') {
      try {
        child.kill(signal)
      } catch {
        /* already gone */
      }
      await exited
    },
  }
  return daemon
}

/** Whether `pid` is gone. A zombie counts as gone: it holds nothing, and the sandbox's own PID 1 may take seconds to
 *  reap a process it adopted. Linux reads /proc; macOS and the rest ask `ps`; Windows asks the process table. */
export function isGone(pid: number): boolean {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, 0)
      return false
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== 'EPERM'
    }
  }
  if (process.platform === 'linux' || process.platform === 'android') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
      return state === 'Z' || state === 'X'
    } catch {
      return true
    }
  }
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  const state = String(r.stdout ?? '').trim()
  return state === '' || state.startsWith('Z')
}

/** Wait until every one of `pids` is gone, up to `ms`. Returns the ones still alive (empty: all gone). */
export async function waitGone(pids: number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms
  for (;;) {
    const alive = pids.filter((p) => !isGone(p))
    if (alive.length === 0 || Date.now() >= deadline) return alive
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** What a test's child wrote to `file`, once it is not empty (up to `ms`, then it throws). A shell's `echo x > f`
 *  and Node's writeFileSync both create the file before they write to it, so a read as soon as the file exists can
 *  come back empty: a marker that is not there yet, or a pid of 0, which record() drops and isGone() calls gone, so
 *  every assertion made on it passes without checking anything. A short write is one write(2): not empty is whole. */
export async function writtenTo(file: string, ms = 5000): Promise<string> {
  const deadline = Date.now() + ms
  for (;;) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      /* not created yet */
    }
    if (text !== '') return text
    if (Date.now() >= deadline) throw new Error(`nothing was written to ${file} within ${ms} ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** The pid a test's child wrote to `file` (see writtenTo). */
export async function pidWrittenTo(file: string, ms = 5000): Promise<number> {
  const text = await writtenTo(file, ms)
  const pid = Number(text.trim())
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`${file} holds ${JSON.stringify(text)}, not a pid`)
  return pid
}

/** The live members of process group `pgid` (POSIX), zombies left out. */
export function groupMembers(pgid: number): number[] {
  if (process.platform === 'linux' || process.platform === 'android') {
    const out: number[] = []
    for (const d of readdirProc()) {
      try {
        const stat = readFileSync(`/proc/${d}/stat`, 'utf8')
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        if (Number(f[2]) === pgid && f[0] !== 'Z' && f[0] !== 'X') out.push(Number(d))
      } catch {
        /* gone meanwhile */
      }
    }
    return out
  }
  const r = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' })
  const out: number[] = []
  for (const line of String(r.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line)
    if (m && Number(m[2]) === pgid && !m[3].startsWith('Z')) out.push(Number(m[1]))
  }
  return out
}

function readdirProc(): string[] {
  try {
    return readdirSync('/proc').filter((d) => /^\d+$/.test(d))
  } catch {
    return []
  }
}

/** Every live descendant of `pid` (POSIX, one `ps` of the whole table), for recording what a stand-in started. */
export function descendantsOf(pid: number): number[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
  const children = new Map<number, number[]>()
  for (const line of String(r.stdout ?? '').split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number)
    if (p && pp) children.set(pp, [...(children.get(pp) ?? []), p])
  }
  const out: number[] = []
  const walk = (p: number) => { for (const c of children.get(p) ?? []) { out.push(c); walk(c) } }
  walk(pid)
  return out
}

/** Pids of the live processes whose command line contains `marker` (POSIX), for finding a watcher, which shares
 *  the command line of the `sh -c <script> <program> <args…>` it was forked from. */
export function pidsWithArg(marker: string): number[] {
  if (process.platform === 'linux' || process.platform === 'android') {
    const out: number[] = []
    for (const d of readdirProc()) {
      try {
        if (readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(marker) && !isGone(Number(d))) out.push(Number(d))
      } catch {
        /* gone meanwhile */
      }
    }
    return out
  }
  const r = spawnSync('ps', ['-A', '-o', 'pid=,stat=,command='], { encoding: 'utf8' })
  const out: number[] = []
  for (const line of String(r.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (m && m[3].includes(marker) && !m[2].startsWith('Z') && Number(m[1]) !== process.pid) out.push(Number(m[1]))
  }
  return out
}

/** This process and its ancestors (the test runner, npx, a shell): a pid a test recorded by mistake (a group
 *  member read from the test's own group, when the code under test did not give its child a group of its own) must
 *  never be one of them. */
function selfAndAncestors(): Set<number> {
  const out = new Set<number>([process.pid])
  if (process.platform === 'win32') return out
  let pid = process.ppid
  for (let i = 0; i < 32 && pid > 1 && !out.has(pid); i++) {
    out.add(pid)
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' })
    pid = Number(String(r.stdout ?? '').trim())
  }
  return out
}

/** SIGKILL every recorded pid that is still alive (TerminateProcess on Windows), by pid only. For a `finally`. */
export function killRecorded(...more: Array<number | undefined | null>): void {
  record(...more)
  const spared = selfAndAncestors()
  for (const pid of recorded) {
    if (spared.has(pid)) continue
    if (!isGone(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone meanwhile */
      }
    }
  }
  recorded.clear()
}
