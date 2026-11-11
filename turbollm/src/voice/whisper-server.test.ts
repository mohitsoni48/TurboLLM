import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
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
