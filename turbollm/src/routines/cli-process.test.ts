import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { runClaudeCliProcess, type SpawnCliProcess } from './cli-process'

/** A fake child process: EventEmitter + fake stdout/stderr streams + a killed() spy,
 *  matching the narrow shape runClaudeCliProcess actually touches. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    pid: number
    kill: (signal?: NodeJS.Signals | number) => boolean
    killed: boolean
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 4242
  child.killed = false
  child.kill = () => { child.killed = true; return true }
  return child
}

test('resolves with captured stdout/stderr and exit code on a clean exit', async () => {
  const child = fakeChild()
  const spawnCalls: Array<{ cmd: string; args: string[] }> = []
  const fakeSpawn: SpawnCliProcess = (cmd, args) => { spawnCalls.push({ cmd, args }); return child }

  const resultPromise = runClaudeCliProcess(
    ['-p', 'hello', '--output-format', 'stream-json'],
    { cwd: '/repo', env: {}, timeoutMs: 5000 },
    fakeSpawn,
  )
  child.stdout.end('{"type":"result","is_error":false,"result":"hi"}\n')
  child.stderr.end('')
  child.emit('exit', 0, null)

  const result = await resultPromise
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.match(result.stdout, /"result":"hi"/)
  assert.equal(spawnCalls[0]?.args[0], '-p')
})

test('kills the process and reports timedOut once the wall-clock timeout elapses', async () => {
  const child = fakeChild()
  const fakeSpawn: SpawnCliProcess = () => child
  // The tree-kill MUST be stubbed alongside the spawn: the real one fires an OS-level
  // `taskkill /F /T /PID 4242` at whatever unrelated process happens to own that pid right now.
  const killedTrees: number[] = []

  const resultPromise = runClaudeCliProcess(
    ['-p', 'loop forever'],
    { cwd: '/repo', env: {}, timeoutMs: 10 },
    fakeSpawn,
    (pid) => { killedTrees.push(pid) },
  )
  // Simulate the process only exiting AFTER the kill signal — timeout fires, kill() is called,
  // then the fake process finally reports its exit.
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(child.killed, true)
  assert.deepEqual(killedTrees, [4242], 'expected the subprocess tree sweep to target the child pid')
  child.stdout.end('')
  child.stderr.end('')
  child.emit('exit', null, 'SIGKILL')

  const result = await resultPromise
  assert.equal(result.timedOut, true)
})

test('a process that exits normally is never killed and never swept', async () => {
  const child = fakeChild()
  const killedTrees: number[] = []
  const resultPromise = runClaudeCliProcess(
    ['-p', 'x'],
    { cwd: '/repo', env: {}, timeoutMs: 5000 },
    () => child,
    (pid) => { killedTrees.push(pid) },
  )
  child.emit('exit', 0, null)
  const result = await resultPromise
  assert.equal(result.timedOut, false)
  assert.equal(child.killed, false)
  assert.deepEqual(killedTrees, [])
})

test('resolves with a non-zero exit code and stderr captured on a real CLI failure', async () => {
  const child = fakeChild()
  const fakeSpawn: SpawnCliProcess = () => child
  const resultPromise = runClaudeCliProcess(['-p', 'x'], { cwd: '/repo', env: {}, timeoutMs: 5000 }, fakeSpawn)
  child.stdout.end('')
  child.stderr.end('Error: not authenticated\n')
  child.emit('exit', 1, null)
  const result = await resultPromise
  assert.equal(result.exitCode, 1)
  assert.match(result.stderr, /not authenticated/)
})

test('spawn errors (ENOENT — CLI vanished between preflight and fire) resolve, never reject', async () => {
  const child = fakeChild()
  const fakeSpawn: SpawnCliProcess = () => child
  const resultPromise = runClaudeCliProcess(['-p', 'x'], { cwd: '/repo', env: {}, timeoutMs: 5000 }, fakeSpawn)
  child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))
  const result = await resultPromise
  assert.equal(result.exitCode, null)
  assert.equal(result.timedOut, false)
  assert.match(result.stderr, /ENOENT/)
})

test('passes cwd and env through to the spawn call unchanged', async () => {
  const child = fakeChild()
  let seen: { cwd: string; env: NodeJS.ProcessEnv } | null = null
  const fakeSpawn: SpawnCliProcess = (_cmd, _args, opts) => { seen = opts; return child }
  const resultPromise = runClaudeCliProcess(
    ['-p', 'x'],
    { cwd: '/some/repo', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:6996' }, timeoutMs: 5000 },
    fakeSpawn,
  )
  child.emit('exit', 0, null)
  await resultPromise
  assert.deepEqual(seen, { cwd: '/some/repo', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:6996' } })
})

test('spawns the literal `claude` binary, never a shell string', async () => {
  const child = fakeChild()
  let cmd: string | null = null
  const fakeSpawn: SpawnCliProcess = (c) => { cmd = c; return child }
  const resultPromise = runClaudeCliProcess(['-p', 'x'], { cwd: '/repo', env: {}, timeoutMs: 5000 }, fakeSpawn)
  child.emit('exit', 0, null)
  await resultPromise
  assert.equal(cmd, 'claude')
})
