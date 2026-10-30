// util/tether.ts: the lifeline wrapper (POSIX), held lifelines, tetheredExecFile, the graceful stop, and the
// Android helper's self-test. The tests that end with "daemon SIGKILL" run a stand-in daemon
// (test-support/stand-in-daemon.ts) and kill it; the rest run in this process, which plays the daemon. Every
// process a test learns about is killed by pid in its `finally`.
import assert from 'node:assert/strict'
import childProcess, { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { tmpDir } from '../test-support/tmp'
import {
  groupMembers, isGone, killRecorded, pidsWithArg, pidWrittenTo, record, srcUrl, startStandInDaemon, waitGone, writtenTo,
} from '../test-support/stand-in-daemon'
import {
  _resetAndroidTether, _setTetherBash, _setTetherEnvProgram, _setTetherResolver, _setTetherShell, closeAllLifelines, endTetheredGroup,
  initAndroidTether, killTetheredSync, killTetheredTree, recountHeld, releaseTetherScope, selfTestHelper, spawnHeld, spawnTethered,
  stopTethered, tetheredExecFile, wrapperScript,
} from './tether'

const posix = process.platform !== 'win32'
const posixOnly = { skip: posix ? false : 'POSIX lifeline wrapper' }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The POSIX shells the wrapper is checked under: /bin/sh always, bash and mksh when installed. */
function shells(): string[] {
  const out = ['/bin/sh']
  for (const name of ['bash', 'mksh']) {
    const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
    const p = String(r.stdout ?? '').trim()
    if (r.status === 0 && p) out.push(p)
  }
  return out
}

function has(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0
}

/** Children of `pid` (POSIX), zombies included: `ps` reads the whole table once. */
function childrenOf(pid: number): number[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
  return String(r.stdout ?? '').split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([, pp]) => pp === pid).map(([p]) => p)
}

function collect(child: ChildProcess): { out: () => Buffer; err: () => string } {
  const out: Buffer[] = []
  let err = ''
  child.stdout?.on('data', (b: Buffer) => out.push(b))
  child.stderr?.on('data', (b: Buffer) => { err += b.toString() })
  return { out: () => Buffer.concat(out), err: () => err }
}

const exitOf = (child: ChildProcess) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  child.once('exit', (code, signal) => resolve({ code, signal }))
})

/** A stand-in engine: starts a `sleep` grandchild, reports both pids once, then idles. It never writes again. */
function engineScript(dir: string): string {
  const file = join(dir, 'engine.cjs')
  writeFileSync(file, `
const { spawn } = require('child_process')
const g = spawn('sleep', ['300'], { stdio: 'ignore' })
process.stdout.write(JSON.stringify({ engine: process.pid, grandchild: g.pid }) + '\\n')
setInterval(() => {}, 1e9)
`)
  return file
}

function cleanup(): void {
  closeAllLifelines()
  killRecorded()
}

// ── The wrapper, under each shell ────────────────────────────────────────────────────────────────────────────────

for (const sh of posix ? shells() : []) {
  for (const fds of [3, 5]) {
    test(`daemon SIGKILL ends the engine, its grandchild and the watcher (lifeline on fd ${fds}, ${sh})`, async () => {
      const dir = tmpDir('tllm-tether-kill-')
      const engine = engineScript(dir)
      const stdio = JSON.stringify(Array.from({ length: fds }, () => 'pipe'))
      const d = await startStandInDaemon(`
import { spawnTethered, _setTetherShell } from ${srcUrl('util/tether.ts')}
_setTetherShell(${JSON.stringify(sh)})
const c = spawnTethered(process.execPath, [${JSON.stringify(engine)}], { stdio: ${stdio} }, { kind: 'engine' })
c.stdout!.once('data', (d) => report({ child: c.pid, ...JSON.parse(String(d)) }))
setInterval(() => {}, 1e9)
`)
      try {
        const msg = await d.next<{ child: number; engine: number; grandchild: number }>()
        record(msg.child, msg.grandchild)
        assert.equal(msg.engine, msg.child, 'child.pid is the engine itself: the wrapper exec()s it')
        const members = groupMembers(msg.child)
        record(...members)
        assert.equal(members.length, 3, `engine, grandchild and watcher in the engine's group, got ${members}`)
        assert.ok(members.includes(msg.grandchild))
        await d.kill('SIGKILL')
        assert.deepEqual(await waitGone(members, 1000), [], 'everything in the group is gone within 1 s')
      } finally {
        killRecorded(d.pid)
      }
    })
  }
}

/** Names dash, mksh and busybox ash drop at their exec (npm's per-registry token, a Spring profile, an exported bash
 *  function, a quote, a leading dash), one value with quotes, newlines and `$` in it. */
const UNNAMED_ENV: Record<string, string> = {
  'spring.profiles.active': 'dev',
  'npm_config_//registry.npmjs.org/:_authToken': `a 'b' "c"\n$HOME \`id\` $(id) \\ end\n`,
  'BASH_FUNC_tl_f%%': '() {  echo fn-ran\n}',
  'it\'s-x': 'quoted',
  '-dash': 'leading dash',
}
const PRINT_ENV = ['-e', 'process.stdout.write(JSON.stringify(process.env))']

for (const sh of posix ? shells() : []) {
  test(`with no bash, variables whose names are not shell identifiers reach the program through env byte for byte, and their carriers do not (${sh})`, async () => {
    const env = { ...process.env, ...UNNAMED_ENV, OK_VAR: 'ok' }
    const check = (got: Record<string, string>, what: string, want: Record<string, string> = { ...UNNAMED_ENV, OK_VAR: 'ok' }) => {
      for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${what}: ${k}`)
      assert.deepEqual(Object.keys(got).filter((k) => k.startsWith('TURBOLLM_TETHER_')), [], `${what}: no carrier reaches the program`)
    }
    // Android, Alpine: no bash to pass the names on, so each value travels past sh in a carrier.
    _setTetherBash(null)
    _setTetherShell(sh)
    try {
      const c = spawnTethered(process.execPath, PRINT_ENV, { env, stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'probe' })
      record(c.pid)
      const io = collect(c)
      await new Promise((r) => c.once('close', r))
      check(JSON.parse(io.out().toString()), 'spawnTethered')
      check(JSON.parse((await tetheredExecFile({ kind: 'probe' })(process.execPath, PRINT_ENV, { env })).stdout), 'tetheredExecFile')
      // The daemon's own environment, as a child inherits it with no `env` of its own (npm's config, from CI).
      for (const [k, v] of Object.entries(UNNAMED_ENV)) process.env[k] = v
      try {
        check(JSON.parse((await tetheredExecFile({ kind: 'probe' })(process.execPath, PRINT_ENV)).stdout), 'inherited', UNNAMED_ENV)
      } finally {
        for (const k of Object.keys(UNNAMED_ENV)) delete process.env[k]
      }
      if (process.platform === 'linux' && has('bash')) {
        // A Code bash command: bash runs the function exported to it (Environment Modules' `module`, `export -f`).
        const r = await tetheredExecFile({ kind: 'code-bash' })('bash', ['-c', 'tl_f'], { env })
        assert.equal(r.stdout, 'fn-ran\n')
      }
    } finally {
      _setTetherShell(null)
      _setTetherBash(undefined)
      cleanup()
    }
  })
}

test('where bash is installed it passes those names on itself: no value in any argv, no ~/.bashrc or BASH_ENV run, and no exported function stands in for the watcher\'s read or kill', { skip: posix && has('bash') ? false : 'needs bash' }, async () => {
  const dir = tmpDir('tllm-tether-bash-')
  const realBash = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
  // A stand-in bash that records its arguments, then runs the real one. Privileged itself (-p), so it runs no
  // BASH_ENV of its own, and bash passes every name on.
  const argvFile = join(dir, 'argv')
  const standIn = join(dir, 'bash')
  writeFileSync(standIn, `#!${realBash} -p\nprintf '%s\\0' "$@" > '${argvFile}'\nexec '${realBash}' "$@"\n`)
  chmodSync(standIn, 0o755)
  const ran = join(dir, 'ran')
  const home = join(dir, 'home')
  spawnSync('mkdir', ['-p', home])
  writeFileSync(join(home, '.bashrc'), `echo bashrc >> '${ran}'\n`)
  writeFileSync(join(dir, 'bash-env'), `echo BASH_ENV >> '${ran}'\n`)
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...UNNAMED_ENV, HOME: home, BASH_ENV: join(dir, 'bash-env'),
    // Exported functions named like the watcher's commands: a `read` that fails would end its loop at once and kill
    // the program; a `kill` that does nothing would let the program outlive its lifeline.
    'BASH_FUNC_read%%': '() { return 1; }', 'BASH_FUNC_kill%%': '() { :; }',
  }
  // No SHLVL: a bash -c whose stdin is a socket (a Node pipe) then takes itself for rshd's and runs ~/.bashrc.
  delete env.SHLVL
  delete env.SHELLOPTS
  delete env.BASHOPTS
  const wanted = { ...UNNAMED_ENV, 'BASH_FUNC_read%%': env['BASH_FUNC_read%%']!, 'BASH_FUNC_kill%%': env['BASH_FUNC_kill%%']!, HOME: home, BASH_ENV: env.BASH_ENV! }
  const printEnv = async (childEnv: NodeJS.ProcessEnv) => {
    const c = spawnTethered(process.execPath, PRINT_ENV, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }, { kind: 'probe' })
    record(c.pid)
    const io = collect(c)
    c.stdin!.end()
    await new Promise((r) => c.once('close', r))
    return { got: JSON.parse(io.out().toString()) as Record<string, string>, err: io.err() }
  }
  _setTetherBash(standIn)
  try {
    const { got, err } = await printEnv(env)
    for (const [k, v] of Object.entries(wanted)) assert.equal(got[k], v, k)
    assert.deepEqual(Object.keys(got).filter((k) => k.startsWith('TURBOLLM_TETHER_')), [], 'no carrier')
    assert.equal(err, '')
    // bash's whole argv: its flags, the plain script (bash execs the program itself, not through env) and the
    // program's own argv, so no value is in it.
    const argv = readFileSync(argvFile, 'utf8').split('\0').slice(0, -1)
    assert.deepEqual(argv, ['--norc', '-p', '-c', wrapperScript({ fd: 3, extra: [], end: 'kill' }), process.execPath, ...PRINT_ENV])
    assert.equal(existsSync(ran), false, 'neither ~/.bashrc nor BASH_ENV ran')

    // The watcher's read and kill are bash's own: the program lives while its lifeline is open, and its group ends
    // when the lifeline closes.
    const s = spawnTethered('sleep', ['30'], { env, stdio: 'ignore' }, { kind: 'engine' })
    record(s.pid)
    await sleep(300)
    assert.equal(isGone(s.pid!), false, 'an exported read ended no watcher')
    closeAllLifelines()
    assert.deepEqual(await waitGone([s.pid!], 1500), [], 'an exported kill stood in for nothing')

    // bash would pass on its own options as SHELLOPTS and BASHOPTS, so an env that exports either goes through env
    // (and bash as /bin/sh, macOS's, rewrites those two itself).
    rmSync(argvFile)
    const opts = await printEnv({ ...env, SHELLOPTS: 'braceexpand:hashall', BASHOPTS: 'cmdhist' })
    assert.equal(existsSync(argvFile), false, 'not through bash')
    const shIsBash = spawnSync('/bin/sh', ['-c', 'printf %s "${BASH_VERSION:-}"'], { encoding: 'utf8' }).stdout !== ''
    const optsWanted = shIsBash ? wanted : { ...wanted, SHELLOPTS: 'braceexpand:hashall', BASHOPTS: 'cmdhist' }
    for (const [k, v] of Object.entries(optsWanted)) assert.equal(opts.got[k], v, k)

    // The real lookup, and a file with no shebang, which bash runs as a script and still passes the names to.
    _setTetherBash(undefined)
    const real = await printEnv(env)
    for (const [k, v] of Object.entries(wanted)) assert.equal(real.got[k], v, `looked up: ${k}`)
    const file = join(dir, 'noshebang')
    writeFileSync(file, 'env | grep -c "^spring\\.profiles\\.active=dev$"\n')
    chmodSync(file, 0o755)
    const r = await tetheredExecFile({ kind: 'engine' })(file, [], { env })
    assert.equal(r.stdout, '1\n')
  } finally {
    _setTetherBash(undefined)
    cleanup()
  }
})

/** The bash found on PATH, and a link to it named `sh`, which runs it as /bin/sh runs on macOS, Fedora, RHEL and
 *  Arch: in POSIX mode, taking options from an exported SHELLOPTS. */
function bashAndBashAsSh(dir: string): { bash: string; asSh: string } {
  const bash = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
  const asSh = join(dir, 'sh')
  symlinkSync(bash, asSh)
  return { bash, asSh }
}

test('an exported TMOUT, which bash\'s read takes for a timeout, ends no watcher: the program outlives it and keeps it, under bash --norc -p, bash, bash as /bin/sh, /bin/sh and mksh', { skip: posix && has('bash') ? false : 'needs bash' }, async () => {
  const { bash, asSh } = bashAndBashAsSh(tmpDir('tllm-tether-tmout-'))
  const env: NodeJS.ProcessEnv = { ...process.env, TMOUT: '1' }
  delete env.SHELLOPTS
  delete env.BASHOPTS
  // Only shell identifiers, so each run below goes through the shell it names, not through bash --norc -p.
  for (const k of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) delete env[k]
  const runs: Array<{ what: string; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; out: () => Buffer }> = []
  const start = (what: string, childEnv: NodeJS.ProcessEnv) => {
    const c = spawnTethered('sh', ['-c', 'sleep 2; printf %s "$TMOUT"'], { env: childEnv, stdio: ['ignore', 'pipe', 'ignore'] }, { kind: 'engine' })
    record(c.pid)
    const io = collect(c)
    runs.push({ what, out: io.out, closed: new Promise((resolve) => c.once('close', (code, signal) => resolve({ code, signal }))) })
  }
  try {
    // A name the shell would drop: the wrapper runs under bash --norc -p.
    _setTetherBash(bash)
    start('bash --norc -p', { ...env, 'spring.profiles.active': 'dev' })
    for (const sh of new Set([bash, asSh, ...shells()])) {
      _setTetherShell(sh)
      start(sh === asSh ? 'bash as /bin/sh' : sh, env)
    }
    for (const r of runs) {
      assert.deepEqual(await r.closed, { code: 0, signal: null }, `${r.what}: no watcher killed the program after TMOUT=1`)
      assert.equal(r.out().toString(), '1', `${r.what}: the program keeps TMOUT`)
    }
  } finally {
    _setTetherShell(null)
    _setTetherBash(undefined)
    cleanup()
  }
})

/** What `export SHELLOPTS` exports from an interactive bash: job control (`monitor`) on. */
const INTERACTIVE_SHELLOPTS = 'braceexpand:emacs:hashall:histexpand:history:interactive-comments:monitor'

test('an interactive shell\'s exported SHELLOPTS turns job control on in neither the wrapper nor a bash program: a held job stays in the program\'s group under /bin/sh and bash as /bin/sh, through sh and through env, until its scope is released', { skip: posix && has('bash') ? false : 'needs bash' }, async () => {
  const { bash, asSh } = bashAndBashAsSh(tmpDir('tllm-tether-monitor-'))
  const jobs: number[] = []
  try {
    for (const sh of [null, asSh]) {
      _setTetherShell(sh)
      // A Code bash command's program is bash wherever there is one (robust-bash); `sh` is dash on Debian and Ubuntu,
      // which passes SHELLOPTS on and ignores it.
      for (const program of ['sh', bash]) {
        // A name the shell would drop goes through env: an exported SHELLOPTS keeps the wrapper off bash -p.
        for (const extra of [{}, { 'spring.profiles.active': 'dev' }]) {
          const what = `${sh === null ? '/bin/sh' : 'bash as /bin/sh'}, ${program === 'sh' ? 'sh' : 'bash'} program, ` +
            `${Object.keys(extra).length > 0 ? 'through env' : 'through sh'}`
          const env = { ...process.env, ...extra, SHELLOPTS: INTERACTIVE_SHELLOPTS }
          const { child, settled } = spawnHeld(program, ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!'], { env, stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'code-bash', hold: 'test:monitor' })
          record(child.pid)
          const io = collect(child)
          assert.deepEqual(await settled, { code: 0, signal: null }, what)
          const job = Number(io.out().toString().trim())
          record(job)
          jobs.push(job)
          await sleep(300)
          const members = groupMembers(child.pid!)
          record(...members)
          assert.equal(members.length, 2, `${what}: the watcher and the job, in the program's group, got ${members}`)
          assert.ok(members.includes(job), `${what}: the job is in the program's group`)
          assert.equal(await recountHeld(), 0, `${what}: the re-count keeps it`)
        }
      }
    }
    _setTetherShell(null)
    assert.deepEqual(jobs.filter(isGone), [], 'every job is held, none killed at its command\'s exit')
    await releaseTetherScope('test:monitor')
    assert.deepEqual(await waitGone(jobs, 3000), [], 'the release ends every job')
    // Only `monitor` is taken out: dash and mksh pass the rest on as it was (bash as /bin/sh exports its own).
    const shIsBash = spawnSync('/bin/sh', ['-c', 'printf %s "${BASH_VERSION:-}"'], { encoding: 'utf8' }).stdout !== ''
    if (!shIsBash) {
      const r = await tetheredExecFile({ kind: 'probe' })(process.execPath, ['-e', 'process.stdout.write(process.env.SHELLOPTS)'], { env: { ...process.env, SHELLOPTS: 'monitor:braceexpand:monitor:hashall' } })
      assert.equal(r.stdout, 'braceexpand:hashall')
    }
  } finally {
    _setTetherShell(null)
    cleanup()
  }
})

test('an interactive shell\'s exported SHELLOPTS: daemon SIGKILL still ends a held bash job, under /bin/sh and bash as /bin/sh', { skip: posix && has('bash') ? false : 'needs bash' }, async () => {
  const { bash, asSh } = bashAndBashAsSh(tmpDir('tllm-tether-monitor-kill-'))
  for (const sh of ['/bin/sh', asSh]) {
    const what = sh === asSh ? 'bash as /bin/sh' : '/bin/sh'
    // The daemon's own environment exports it, as a daemon started from such a shell has it.
    const d = await startStandInDaemon(`
import { spawnHeld, _setTetherShell } from ${srcUrl('util/tether.ts')}
_setTetherShell(${JSON.stringify(sh)})
const { child, settled } = spawnHeld(${JSON.stringify(bash)}, ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore'] }, { kind: 'code-bash', hold: 'daemon' })
let out = ''
child.stdout!.on('data', (b) => { out += b })
await settled
report({ child: child.pid, job: Number(out.trim()) })
setInterval(() => {}, 1e9)
`, { env: { SHELLOPTS: INTERACTIVE_SHELLOPTS } })
    try {
      const msg = await d.next<{ child: number; job: number }>()
      record(msg.child, msg.job)
      await sleep(300)
      assert.equal(isGone(msg.job), false, `${what}: the job is held`)
      await d.kill('SIGKILL')
      assert.deepEqual(await waitGone([msg.job], 1500), [], `${what}: the job ends with the daemon`)
    } finally {
      killRecorded(d.pid)
    }
  }
})

test('an exported SHELLOPTS holding nounset: a program run with no arguments starts, and one run with arguments gets them all, under /bin/sh and bash as /bin/sh, through sh and through env', { skip: posix && has('bash') ? false : 'needs bash' }, async () => {
  // bash as /bin/sh (macOS, Fedora) takes `set -u` from an exported SHELLOPTS. bash 4.0 then took an empty "$@" for an
  // unbound variable, and the wrapper's exec failed with exit 127 before the program ran. bash 3.2 (macOS) and 4.1 on
  // pass either way; with a bash 4.0 first on PATH this fails without the wrapper's ${1+"$@"}.
  const { asSh } = bashAndBashAsSh(tmpDir('tllm-tether-nounset-'))
  const uname = spawnSync('uname', { encoding: 'utf8' }).stdout
  try {
    for (const sh of [null, asSh]) {
      _setTetherShell(sh)
      for (const extra of [{}, { 'spring.profiles.active': 'dev' }]) {
        const what = `${sh === null ? '/bin/sh' : 'bash as /bin/sh'}, ${Object.keys(extra).length > 0 ? 'through env' : 'through sh'}`
        const env = { ...process.env, ...extra, SHELLOPTS: 'braceexpand:hashall:interactive-comments:nounset' }
        const none = await tetheredExecFile({ kind: 'probe' })('uname', [], { env })
        assert.equal(none.stdout, uname, `${what}: the program ran with no arguments`)
        const some = await tetheredExecFile({ kind: 'probe' })('printf', ['[%s]', 'a b', '', 'c'], { env })
        assert.equal(some.stdout, '[a b][][c]', `${what}: its arguments, an empty one included`)
      }
    }
  } finally {
    _setTetherShell(null)
    cleanup()
  }
})

test('a daemon killed right after spawnTethered still takes the group with it', posixOnly, async () => {
  const dir = tmpDir('tllm-tether-early-')
  const engine = engineScript(dir)
  const d = await startStandInDaemon(`
import { spawnTethered } from ${srcUrl('util/tether.ts')}
const c = spawnTethered(process.execPath, [${JSON.stringify(engine)}], { stdio: ['ignore', 'ignore', 'ignore'] }, { kind: 'engine' })
reportSync({ child: c.pid })
process.kill(process.pid, 'SIGKILL')
`)
  try {
    const { child } = await d.next<{ child: number }>()
    record(child)
    await d.exited
    await sleep(300)
    const deadline = Date.now() + 1500
    while (groupMembers(child).length > 0 && Date.now() < deadline) await sleep(25)
    record(...groupMembers(child))
    assert.deepEqual(groupMembers(child), [], 'nothing of the group is left')
  } finally {
    killRecorded(d.pid)
  }
})

test('the watcher is not the program\'s child: programs that wait for all their children finish', posixOnly, async (t) => {
  const programs: Array<[string, string, string[]]> = [
    ['python3', 'python3', ['-c', 'import os, time\nif os.fork() == 0:\n    time.sleep(0.3); os._exit(0)\nwhile True:\n    try: os.wait()\n    except ChildProcessError: break\nprint("done")']],
    ['perl', 'perl', ['-e', 'if (fork() == 0) { select(undef, undef, undef, 0.3); exit 0 } 1 while wait != -1; print "done\\n"']],
  ]
  for (const [name, bin, args] of programs) {
    if (!has(name)) {
      t.diagnostic(`${name} is not installed: its wait-for-all loop is not checked here`)
      continue
    }
    const c = spawnTethered(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'probe' })
    record(c.pid)
    try {
      const io = collect(c)
      const exited = exitOf(c)
      const r = await Promise.race([exited, sleep(3000).then(() => null)])
      assert.ok(r, `${name}'s wait-for-all loop hung: the watcher is its child`)
      assert.equal(io.out().toString(), 'done\n')
    } finally {
      cleanup()
    }
  }
  // The program's only children are its own: a program that starts one child has exactly that one.
  const c = spawnTethered('sh', ['-c', 'sleep 30 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] }, { kind: 'probe' })
  record(c.pid)
  try {
    const line = await new Promise<string>((resolve) => c.stdout!.once('data', (b: Buffer) => resolve(b.toString().trim())))
    record(Number(line))
    assert.deepEqual(childrenOf(c.pid!), [Number(line)])
  } finally {
    cleanup()
  }
})

test('pass-through: the pid is the program\'s, stdout bytes are identical, and exit codes and signals are its own', posixOnly, async () => {
  try {
    const pidChild = spawnTethered(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'probe' })
    record(pidChild.pid)
    const pidOut = collect(pidChild)
    await exitOf(pidChild)
    await sleep(50)
    assert.equal(pidOut.out().toString(), String(pidChild.pid))

    const bytes = `process.stdout.write(Buffer.from(Array.from({ length: 65536 }, (_, i) => (i * 7) % 256)))`
    const raw = spawn(process.execPath, ['-e', bytes], { stdio: ['ignore', 'pipe', 'pipe'] })
    const tied = spawnTethered(process.execPath, ['-e', bytes], { stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'probe' })
    record(raw.pid, tied.pid)
    const rawIo = collect(raw)
    const tiedIo = collect(tied)
    await Promise.all([new Promise((r) => raw.once('close', r)), new Promise((r) => tied.once('close', r))])
    assert.ok(rawIo.out().length === 65536 && rawIo.out().equals(tiedIo.out()), 'the same bytes as an unwrapped spawn')

    for (const code of [7, 42]) {
      const c = spawnTethered('sh', ['-c', `exit ${code}`], { stdio: 'ignore' }, { kind: 'probe' })
      record(c.pid)
      assert.deepEqual(await exitOf(c), { code, signal: null })
    }
    const k = spawnTethered('sleep', ['30'], { stdio: 'ignore' }, { kind: 'probe' })
    record(k.pid)
    const kExit = exitOf(k)
    await sleep(100)
    k.kill('SIGKILL')
    assert.deepEqual(await kExit, { code: null, signal: 'SIGKILL' })
    assert.equal(k.spawnfile, 'sleep')
    assert.deepEqual(k.spawnargs, ['sleep', '30'])
  } finally {
    cleanup()
  }
})

test('the program never sees the lifeline fd', posixOnly, async () => {
  try {
    const script = 'for n in 3 4 5 6 7 8 9; do if { true >&$n; } 2>/dev/null; then echo "open $n"; fi; done; echo end'
    const c = spawnTethered('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'probe' })
    record(c.pid)
    const io = collect(c)
    await new Promise((r) => c.once('close', r))
    assert.equal(io.out().toString(), 'end\n')
  } finally {
    cleanup()
  }
})

test('extra fds: the daemon sees fd 4\'s EOF at the program\'s exit, while its held watcher still lives', posixOnly, async () => {
  try {
    const { child, settled } = spawnHeld('sh', ['-c', 'cat <&3 >&4; (sleep 30 3<&- 4<&- </dev/null >/dev/null 2>&1 &); exit 7'], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    }, { kind: 'code-bash', hold: 'test:fds' })
    record(child.pid)
    const fd3 = child.stdio[3] as unknown as NodeJS.WritableStream
    const fd4 = child.stdio[4] as unknown as NodeJS.ReadableStream
    let echoed = ''
    let fd4EndAt = 0
    fd4.on('data', (b: Buffer) => { echoed += b.toString() })
    fd4.once('end', () => { fd4EndAt = Date.now() })
    fd3.end('ping\n')
    const r = await settled
    const exitAt = Date.now()
    assert.equal(r.code, 7)
    const deadline = Date.now() + 1000
    while (!fd4EndAt && Date.now() < deadline) await sleep(10)
    assert.ok(fd4EndAt > 0 && fd4EndAt - exitAt < 500, 'fd 4 ended at the exit: the watcher holds none of the caller\'s fds')
    assert.equal(echoed, 'ping\n')
    const members = groupMembers(child.pid!)
    record(...members)
    assert.ok(members.length >= 2, `held: the watcher and the background sleep are still there, got ${members}`)
    await releaseTetherScope('test:fds')
    assert.deepEqual(await waitGone(members, 1000), [])
  } finally {
    cleanup()
  }
})

// ── Errors and the forms of a spawn ──────────────────────────────────────────────────────────────────────────────

test('ENOENT and EACCES come back exactly as an unwrapped spawn reports them, with no process', posixOnly, async () => {
  const dir = tmpDir('tllm-tether-err-')
  const noExec = join(dir, 'not-executable')
  writeFileSync(noExec, '#!/bin/sh\necho no\n')
  chmodSync(noExec, 0o644)
  for (const file of ['turbollm-no-such-program-xyz', join(dir, 'missing'), noExec]) {
    const errOf = (c: ChildProcess) => new Promise<NodeJS.ErrnoException & { spawnargs?: string[] }>((resolve) => c.once('error', resolve))
    const raw = spawn(file, ['a', 'b'])
    const tied = spawnTethered(file, ['a', 'b'], {}, { kind: 'probe' })
    assert.equal(raw.pid, undefined)
    assert.equal(tied.pid, undefined)
    const [re, te] = await Promise.all([errOf(raw), errOf(tied)])
    for (const k of ['code', 'errno', 'syscall', 'path', 'message'] as const) assert.equal(te[k], re[k], `${file}: ${k}`)
    assert.deepEqual(te.spawnargs, re.spawnargs)
  }
})

test('a resolver miss whose spawn still starts is logged, and the graceful stop and the exit handler end it', posixOnly, async () => {
  // A lookup the resolver gets wrong leaves the program unwrapped, with no lifeline. It must still be stopped with
  // the daemon and killed by the exit handler, group and all, and the daemon must say so.
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')) }
  _setTetherResolver(() => null)
  const groups: number[] = []
  try {
    const stopped = spawnTethered('sh', ['-c', 'sleep 300 & wait'], { stdio: 'ignore' }, { kind: 'probe' })
    record(stopped.pid)
    assert.ok(stopped.pid, 'the program started, unwrapped')
    groups.push(stopped.pid)
    await sleep(150)
    const stoppedGroup = groupMembers(stopped.pid)
    record(...stoppedGroup)
    assert.match(warnings.join('\n'), /^\[tether\] sh: started without a lifeline \(resolver miss\)/m)
    assert.equal(stoppedGroup.length, 2, 'sh and its sleep, in a group of their own')
    await stopTethered(300)
    assert.deepEqual(await waitGone(stoppedGroup, 1500), [], 'the graceful stop ends its group')

    const killed = spawnTethered('sh', ['-c', 'sleep 300 & wait'], { stdio: 'ignore' }, { kind: 'probe' })
    record(killed.pid)
    assert.ok(killed.pid)
    groups.push(killed.pid)
    await sleep(150)
    const killedGroup = groupMembers(killed.pid)
    record(...killedGroup)
    assert.equal(killedGroup.length, 2)
    killTetheredSync()
    assert.deepEqual(await waitGone(killedGroup, 1500), [], 'the exit handler kills its group')
  } finally {
    _setTetherResolver(null)
    console.warn = warn
    for (const g of groups) {
      try {
        process.kill(-g, 'SIGKILL') // the test's own unwrapped groups, if an assertion failed before their kill
      } catch {
        /* already gone */
      }
    }
    cleanup()
  }
})

test('a file with no shebang runs through sh, as llamafile needs', posixOnly, async () => {
  const dir = tmpDir('tllm-tether-noexec-')
  const file = join(dir, 'noshebang')
  writeFileSync(file, 'echo "ran with $# args: $1"\n')
  chmodSync(file, 0o755)
  try {
    const c = spawnTethered(file, ['x y'], { stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'engine' })
    record(c.pid)
    const io = collect(c)
    assert.deepEqual(await exitOf(c), { code: 0, signal: null })
    await sleep(50)
    assert.equal(io.out().toString(), 'ran with 1 args: x y\n')
  } finally {
    cleanup()
  }
})

/** env as toybox's (Android) and musl's execvp make it: `-u NAME`s, `--`, NAME=VALUE pairs, then the program's exec
 *  with no sh fallback, so a file the kernel refuses (ENOEXEC) fails with exit 126. */
const ENV_NO_SH_FALLBACK_C = `
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  int i = 1;
  while (i + 1 < argc && strcmp(argv[i], "-u") == 0) { unsetenv(argv[i + 1]); i += 2; }
  if (i < argc && strcmp(argv[i], "--") == 0) i++;
  for (; i < argc && strchr(argv[i], '='); i++) putenv(argv[i]);
  if (i >= argc) return 0;
  execv(argv[i], argv + i);
  fprintf(stderr, "env: %s: %s\\n", argv[i], strerror(errno));
  return errno == ENOENT ? 127 : 126;
}
`

test('a file with no shebang runs through sh with names to carry too, as env with toybox or musl has no sh fallback', { skip: posix && has('cc') ? false : 'needs POSIX and cc' }, async () => {
  const dir = tmpDir('tllm-tether-noexec-carry-')
  const env = build(dir, 'env', ENV_NO_SH_FALLBACK_C)
  assert.ok(env, 'cc built the env')
  const file = join(dir, 'noshebang')
  writeFileSync(file, 'echo "ran with $# args: $1"\n')
  chmodSync(file, 0o755)
  const script = join(dir, 'shebang')
  writeFileSync(script, '#!/bin/sh\necho "shebang ran: $1"\n')
  chmodSync(script, 0o755)
  const childEnv = { ...process.env, ...UNNAMED_ENV }
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')) }
  _setTetherEnvProgram(env)
  _setTetherBash(null)
  const run = async (program: string, args: string[]) => {
    const c = spawnTethered(program, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'engine' })
    record(c.pid)
    const io = collect(c)
    const status = await exitOf(c)
    await sleep(50)
    return { status, out: io.out().toString(), err: io.err() }
  }
  try {
    // This env carries the names to what the kernel runs itself: a binary, and a `#!` script.
    const bin = await run(process.execPath, PRINT_ENV)
    assert.deepEqual(bin.status, { code: 0, signal: null }, bin.err)
    const got = JSON.parse(bin.out) as Record<string, string>
    for (const [k, v] of Object.entries(UNNAMED_ENV)) assert.equal(got[k], v, k)
    assert.deepEqual(await run(script, ['x']), { status: { code: 0, signal: null }, out: 'shebang ran: x\n', err: '' })
    assert.deepEqual(warnings, [], 'both were carried')
    // A file with no shebang keeps sh's exec, which runs it as a script; the daemon says the names may not reach it
    // (bash passes them on, dash, mksh and busybox ash do not).
    assert.deepEqual(await run(file, ['x y']), { status: { code: 0, signal: null }, out: 'ran with 1 args: x y\n', err: '' })
    assert.match(warnings.join('\n'), /^\[tether\] .*\/noshebang: it has no shebang and runs through sh, so \d+ variable\(s\) whose names are not shell identifiers may not reach it \(dash, mksh and busybox ash drop them\)$/m)
  } finally {
    _setTetherEnvProgram(undefined)
    _setTetherBash(undefined)
    console.warn = warn
    cleanup()
  }
})

test('a spawn whose lifeline would land past fd 9 throws', posixOnly, () => {
  assert.throws(() => spawnTethered('true', [], { stdio: Array.from({ length: 10 }, () => 'pipe') as 'pipe'[] }, { kind: 'probe' }), RangeError)
  assert.throws(() => wrapperScript({ fd: 10, extra: [], end: 'kill' }), RangeError)
})

test('the command-string form gives sh\'s own "not found" and exit 127, as spawn with shell: true does', posixOnly, async () => {
  const command = 'turbollm-no-such-cli-xyz -p --output-format stream-json'
  const run = (c: ChildProcess) => new Promise<{ code: number | null; err: string }>((resolve) => {
    let err = ''
    c.stderr?.on('data', (b: Buffer) => { err += b.toString() })
    c.once('close', (code) => resolve({ code, err }))
  })
  try {
    const raw = run(spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] }))
    const t = spawnTethered(command, null, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'routine-cli' })
    record(t.pid)
    const tied = run(t)
    const [r, tr] = await Promise.all([raw, tied])
    assert.equal(tr.code, 127)
    assert.deepEqual(tr, r)
  } finally {
    cleanup()
  }
})

// ── End modes ────────────────────────────────────────────────────────────────────────────────────────────────────

test('term mode: daemon SIGKILL sends the program SIGTERM, and nothing harder', posixOnly, async () => {
  const dir = tmpDir('tllm-tether-term-')
  const marker = join(dir, 'got-term')
  const d = await startStandInDaemon(`
import { spawnTethered } from ${srcUrl('util/tether.ts')}
const c = spawnTethered('sh', ['-c', ${JSON.stringify(`trap 'echo term > ${marker}; exit 0' TERM; while :; do sleep 0.1; done`)}], { stdio: 'ignore' }, { kind: 'install', end: 'term' })
report({ child: c.pid })
setInterval(() => {}, 1e9)
`)
  try {
    const { child } = await d.next<{ child: number }>()
    record(child)
    await sleep(200)
    await d.kill('SIGKILL')
    assert.equal(await writtenTo(marker, 2000), 'term\n', 'the program got SIGTERM from its watcher')
    assert.deepEqual(await waitGone([child], 1000), [])
  } finally {
    killRecorded(d.pid)
  }
})

test('term mode: a normal exit sends `q`, so the watcher leaves without a signal', posixOnly, async () => {
  const marker = `tether-term-q-${process.pid}-${Date.now()}`
  try {
    const c = spawnTethered('sh', ['-c', 'sleep 0.3', marker], { stdio: 'ignore' }, { kind: 'install', end: 'term' })
    record(c.pid)
    const lifeline = c.stdio[3] as unknown as { end: (...a: unknown[]) => unknown }
    const sent: unknown[] = []
    const realEnd = lifeline.end.bind(lifeline)
    lifeline.end = (...a: unknown[]) => { sent.push(a[0]); return realEnd(...a) }
    await sleep(100)
    const watcher = pidsWithArg(marker).filter((p) => p !== c.pid)
    record(...watcher)
    assert.equal(watcher.length, 1, 'one watcher')
    assert.deepEqual(await exitOf(c), { code: 0, signal: null })
    assert.deepEqual(sent, ['q\n'])
    assert.deepEqual(await waitGone(watcher, 1000), [], 'the watcher left on `q`')
  } finally {
    cleanup()
  }
})

test('term mode: `q` to a watcher that is already gone does not crash the daemon', posixOnly, async () => {
  const marker = `tether-term-dead-${process.pid}-${Date.now()}`
  try {
    const c = spawnTethered('sh', ['-c', 'sleep 0.5', marker], { stdio: 'ignore' }, { kind: 'install', end: 'term' })
    record(c.pid)
    await sleep(150)
    const watcher = pidsWithArg(marker).filter((p) => p !== c.pid)
    record(...watcher)
    for (const p of watcher) process.kill(p, 'SIGKILL')
    // The exit and the watcher's EOF race each other: either order must leave this process alive.
    assert.deepEqual(await exitOf(c), { code: 0, signal: null })
    await sleep(200)
  } finally {
    cleanup()
  }
})

test('term-then-kill: daemon SIGKILL gives the group SIGTERM, and a member that ignores it is killed after the grace', posixOnly, async () => {
  const dir = tmpDir('tllm-tether-ttk-')
  const marker = join(dir, 'got-term')
  const stubborn = join(dir, 'stubborn.pid')
  // The member writes its own pid once its trap is set: a pid its parent wrote could arrive while the member still
  // took SIGTERM's default, and the group's SIGTERM would end it before the grace.
  const script = `trap 'echo term > ${marker}; exit 0' TERM; sh -c 'trap "" TERM; echo $$ > ${stubborn}; while :; do sleep 0.1; done' & while :; do sleep 0.1; done`
  const d = await startStandInDaemon(`
import { spawnTethered } from ${srcUrl('util/tether.ts')}
const c = spawnTethered('sh', ['-c', ${JSON.stringify(script)}], { stdio: 'ignore' }, { kind: 'git', end: 'term-then-kill' })
report({ child: c.pid })
setInterval(() => {}, 1e9)
`)
  try {
    const { child } = await d.next<{ child: number }>()
    record(child)
    const stubbornPid = await pidWrittenTo(stubborn, 2000)
    record(stubbornPid)
    await d.kill('SIGKILL')
    const killedAt = Date.now()
    while (!existsSync(marker) && Date.now() - killedAt < 1500) await sleep(25)
    assert.ok(existsSync(marker), 'the program got SIGTERM')
    await sleep(Math.max(0, 1000 - (Date.now() - killedAt)))
    assert.equal(isGone(stubbornPid), false, 'the TERM-ignoring member lives through the grace')
    assert.deepEqual(await waitGone([stubbornPid], 3500), [], 'and is killed after it')
    // Right after the group's KILL a member can still be listed for a moment: one killed but not yet run to its exit
    // (a child just forked, still waiting for a CPU), and on macOS one the KILL missed: xnu's killpg lists the group's
    // members under its lock, then signals each one it can look up, and a child still being forked is in the group
    // but cannot be looked up (proc_find refuses it while P_REF_NEW is set) until cloneproc's pinsertchild, after its
    // address space is copied. So a `sleep 0.1` the stubborn loop was forking then outlives its killed parent and ends
    // on its own (CI's macOS job saw one member left). So the group gets a bound to empty in; a member the KILL truly
    // left alive, the watcher included, is still there at it (and is recorded, so the finally ends it).
    const deadline = Date.now() + 1500
    while (groupMembers(child).length > 0 && Date.now() < deadline) await sleep(25)
    record(...groupMembers(child))
    assert.deepEqual(groupMembers(child), [], 'nothing of the group is left, the watcher included')
  } finally {
    killRecorded(d.pid)
  }
})

// ── Held lifelines ───────────────────────────────────────────────────────────────────────────────────────────────

test('hold: a group with a background job is kept after the program exits, and its release kills it', posixOnly, async () => {
  try {
    const { child, settled } = spawnHeld('sh', ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!'], { stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'code-bash', hold: 'test:s1' })
    record(child.pid)
    const io = collect(child)
    let closed = false
    child.once('close', () => { closed = true })
    const t0 = Date.now()
    assert.deepEqual(await settled, { code: 0, signal: null })
    assert.ok(Date.now() - t0 < 1000, 'settled at the exit, not at the release')
    const job = Number(io.out().toString().trim())
    record(job)
    const other = spawnHeld('sh', ['-c', 'sleep 300 >/dev/null 2>&1 &'], { stdio: 'ignore' }, { kind: 'code-bash', hold: 'test:s2' })
    record(other.child.pid)
    await other.settled
    await sleep(300)
    const members = groupMembers(child.pid!)
    const otherMembers = groupMembers(other.child.pid!)
    record(...members, ...otherMembers)
    assert.equal(members.length, 2, 'the watcher and the background job')
    assert.equal(isGone(job), false)
    assert.equal(closed, false, '\'close\' waits for the release (the lifeline is one of child.stdio)')
    await releaseTetherScope('test:s1')
    assert.deepEqual(await waitGone(members, 1000), [])
    await sleep(100)
    assert.equal(closed, true)
    assert.equal(otherMembers.every((p) => !isGone(p)), true, 'another scope\'s job lives on')
  } finally {
    cleanup()
  }
})

// At its program's exit a held group is counted before it is held: synchronously on Linux, but through `ps` on macOS,
// which takes tens of milliseconds. A release in that window passed the group by, so deleting a Code session right
// after a command left a job ended that job only once the count came back, after the release had returned and the
// session's worktree had been removed (CI's macOS run of code-routes.release.test.ts). Here the release comes from an
// 'exit' listener behind the tether's own, while the group is being counted, on any OS.
test('hold: a release while the exited program\'s group is still being counted ends its job before it returns', posixOnly, async () => {
  try {
    const pidFile = join(tmpDir('tllm-tether-deciding-'), 'job.pid')
    const { child, settled } = spawnHeld('sh', ['-c', `sleep 300 >/dev/null 2>&1 & echo $! > '${pidFile}'`], { stdio: 'ignore' }, { kind: 'code-bash', hold: 'test:deciding' })
    record(child.pid)
    let job = 0
    const released = new Promise<void>((resolve, reject) => child.once('exit', () => {
      job = Number(readFileSync(pidFile, 'utf8').trim())
      record(job)
      releaseTetherScope('test:deciding').then(resolve, reject)
    }))
    await settled
    await released
    assert.equal(isGone(job), true, 'the job was gone when the release returned')
    assert.deepEqual(groupMembers(child.pid!), [], 'and so was its group, the watcher included')
  } finally {
    cleanup()
  }
})

test('hold: a command that left nothing running is not held: its watcher goes at once', posixOnly, async () => {
  try {
    const { child, settled } = spawnHeld('sh', ['-c', 'echo plain'], { stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'code-bash', hold: 'test:plain' })
    record(child.pid)
    const members = groupMembers(child.pid!)
    record(...members)
    await settled
    const deadline = Date.now() + 1000
    while (groupMembers(child.pid!).length > 0 && Date.now() < deadline) await sleep(20)
    assert.deepEqual(groupMembers(child.pid!), [])
  } finally {
    cleanup()
  }
})

test('hold: the re-count closes a held group once its background job has ended', posixOnly, async () => {
  try {
    const short = spawnHeld('sh', ['-c', 'sleep 1 >/dev/null 2>&1 &'], { stdio: 'ignore' }, { kind: 'code-bash', hold: 'test:recount' })
    const long = spawnHeld('sh', ['-c', 'sleep 300 >/dev/null 2>&1 &'], { stdio: 'ignore' }, { kind: 'code-bash', hold: 'test:recount' })
    record(short.child.pid, long.child.pid)
    await Promise.all([short.settled, long.settled])
    await sleep(200)
    record(...groupMembers(short.child.pid!), ...groupMembers(long.child.pid!))
    assert.equal(groupMembers(short.child.pid!).length, 2)
    await sleep(1300)
    assert.equal(groupMembers(short.child.pid!).length, 1, 'only the watcher is left')
    assert.ok((await recountHeld()) >= 1)
    const deadline = Date.now() + 1000
    while (groupMembers(short.child.pid!).length > 0 && Date.now() < deadline) await sleep(20)
    assert.deepEqual(groupMembers(short.child.pid!), [], 'the re-count closed it')
    assert.equal(groupMembers(long.child.pid!).length, 2, 'a group whose job still runs is kept')
  } finally {
    cleanup()
  }
})

test('tetheredExecFile with a hold resolves at the program\'s exit while its group is held, and a release ends it', posixOnly, async () => {
  try {
    const exec = tetheredExecFile({ kind: 'git', end: 'term-then-kill', hold: 'test:git' })
    const t0 = Date.now()
    const { stdout } = await exec('sh', ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!; echo ok'])
    assert.ok(Date.now() - t0 < 1000)
    const [job, ok] = stdout.trim().split('\n')
    record(Number(job))
    assert.equal(ok, 'ok')
    await sleep(200)
    assert.equal(isGone(Number(job)), false, 'held')
    await releaseTetherScope('test:git')
    assert.deepEqual(await waitGone([Number(job)], 1000), [])
  } finally {
    cleanup()
  }
})

test('a timeout never holds: the group is ended by its end mode (git: TERM, the grace, then KILL)', posixOnly, async () => {
  const dir = tmpDir('tllm-tether-timeout-')
  const pidFile = join(dir, 'job.pid')
  try {
    const exec = tetheredExecFile({ kind: 'git', end: 'term-then-kill', hold: 'test:timeout' })
    const t0 = Date.now()
    const err = await exec('sh', ['-c', `(trap '' TERM; sleep 300) >/dev/null 2>&1 & echo $! > ${pidFile}; sleep 300`], { timeout: 500 })
      .then(() => null, (e: Record<string, unknown>) => e)
    assert.ok(err, 'rejected')
    assert.equal(err.killed, true)
    assert.ok(Date.now() - t0 < 1500, 'at the timeout')
    const job = await pidWrittenTo(pidFile, 1000)
    record(job)
    assert.deepEqual(await waitGone([job], 4000), [], 'gone after the grace, with no release')
  } finally {
    cleanup()
  }
})

test('endTetheredGroup: a caller\'s timeout ends the whole group by its end mode, and it is never held', posixOnly, async () => {
  const dir = tmpDir('tllm-tether-endgroup-')
  const pidFile = join(dir, 'job.pid')
  try {
    // The job writes its own pid once SIGTERM is ignored (as in the term-then-kill test above), and the exec keeps
    // that pid and the ignored signal for its sleep.
    const { child, settled } = spawnHeld('sh', ['-c', `sh -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 300' >/dev/null 2>&1 & sleep 300`], { stdio: 'ignore' }, { kind: 'git', end: 'term-then-kill', hold: 'test:endgroup' })
    record(child.pid)
    const job = await pidWrittenTo(pidFile, 2000)
    record(job)
    child.kill()
    endTetheredGroup(child)
    await settled
    assert.equal(isGone(job), false, 'the TERM-ignoring job lives through git\'s grace')
    assert.deepEqual(await waitGone([job], 4000), [], 'and is killed after it, with no release')
  } finally {
    cleanup()
  }
})

// ── tetheredExecFile against promisify(execFile) ─────────────────────────────────────────────────────────────────

test('tetheredExecFile matches promisify(execFile): success, a failure, a timeout, an abort, maxBuffer and a missing program', posixOnly, async () => {
  const node = promisify(execFile)
  const ours = tetheredExecFile({ kind: 'probe' })
  const both = async (file: string, args: string[], opts: Record<string, unknown> = {}) => {
    const settle = (p: Promise<unknown>) => p.then((v) => ({ ok: v as Record<string, unknown> }), (e: Record<string, unknown>) => ({ err: e }))
    return Promise.all([settle(node(file, args, opts)), settle(ours(file, args, opts as never))])
  }
  const pick = (e: Record<string, unknown> | undefined, keys: string[]) => Object.fromEntries(keys.map((k) => [k, e?.[k]]))
  try {
    const [n1, o1] = await both('sh', ['-c', 'echo out; echo err >&2'])
    assert.deepEqual(o1, n1)
    const fields = ['code', 'killed', 'signal', 'cmd', 'message', 'stdout', 'stderr', 'name']
    const [n2, o2] = await both('sh', ['-c', 'echo out; echo err >&2; exit 3'])
    assert.ok('err' in n2 && 'err' in o2)
    assert.deepEqual(pick(o2.err, fields), pick(n2.err, fields))
    const [n3, o3] = await both('sleep', ['5'], { timeout: 300 })
    assert.ok('err' in n3 && 'err' in o3)
    assert.deepEqual(pick(o3.err, fields), pick(n3.err, fields))
    assert.equal(o3.err?.killed, true)
    const ac1 = new AbortController()
    const ac2 = new AbortController()
    const aborted = Promise.all([
      node('sleep', ['5'], { signal: ac1.signal }).then(() => null, (e: Record<string, unknown>) => e),
      ours('sleep', ['5'], { signal: ac2.signal }).then(() => null, (e: Record<string, unknown>) => e),
    ])
    setTimeout(() => { ac1.abort(); ac2.abort() }, 200)
    const [na, oa] = await aborted
    assert.deepEqual(pick(oa ?? undefined, ['name', 'code', 'message', 'cmd', 'stdout', 'stderr']), pick(na ?? undefined, ['name', 'code', 'message', 'cmd', 'stdout', 'stderr']))
    const big = `process.stdout.write('x'.repeat(5000))`
    const [nb, ob] = await both(process.execPath, ['-e', big], { maxBuffer: 1000 })
    assert.ok('err' in nb && 'err' in ob)
    assert.deepEqual(pick(ob.err, ['code', 'message', 'stdout', 'name']), pick(nb.err, ['code', 'message', 'stdout', 'name']))
    assert.equal(String(ob.err?.cmd), String(nb.err?.cmd))
    const [nm, om] = await both('turbollm-no-such-program-xyz', ['--version'])
    assert.ok('err' in nm && 'err' in om)
    assert.deepEqual(pick(om.err, ['code', 'syscall', 'path', 'spawnargs', 'cmd', 'message', 'stdout', 'stderr']),
      pick(nm.err, ['code', 'syscall', 'path', 'spawnargs', 'cmd', 'message', 'stdout', 'stderr']))
  } finally {
    cleanup()
  }
})

// ── Closing and stopping ─────────────────────────────────────────────────────────────────────────────────────────

test('closeAllLifelines ends every live and every held group', posixOnly, async () => {
  try {
    const live = spawnTethered('sh', ['-c', 'sleep 300 & wait'], { stdio: 'ignore' }, { kind: 'probe' })
    const held = spawnHeld('sh', ['-c', 'sleep 300 >/dev/null 2>&1 &'], { stdio: 'ignore' }, { kind: 'code-bash', hold: 'test:all' })
    record(live.pid, held.child.pid)
    await held.settled
    await sleep(200)
    const members = [...groupMembers(live.pid!), ...groupMembers(held.child.pid!)]
    record(...members)
    assert.equal(members.length, 5, 'live: sh, sleep, watcher; held: sleep, watcher')
    closeAllLifelines()
    assert.deepEqual(await waitGone(members, 1000), [])
  } finally {
    cleanup()
  }
})

test('stopTethered: SIGTERM first, then a group kill after the grace; engines are left to their owner', posixOnly, async () => {
  const dir = tmpDir('tllm-tether-stop-')
  const marker = join(dir, 'term')
  try {
    const polite = spawnTethered('sh', ['-c', `trap 'echo term > ${marker}; exit 0' TERM; while :; do sleep 0.1; done`], { stdio: 'ignore' }, { kind: 'probe' })
    const stubborn = spawnTethered('sh', ['-c', `trap '' TERM; while :; do sleep 0.1; done`], { stdio: 'ignore' }, { kind: 'mcp' })
    const engine = spawnTethered('sleep', ['300'], { stdio: 'ignore' }, { kind: 'engine' })
    record(polite.pid, stubborn.pid, engine.pid)
    await sleep(200)
    const stubbornMembers = groupMembers(stubborn.pid!)
    record(...stubbornMembers)
    const t0 = Date.now()
    const stopping = stopTethered(800)
    await sleep(400)
    assert.ok(existsSync(marker), 'the polite one got SIGTERM')
    assert.equal(isGone(stubborn.pid!), false, 'the stubborn one lives through the grace')
    await stopping
    assert.ok(Date.now() - t0 >= 700)
    assert.deepEqual(await waitGone(stubbornMembers, 1500), [], 'and its group is killed after it')
    assert.equal(isGone(engine.pid!), false, 'an engine is its Manager\'s to stop')
  } finally {
    cleanup()
  }
})

test('stopTethered on Windows ends each tree while its root lives, with no SIGTERM first (injected tree kill)', posixOnly, async () => {
  const dir = tmpDir('tllm-tether-win-')
  const marker = join(dir, 'term')
  try {
    const a = spawnTethered('sh', ['-c', `trap 'echo term > ${marker}; exit 0' TERM; while :; do sleep 0.1; done`], { stdio: 'ignore' }, { kind: 'routine-cli' })
    const engine = spawnTethered('sleep', ['300'], { stdio: 'ignore' }, { kind: 'engine' })
    record(a.pid, engine.pid)
    await sleep(150)
    const killed: number[][] = []
    await stopTethered(200, { platform: 'win32', treeKill: (pids) => { killed.push(pids) } })
    assert.deepEqual(killed, [[a.pid]], 'one tree kill, for the live non-engine child, while it was alive')
    assert.equal(existsSync(marker), false, 'no SIGTERM')
    assert.equal(isGone(a.pid!), false)
  } finally {
    cleanup()
  }
})

test('killTetheredTree never signals a reaped pid: nothing once an exited program\'s group is gone, its group alone while it is held, nothing for an exited child started elsewhere', posixOnly, async () => {
  const realKill = process.kill
  /** What `f` asks process.kill for, recorded and not sent: each call fails with ESRCH, as for a pid or a group
   *  that is gone, so a fallback to the bare pid shows. */
  const kills = (f: () => void): Array<[number, unknown]> => {
    const calls: Array<[number, unknown]> = []
    process.kill = ((pid: number, sig?: unknown) => {
      calls.push([pid, sig])
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    }) as typeof process.kill
    try {
      f()
    } finally {
      process.kill = realKill
    }
    return calls
  }
  try {
    // An engine past its exit (the manager force-kills it after its grace while an escaped worker holds its stdio
    // open): Node has reaped it, and its group has ended, so both numbers are free for others.
    const engine = spawnTethered('sh', ['-c', 'exit 0'], { stdio: 'ignore' }, { kind: 'engine' })
    record(engine.pid)
    await exitOf(engine)
    const deadline = Date.now() + 2000
    while (groupMembers(engine.pid!).length > 0 && Date.now() < deadline) await sleep(25)
    assert.deepEqual(groupMembers(engine.pid!), [], 'its group has ended')
    assert.deepEqual(kills(() => killTetheredTree(engine, 'SIGKILL')), [], 'neither its pid nor its group')

    // Held: its watcher still pins the group id, so the group may still be signalled, and only the group.
    const { child: held } = spawnHeld('sh', ['-c', 'sleep 30 & exit 0'], { stdio: 'ignore' }, { kind: 'code-bash', hold: 'test:reaped' })
    record(held.pid)
    await exitOf(held)
    record(...groupMembers(held.pid!))
    assert.deepEqual(kills(() => killTetheredTree(held, 'SIGTERM')), [[-held.pid!, 'SIGTERM']], 'its group, never the bare pid')
    await releaseTetherScope('test:reaped')

    // Not started here: as child.kill() does, nothing once it has exited.
    const plain = spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' })
    record(plain.pid)
    await exitOf(plain)
    assert.deepEqual(kills(() => killTetheredTree(plain, 'SIGKILL')), [])
  } finally {
    process.kill = realKill
    cleanup()
  }
})

test('killTetheredTree on Windows sends taskkill only while Node has not seen the program exit, never for a pid it may have handed on (platform and taskkill stubbed, so on every OS)', async (t) => {
  const taskkills: string[][] = []
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  /** `f` as if on Windows, with execFile recorded and not run. */
  const asWindows = (f: () => void) => {
    const m = t.mock.method(childProcess, 'execFile', ((file: string, args: readonly string[]) => {
      taskkills.push([file, ...args])
    }) as unknown as typeof childProcess.execFile)
    syncBuiltinESMExports()
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      f()
    } finally {
      Object.defineProperty(process, 'platform', platform)
      m.mock.restore()
      syncBuiltinESMExports()
    }
  }
  try {
    const live = spawnTethered(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }, { kind: 'engine' })
    const exited = spawnTethered(process.execPath, ['-e', ''], { stdio: 'ignore' }, { kind: 'engine' })
    const plain = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    record(live.pid, exited.pid, plain.pid)
    await Promise.all([exitOf(exited), exitOf(plain)])
    asWindows(() => {
      killTetheredTree(exited, 'SIGKILL')
      killTetheredTree(plain, 'SIGKILL')
    })
    // libuv closed each one's handle at its exit, and that handle was what kept the pid from being reused.
    assert.deepEqual(taskkills, [], 'no taskkill once Node has seen the exit, tethered or not')
    asWindows(() => killTetheredTree(live, 'SIGKILL'))
    assert.deepEqual(taskkills, [['taskkill', '/PID', String(live.pid), '/T', '/F']], 'a running one: its tree')
  } finally {
    cleanup()
  }
})

// ── macOS: DYLD_* through SIP ────────────────────────────────────────────────────────────────────────────────────

test('every DYLD_* variable reaches the program, past SIP\'s stripping of /bin/sh\'s environment, and of bash\'s and env\'s when other names must be passed', { skip: process.platform === 'darwin' ? false : 'macOS only' }, async () => {
  // The program must be one dyld leaves DYLD_* to: not SIP-protected (/usr/bin/env is) and not hardened (a signed
  // node may be). A C program built here is neither. It prints the DYLD_* variables, a dotted one and any carrier.
  const dir = tmpDir('tllm-tether-dyld-')
  const src = join(dir, 'dyld-env.c')
  writeFileSync(src, '#include <stdio.h>\n#include <string.h>\nextern char **environ;\nint main(void) { for (char **e = environ; *e; e++) if (!strncmp(*e, "DYLD_", 5) || !strncmp(*e, "spring.", 7) || !strncmp(*e, "TURBOLLM_TETHER_", 16)) puts(*e); return 0; }\n')
  const bin = join(dir, 'dyld-env')
  assert.equal(spawnSync('cc', ['-o', bin, src]).status, 0, 'cc built the probe')
  const env = { ...process.env, DYLD_LIBRARY_PATH: join(dir, 'a'), DYLD_FALLBACK_LIBRARY_PATH: join(dir, 'b'), DYLD_FRAMEWORK_PATH: join(dir, 'c') }
  const dyld = [
    `DYLD_FALLBACK_LIBRARY_PATH=${env.DYLD_FALLBACK_LIBRARY_PATH}`, `DYLD_FRAMEWORK_PATH=${env.DYLD_FRAMEWORK_PATH}`, `DYLD_LIBRARY_PATH=${env.DYLD_LIBRARY_PATH}`,
  ]
  const run = async (childEnv: NodeJS.ProcessEnv) => {
    const c = spawnTethered(bin, [], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'engine' })
    record(c.pid)
    const io = collect(c)
    await new Promise((r) => c.once('close', r))
    return io.out().toString().trim().split('\n').sort()
  }
  try {
    // Only DYLD_* names: sh restores each one before its own exec.
    assert.deepEqual(await run(env), dyld)
    // A name sh would drop as well: the wrapper runs under /bin/bash, SIP-protected too, which restores each one.
    assert.deepEqual(await run({ ...env, 'spring.profiles.active': 'dev' }), [...dyld, 'spring.profiles.active=dev'])
    // With no bash, every one goes to /usr/bin/env as a pair, which sets it after env's own exec (SIP strips DYLD_*
    // only at the exec of a protected program), and no carrier reaches the program.
    _setTetherBash(null)
    assert.deepEqual(await run({ ...env, 'spring.profiles.active': 'dev' }), [...dyld, 'spring.profiles.active=dev'])
  } finally {
    _setTetherBash(undefined)
    cleanup()
  }
})

test('the wrapper restores each DYLD_* name it is given, and closes the caller\'s extra fds in the watcher', () => {
  const s = wrapperScript({ fd: 5, extra: [3, 4], end: 'kill', dyldKeys: ['DYLD_LIBRARY_PATH'] })
  assert.match(s, /DYLD_LIBRARY_PATH=\$TURBOLLM_TETHER_DYLD_LIBRARY_PATH; export DYLD_LIBRARY_PATH; unset TURBOLLM_TETHER_DYLD_LIBRARY_PATH; exec "\$0" \$\{1\+"\$@"\} 5<&-$/)
  assert.match(s, /exec <\/dev\/null >\/dev\/null 2>&1 3<&- 4<&-;/)
  assert.match(s, /^\( \( unset TMOUT; trap '' HUP INT TERM;/, 'double-forked')
})

test('with names to carry, the wrapper execs through env, which sets each one from its carrier and drops the carriers', () => {
  const s = wrapperScript({ fd: 3, extra: [], end: 'kill', dyldKeys: ['DYLD_X'], carried: { env: '/usr/bin/env', names: ['a.b', 'it\'s', 'DYLD_X'] } })
  assert.match(s, /; exec '\/usr\/bin\/env' -u TURBOLLM_TETHER_V0 -u TURBOLLM_TETHER_V1 -u TURBOLLM_TETHER_V2 -- 'a\.b'="\$TURBOLLM_TETHER_V0" 'it'\\''s'="\$TURBOLLM_TETHER_V1" 'DYLD_X'="\$TURBOLLM_TETHER_V2" "\$0" \$\{1\+"\$@"\} 3<&-$/)
  assert.ok(!s.includes('export DYLD_X'), 'a DYLD_* name goes through env too: macOS\'s /usr/bin/env is SIP-protected')
  assert.equal(wrapperScript({ fd: 3, extra: [], end: 'kill', carried: { env: '/usr/bin/env', names: [] } }), wrapperScript({ fd: 3, extra: [], end: 'kill' }), 'nothing to carry: the script is as before')
})

// ── Android: libtether_exec.so and its self-test (host builds) ──────────────────────────────────────────────────

/** The helper's source as TurboLLM-Android ships it (engines/tether-exec/tether_exec.c), built here for the host. */
const TETHER_EXEC_C = `
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc < 3) { fputs("usage: libtether_exec.so <daemon-pid> <program> [args...]\\n", stderr); return 127; }
  char *end = NULL;
  long parent = strtol(argv[1], &end, 10);
  if (!end || *end || parent <= 1) { fprintf(stderr, "libtether_exec.so: bad daemon pid '%s'\\n", argv[1]); return 127; }
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0)
    fprintf(stderr, "libtether_exec.so: prctl(PR_SET_PDEATHSIG) failed: %s; starting %s without it\\n", strerror(errno), argv[2]);
  else if (getppid() != (pid_t)parent)
    return 127;
  execvp(argv[2], argv + 2);
  fprintf(stderr, "libtether_exec.so: cannot run %s: %s\\n", argv[2], strerror(errno));
  return 127;
}
`
const EXITS_127_C = 'int main(void) { return 127; }\n'
const NO_PDEATHSIG_C = '#include <unistd.h>\nint main(int argc, char **argv) { (void)argc; execvp(argv[2], argv + 2); return 127; }\n'

function build(dir: string, name: string, source: string): string | null {
  const src = join(dir, `${name}.c`)
  writeFileSync(src, source)
  const out = join(dir, name)
  return spawnSync('cc', ['-O1', '-o', out, src]).status === 0 ? out : null
}

const androidHost = process.platform === 'linux' && has('cc') && existsSync('/bin/sleep') ? false : 'needs Linux and cc'

test('Android: only engines and probes start under the helper; any other kind keeps the sh lifeline, so a forking MCP server leaves nothing after a graceful stop or a daemon SIGKILL', { skip: androidHost }, async () => {
  const root = tmpDir('tllm-tether-android-kinds-')
  const lib = join(root, 'lib')
  spawnSync('mkdir', ['-p', lib])
  const built = build(root, 'helper', TETHER_EXEC_C)
  assert.ok(built, 'cc built the helper')
  copyFileSync(built, join(lib, 'libtether_exec.so'))
  chmodSync(join(lib, 'libtether_exec.so'), 0o755)
  const pgrpOf = (pid: number) => {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2])
  }
  /** An MCP stdio server that starts a child of its own, as `npx` or `uvx` does: the child's pid once it runs. */
  const forkingServer = 'sleep 3001 & echo $!; wait'
  try {
    assert.equal(await initAndroidTether({ nativeLibDir: lib, sh: '/bin/sh', sleep: '/bin/sleep', log: () => {} }), true)
    for (const kind of ['engine', 'probe'] as const) {
      const c = spawnTethered('sleep', ['30'], { stdio: 'ignore' }, { kind })
      record(c.pid)
      await sleep(100)
      assert.notEqual(pgrpOf(c.pid!), c.pid, `${kind}: under the helper, in the daemon's group`)
    }
    const mcp = spawnTethered('sh', ['-c', forkingServer], { stdio: ['ignore', 'pipe', 'ignore'] }, { kind: 'mcp' })
    record(mcp.pid)
    const child = Number(await new Promise<string>((resolve) => mcp.stdout!.once('data', (b: Buffer) => resolve(b.toString().trim()))))
    record(child)
    assert.equal(pgrpOf(mcp.pid!), mcp.pid, 'mcp: behind the sh lifeline, the leader of a group of its own')
    await stopTethered(1000)
    assert.deepEqual(await waitGone([mcp.pid!, child], 1500), [], 'the graceful stop ended the server and its child')
  } finally {
    _resetAndroidTether()
    cleanup()
  }
  const d = await startStandInDaemon(`
import { initAndroidTether, spawnTethered } from ${srcUrl('util/tether.ts')}
if (!(await initAndroidTether({ nativeLibDir: ${JSON.stringify(lib)}, sh: '/bin/sh', sleep: '/bin/sleep', log: () => {} }))) throw new Error('the helper failed its self-test')
const c = spawnTethered('sh', ['-c', ${JSON.stringify(forkingServer)}], { stdio: ['ignore', 'pipe', 'ignore'] }, { kind: 'mcp' })
c.stdout!.once('data', (b) => report({ server: c.pid, child: Number(String(b).trim()) }))
setInterval(() => {}, 1e9)
`)
  try {
    const { server, child } = await d.next<{ server: number; child: number }>()
    record(server, child)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone([server, child], 1500), [], 'the daemon\'s death ended the server and its child')
  } finally {
    killRecorded(d.pid)
  }
})

test('Android: the real helper passes the self-test and is used; broken ones fail a named step and the sh lifeline is used', { skip: androidHost }, async () => {
  const root = tmpDir('tllm-tether-android-')
  const sleepBin = '/bin/sleep'
  const lines: string[] = []
  const dirFor = (name: string, source: string | null, mode = 0o755) => {
    const dir = join(root, name)
    spawnSync('mkdir', ['-p', dir])
    if (source !== null) {
      const built = build(root, `${name}-bin`, source)
      assert.ok(built, `cc built ${name}`)
      copyFileSync(built, join(dir, 'libtether_exec.so'))
      chmodSync(join(dir, 'libtether_exec.so'), mode)
    }
    return dir
  }
  /** Spawn under whatever initAndroidTether chose: under the helper the program stays in this process's group (not
   *  detached); under the wrapper it leads a group of its own. */
  const leadsOwnGroup = async () => {
    const c = spawnTethered('sleep', ['30'], { stdio: 'ignore' }, { kind: 'engine' })
    record(c.pid)
    await sleep(100)
    const stat = readFileSync(`/proc/${c.pid}/stat`, 'utf8')
    const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2])
    c.kill('SIGKILL')
    return pgrp === c.pid
  }
  try {
    const good = dirFor('good', TETHER_EXEC_C)
    assert.equal(await initAndroidTether({ nativeLibDir: good, sh: '/bin/sh', sleep: sleepBin, log: (l) => lines.push(l) }), true)
    assert.match(lines.at(-1) ?? '', /^tether: libtether_exec\.so self-test passed \(\d+ ms\)$/)
    assert.equal(await leadsOwnGroup(), false, 'spawned under the helper')

    const cases: Array<[string, string | null, number, RegExp]> = [
      ['noexec', TETHER_EXEC_C, 0o644, /self-test failed: step 1: the program never ran under the helper/],
      ['exits127', EXITS_127_C, 0o755, /self-test failed: step 1: the program never ran under the helper/],
      ['nopdeathsig', NO_PDEATHSIG_C, 0o755, /self-test failed: step 2: the program outlived its parent sh/],
    ]
    for (const [name, source, mode, expected] of cases) {
      const dir = dirFor(name, source, mode)
      assert.equal(await initAndroidTether({ nativeLibDir: dir, sh: '/bin/sh', sleep: sleepBin, log: (l) => lines.push(l) }), false, name)
      assert.match(lines.at(-1) ?? '', expected, name)
      assert.match(lines.at(-1) ?? '', /tethered spawns use the \/bin\/sh lifeline instead$/)
      assert.equal(await leadsOwnGroup(), true, `${name}: the sh lifeline is used`)
    }
    const missing = dirFor('missing', null)
    assert.equal(await initAndroidTether({ nativeLibDir: missing, sh: '/bin/sh', sleep: sleepBin, log: (l) => lines.push(l) }), false)
    assert.match(lines.at(-1) ?? '', /libtether_exec\.so not found in .*; tethered spawns use the \/bin\/sh lifeline instead$/)

    const helper = join(good, 'libtether_exec.so')
    assert.equal(spawnSync(helper, ['1', sleepBin, '1']).status, 127, 'a parent pid of 1 is refused')
    const direct = await selfTestHelper(helper, { sh: '/bin/sh', sleep: sleepBin })
    assert.equal(direct.ok, true)
  } finally {
    _resetAndroidTether()
    cleanup()
  }
})

test('after refuseNewTetheredSpawns (the restart keeper) every tethered spawn throws, and a terminal gets no tie', posixOnly, async () => {
  const d = await startStandInDaemon(`
import { refuseNewTetheredSpawns, spawnHeld, spawnTethered, tetheredExecFile, tetherTerminal } from ${srcUrl('util/tether.ts')}
refuseNewTetheredSpawns()
const outcome = (f: () => unknown) => { try { f(); return 'started' } catch (e) { return (e as Error).message } }
const exec = await tetheredExecFile({ kind: 'probe' })('true').then(() => 'started', (e: Error) => e.message)
report({
  tethered: outcome(() => spawnTethered('sleep', ['300'], { stdio: 'ignore' }, { kind: 'probe' })),
  held: outcome(() => spawnHeld('sleep', ['300'], { stdio: 'ignore' }, { kind: 'code-bash', hold: 'daemon' })),
  exec,
  terminalWatchers: (() => {
    const children = () => process.getActiveResourcesInfo().filter((r) => r === 'ProcessWrap').length
    const before = children()
    tetherTerminal(process.pid)
    return children() - before
  })(),
})
process.exit(0)
`)
  try {
    const r = await d.next<{ tethered: string; held: string; exec: string; terminalWatchers: number }>()
    for (const outcome of [r.tethered, r.held, r.exec]) assert.match(outcome, /restart keeper and starts nothing more/)
    assert.equal(r.terminalWatchers, 0, 'no terminal watcher was started')
  } finally {
    killRecorded(d.pid)
  }
})
