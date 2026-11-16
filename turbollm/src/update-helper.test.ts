// The detached app-updater helper (update-helper.mjs), run for real: `node update-helper.mjs <json>`
// as spawnUpdateHelper starts it. It runs its whole job when it loads and may import nothing out of
// the package, so it is driven from outside, against real processes, rather than imported.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { helperPath } from './app-update-apply'
import { tmpDir } from './test-support/tmp'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Whether `pid` is a zombie, read the way the OS reports it (not the way the helper does). */
function zombie(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')')).startsWith(') Z')
    } catch {
      return false
    }
  }
  return /^\s*Z/.test(spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '')
}

// A daemon whose parent does not reap it (a Python Popen handle kept and never waited on, a
// container PID 1 that is not an init) is a zombie once it exits, and signal 0 still reaches a
// zombie. The helper took the daemon for alive through its whole 60 s wait, then gave up: the
// update was not applied, and nothing relaunched the daemon, which was gone.
test('the update helper takes a daemon that exited but was not reaped for gone, and relaunches it', {
  skip: process.platform === 'win32' && 'no zombie processes on Windows',
}, async () => {
  // `exec sleep` never reaps the background sleep: killed, it stays a zombie.
  const parent = spawn('sh', ['-c', 'sleep 60 & echo $!; exec sleep 60'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const dataDir = tmpDir('tllm-update-helper-')
  const marker = join(dataDir, 'relaunched')
  let helper: ReturnType<typeof spawn> | undefined
  try {
    const pid = await new Promise<number>((resolve, reject) => {
      parent.stdout!.once('data', (b: Buffer) => resolve(Number(String(b).trim())))
      parent.once('error', reject)
    })
    process.kill(pid, 'SIGKILL')
    for (let i = 0; i < 100 && !zombie(pid); i++) await sleep(20)
    assert.ok(zombie(pid), 'the stand-in daemon is a zombie')

    const payload = JSON.stringify({
      pid,
      dataDir,
      method: 'source', // installs nothing: the wait and the relaunch are what is tested
      from: '1.0.0',
      to: '1.0.1',
      execPath: process.execPath,
      argv: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'up')`],
      cwd: dataDir,
    })
    const started = Date.now()
    helper = spawn(process.execPath, [helperPath(), payload], { cwd: dataDir, stdio: 'ignore' })
    const exited = new Promise<void>((resolve) => helper!.once('exit', () => resolve()))
    let timer: NodeJS.Timeout | undefined
    // Well under the 60 s wait for exit, with room for the ~10 s watch of the relaunched daemon.
    const done = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), 20_000) })])
    clearTimeout(timer)
    assert.ok(done, 'the helper waited for a daemon that is gone')
    assert.ok(Date.now() - started < 20_000)
    const result = JSON.parse(readFileSync(join(dataDir, 'update-result.json'), 'utf8')) as { ok: boolean; error?: string }
    assert.equal(result.ok, true, result.error)
    for (let i = 0; i < 250 && !existsSync(marker); i++) await sleep(20)
    assert.equal(readFileSync(marker, 'utf8'), 'up', 'the daemon was relaunched')
  } finally {
    helper?.kill('SIGKILL')
    parent.kill('SIGKILL')
  }
})

// After a Settings restart from a terminal the daemon runs under its restart keeper (cli.ts becomeKeeper), the old
// process, which still holds the package's files open: on Windows `npm i -g` cannot replace them until it exits too.
test('the update helper waits for every pid it is given (the restart keeper too) before it relaunches', async () => {
  const dataDir = tmpDir('tllm-update-helper-')
  const marker = join(dataDir, 'relaunched')
  const daemon = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], { stdio: 'ignore' })
  const keeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' })
  let keeperGoneAt = 0
  keeper.once('exit', () => { keeperGoneAt = Date.now() })
  let helper: ReturnType<typeof spawn> | undefined
  try {
    const payload = JSON.stringify({
      pid: daemon.pid,
      alsoWait: [keeper.pid],
      dataDir,
      method: 'source',
      from: '1.0.0',
      to: '1.0.1',
      execPath: process.execPath,
      argv: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, String(Date.now()))`],
      cwd: dataDir,
    })
    helper = spawn(process.execPath, [helperPath(), payload], { cwd: dataDir, stdio: 'ignore' })
    for (let i = 0; i < 500 && !existsSync(marker); i++) await sleep(20)
    for (let i = 0; i < 50 && readFileSync(marker, 'utf8') === ''; i++) await sleep(20)
    const relaunchedAt = Number(readFileSync(marker, 'utf8'))
    assert.ok(keeperGoneAt > 0, 'the keeper had exited when the daemon was relaunched')
    assert.ok(relaunchedAt >= keeperGoneAt, 'the relaunch came after the keeper was gone')
  } finally {
    helper?.kill('SIGKILL')
    daemon.kill('SIGKILL')
    keeper.kill('SIGKILL')
  }
})

/** Run the helper against a daemon that has already exited, relaunching `relaunchedScript` with node. */
async function runHelper(dataDir: string, relaunchedScript: string, waitMs: number): Promise<{ ok: boolean; error?: string; at: string }> {
  const payload = JSON.stringify({
    pid: 2_147_483_646, // no such process: the old daemon is gone
    dataDir,
    method: 'source', // installs nothing: the relaunch watch is what is tested
    from: '1.15.0',
    to: '1.16.0',
    execPath: process.execPath,
    argv: ['-e', relaunchedScript],
    cwd: dataDir,
  })
  const helper = spawn(process.execPath, [helperPath(), payload], { cwd: dataDir, stdio: 'ignore' })
  try {
    const exited = new Promise<void>((resolve) => helper.once('exit', () => resolve()))
    let timer: NodeJS.Timeout | undefined
    const done = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), waitMs) })])
    clearTimeout(timer)
    assert.ok(done, 'the helper finished')
    return JSON.parse(readFileSync(join(dataDir, 'update-result.json'), 'utf8')) as { ok: boolean; error?: string; at: string }
  } finally {
    helper.kill('SIGKILL')
  }
}

// PG-3: an update into a core release on a system with no native binary used to write a success
// and exit, while the relaunched daemon stopped at once with exit 69: TurboLLM was left stopped.
test('the update helper reports a relaunched daemon that exits 69 as a failed update, with the reinstall instruction', async () => {
  const dataDir = tmpDir('tllm-update-helper-')
  const result = await runHelper(
    dataDir,
    `process.stderr.write("TurboLLM's native core is not available for this system.\\n"); process.exit(69)`,
    9_000,
  )
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /TurboLLM's native core is not available/)
  assert.match(result.error ?? '', /Reinstall with: npm install -g turbollm \(without --omit=optional\)/)
})

// The success is written only once the relaunched daemon has outlived the ~10 s watch: a result written at
// relaunch (the PG-3 defect) would come before the daemon even started.
test('the update helper records success for a relaunched daemon still running after the watch', { timeout: 30_000 }, async () => {
  const dataDir = tmpDir('tllm-update-helper-')
  const startFile = join(dataDir, 'relaunched.json')
  const readStart = () => JSON.parse(readFileSync(startFile, 'utf8')) as { pid: number; at: number }
  try {
    const result = await runHelper(
      dataDir,
      `require('fs').writeFileSync(${JSON.stringify(startFile)}, JSON.stringify({ pid: process.pid, at: Date.now() })); setTimeout(() => {}, 20000)`,
      20_000,
    )
    assert.equal(result.ok, true, result.error)
    const relaunched = readStart()
    const watched = Date.parse(result.at) - relaunched.at
    assert.ok(watched >= 9_000 && watched <= 11_000, `the result came ${watched} ms after the relaunch, not after the ~10 s watch`)
    assert.doesNotThrow(() => process.kill(relaunched.pid, 0), 'the relaunched daemon outlived the helper')
  } finally {
    if (existsSync(startFile)) {
      try {
        process.kill(readStart().pid)
      } catch {
        /* already gone */
      }
    }
  }
})
