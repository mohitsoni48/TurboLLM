// An engine build's steps, the prerequisite installs and the build's probes run through util/tether.ts. Before, a
// build step's whole group was killed only by the daemon's 'exit' handler, a prerequisite install by nothing, and
// the ldconfig and vswhere probes only by their own (daemon-timer) timeouts: a daemon that died without its handlers
// (SIGKILL, an out-of-memory kill) left cmake, ninja and the compiler jobs running, parented to init.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildNodeReuseEnv } from './build-runner'
import { killRecorded, record, srcUrl, startStandInDaemon, waitGone, writtenTo } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'

const skip = process.platform === 'win32' ? 'POSIX shell stand-ins and process groups' : false
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function pidsIn(file: string, n: number): Promise<number[]> {
  const deadline = Date.now() + 5000
  for (;;) {
    const pids = (await writtenTo(file)).trim().split(/\s+/).map(Number)
    if (pids.length === n && pids.every((p) => p > 0)) return pids
    if (Date.now() >= deadline) throw new Error(`${file} holds no ${n} pids`)
    await sleep(25)
  }
}

test('a daemon SIGKILLed during a build step takes the step and its compiler jobs with it', { skip }, async () => {
  const dir = tmpDir('tllm-build-tether-')
  const pids = join(dir, 'pids')
  // The step stands in for cmake: two background "compiler jobs" and a wait.
  const d = await startStandInDaemon(`
import { runStep } from ${srcUrl('engines/build-runner.ts')}
void runStep('sh', ['-c', 'sleep 300 & a=$!; sleep 301 & echo "$$ $a $!" > ${pids}; wait'], { env: { ...process.env }, signal: new AbortController().signal, onLine: () => {} }).catch(() => {})
report({ started: true })
setInterval(() => {}, 1e9)
`)
  try {
    await d.next()
    const running = await pidsIn(pids, 3)
    record(...running)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone(running, 1000), [], 'the step and both jobs are gone within 1 s')
  } finally {
    killRecorded(d.pid)
  }
})

test('a daemon SIGKILLed during a prerequisite install sends the package manager SIGTERM, and nothing harder', { skip }, async () => {
  const dir = tmpDir('tllm-install-tether-')
  const log = join(dir, 'log')
  const pm = join(dir, 'pm')
  // A package manager that finishes its transaction after SIGTERM, as dnf and brew stop at a safe point. It writes to
  // a file, never to the dead daemon's pipes (a write there would be SIGPIPE, not the signal under test).
  writeFileSync(pm, [
    '#!/bin/sh',
    `echo $$ > ${join(dir, 'pid')}`,
    `trap 'echo term >> ${log}' TERM`,
    'i=0; while [ $i -lt 15 ]; do sleep 0.1; i=$((i+1)); done',
    `echo done >> ${log}`,
    '',
  ].join('\n'))
  chmodSync(pm, 0o755)
  const d = await startStandInDaemon(`
import { runStep } from ${srcUrl('engines/build-runner.ts')}
void runStep(${JSON.stringify(pm)}, [], { env: { ...process.env }, signal: new AbortController().signal, onLine: () => {}, killTree: false }).catch(() => {})
report({ started: true })
setInterval(() => {}, 1e9)
`)
  let pid = 0
  try {
    await d.next()
    ;[pid] = await pidsIn(join(dir, 'pid'), 1)
    record(pid)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone([pid], 5000), [], 'it finished')
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['term', 'done'], 'SIGTERM, then its own end: no SIGKILL')
  } finally {
    killRecorded(d.pid, pid)
  }
})

test('a daemon SIGKILLed while the build\'s `ldconfig -p` probe hangs takes it with it', { skip }, async () => {
  const dir = tmpDir('tllm-ldconfig-tether-')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const pids = join(dir, 'pids')
  writeFileSync(join(bin, 'ldconfig'), `#!/bin/sh\nsleep 300 &\necho "$$ $!" > ${pids}\nwait\n`)
  chmodSync(join(bin, 'ldconfig'), 0o755)
  const d = await startStandInDaemon(`
import { findLibcudaDir } from ${srcUrl('engines/build-runner.ts')}
void findLibcudaDir(new AbortController().signal)
report({ started: true })
setInterval(() => {}, 1e9)
`, { env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })
  try {
    await d.next()
    const running = await pidsIn(pids, 2)
    record(...running)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone(running, 1000), [], 'ldconfig and its child are gone within 1 s')
  } finally {
    killRecorded(d.pid)
  }
})

test('the build\'s env turns MSBuild\'s node reuse off on Windows, and only there', () => {
  assert.deepEqual(buildNodeReuseEnv('win32'), { MSBUILDDISABLENODEREUSE: '1' })
  assert.deepEqual(buildNodeReuseEnv('linux'), {})
  assert.deepEqual(buildNodeReuseEnv('darwin'), {})
  const src = readFileSync(fileURLToPath(new URL('./build-runner.ts', import.meta.url)), 'utf8')
  assert.ok(src.includes("GCM_INTERACTIVE: 'never', ...buildNodeReuseEnv(process.platform) }"), 'the build steps\' env carries it')
})
