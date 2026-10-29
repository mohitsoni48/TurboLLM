// The boot check (util/pid1.ts) under the PID 1s TurboLLM really runs under, each in a pid namespace of its own
// (`unshare --pid --fork --mount-proc`, as root or through `sudo -n`; skipped where neither works). The images used
// to run node itself as PID 1, and every orphan TurboLLM made (every tethered child's watcher, double-forked to be
// adopted) stayed a zombie: nothing said so. GitHub Actions' `container:` jobs run `tail -f /dev/null` as PID 1,
// which does not reap either. tini, as the images now start it, reaps; so does tini -s under a shell (--init).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { checkOrphansReaped } from './pid1'
import { tmpDir } from '../test-support/tmp'

const require = createRequire(import.meta.url)
const TSX = pathToFileURL(require.resolve('tsx')).href
const PID1 = pathToFileURL(require.resolve('./pid1.ts')).href

/** How to run unshare here: directly as root, through `sudo -n`, or not at all. */
function unshareVia(): string[] | null {
  if (process.platform !== 'linux') return null
  const works = (argv: string[]) => spawnSync(argv[0], argv.slice(1), { stdio: 'ignore', timeout: 10_000 }).status === 0
  const ns = ['unshare', '--pid', '--fork', '--mount-proc', 'true']
  if (process.getuid?.() === 0 && works(ns)) return []
  if (works(['sudo', '-n', ...ns])) return ['sudo', '-n']
  return null
}
const via = unshareVia()
const skip = via === null ? 'needs Linux and `unshare --pid --fork --mount-proc` (root, or passwordless sudo)' : false
const tini = spawnSync('sh', ['-c', 'command -v tini'], { encoding: 'utf8' }).stdout.trim()
const bash = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()

/** The node that runs the check, as a command line the namespace's PID 1 can start; `prelude` runs first. */
const checkCommand = (timeoutMs: number, prelude = '') => [process.execPath, '--import', TSX, '-e', prelude +
  `import(${JSON.stringify(PID1)}).then(async ({ checkOrphansReaped }) => { ` +
  `const r = await checkOrphansReaped({ timeoutMs: ${timeoutMs}, log: (l) => console.log('WARN ' + l) }); console.log('RESULT ' + r) })`]

/** A prelude that makes every `/bin/sh -c` the check starts linger 0.5 s before it exits, as a sh preempted right
 *  after its fork on a busy machine does. */
const SLOW_SH = "const cp = require('node:child_process'); const spawn = cp.spawn; " +
  "cp.spawn = (cmd, args, o) => spawn(cmd, cmd === '/bin/sh' ? [args[0], args[1] + '; sleep 0.5'] : args, o); " +
  "require('node:module').syncBuiltinESMExports(); "

/** The unshares of namespaces still running, by pid, ended at exit if a test left one (it never should). */
const liveUnshares = new Set<number>()
/** SIGKILL an unshare: --kill-child then SIGKILLs the namespace's PID 1, which ends every process in it. As root
 *  directly; under sudo through `sudo -n kill`, which signals unshare itself. A SIGTERM to sudo, for it to relay,
 *  ended nothing: sudo relays no signal sent from a process in its own process group, and the `sudo -n kill` was
 *  in it (both sudos are started in this file's group); and unshare --fork blocks SIGTERM and SIGINT while it
 *  waits for its child (SigBlk 0x4002). `tail -f /dev/null` as PID 1 never exits by itself, so its namespace lived
 *  on, its pipes held this file's process open, and the test run never ended: CI's runner is a non-root user with
 *  passwordless sudo, and its unit test job hung for hours after this file. */
function killUnshare(pid: number): void {
  if (via?.length) spawnSync('sudo', ['-n', 'kill', '-KILL', String(pid)], { stdio: 'ignore', timeout: 10_000 })
  else { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
}
process.once('exit', () => { for (const pid of liveUnshares) killUnshare(pid) })

/** Run `pid1` (argv) as PID 1 of a new pid namespace; --kill-child ends the namespace when unshare ends. Returns
 *  what the check printed, once it printed its RESULT line. Whatever happens, by the time this returns or throws
 *  the namespace has ended (unshare, sudo and every process in it, which all hold the output pipes), or it throws
 *  saying so, having let go of the pipes so that this file's process can still exit. */
async function inNamespace(pid1: string[]): Promise<string> {
  const unshare = ['unshare', '--pid', '--fork', '--kill-child', '--mount-proc', ...pid1]
  // Under sudo the child is sudo, so a shell between them says unshare's pid before it execs it (sudo may run it
  // under a monitor process of its own, use_pty, so sudo's own child is not always unshare).
  const argv = via?.length ? [...via, 'sh', '-c', 'echo "UNSHARE $$"; exec "$@"', 'sh', ...unshare] : unshare
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  let out = ''
  child.stdout.on('data', (d: Buffer) => { out += d.toString() })
  child.stderr.on('data', (d: Buffer) => { out += d.toString() })
  let unsharePid = via?.length ? undefined : child.pid
  const learnUnsharePid = () => {
    const said = unsharePid === undefined ? /^UNSHARE (\d+)$/m.exec(out) : null
    if (said) unsharePid = Number(said[1])
    if (unsharePid !== undefined) liveUnshares.add(unsharePid)
  }
  learnUnsharePid()
  try {
    const deadline = Date.now() + 30_000
    while (!/RESULT \S+/.test(out)) {
      learnUnsharePid()
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`no result; it printed:\n${out}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return out
  } finally {
    learnUnsharePid()
    // A namespace whose PID 1 is the check's node ends by itself once it has printed; tail's never does.
    if (child.exitCode === null && child.signalCode === null && unsharePid !== undefined) killUnshare(unsharePid)
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<boolean>((resolve) => { timer = setTimeout(resolve, 10_000, false) })
    const ended = await Promise.race([closed.then(() => true), late])
    clearTimeout(timer)
    if (!ended) {
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      // biome-ignore lint/correctness/noUnsafeFinally: deliberate — a namespace that outlives its kill is itself the failure this test harness reports, even over a try-block error
      throw new Error(`the namespace (unshare ${unsharePid ?? 'of unknown pid'}) did not end within 10 s of its kill; it printed:\n${out}`)
    }
    if (unsharePid !== undefined) liveUnshares.delete(unsharePid)
  }
}

const WARNING = /WARN TurboLLM's orphaned processes are not being reaped \(PID 1 is '(\S+)' and reaped nothing within 2 s\): every process TurboLLM ends would stay a zombie\. Run the image as shipped \(it starts tini\), or add --init\./

test('node as PID 1 (the images before tini): the orphan stays a zombie, and the check says so', { skip }, async () => {
  const out = await inNamespace(checkCommand(2000))
  assert.match(out, /RESULT not-reaped/)
  assert.match(out, WARNING)
  assert.equal(WARNING.exec(out)?.[1], 'node')
})

// The orphan used to be a `sh -c "exit 0"`: when it exited before the sh that started it, that sh reaped it itself,
// it never reached PID 1, and the check said 'reaped' under node. Loaded with busy loops, 1 run in 3 did; here the
// sh lingers every time.
test('node as PID 1, the sh that starts the orphan slow to exit (a busy machine): the check still says so', { skip }, async () => {
  const out = await inNamespace(checkCommand(2000, SLOW_SH))
  assert.match(out, /RESULT not-reaped/)
  assert.equal(WARNING.exec(out)?.[1], 'node')
})

// bash's read takes an exported TMOUT for a timeout. Where the orphan's `sh` is bash (Fedora, Arch), a TMOUT shorter
// than the sh that starts it took to exit let the orphan exit first, that sh reaped it, and the check said 'reaped'
// under node. `env` sets the two (sudo would drop them) and execs node in place, so node is still PID 1.
test('node as PID 1, bash as the orphan\'s sh with an exported TMOUT, and the sh that starts it slow to exit: the check still says so', { skip: skip || (!bash && 'needs bash') }, async () => {
  const dir = tmpDir('tllm-pid1-tmout-')
  symlinkSync(bash, join(dir, 'sh'))
  const out = await inNamespace(['env', `PATH=${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`, 'TMOUT=0.1', ...checkCommand(2000, SLOW_SH)])
  assert.match(out, /RESULT not-reaped/)
  assert.equal(WARNING.exec(out)?.[1], 'node')
})

test('`tail -f /dev/null` as PID 1 with node under it (a GitHub Actions container job): the check says so', { skip }, async () => {
  const command = checkCommand(2000).map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
  const out = await inNamespace(['/bin/sh', '-c', `${command} & exec tail -f /dev/null`])
  assert.match(out, /RESULT not-reaped/)
  assert.equal(WARNING.exec(out)?.[1], 'tail')
})

test('tini as PID 1 (the images now): the orphan is reaped, and nothing is said', { skip: skip || (!tini && 'tini is not installed') }, async () => {
  const out = await inNamespace([tini, '-s', '--', ...checkCommand(2000)])
  assert.match(out, /RESULT reaped/)
  assert.doesNotMatch(out, /WARN/)
})

test('a shell as PID 1 with tini -s under it (docker run --init, compose init: true): reaped, nothing said', { skip: skip || (!tini && 'tini is not installed') }, async () => {
  const command = [tini, '-s', '--', ...checkCommand(2000)].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
  const out = await inNamespace(['/bin/sh', '-c', `${command}; :`])
  assert.match(out, /RESULT reaped/)
  assert.doesNotMatch(out, /WARN/)
})

test('the check runs on Linux only', async () => {
  for (const platform of ['darwin', 'win32', 'android'] as const) assert.equal(await checkOrphansReaped({ platform }), 'skipped')
})
