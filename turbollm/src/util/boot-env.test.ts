// The variables by which a parent says "I supervise you" are read once at boot, bound to the parent's pid and removed
// from process.env (boot-env.ts). Before, TURBOLLM_DESKTOP=1 reached every child of the desktop app's daemon: a
// TurboLLM run from a desktop Code terminal took itself for the app's own daemon and, on a Settings restart, exited
// 75 for an app that was not listening. A stdin lifeline read the same way would have shut a nested TurboLLM down the
// moment it started (its stdin is /dev/null).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BOOT_ENV_NAMES, _resetBootEnvironment, bootEnvironment, takeBootEnvironment } from './boot-env'
import { sourceFilesUnder } from '../test-support/raw-spawn-sites'

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url))

function take(env: NodeJS.ProcessEnv, ppid = 4242) {
  _resetBootEnvironment()
  const logged: string[] = []
  const boot = takeBootEnvironment(env, ppid, (line) => logged.push(line))
  return { boot, logged }
}

test('a lifeline and a keeper are honoured only when they name this process\'s parent, and all three are removed', () => {
  try {
    const env: NodeJS.ProcessEnv = { TURBOLLM_LIFELINE: 'stdin:4242', TURBOLLM_SUPERVISOR: 'keeper:4242', TURBOLLM_DESKTOP: '1', KEEP: 'x' }
    const { boot, logged } = take(env)
    assert.deepEqual({ ...boot }, { stdinLifeline: true, keeperPid: 4242, desktop: true, testStallRestart: false, testSlowShutdownMs: 0 })
    assert.deepEqual(env, { KEEP: 'x' }, 'removed, so no child inherits them')
    assert.deepEqual(logged, [])

    const copied: NodeJS.ProcessEnv = { TURBOLLM_LIFELINE: 'stdin:999', TURBOLLM_SUPERVISOR: 'keeper:999' }
    const mismatch = take(copied)
    assert.equal(mismatch.boot.stdinLifeline, false, 'a lifeline copied into a grandchild\'s env is not its own')
    assert.equal(mismatch.boot.keeperPid, null)
    assert.equal(mismatch.logged.length, 2)
    assert.match(mismatch.logged[0], /TURBOLLM_SUPERVISOR=keeper:999 does not name this process's parent \(pid 4242\); ignored/)
    assert.match(mismatch.logged[1], /TURBOLLM_LIFELINE=stdin:999 does not name this process's parent/)
    assert.deepEqual(copied, {})

    for (const notAPromise of ['', '0', 'true', 'yes']) {
      assert.equal(take({ TURBOLLM_DESKTOP: notAPromise }).boot.desktop, false, `TURBOLLM_DESKTOP='${notAPromise}'`)
    }
    assert.equal(take({ TURBOLLM_LIFELINE: 'stdin' }).boot.stdinLifeline, false, 'an unbound value is not honoured')
    assert.deepEqual(take({}).logged, [], 'nothing set: nothing to log')
  } finally {
    _resetBootEnvironment()
  }
})

test('the answer is taken once: later calls return it, whatever the environment says by then', () => {
  try {
    const env: NodeJS.ProcessEnv = { TURBOLLM_DESKTOP: '1' }
    const first = take(env).boot
    env.TURBOLLM_DESKTOP = '1'
    assert.equal(takeBootEnvironment(env), first)
    assert.equal(bootEnvironment(), first)
    assert.equal(env.TURBOLLM_DESKTOP, '1', 'a second call reads nothing')
  } finally {
    _resetBootEnvironment()
  }
})

test('a child spawned after boot inherits none of them', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { takeBootEnvironment } = await import(${JSON.stringify(new URL('./boot-env.ts', import.meta.url).href)})
    const { spawnSync } = await import('node:child_process')
    const boot = takeBootEnvironment()
    const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify([process.env.TURBOLLM_LIFELINE, process.env.TURBOLLM_SUPERVISOR, process.env.TURBOLLM_DESKTOP]))'], { encoding: 'utf8' })
    console.log(JSON.stringify({ boot, child: JSON.parse(child.stdout) }))
  `], { encoding: 'utf8', env: { ...process.env, TURBOLLM_LIFELINE: `stdin:${process.pid}`, TURBOLLM_SUPERVISOR: `keeper:${process.pid}`, TURBOLLM_DESKTOP: '1' } })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout.trim().split('\n').pop() as string) as { boot: { stdinLifeline: boolean; keeperPid: number; desktop: boolean }; child: unknown[] }
  assert.equal(out.boot.stdinLifeline, true)
  assert.equal(out.boot.keeperPid, process.pid)
  assert.equal(out.boot.desktop, true)
  assert.deepEqual(out.child, [null, null, null], 'the child saw none of the three')
})

test('no file but boot-env.ts reads the supervision variables from the environment', () => {
  const names = BOOT_ENV_NAMES.join('|')
  // `env.TURBOLLM_X`, `env['TURBOLLM_X']`, `process.env.TURBOLLM_X`: a read. Setting one in a child's env
  // (`{ TURBOLLM_LIFELINE: … }`, the keeper and the desktop app) is not.
  const read = new RegExp(`\\benv(\\.|\\[\\s*['"\`])(${names})\\b`)
  const offenders: string[] = []
  for (const file of sourceFilesUnder(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).split(sep).join('/')
    if (rel === 'util/boot-env.ts') continue
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (read.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], 'read them through bootEnvironment() (util/boot-env.ts) instead')
})
