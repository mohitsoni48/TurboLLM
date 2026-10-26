// resolveLikeExec (util/tether.ts) must name exactly the program an unwrapped spawn would run, or the wrapper runs a
// different program than the caller asked for (or none, untethered). Each case is checked against the OS itself:
// an unwrapped spawn of the same name, cwd and env, where every candidate prints which one it is. On Linux that is
// libuv's execvp; on macOS it is libuv's own posix_spawn PATH walk, which the CI `tether` job runs.
// util/resolve-executable.ts, used before for this, got four of these wrong: `./x` against the daemon's cwd,
// `bin/y` and a child env with no PATH untethered, and an empty PATH entry untethered.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { killRecorded, srcUrl, startStandInDaemon } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'
import { resolveLikeExec } from './tether'

const skip = process.platform === 'win32' ? 'POSIX lookup' : false

/** What the OS ran for `file`: the identity line the candidate printed, or the spawn's error code. */
function osRuns(file: string, opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve) => {
    const c = spawn(file, [], { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    c.stdout?.on('data', (b: Buffer) => { out += b.toString() })
    c.once('error', (e: NodeJS.ErrnoException) => resolve(`error ${e.code}`))
    c.once('close', () => resolve(out.trim()))
  })
}

/** A candidate program that prints `id`. */
function candidate(path: string, id: string, mode = 0o755): void {
  writeFileSync(path, `#!/bin/sh\necho ${id}\n`)
  chmodSync(path, mode)
}

test('resolveLikeExec names the program the OS runs, in all ten cases of the lookup matrix', { skip }, async () => {
  const root = tmpDir('tllm-tether-lookup-')
  const dir = (name: string) => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p }
  const cwdA = dir('cwdA')
  const cwdB = dir('cwdB')
  const p1 = dir('p1')
  const p2 = dir('p2')
  const p3 = dir('p3')
  const p4 = dir('p4')
  candidate(join(cwdA, 'x'), 'cwdA/x')
  candidate(join(cwdB, 'x'), 'cwdB/x')
  dir('cwdA/bin')
  dir('cwdB/bin')
  candidate(join(cwdA, 'bin', 'y'), 'cwdA/bin/y')
  candidate(join(cwdB, 'bin', 'y'), 'cwdB/bin/y')
  candidate(join(p1, 'z'), 'p1/z', 0o644) // exists, not executable: skipped
  candidate(join(p2, 'z'), 'p2/z')
  candidate(join(p2, 'x'), 'p2/x')
  mkdirSync(join(p3, 'w')) // a directory named w: skipped
  candidate(join(p4, 'w'), 'p4/w')
  const { PATH: _path, ...noPath } = process.env
  const cases: Array<{ name: string; file: string; cwd: string; env: NodeJS.ProcessEnv }> = [
    { name: './x, cwd B', file: './x', cwd: cwdB, env: process.env },
    { name: 'bin/y, cwd B', file: 'bin/y', cwd: cwdB, env: process.env },
    { name: 'z, PATH p1 (not +x) then p2', file: 'z', cwd: cwdB, env: { ...process.env, PATH: `${p1}:${p2}` } },
    { name: 'w, PATH p3 (a directory w) then p4', file: 'w', cwd: cwdB, env: { ...process.env, PATH: `${p3}:${p4}` } },
    { name: 'ls, the child env has no PATH', file: 'ls', cwd: cwdB, env: noPath },
    { name: 'x, PATH with an empty entry, cwd B', file: 'x', cwd: cwdB, env: { ...process.env, PATH: `:${p2}` } },
    { name: 'z, PATH only in the child env', file: 'z', cwd: cwdB, env: { ...noPath, PATH: p2 } },
    { name: 'z, a relative PATH entry, cwd B', file: 'z', cwd: cwdB, env: { ...process.env, PATH: '../p2' } },
    { name: 'a missing command', file: 'turbollm-no-such-program-xyz', cwd: cwdB, env: process.env },
    { name: 'z, PATH p1 only (not +x)', file: 'z', cwd: cwdB, env: { ...process.env, PATH: p1 } },
  ]
  const previous = process.cwd()
  process.chdir(cwdA) // the daemon's cwd differs from the child's in every case
  try {
    for (const c of cases) {
      const ran = await osRuns(c.file, { cwd: c.cwd, env: c.env })
      const resolved = resolveLikeExec(c.file, { cwd: c.cwd, env: c.env })
      if (ran.startsWith('error ')) {
        assert.equal(resolved, null, `${c.name}: the OS refused it (${ran}), so the resolver must find nothing`)
        continue
      }
      assert.ok(resolved, `${c.name}: the OS ran "${ran}" but the resolver found nothing`)
      if (c.file === 'ls') {
        // Every candidate here is the system's own ls: the resolver must have found one on libc's default path.
        assert.match(resolved, /^\/(usr\/)?bin\/ls$/, c.name)
        continue
      }
      const viaResolved = await osRuns(resolved, { cwd: c.cwd, env: c.env })
      assert.equal(viaResolved, ran, `${c.name}: the resolver named ${resolved}, the OS ran ${ran}`)
    }
  } finally {
    process.chdir(previous)
  }
})

// With no PATH in the child's env, Linux's libuv calls execvp, whose default is libc's own: glibc searches /bin
// before /usr/bin. On a merged /usr both /bin/sh and /usr/bin/sh exist, so the resolver's order shows; on a host
// where they are different files it decides which program runs.
const glibcReport = process.platform === 'linux'
  ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime
  : undefined
test('a child env with no PATH is searched in libc\'s own order: glibc\'s /bin before /usr/bin', { skip: glibcReport ? false : 'Linux with glibc' }, () => {
  const { PATH: _path, ...noPath } = process.env
  assert.equal(resolveLikeExec('sh', { env: noPath }), '/bin/sh')
})

// The libc check behind that order runs once, on the daemon's event loop, at the first spawn whose env has no PATH.
// It must not build a process report: getReport() first looks up every TCP handle's endpoints by reverse DNS,
// synchronously (a 127.0.0.1 socket comes back as "localhost"), which blocks the daemon while a resolver is slow.
// A stand-in daemon of its own, so the check has not run yet in it.
test('the libc check for a child env with no PATH builds no process report, which would look up every socket by DNS', { skip: process.platform === 'linux' ? false : 'Linux: the libc check' }, async () => {
  const d = await startStandInDaemon(`
import { resolveLikeExec } from ${srcUrl('util/tether.ts')}
let reports = 0
const realGetReport = process.report.getReport.bind(process.report)
process.report.getReport = ((...a: Parameters<typeof realGetReport>) => { reports++; return realGetReport(...a) }) as typeof process.report.getReport
const { PATH: _path, ...noPath } = process.env
const resolved = resolveLikeExec('sh', { env: noPath })
report({ resolved, reports })
`)
  try {
    const { resolved, reports } = await d.next<{ resolved: string | null; reports: number }>()
    assert.match(resolved ?? '', /^\/(usr\/)?bin\/sh$/, 'found on libc\'s default path')
    assert.equal(reports, 0, 'no process report was built')
  } finally {
    killRecorded(d.pid)
  }
})
