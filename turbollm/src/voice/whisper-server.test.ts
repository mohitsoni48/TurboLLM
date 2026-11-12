import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../test-support/tmp'
import { spawnTethered } from '../util/tether'
import { WhisperServer, WhisperStartError, startFailureMessage, whisperServerArgs, whisperThreads, type WhisperLaunch, type WhisperServerOptions } from './whisper-server'

const FAKE_SERVER = fileURLToPath(new URL('../test-support/fake-whisper-server.mjs', import.meta.url))

const launch: WhisperLaunch = { binPath: '/nowhere/whisper-server', modelPath: '/models/ggml-base.bin', gpu: false }

async function waitFor(what: string, cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function healthOk(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
    return res.status === 200 && ((await res.json()) as { status: string }).status === 'ok'
  } catch {
    return false
  }
}

/** A WhisperServer whose process is the fake script: the launch's binPath is ignored (its folder only has to exist) and
 *  node runs the script with the very args whisper-server would have got. `extraEnv` steers the fake. */
function fakeRig(extraEnv: Record<string, string> = {}, opts: Partial<WhisperServerOptions> = {}) {
  const dir = tmpDir('tllm-whisper-server-')
  const spawns: { args: readonly string[]; child: ChildProcess }[] = []
  const states: string[] = []
  const server: WhisperServer = new WhisperServer({
    dataDir: dir,
    onChange: () => states.push(server.state()),
    spawn: (_bin, args, options, tether) => {
      const child = spawnTethered(process.execPath, [FAKE_SERVER, ...(args ?? [])], { ...options, cwd: dir, env: { ...options.env, ...extraEnv } }, tether)
      spawns.push({ args: args ?? [], child })
      return child
    },
    ...opts,
  })
  return { server, spawns, states, dir }
}

const exitedOf = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

test('whisperServerArgs binds loopback on the given port with the model, and turns the GPU off unless asked', () => {
  const off = whisperServerArgs(launch, 4321)
  assert.deepEqual(off, ['--host', '127.0.0.1', '--port', '4321', '-m', '/models/ggml-base.bin', '-l', 'auto', '-ng'])
  const on = whisperServerArgs({ ...launch, gpu: true }, 4321)
  assert.equal(on.includes('-ng'), false)
  assert.equal(on[on.indexOf('--host') + 1], '127.0.0.1')
})

test('whisperServerArgs puts -t after -l auto and before -ng, with the count floored, only for a positive threads', () => {
  const base = ['--host', '127.0.0.1', '--port', '4321', '-m', '/models/ggml-base.bin', '-l', 'auto']
  for (const gpu of [false, true]) {
    const tail = gpu ? [] : ['-ng']
    // Absent and 0 leave the count to whisper: no flag at all.
    assert.deepEqual(whisperServerArgs({ ...launch, gpu }, 4321), [...base, ...tail])
    assert.deepEqual(whisperServerArgs({ ...launch, gpu, threads: 0 }, 4321), [...base, ...tail])
    assert.deepEqual(whisperServerArgs({ ...launch, gpu, threads: 2 }, 4321), [...base, '-t', '2', ...tail])
    assert.deepEqual(whisperServerArgs({ ...launch, gpu, threads: 3.7 }, 4321), [...base, '-t', '3', ...tail])
  }
})

test('whisperThreads is the fast-core count capped at 8, and undefined when the CPU does not say', () => {
  assert.equal(whisperThreads({}), undefined)
  assert.equal(whisperThreads({ perfCores: 0 }), undefined)
  assert.equal(whisperThreads({ perfCores: -3 }), undefined)
  assert.equal(whisperThreads({ perfCores: 2 }), 2)
  assert.equal(whisperThreads({ perfCores: 4 }), 4)
  assert.equal(whisperThreads({ perfCores: 8 }), 8)
  assert.equal(whisperThreads({ perfCores: 12 }), 8)
  assert.equal(whisperThreads({ perfCores: 2.9 }), 2)
})

test('startFailureMessage quotes the last error-looking log line and the exit code', () => {
  const msg = startFailureMessage(3, ['loading model', 'error: first problem', 'noise', 'whisper_init failed: bad file', 'bye'])
  assert.match(msg, /exit code 3/)
  assert.match(msg, /bad file/)
  assert.doesNotMatch(msg, /first problem/)
})

test('startFailureMessage without a recognisable reason or code is still a sentence', () => {
  assert.equal(startFailureMessage(null, ['all fine', 'bye']), 'whisper-server stopped while starting.')
  assert.equal(startFailureMessage(undefined, []), 'whisper-server stopped while starting.')
  assert.equal(startFailureMessage(1, []), 'whisper-server stopped while starting (exit code 1).')
})

test('startFailureMessage cuts a very long log line', () => {
  const msg = startFailureMessage(1, [`error: ${'x'.repeat(2000)}`])
  assert.ok(msg.length < 400)
})

test('ensure starts a server that answers /health, and state goes stopped, starting, ready with onChange each time', async () => {
  // The real server refuses connections until its model is loaded; the fake imitates that.
  const { server, states } = fakeRig({ FAKE_WHISPER_LOAD_MS: '400' })
  try {
    assert.equal(server.state(), 'stopped')
    const pending = server.ensure(launch)
    await waitFor('starting', () => server.state() === 'starting')
    assert.equal(server.launch(), null, 'no launch is reported before the process is up')
    const port = await pending
    assert.equal(server.state(), 'ready')
    assert.equal(await healthOk(port), true)
    assert.deepEqual(server.launch(), launch)
    assert.equal(server.error(), null)
    assert.deepEqual(states, ['starting', 'ready'])
  } finally {
    await server.stop()
  }
})

test('ensure does not resolve before the model is loaded', async () => {
  const { server } = fakeRig({ FAKE_WHISPER_LOAD_MS: '500' })
  try {
    const t0 = Date.now()
    const port = await server.ensure(launch)
    assert.ok(Date.now() - t0 >= 400, 'it waited for /health to answer')
    assert.equal(await healthOk(port), true)
  } finally {
    await server.stop()
  }
})

test('ensure on an already running launch returns the same port without a new process', async () => {
  const { server, spawns } = fakeRig()
  try {
    const a = await server.ensure(launch)
    const b = await server.ensure({ ...launch })
    assert.equal(a, b)
    assert.equal(spawns.length, 1)
  } finally {
    await server.stop()
  }
})

test('two concurrent ensure calls for the same launch share one process', async () => {
  const { server, spawns } = fakeRig({ FAKE_WHISPER_LOAD_MS: '200' })
  try {
    const [a, b] = await Promise.all([server.ensure(launch), server.ensure({ ...launch })])
    assert.equal(a, b)
    assert.equal(spawns.length, 1)
  } finally {
    await server.stop()
  }
})

test('a different model stops the first process and starts another', async () => {
  const { server, spawns } = fakeRig()
  try {
    const a = await server.ensure(launch)
    const b = await server.ensure({ ...launch, modelPath: '/models/ggml-small.bin' })
    assert.equal(spawns.length, 2)
    await waitFor('the first process to be gone', () => exitedOf(spawns[0].child))
    assert.notEqual(a, b)
    assert.equal(await healthOk(a), false)
    assert.equal(await healthOk(b), true)
    assert.equal(server.launch()?.modelPath, '/models/ggml-small.bin')
    assert.equal(server.state(), 'ready')
  } finally {
    await server.stop()
  }
})

test('flipping the GPU option restarts the server with the flag changed', async () => {
  const { server, spawns } = fakeRig()
  try {
    await server.ensure(launch)
    await server.ensure({ ...launch, gpu: true })
    assert.equal(spawns.length, 2)
    assert.ok(spawns[0].args.includes('-ng'))
    assert.ok(!spawns[1].args.includes('-ng'))
    await waitFor('the first process to be gone', () => exitedOf(spawns[0].child))
  } finally {
    await server.stop()
  }
})

test('a different thread count restarts the server with -t changed, and the same count reuses the process', async () => {
  const { server, spawns } = fakeRig()
  try {
    const a = await server.ensure({ ...launch, threads: 2 })
    assert.equal(await server.ensure({ ...launch, threads: 2 }), a)
    assert.equal(spawns.length, 1)
    const b = await server.ensure({ ...launch, threads: 4 })
    assert.equal(spawns.length, 2)
    assert.notEqual(a, b)
    await waitFor('the first process to be gone', () => exitedOf(spawns[0].child))
    assert.equal(await healthOk(a), false)
    assert.equal(await healthOk(b), true)
    assert.deepEqual([spawns[0].args[spawns[0].args.indexOf('-t') + 1], spawns[1].args[spawns[1].args.indexOf('-t') + 1]], ['2', '4'])
    assert.equal(server.launch()?.threads, 4)
  } finally {
    await server.stop()
  }
})

test('a launch with threads undefined or 0 is the same launch as one without, so it does not restart', async () => {
  const { server, spawns } = fakeRig()
  try {
    const a = await server.ensure(launch)
    assert.equal(await server.ensure({ ...launch, threads: undefined }), a)
    assert.equal(await server.ensure({ ...launch, threads: 0 }), a)
    assert.equal(spawns.length, 1)
    assert.ok(!spawns[0].args.includes('-t'))
  } finally {
    await server.stop()
  }
})

test('a different launch requested while one is starting waits for it to settle, then replaces it', async () => {
  const { server, spawns } = fakeRig({ FAKE_WHISPER_LOAD_MS: '200' })
  try {
    const first = server.ensure(launch)
    const second = server.ensure({ ...launch, modelPath: '/models/ggml-tiny.bin' })
    const [a, b] = await Promise.all([first, second])
    assert.equal(spawns.length, 2)
    assert.notEqual(a, b)
    assert.equal(server.launch()?.modelPath, '/models/ggml-tiny.bin')
  } finally {
    await server.stop()
  }
})

test('a different launch waits for what the running server is still answering before it replaces it', async () => {
  const { server, spawns } = fakeRig()
  const other = { ...launch, modelPath: '/models/ggml-tiny.bin' }
  try {
    let finish = (): void => {}
    let firstChildGoneMidWork = false
    const first = server.use(launch, async (port) => {
      await new Promise<void>((resolve) => { finish = resolve })
      firstChildGoneMidWork = exitedOf(spawns[0].child)
      return port
    })
    await waitFor('the first transcription to be under way', () => spawns.length === 1 && server.state() === 'ready')
    let secondPort = 0
    const second = server.use(other, async (port) => { secondPort = port })
    // Long enough for a stop() to have ended the first server, had the new launch not waited.
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(spawns.length, 1)
    assert.equal(exitedOf(spawns[0].child), false)
    finish()
    const firstPort = await first
    await second
    assert.equal(firstChildGoneMidWork, false)
    assert.equal(spawns.length, 2)
    assert.notEqual(secondPort, firstPort)
    assert.equal(server.launch()?.modelPath, '/models/ggml-tiny.bin')
  } finally {
    await server.stop()
  }
})

test('a start whose process exits early rejects with WhisperStartError carrying the exit code and the log line', async () => {
  const { server } = fakeRig({ FAKE_WHISPER_FAIL: '1' })
  try {
    await assert.rejects(server.ensure(launch), (e: unknown) => {
      assert.ok(e instanceof WhisperStartError)
      assert.match(e.message, /exit code 3/)
      assert.match(e.message, /failed to initialize whisper context/)
      assert.ok(e.logTail.some((l) => l.includes('failed to initialize whisper context')))
      return true
    })
    assert.equal(server.launch(), null)
  } finally {
    await server.stop()
  }
})

// The process's own exit clears it before the failed start is handled. Taken for a stop() made on purpose, the failure
// was dropped: the state stayed 'starting' for good and Settings showed no reason.
test('a start whose process exits early leaves state error with the log line in error()', async () => {
  const { server, states } = fakeRig({ FAKE_WHISPER_FAIL: '1' })
  try {
    await assert.rejects(server.ensure(launch), WhisperStartError)
    assert.equal(server.state(), 'error')
    assert.match(server.error() ?? '', /failed to initialize whisper context/)
    assert.deepEqual(states, ['starting', 'error'])
  } finally {
    await server.stop()
  }
})

test('after a failed start the next ensure tries again and ends ready with no error', async () => {
  const dir = tmpDir('tllm-whisper-server-')
  let fail = true
  const server = new WhisperServer({
    dataDir: dir,
    spawn: (_bin, args, options, tether) =>
      spawnTethered(process.execPath, [FAKE_SERVER, ...(args ?? [])], { ...options, cwd: dir, env: { ...options.env, FAKE_WHISPER_FAIL: fail ? '1' : '0' } }, tether),
  })
  try {
    await assert.rejects(server.ensure(launch), WhisperStartError)
    fail = false
    await server.ensure(launch)
    assert.equal(server.state(), 'ready')
    assert.equal(server.error(), null)
  } finally {
    await server.stop()
  }
})

test('a binary that cannot be started at all rejects with WhisperStartError instead of crashing the process', async () => {
  const dir = tmpDir('tllm-whisper-server-')
  const server = new WhisperServer({ dataDir: dir, spawn: (bin, args, options, tether) => spawnTethered(bin, args, { ...options, cwd: dir }, tether) })
  try {
    await assert.rejects(server.ensure({ ...launch, binPath: `${dir}/does-not-exist` }), (e: unknown) => e instanceof WhisperStartError && /could not be started/.test(e.message))
  } finally {
    await server.stop()
  }
})

test('a binary that cannot be started at all leaves state error', async () => {
  const dir = tmpDir('tllm-whisper-server-')
  const server = new WhisperServer({ dataDir: dir, spawn: (bin, args, options, tether) => spawnTethered(bin, args, { ...options, cwd: dir }, tether) })
  try {
    await assert.rejects(server.ensure({ ...launch, binPath: `${dir}/does-not-exist` }), WhisperStartError)
    assert.equal(server.state(), 'error')
    assert.match(server.error() ?? '', /could not be started/)
  } finally {
    await server.stop()
  }
})

test('a start that never becomes ready within startTimeoutMs fails and its process is killed', async () => {
  const { server, spawns } = fakeRig({ FAKE_WHISPER_LOAD_MS: '60000' }, { startTimeoutMs: 400 })
  try {
    await assert.rejects(server.ensure(launch), (e: unknown) => e instanceof WhisperStartError && /did not become ready/.test(e.message))
    assert.equal(server.state(), 'error')
    await waitFor('the stuck process to be killed', () => exitedOf(spawns[0].child))
  } finally {
    await server.stop()
  }
})

test('stop ends the process, leaves state stopped, and is not reported as an error', async () => {
  const { server, spawns, states } = fakeRig()
  try {
    const port = await server.ensure(launch)
    await server.stop()
    assert.equal(server.state(), 'stopped')
    assert.equal(server.error(), null)
    assert.equal(exitedOf(spawns[0].child), true)
    assert.equal(await healthOk(port), false)
    assert.equal(server.launch(), null)
    assert.deepEqual(states, ['starting', 'ready', 'stopped'])
    await server.stop() // nothing to stop is fine
  } finally {
    await server.stop()
  }
})

test('stop while the model is still loading ends the start without an error state', async () => {
  const { server, spawns } = fakeRig({ FAKE_WHISPER_LOAD_MS: '60000' })
  try {
    const pending = server.ensure(launch)
    const outcome = pending.then(() => 'resolved', (e: unknown) => e)
    await waitFor('the process to be spawned', () => spawns.length === 1)
    await server.stop()
    const result = await outcome
    assert.ok(result instanceof WhisperStartError, 'the waiting caller is told the start did not finish')
    assert.equal(server.state(), 'stopped')
    assert.equal(server.error(), null)
  } finally {
    await server.stop()
  }
})

test('use holds the idle stop off while work runs, and the server stops by itself idleMs after the work ends', async () => {
  const { server } = fakeRig({}, { idleMs: 150 })
  try {
    const result = await server.use(launch, async (port) => {
      // Well past idleMs: a server stopped under a running transcription would fail the request.
      await new Promise((r) => setTimeout(r, 500))
      assert.equal(server.state(), 'ready')
      return healthOk(port)
    })
    assert.equal(result, true)
    assert.equal(server.state(), 'ready', 'the idle clock starts when the work ends')
    await waitFor('the idle stop', () => server.state() === 'stopped')
    assert.equal(server.error(), null)
  } finally {
    await server.stop()
  }
})

test('use that throws still releases the hold, so the idle stop happens', async () => {
  const { server } = fakeRig({}, { idleMs: 100 })
  try {
    await assert.rejects(server.use(launch, async () => { throw new Error('boom') }), /boom/)
    await waitFor('the idle stop', () => server.state() === 'stopped')
  } finally {
    await server.stop()
  }
})

test('a second use keeps the server up while either is still running', async () => {
  const { server, spawns } = fakeRig({}, { idleMs: 100 })
  try {
    const slow = server.use(launch, () => new Promise<void>((r) => setTimeout(r, 600)))
    await server.use(launch, async () => {})
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(server.state(), 'ready', 'the slow work is still holding the server')
    await slow
    await waitFor('the idle stop', () => server.state() === 'stopped')
    assert.equal(spawns.length, 1)
  } finally {
    await server.stop()
  }
})

test('after the process dies unexpectedly the next ensure starts a fresh one', async () => {
  const { server, spawns } = fakeRig()
  try {
    const first = await server.ensure(launch)
    spawns[0].child.kill('SIGKILL')
    await waitFor('the death to be noticed', () => server.state() === 'stopped')
    assert.equal(server.error(), null)
    assert.equal(server.launch(), null)
    const second = await server.ensure(launch)
    assert.equal(spawns.length, 2)
    assert.notEqual(first, second)
    assert.equal(await healthOk(second), true)
  } finally {
    await server.stop()
  }
})

test('shutdown stops the server for good: a later ensure rejects and starts nothing', async () => {
  const { server, spawns } = fakeRig()
  await server.ensure(launch)
  await server.shutdown()
  assert.equal(server.state(), 'stopped')
  await assert.rejects(server.ensure(launch), (e: unknown) => e instanceof WhisperStartError && /shutting down/.test(e.message))
  assert.equal(spawns.length, 1)
  assert.equal(server.state(), 'stopped')
})

// ── a failed start keeps its reason ──
// whisper-server says why it cannot start (a GPU driver it cannot use, a model it cannot read) on its last lines and
// exits at once. The failure has to carry those lines every time, and outlive the next start, which empties the log.

/** A rig whose process is a script written to the temp dir (`script` is read at each spawn, so a test can swap it). */
function scriptRig() {
  const dir = tmpDir('tllm-whisper-script-')
  let script = ''
  const server = new WhisperServer({
    dataDir: dir,
    spawn: (_bin, args, options, tether) => spawnTethered(process.execPath, [script, ...(args ?? [])], { ...options, cwd: dir }, tether),
  })
  const write = (name: string, body: string): void => {
    script = join(dir, name)
    writeFileSync(script, body)
  }
  return { server, dir, write, failedLog: join(dir, 'logs', 'whisper-server.failed.log'), log: join(dir, 'logs', 'whisper-server.log') }
}

const REASON = 'ggml_vulkan: Error: Vulkan 1.2 required.'

test('a process that says why on stderr and exits at once fails the start with that reason, every time', async () => {
  const r = scriptRig()
  r.write('die.mjs', `console.error(${JSON.stringify(REASON)})\nprocess.exit(1)\n`)
  for (let i = 0; i < 5; i++) {
    let message = ''
    await assert.rejects(r.server.ensure(launch), (e: unknown) => {
      assert.ok(e instanceof WhisperStartError)
      message = e.message
      assert.match(e.message, /exit code 1/)
      assert.ok(e.message.includes(REASON), e.message)
      assert.ok(e.logTail.includes(REASON), JSON.stringify(e.logTail))
      return true
    }, `attempt ${i}`)
    assert.equal(r.server.state(), 'error')
    assert.equal(r.server.error(), message)
  }
  await r.server.stop()
})

test('a failed start leaves whisper-server.failed.log with the command line then the reason, and a later start keeps it', async () => {
  const r = scriptRig()
  r.write('die.mjs', `console.error(${JSON.stringify(REASON)})\nprocess.exit(1)\n`)
  await assert.rejects(r.server.ensure(launch), WhisperStartError)
  const lines = readFileSync(r.failedLog, 'utf8').split('\n')
  assert.match(lines[0], /^\[turbollm\] /)
  assert.ok(lines[0].includes('this start failed:'))
  assert.ok(lines[0].includes(launch.binPath))
  assert.ok(lines[0].includes('--port'))
  assert.ok(lines.slice(1).includes(REASON))

  r.write('ok.mjs', readFileSync(FAKE_SERVER, 'utf8'))
  try {
    const port = await r.server.ensure(launch)
    assert.equal(await healthOk(port), true)
    assert.ok(readFileSync(r.failedLog, 'utf8').includes(REASON))
    // The log is the new start's own: the failed one's reason lives only in the kept file.
    assert.ok(!readFileSync(r.log, 'utf8').includes(REASON))
  } finally {
    await r.server.stop()
  }
})

test('a start that stop() ends while it is still starting writes no failed log', async () => {
  const r = scriptRig()
  r.write('slow.mjs', readFileSync(FAKE_SERVER, 'utf8'))
  process.env.FAKE_WHISPER_LOAD_MS = '60000'
  try {
    const started = r.server.ensure(launch)
    started.catch(() => {})
    await waitFor('the process to be spawned', () => r.server.launch() !== null)
    await r.server.stop()
    await assert.rejects(started, WhisperStartError)
    assert.equal(existsSync(r.failedLog), false)
  } finally {
    delete process.env.FAKE_WHISPER_LOAD_MS
    await r.server.stop()
  }
})

test('a process that exits with no output fails with the plain message and its exit code', async () => {
  const r = scriptRig()
  r.write('quiet.mjs', 'process.exit(7)\n')
  await assert.rejects(r.server.ensure(launch), (e: unknown) => {
    assert.ok(e instanceof WhisperStartError)
    assert.equal(e.message, 'whisper-server stopped while starting (exit code 7).')
    return true
  })
  await r.server.stop()
})

test('a process that prints more than the kept lines is reported by its last ones', async () => {
  const r = scriptRig()
  r.write('chatty.mjs', "for (let i = 1; i <= 100; i++) console.error('line ' + i)\nconsole.error('error: boom')\nprocess.exit(2)\n")
  await assert.rejects(r.server.ensure(launch), (e: unknown) => {
    assert.ok(e instanceof WhisperStartError)
    assert.match(e.message, /error: boom/)
    assert.match(e.message, /exit code 2/)
    assert.ok(e.logTail.length <= 20)
    assert.equal(e.logTail.at(-1), 'error: boom')
    assert.ok(!e.logTail.includes('line 1'))
    return true
  })
  const kept = readFileSync(r.failedLog, 'utf8').split('\n').filter(Boolean)
  assert.ok(kept.length <= 41 + 0)
  assert.equal(kept.at(-1), 'error: boom')
  await r.server.stop()
})
