import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import {
  runClaudeCliProcess,
  realSpawnCliProcess,
  type CliChildProcess,
  type SpawnCliProcess,
} from './cli-process'

/** A fake child process: EventEmitter + fake stdin/stdout/stderr streams + a killed() spy,
 *  matching the narrow shape runClaudeCliProcess actually touches. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    pid: number
    kill: (signal?: NodeJS.Signals | number) => boolean
    killed: boolean
    stdinWritten: string
    stdinEnded: boolean
  }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdinWritten = ''
  child.stdinEnded = false
  child.stdin.on('data', (b: Buffer) => { child.stdinWritten += b.toString('utf8') })
  child.stdin.on('end', () => { child.stdinEnded = true })
  child.pid = 4242
  child.killed = false
  child.kill = () => { child.killed = true; return true }
  return child
}

/** Every test injects this. The default `_killTree` fires a REAL `taskkill /F /T /PID 4242` at
 *  whatever unrelated process owns that pid on the developer's machine, and "the test happens to
 *  finish before the timer" is not a defence (review finding I2). */
function killSpy() {
  const pids: number[] = []
  const spy = (pid: number) => { pids.push(pid) }
  return { pids, spy }
}

test('resolves with captured stdout/stderr and exit code on a clean exit', async () => {
  const child = fakeChild()
  const { spy } = killSpy()
  const spawnCalls: Array<{ cmd: string; args: string[] }> = []
  const fakeSpawn: SpawnCliProcess = (cmd, args) => { spawnCalls.push({ cmd, args }); return child }

  const resultPromise = runClaudeCliProcess(
    ['-p', '--output-format', 'stream-json'],
    { cwd: '/repo', env: {}, stdin: 'hello', timeoutMs: 5000 },
    fakeSpawn,
    spy,
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
    ['-p'],
    { cwd: '/repo', env: {}, stdin: 'loop forever', timeoutMs: 10 },
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
    ['-p'],
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
  const { spy } = killSpy()
  const fakeSpawn: SpawnCliProcess = () => child
  const resultPromise = runClaudeCliProcess(['-p'], { cwd: '/repo', env: {}, timeoutMs: 5000 }, fakeSpawn, spy)
  child.stdout.end('')
  child.stderr.end('Error: not authenticated\n')
  child.emit('exit', 1, null)
  const result = await resultPromise
  assert.equal(result.exitCode, 1)
  assert.match(result.stderr, /not authenticated/)
})

test('spawn errors (ENOENT — CLI vanished between preflight and fire) resolve, never reject', async () => {
  const child = fakeChild()
  const { spy } = killSpy()
  const fakeSpawn: SpawnCliProcess = () => child
  const resultPromise = runClaudeCliProcess(['-p'], { cwd: '/repo', env: {}, timeoutMs: 5000 }, fakeSpawn, spy)
  child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))
  const result = await resultPromise
  assert.equal(result.exitCode, null)
  assert.equal(result.timedOut, false)
  assert.match(result.stderr, /ENOENT/)
})

test('a synchronous throw from spawn resolves too, rather than rejecting', async () => {
  const { spy } = killSpy()
  const result = await runClaudeCliProcess(
    ['-p'],
    { cwd: '/repo', env: {}, timeoutMs: 5000 },
    () => { throw new Error('EINVAL cannot spawn a .cmd without a shell') },
    spy,
  )
  assert.equal(result.exitCode, null)
  assert.match(result.stderr, /EINVAL/)
})

test('passes cwd and env through to the spawn call unchanged', async () => {
  const child = fakeChild()
  const { spy } = killSpy()
  let seen: { cwd: string; env: NodeJS.ProcessEnv } | null = null
  const fakeSpawn: SpawnCliProcess = (_cmd, _args, opts) => { seen = opts; return child }
  const resultPromise = runClaudeCliProcess(
    ['-p'],
    { cwd: '/some/repo', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:6996' }, timeoutMs: 5000 },
    fakeSpawn,
    spy,
  )
  child.emit('exit', 0, null)
  await resultPromise
  assert.deepEqual(seen, { cwd: '/some/repo', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:6996' } })
})

test('spawns the literal `claude` binary, never a shell string', async () => {
  const child = fakeChild()
  const { spy } = killSpy()
  let cmd: string | null = null
  const fakeSpawn: SpawnCliProcess = (c) => { cmd = c; return child }
  const resultPromise = runClaudeCliProcess(['-p'], { cwd: '/repo', env: {}, timeoutMs: 5000 }, fakeSpawn, spy)
  child.emit('exit', 0, null)
  await resultPromise
  assert.equal(cmd, 'claude')
})

// ── C1: the prompt never reaches a command line ──────────────────────────────────────────────

test('the prompt is written to the child stdin and never appears in argv', async () => {
  const child = fakeChild()
  const { spy } = killSpy()
  let seenArgs: string[] = []
  const prompt = 'summarize the "Q3 report" & flag risks %USERPROFILE%'
  const resultPromise = runClaudeCliProcess(
    ['-p', '--output-format', 'stream-json'],
    { cwd: '/repo', env: {}, stdin: prompt, timeoutMs: 5000 },
    (_cmd, args) => { seenArgs = args; return child },
    spy,
  )
  child.stdout.end('')
  child.stderr.end('')
  child.emit('exit', 0, null)
  await resultPromise
  await new Promise((r) => setImmediate(r))

  assert.ok(!seenArgs.some((a) => a.includes('Q3')), `prompt leaked into argv: ${JSON.stringify(seenArgs)}`)
  assert.equal(child.stdinWritten, prompt)
  assert.equal(child.stdinEnded, true)
})

test('stdin is closed even when there is no prompt, so a reading child sees EOF', async () => {
  const child = fakeChild()
  const { spy } = killSpy()
  const resultPromise = runClaudeCliProcess(['--version'], { cwd: '/repo', env: {}, timeoutMs: 5000 }, () => child, spy)
  child.emit('exit', 0, null)
  await resultPromise
  await new Promise((r) => setImmediate(r))
  assert.equal(child.stdinWritten, '')
  assert.equal(child.stdinEnded, true)
})

test('a hostile prompt executes nothing even with the shell branch forced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-cli-inj-'))
  try {
    const victim = join(dir, 'victim.cjs')
    const marker = join(dir, 'INJECTED.txt')
    writeFileSync(
      victim,
      [
        "let input = ''",
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (c) => { input += c })",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin: input }))",
        '})',
        '',
      ].join('\n'),
    )
    // Both shells' break-out payloads in one string: cmd.exe's `"` + `&` chain (the exact shape
    // the reviewer proved executed) and a POSIX `'; ...; #` chain.
    const hostile = `a" & echo pwned> ${marker} & rem "; echo pwned > ${marker}; #`
    // `needsShell: () => true` forces the branch that is only naturally reachable on a machine
    // where `claude` is an npm-installed `.cmd` shim.
    const spawnThroughShell: SpawnCliProcess = (_cmd, args, opts) =>
      realSpawnCliProcess(process.execPath, args, opts, { needsShell: () => true })

    const result = await runClaudeCliProcess(
      [victim],
      { cwd: dir, env: process.env, stdin: hostile, timeoutMs: 30_000 },
      spawnThroughShell,
      () => {},
    )

    assert.equal(existsSync(marker), false, `INJECTION SUCCEEDED — marker file was created. stdout=${result.stdout}`)
    const seen = JSON.parse(result.stdout) as { argv: string[]; stdin: string }
    assert.deepEqual(seen.argv, [], 'the prompt must not reach the child as an argument')
    assert.equal(seen.stdin, hostile, 'the prompt must arrive on stdin byte-for-byte')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unquotable ARGUMENT on the shell branch is refused, not quoted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-cli-inj-'))
  try {
    const victim = join(dir, 'victim.cjs')
    const marker = join(dir, 'INJECTED.txt')
    writeFileSync(victim, "process.stdout.write('ran')\n")
    const hostile = `a" & echo pwned> ${marker} & rem "`
    const spawnThroughShell: SpawnCliProcess = (_cmd, args, opts) =>
      realSpawnCliProcess(process.execPath, args, opts, { needsShell: () => true })

    const result = await runClaudeCliProcess(
      [victim, hostile],
      { cwd: dir, env: process.env, timeoutMs: 30_000 },
      spawnThroughShell,
      () => {},
    )

    assert.equal(existsSync(marker), false, 'INJECTION SUCCEEDED — marker file was created')
    assert.equal(result.exitCode, null)
    assert.equal(result.stdout, '', 'nothing should have run at all')
    assert.match(result.stderr, /refusing to build a shell command line/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// N8: the two tests above both force the SHELL branch, which is only reachable where `claude` is a
// `.cmd` shim. The DIRECT branch is the one that runs in production on a native-binary install, and
// until now nothing in CI proved the prompt actually reaches a real process's stdin without a shell.
test('a real subprocess on the DIRECT (no-shell) branch gets the prompt byte-exact on stdin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-cli-direct-'))
  try {
    const victim = join(dir, 'victim.cjs')
    writeFileSync(
      victim,
      [
        "let input = ''",
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (c) => { input += c })",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin: input }))",
        '})',
        '',
      ].join('\n'),
    )
    // The same hostile shape the shell-branch test uses, plus the newline and CR that cmd.exe
    // mangles — none of it is special here, because no shell ever parses it.
    const prompt = 'a" & echo pwned & rem "; echo pwned; #\nsecond line\rcarriage'
    const spawnDirect: SpawnCliProcess = (_cmd, args, opts) =>
      realSpawnCliProcess(process.execPath, args, opts, { needsShell: () => false })

    const startedAt = Date.now()
    const result = await runClaudeCliProcess(
      [victim],
      { cwd: dir, env: process.env, stdin: prompt, timeoutMs: 30_000 },
      spawnDirect,
      () => {},
    )
    const elapsed = Date.now() - startedAt

    assert.equal(result.exitCode, 0)
    assert.equal(result.timedOut, false)
    const seen = JSON.parse(result.stdout) as { argv: string[]; stdin: string }
    assert.deepEqual(seen.argv, [], 'the prompt must not reach the child as an argument')
    assert.equal(seen.stdin, prompt, 'the prompt must arrive on stdin byte-for-byte')
    // The fast path must not pay any part of a grace window: a clean exit settles on 'close'.
    // Measured at ~40-60 ms; the bound exists to catch a regression that made it wait out
    // EXIT_STDIO_GRACE_MS or CLI_KILL_GRACE_MS, not to police machine speed.
    assert.ok(elapsed < 1000, `clean-exit fast path took ${elapsed}ms — a settlement window regressed`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── M6: realSpawnCliProcess's own branch selection ───────────────────────────────────────────

function recordingSpawn() {
  const calls: Array<{ cmd: string; args: string[] | null; opts: SpawnOptions }> = []
  const spawn = (cmd: string, args: string[] | null, opts: SpawnOptions): CliChildProcess => {
    calls.push({ cmd, args, opts })
    return fakeChild()
  }
  return { calls, spawn }
}

test('realSpawnCliProcess: a resolved native binary is spawned directly, with an args array', () => {
  const { calls, spawn } = recordingSpawn()
  realSpawnCliProcess('claude', ['-p'], { cwd: '/repo', env: { PATH: '/opt/bin' } }, {
    spawn,
    resolve: () => '/opt/bin/claude',
    needsShell: () => false,
  })
  assert.equal(calls[0]?.cmd, '/opt/bin/claude')
  assert.deepEqual(calls[0]?.args, ['-p'])
  assert.equal(calls[0]?.opts.shell, undefined, 'no shell must be involved on the direct branch')
  assert.deepEqual(calls[0]?.opts.stdio, ['pipe', 'pipe', 'pipe'])
  assert.equal(calls[0]?.opts.windowsHide, true)
  assert.equal(calls[0]?.opts.detached, process.platform !== 'win32', 'detached on POSIX only')
})

test('realSpawnCliProcess: a .cmd shim takes the shell branch as ONE quoted command string', () => {
  const { calls, spawn } = recordingSpawn()
  realSpawnCliProcess('claude', ['-p', '--output-format', 'stream-json'], { cwd: '/repo', env: {} }, {
    spawn,
    resolve: () => 'C:\\npm\\claude.cmd',
    needsShell: () => true,
  })
  assert.equal(calls[0]?.args, null, 'an args array alongside shell:true is deprecated (DEP0190)')
  assert.equal(calls[0]?.opts.shell, true)
  assert.match(String(calls[0]?.cmd), /^claude -p --output-format stream-json$/)
})

test('realSpawnCliProcess: an unresolvable command still falls back to the raw command name', () => {
  const { calls, spawn } = recordingSpawn()
  realSpawnCliProcess('claude', ['-p'], { cwd: '/repo', env: {} }, {
    spawn,
    resolve: () => null,
    needsShell: () => false,
  })
  assert.equal(calls[0]?.cmd, 'claude')
})

test('realSpawnCliProcess: resolution uses the env the CHILD runs under, not process.env', () => {
  const { spawn } = recordingSpawn()
  let seenEnv: NodeJS.ProcessEnv | undefined
  realSpawnCliProcess('claude', [], { cwd: '/repo', env: { PATH: '/service/only/bin' } }, {
    spawn,
    resolve: (_cmd, env) => { seenEnv = env; return '/service/only/bin/claude' },
    needsShell: () => false,
  })
  assert.deepEqual(seenEnv, { PATH: '/service/only/bin' })
})

// ── N3 / N4: the shell-path tripwire is an allow-list, and it covers the command too ─────────

const shimDeps = (spawn: (cmd: string, args: string[] | null, opts: SpawnOptions) => CliChildProcess) => ({
  spawn,
  resolve: () => 'C:\\npm\\claude.cmd',
  needsShell: () => true,
})

test('realSpawnCliProcess: newline and CR arguments are REFUSED, not silently mangled', () => {
  // The old denylist (`/["%]/`) passed both. Driven through real cmd.exe by the re-reviewer, a
  // newline TRUNCATED the argument (`a\necho pwned` arrived as `a`) and a CR was EATEN
  // (`a\recho pwned` arrived as `aecho pwned`) — corrupted rather than refused.
  for (const hostile of ['a\necho pwned', 'a\recho pwned', 'a\r\necho pwned']) {
    const { calls, spawn } = recordingSpawn()
    assert.throws(
      () => realSpawnCliProcess('claude', ['-p', hostile], { cwd: '/repo', env: {} }, shimDeps(spawn)),
      /refusing to build a shell command line/,
      `expected ${JSON.stringify(hostile)} to be refused`,
    )
    assert.deepEqual(calls, [], 'nothing may be spawned once an argument is refused')
  }
})

test('realSpawnCliProcess: the two characters the old denylist caught are still refused', () => {
  for (const hostile of ['a" & echo pwned & rem "', 'a%USERPROFILE%b']) {
    const { calls, spawn } = recordingSpawn()
    assert.throws(
      () => realSpawnCliProcess('claude', ['-p', hostile], { cwd: '/repo', env: {} }, shimDeps(spawn)),
      /refusing to build a shell command line/,
      `expected ${JSON.stringify(hostile)} to be refused`,
    )
    assert.deepEqual(calls, [])
  }
})

test("realSpawnCliProcess: every argument TurboLLM actually passes clears the allow-list", () => {
  // An allow-list is only safe to invert to if it admits the real vocabulary. These are every flag
  // this module sends today plus every value resolveClaudePermissionMode (terminal/agent-modes.ts)
  // can return, which Task 6 will thread through. A false refusal here is a failed scheduled run.
  const { calls, spawn } = recordingSpawn()
  realSpawnCliProcess(
    'claude',
    ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'],
    { cwd: '/repo', env: {} },
    shimDeps(spawn),
  )
  assert.equal(calls.length, 1, 'the real argument list must not be refused')
  for (const mode of ['auto', 'acceptEdits', 'plan', 'manual', 'default']) {
    const one = recordingSpawn()
    realSpawnCliProcess('claude', ['--permission-mode', mode], { cwd: '/repo', env: {} }, shimDeps(one.spawn))
    assert.equal(one.calls.length, 1, `permission mode ${mode} must not be refused`)
  }
})

test('realSpawnCliProcess: the COMMAND is held to the same rule as the arguments', () => {
  // buildShellCommand(cmd, args) interpolates `cmd` onto the same command line, so exempting it
  // would leave one string on that line outside a guard whose point is to have no exemptions.
  const { calls, spawn } = recordingSpawn()
  assert.throws(
    () => realSpawnCliProcess('claude" & echo pwned & rem "', ['-p'], { cwd: '/repo', env: {} }, shimDeps(spawn)),
    /refusing to build a shell command line/,
  )
  assert.deepEqual(calls, [], 'nothing may be spawned once the command is refused')
})

test('realSpawnCliProcess: an ordinary executable PATH (spaces, backslashes) is not refused', () => {
  // The flip side of N4: `cmd` is a path, not a flag, so the allow-list has to admit the shape of
  // a real one — `C:\Program Files\nodejs\node.exe` is what this file's own tests pass through.
  const { calls, spawn } = recordingSpawn()
  realSpawnCliProcess('C:\\Program Files\\nodejs\\node.exe', ['-p'], { cwd: '/repo', env: {} }, shimDeps(spawn))
  assert.equal(calls.length, 1)
})

// ── I1 / I3 / M4: settlement guarantees ──────────────────────────────────────────────────────

test('trailing stdout flushed AFTER the child exits is still captured', async () => {
  const child = fakeChild()
  const { spy } = killSpy()
  const resultPromise = runClaudeCliProcess(['-p'], { cwd: '/repo', env: {}, timeoutMs: 5000 }, () => child, spy)
  // The pi#5303 shape: the parent exits while a descendant still holds the pipe, and the final
  // `result` event only lands afterwards. Resolving on 'exit' alone would drop it.
  child.emit('exit', 0, null)
  await new Promise((r) => setTimeout(r, 20))
  child.stdout.write('{"type":"result","is_error":false,"result":"late but real"}\n')
  child.stdout.end()
  child.stderr.end()

  const result = await resultPromise
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /late but real/)
})

test('the wall-clock timeout resolves even when the child NEVER reports exit', async () => {
  const child = fakeChild() // never emits 'exit', never ends its pipes — an unkillable child
  const { pids, spy } = killSpy()
  const startedAt = Date.now()
  const result = await runClaudeCliProcess(
    ['-p'],
    { cwd: '/repo', env: {}, timeoutMs: 20 },
    () => child,
    spy,
  )
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, null)
  assert.deepEqual(pids, [4242])
  assert.ok(Date.now() - startedAt < 5000, 'must not wait on a child that never cooperates')
})

test('a stream-level error (EPIPE) is recorded rather than thrown out of band', async () => {
  const child = fakeChild()
  const { spy } = killSpy()
  const resultPromise = runClaudeCliProcess(['-p'], { cwd: '/repo', env: {}, timeoutMs: 5000 }, () => child, spy)
  child.stdout.emit('error', new Error('EPIPE broken pipe'))
  child.stderr.end('')
  child.emit('exit', 0, null)

  const result = await resultPromise
  assert.equal(result.exitCode, 0)
  assert.match(result.stderr, /EPIPE/)
})
