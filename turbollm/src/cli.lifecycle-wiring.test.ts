// Source-level guards for the daemon's listen / rebind / shutdown wiring in cli.ts.
//
// Why a source scan and not a behavioural test: cli.ts is top-level module code. Importing it
// boots the real daemon (config, engines, a listening port), so it cannot be loaded from a test —
// the same reason as cli.restart-wiring.test.ts. Each test pins one fix that only exists as
// wiring in this file; the logic it leans on is unit-tested where it lives (daemon-pid.ts,
// routines/cli-interactive-runner.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = readFileSync(join(HERE, 'cli.ts'), 'utf8').replace(/\r\n/g, '\n')

/** The text from `opening` through the first closing brace at column 0 after it. */
function blockFrom(opening: string): string {
  const start = CLI.indexOf(opening)
  assert.ok(start >= 0, `cli.ts must contain "${opening}"`)
  const end = CLI.indexOf('\n}\n', start)
  assert.ok(end > start, `no column-0 closing brace after "${opening}"`)
  return CLI.slice(start, end + 2)
}

const LISTEN = 'function listen(attempt = 0): void {'
const REBIND = 'deps.rebind = () => {'
const SIGNALS = "for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {"

test('every listener instance gets the terminal WebSocket upgrade handler (bind retry, rebind, revert)', () => {
  const listen = blockFrom(LISTEN)
  assert.ok(listen.includes("registerTerminalWs(s as unknown as import('http').Server, deps)"),
    'listen() must register the upgrade handler on the server it just created')
  assert.ok(!CLI.includes('registerTerminalWs(server '), 'a one-off registration on the first server is lost on rebind')
})

test('the boot-time remote-access start is one-shot, not re-run by a later listen()', () => {
  const listen = blockFrom(LISTEN)
  assert.ok(!listen.includes("if (remoteWanted && remote.state().kind === 'off')"), "'off' is also the state after Stop — a rebind re-enabled the tunnel")
  const gate = listen.indexOf('if (remoteWanted && !bootRemoteStarted) {')
  assert.ok(gate >= 0, 'the start must be gated on a one-shot flag')
  const set = listen.indexOf('bootRemoteStarted = true', gate)
  assert.ok(set > gate && set < listen.indexOf('await reconcileTailscalePromise', gate), 'the flag must be set before the await')
})

test('a failed rebind reverting to the old address does not re-run the boot banner', () => {
  const listen = blockFrom(LISTEN)
  assert.ok(listen.includes('if (rebinding || reverting) {'), 'the revert must take the in-place-rebind branch')
  assert.match(listen, /rebinding = false\n\s*reverting = true\n\s*host = prevHost/, 'the revert branch must flag itself')
})

test('the browser opens only when neither --no-open nor Settings → "Open browser on start" says no', () => {
  assert.ok(blockFrom(LISTEN).includes('if (!noOpen && store.snapshot().daemon.openBrowserOnStart !== false) {'))
})

test('a LAN toggle keeps the bound port; only a configured-port change moves it', () => {
  const rebind = blockFrom(REBIND)
  assert.ok(rebind.includes('const wantPort = c.daemon.port !== appliedCfgPort ? c.daemon.port : port'))
  assert.ok(rebind.includes('appliedCfgPort = c.daemon.port'))
  assert.ok(blockFrom(LISTEN).includes('deps.bindPort = info.port'), 'routes report the real bound port from deps.bindPort')
})

test('signal shutdown drops open connections before close() (an SSE stream otherwise holds it 12 s)', () => {
  const signals = blockFrom(SIGNALS)
  const drop = signals.indexOf('closeAllConnections?.()')
  assert.ok(drop >= 0, 'the signal path must call closeAllConnections')
  assert.ok(drop < signals.indexOf('server.close(() => process.exit(0))'))
})

// The behaviour itself is terminal-routes.test.ts's "closeTerminalSockets" test.
test('signal shutdown and restart drop open terminal WebSockets before close() (one held it past --stop\'s 10 s)', () => {
  const signals = blockFrom(SIGNALS)
  const drop = signals.indexOf('closeTerminalSockets()')
  assert.ok(drop >= 0, 'the signal path must call closeTerminalSockets')
  assert.ok(drop < signals.indexOf('server.close(() => process.exit(0))'))
  const restart = blockFrom('if (!packagedAndroidApp()) deps.requestRestart = (')
  const restartDrop = restart.indexOf('closeTerminalSockets()')
  assert.ok(restartDrop >= 0, 'the restart path must call closeTerminalSockets')
  assert.ok(restartDrop < restart.indexOf('server.close(() => {'))
})

test('pidfile removal is owner-scoped and a second daemon on the data dir is refused before boot side effects', () => {
  assert.ok(!CLI.includes('removePidfile('), "only removeOwnPidfile — never delete another daemon's pidfile")
  const guard = CLI.indexOf('const runningDaemon = await findRunningDaemon(store.dir())')
  assert.ok(guard > CLI.indexOf("if (hasFlag('--stop')) {"), 'after --stop handling')
  for (const sideEffect of ['reapStaleEngines(store.dir())', 'reconcileTailscale(', 'sweepInteractiveCliRuns(cliInteractiveSweepDeps)']) {
    assert.ok(guard < CLI.indexOf(sideEffect), `the guard must run before ${sideEffect}`)
  }
  assert.match(CLI.slice(guard, guard + 600), /if \(runningDaemon\) \{[\s\S]*process\.exit\(1\)/)
})

test('the harness resync after a model load uses the bound port, not daemon.port', () => {
  const call = CLI.indexOf('await syncHarnessModelConfig(target, {')
  assert.ok(call >= 0)
  assert.ok(!CLI.slice(call, call + 400).includes('store.snapshot().daemon.port'))
})

test('the packaged Android app never wires a restart (exiting its in-process Node closes the app)', () => {
  assert.ok(CLI.includes('if (!packagedAndroidApp()) deps.requestRestart = ('))
})

test('the interactive-routine sweep maps Code session ids to terminal ids', () => {
  assert.ok(CLI.includes('...terminalLookupsBySession(() => getTerminalManager(deps)),'))
  assert.ok(!/getTerminalManager\(deps\)\.(isActive|isAgentExited|getExitCode|kill)\(codeSessionId\)/.test(CLI),
    'TerminalManager is keyed by terminal id, not the Code session id')
})
