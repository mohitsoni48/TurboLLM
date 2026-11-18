// rust-core plan T22 (arch 2.2 boot.ts row, P-5, E-53): a daemon whose native core cannot load stops before it
// listens, prints the loader's message and exits 69; with TURBOLLM_DAEMON_FATAL_FILE set it first writes that
// failure there as JSON, for a supervisor that cannot see its stderr. `--help` never loads the core.
//
// TURBOLLM_CORE_PATH names a file that does not exist: an explicit override never falls through to another binary,
// so the load fails on every machine, whatever is built. The child never reaches the listener, so no port is bound.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { bootBody } from './test-support/daemon-source'
import { tmpDir } from './test-support/tmp'

const TURBOLLM = fileURLToPath(new URL('..', import.meta.url))
const CORE_UNAVAILABLE = 69

interface CliRun {
  status: number | null
  stdout: string
  stderr: string
  fatalFile: string
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): CliRun {
  const root = tmpDir('tllm-core-load-')
  const dataDir = join(root, 'data')
  const home = join(root, 'home')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ defaultEngineSeeded: true }))
  const fatalFile = join(root, 'fatal.json')
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', '--config', join(dataDir, 'config.json'), '--no-open', '--no-telemetry', ...args],
    {
      cwd: TURBOLLM,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TURBOLLM_CORE_PATH: join(root, 'missing.node'),
        TURBOLLM_DAEMON_FATAL_FILE: undefined,
        ...expandFatalFile(env, fatalFile),
      },
    },
  )
  return { status: child.status, stdout: child.stdout, stderr: child.stderr, fatalFile }
}

/** `TURBOLLM_DAEMON_FATAL_FILE: 'fatal.json'` in a test means "the run's own fatal.json". */
function expandFatalFile(env: NodeJS.ProcessEnv, fatalFile: string): NodeJS.ProcessEnv {
  return env.TURBOLLM_DAEMON_FATAL_FILE ? { ...env, TURBOLLM_DAEMON_FATAL_FILE: fatalFile } : env
}

// Before every boot side effect (the reaps, Tailscale's reconcile, the listener): a start that cannot parse a GGUF
// must not touch the machine first.
test("bootDaemon's first statement loads the native core", () => {
  const firstLine = bootBody().split('\n', 1)[0]
  assert.equal(firstLine, 'loadCore()')
})

test('a start whose native core cannot load exits 69 with the loader message, writing no fatal file', () => {
  const run = runCli([])

  assert.equal(run.status, CORE_UNAVAILABLE, run.stderr)
  assert.match(run.stderr, /TurboLLM's native core/)
  assert.match(run.stderr, /TURBOLLM_CORE_PATH/)
  assert.equal(existsSync(run.fatalFile), false)
})

test('with TURBOLLM_DAEMON_FATAL_FILE set, the failure is written there before the exit', () => {
  const run = runCli([], { TURBOLLM_DAEMON_FATAL_FILE: 'fatal.json' })

  assert.equal(run.status, CORE_UNAVAILABLE, run.stderr)
  const fatal = JSON.parse(readFileSync(run.fatalFile, 'utf8')) as Record<string, unknown>
  assert.equal(fatal.code, 'core_unavailable')
  assert.equal(fatal.exitCode, CORE_UNAVAILABLE)
  assert.equal(typeof fatal.message, 'string')
  assert.ok(run.stderr.includes(fatal.message as string), 'the file carries the message printed to stderr')
  assert.ok(!Number.isNaN(Date.parse(fatal.at as string)), `at is an ISO time: ${String(fatal.at)}`)
})

test('--help never loads the native core', () => {
  const run = runCli(['--help'])

  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stderr, /native core/)
})

for (const flag of ['--version', '-v']) {
  test(`${flag} prints the package version and exits without booting or loading the native core`, () => {
    const run = runCli([flag])

    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout.trim(), packageVersion())
    assert.doesNotMatch(run.stderr, /native core/)
  })
}

function packageVersion(): string {
  return (JSON.parse(readFileSync(join(TURBOLLM, 'package.json'), 'utf8')) as { version: string }).version
}
