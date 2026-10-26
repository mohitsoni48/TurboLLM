// An engine and everything it starts end the moment the daemon does (util/tether.ts): a SIGKILLed daemon left
// llama-server running, parented to init, holding the model's VRAM and port, and an engine's own workers outlived even
// a graceful stop (SIGTERM reaches the engine's pid alone). The stand-in engine starts a `sleep` grandchild and writes
// its pid to a file; it never writes to stdio after the daemon died.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ConfigStore } from '../config/config'
import { Manager, killTrackedEnginesSync, type StartOpts } from './manager'
import { freePort } from '../test-support/stand-in-engine'
import { isGone, killRecorded, pidWrittenTo, record, srcUrl, startStandInDaemon, waitGone } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'

const skip = process.platform === 'win32' ? 'a POSIX shell stand-in engine' : false

/** A stand-in llama-server: starts a grandchild that outlives a plain SIGTERM of the engine, records its pid, then
 *  answers /health on --port and exits at once on SIGTERM. `shebang: false` writes the bin as llamafile ships: no
 *  `#!`, which execve refuses with ENOEXEC. `termMs`: it exits that long after SIGTERM, and writes `exitFile` as it
 *  does (an engine that exits by itself, as llama-server does once its slots are freed). `stdoutHolder`: the
 *  grandchild is a worker in a session of its own that holds the engine's stdout and stderr, so the engine's
 *  'close' waits for it after the engine exits (on SIGUSR2). */
async function fakeEngine(dir: string, o: { kind?: 'llama-server' | 'llamafile'; shebang?: boolean; termMs?: number; stdoutHolder?: boolean } = {}): Promise<{ opts: StartOpts; grandchildFile: string; exitFile: string }> {
  const grandchildFile = join(dir, 'grandchild.pid')
  const exitFile = join(dir, 'exited-by-itself')
  writeFileSync(join(dir, 'fake-engine.js'), `
const http = require('http')
const { spawn } = require('child_process')
const fs = require('fs')
const g = ${o.stdoutHolder
    ? "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })"
    : "spawn('sleep', ['300'], { stdio: 'ignore' })"}
fs.writeFileSync(${JSON.stringify(grandchildFile)}, String(g.pid))
process.on('SIGUSR2', () => process.exit(0))
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{}') }).listen(port, '127.0.0.1')
process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(exitFile)}, 'exit 0 after SIGTERM'); process.exit(0) }, ${o.termMs ?? 0}))
`)
  const bin = join(dir, o.kind === 'llamafile' ? 'model.llamafile' : 'llama-server')
  writeFileSync(bin, `${o.shebang === false ? '' : '#!/bin/sh\n'}exec "${process.execPath}" "${join(dir, 'fake-engine.js')}" "$@"\n`)
  chmodSync(bin, 0o755)
  return {
    grandchildFile,
    exitFile,
    opts: {
      engine: { id: 'fake', name: 'Fake', binPath: bin, kind: o.kind ?? 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
      model: { key: 'A', name: 'A', quant: '', ctx: 0, vision: false },
      modelPath: join(dir, 'A.gguf'),
      extraArgs: [],
      preferredPort: await freePort(),
    },
  }
}


test('a daemon SIGKILLed with a model loaded takes the engine and its grandchild with it', { skip }, async () => {
  const dir = tmpDir('tllm-engine-tether-')
  const { opts, grandchildFile } = await fakeEngine(dir)
  const d = await startStandInDaemon(`
import { ConfigStore } from ${srcUrl('config/config.ts')}
import { Manager } from ${srcUrl('engines/manager.ts')}
const manager = new Manager(ConfigStore.load(${JSON.stringify(join(dir, 'config.json'))}))
await manager.load(${JSON.stringify(opts)})
report({ state: manager.status().state, pid: manager.status().pid })
setInterval(() => {}, 1e9)
`)
  try {
    const { state, pid } = await d.next<{ state: string; pid: number }>(30_000)
    const grandchild = await pidWrittenTo(grandchildFile)
    record(pid, grandchild)
    assert.equal(state, 'running')
    assert.equal(isGone(grandchild), false)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone([pid, grandchild], 1000), [], 'the engine and its grandchild are gone within 1 s')
  } finally {
    killRecorded(d.pid)
  }
})

test('manager.shutdown(): the engine gets SIGTERM, and the grandchild it left goes with its group', { skip }, async (t) => {
  const dir = tmpDir('tllm-engine-shutdown-')
  const { opts, grandchildFile } = await fakeEngine(dir)
  const manager = new Manager(ConfigStore.load(join(dir, 'config.json')))
  t.after(() => manager.stopAndWait({ force: true }))
  try {
    await manager.load(opts)
    assert.equal(manager.status().state, 'running')
    const pid = manager.status().pid as number
    const grandchild = await pidWrittenTo(grandchildFile)
    record(pid, grandchild)
    await manager.shutdown()
    assert.equal(manager.status().state, 'stopped', 'it exited on its SIGTERM, not by the force kill')
    assert.deepEqual(await waitGone([grandchild], 1000), [], 'the grandchild did not outlive it')
  } finally {
    killRecorded()
  }
})

// A Ctrl+C or SIGTERM while a stop is already under way (a Stop, an eject, the idle unload, a Settings restart's
// teardown) found the engine 'stopping': shutdown() returned at once, the daemon exited about 1.5 s into the stop's
// 8 s grace, and the exit handler SIGKILLed the engine's group before it could exit by itself.
test('manager.shutdown() during a stop already under way waits for the engine to exit by itself', { skip }, async (t) => {
  const dir = tmpDir('tllm-engine-shutdown-stopping-')
  const termMs = 1500
  const { opts, grandchildFile, exitFile } = await fakeEngine(dir, { termMs })
  const manager = new Manager(ConfigStore.load(join(dir, 'config.json')))
  t.after(() => manager.stopAndWait({ force: true }))
  try {
    await manager.load(opts)
    const pid = manager.status().pid as number
    record(pid, await pidWrittenTo(grandchildFile))
    manager.stop()
    assert.equal(manager.status().state, 'stopping')
    const at = Date.now()
    await manager.shutdown()
    assert.ok(existsSync(exitFile), `the engine exited by itself after its SIGTERM (shutdown() returned after ${Date.now() - at} ms)`)
    assert.ok(Date.now() - at >= termMs - 200, 'shutdown() waited for that exit')
    assert.equal(manager.status().state, 'stopped')
    assert.deepEqual(await waitGone([pid], 1000), [])
  } finally {
    killRecorded()
  }
})

test('a llamafile with no shebang (execve refuses it) loads through the wrapper\'s sh', { skip }, async (t) => {
  const dir = tmpDir('tllm-engine-llamafile-')
  const { opts, grandchildFile } = await fakeEngine(dir, { kind: 'llamafile', shebang: false })
  const manager = new Manager(ConfigStore.load(join(dir, 'config.json')))
  t.after(() => manager.stopAndWait({ force: true }))
  try {
    await manager.load(opts)
    record(manager.status().pid, await pidWrittenTo(grandchildFile))
    assert.equal(manager.status().state, 'running')
  } finally {
    await manager.stopAndWait({ force: true })
    killRecorded()
  }
})

/** Resolves once `pid` is gone from the process table: Node has reaped it, and its child's exitCode is set. */
async function reaped(pid: number, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    if (Date.now() > deadline) throw new Error(`pid ${pid} not reaped within ${ms} ms`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** `f` as if on Windows, with execFile and spawnSync recorded in `calls` and not run. */
function asWindows<T>(t: TestContext, calls: string[][], f: () => T): T {
  const note = (file: string, args: readonly string[]) => { calls.push([file, ...args]) }
  const e = t.mock.method(childProcess, 'execFile', ((file: string, args: readonly string[]) => { note(file, args) }) as unknown as typeof childProcess.execFile)
  const s = t.mock.method(childProcess, 'spawnSync', ((file: string, args: readonly string[]) => { note(file, args); return { status: 0 } }) as unknown as typeof childProcess.spawnSync)
  syncBuiltinESMExports()
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  try {
    return f()
  } finally {
    Object.defineProperty(process, 'platform', platform)
    e.mock.restore()
    s.mock.restore()
    syncBuiltinESMExports()
  }
}

// On Windows the force kill is `taskkill /PID <pid> /F /T`. An engine that has exited while a worker it left still
// holds its stdout is still 'running' to the manager, whose 'close' waits for that worker, so a stop (whose SIGTERM is
// that force kill there), a forced stop and the grace's force kill sent taskkill for a pid Node had reaped: libuv had
// closed the handle that kept it from being reused, so the tree it named could be another program's by then.
test('on Windows a stop sends no taskkill once Node has seen the engine exit, while a worker it left holds its stdout (platform and execFile stubbed, so on every OS)', { skip }, async (t) => {
  const dir = tmpDir('tllm-engine-exited-stop-')
  const { opts, grandchildFile } = await fakeEngine(dir, { stdoutHolder: true })
  const manager = new Manager(ConfigStore.load(join(dir, 'config.json')))
  t.after(() => manager.stopAndWait({ force: true }))
  try {
    await manager.load(opts)
    const pid = manager.status().pid as number
    const worker = await pidWrittenTo(grandchildFile)
    record(pid, worker)
    process.kill(pid, 'SIGUSR2')
    await reaped(pid)
    assert.equal(manager.status().state, 'running', 'its close waits for the worker holding its stdout')
    const calls: string[][] = []
    asWindows(t, calls, () => manager.stop())
    const stopped = asWindows(t, calls, () => manager.stopAndWait({ force: true }))
    assert.deepEqual(calls, [], 'no taskkill for a pid Node has reaped')
    process.kill(worker, 'SIGKILL')
    await stopped
    assert.equal(manager.status().state, 'stopped')
  } finally {
    killRecorded()
  }
})

// The 'exit' handler's killTrackedEnginesSync kills by pidfile (taskkill /T on Windows, the pid as the fallback on
// POSIX). The pidfile went only at the engine's 'close', which a worker holding its stdout holds back, so a daemon
// exiting meanwhile killed a pid Node had reaped.
test('the exit handler\'s kill names no engine Node has seen exit: its pidfile goes at the exit, while a worker it left still holds its stdout (platform and spawnSync stubbed, so on every OS)', { skip }, async (t) => {
  const dir = tmpDir('tllm-engine-exited-sync-')
  const { opts, grandchildFile } = await fakeEngine(dir, { stdoutHolder: true })
  const manager = new Manager(ConfigStore.load(join(dir, 'config.json')))
  t.after(() => manager.stopAndWait({ force: true }))
  try {
    await manager.load(opts)
    const pid = manager.status().pid as number
    const worker = await pidWrittenTo(grandchildFile)
    record(pid, worker)
    const pidFile = join(dir, 'run', `engine-${pid}.pid`)
    assert.ok(existsSync(pidFile), 'a running engine has its pidfile')
    process.kill(pid, 'SIGUSR2')
    await reaped(pid)
    assert.equal(manager.status().state, 'running', 'its close waits for the worker holding its stdout')
    const calls: string[][] = []
    asWindows(t, calls, () => killTrackedEnginesSync(dir))
    assert.deepEqual(calls, [], 'no taskkill for a pid Node has reaped')
    assert.equal(existsSync(pidFile), false)
    process.kill(worker, 'SIGKILL')
  } finally {
    killRecorded()
  }
})
