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

// `--port 6997` with the default ingress 6997: resolved against daemon.port (6996) the ingress
// stayed on 6997, so remote access failed with EADDRINUSE and the boot reconcile turned off a
// user's own `tailscale serve 6997`. Both must use the port the main listener binds.
test('the remote-access ingress port is resolved against the bound port, not daemon.port', () => {
  assert.ok(!/resolveIngressPort\([^)]*daemon\.port\)/.test(CLI), 'no ingress port resolved against the configured daemon.port')
  assert.ok(CLI.includes('const reconcileTailscalePromise = reconcileTailscale(bootIngressPort)'))
  assert.match(blockFrom('const remote = new RemoteAccessManager({'), /ingressPort: bootIngressPort\b/)
  // The boot port the ingress is resolved against is parsed like the listen address below.
  const def = CLI.slice(CLI.indexOf('const bootIngressPort = (() => {'), CLI.indexOf('const reconcileTailscalePromise'))
  assert.ok(def.includes("const portFlag = argValue('--port', '')"))
  assert.ok(def.includes("argValue('--addr', `:${store.snapshot().daemon.port}`)"))
  assert.ok(CLI.includes("addr = argValue('--addr', `${defaultHost}:${cfg.daemon.port}`)"))
})

// Until the boot start runs, remote access reads `off`, so the UI lets a provider be picked; the
// settings route takes that change and clears `enabled`. A start decided before it must not run.
test('the boot-time remote-access start re-reads `enabled` after the Tailscale reconcile wait', () => {
  const listen = blockFrom(LISTEN)
  const wait = listen.indexOf('await reconcileTailscalePromise')
  const start = listen.indexOf('if (tunnelFlag || store.snapshot().remoteAccess.enabled) void remote.enable()')
  assert.ok(wait > 0 && start > wait)
  assert.equal(listen.split('remote.enable()').length, 2, 'the only boot start is the re-checked one')
})

test('a leftover remoteAccess.enabled is cleared at boot when the experimental flag is off', () => {
  const wanted = CLI.indexOf('const remoteWanted = tunnelFlag || (isRemoteAccessEnabled(deps) && store.snapshot().remoteAccess.enabled)')
  const clear = CLI.indexOf('clearEnabledWhileFlagOff(deps)')
  assert.ok(wanted > 0 && clear > wanted, 'cleared after remoteWanted reads it (flag off: only --tunnel starts anything)')
  const bootListen = CLI.indexOf('\nlisten()\n') // the top-level boot call, not a comment's mention
  assert.ok(bootListen > 0 && clear < bootListen, 'before the listener serves its first request')
})

test('the packaged Android app never wires a restart (exiting its in-process Node closes the app)', () => {
  assert.ok(CLI.includes('if (!packagedAndroidApp()) deps.requestRestart = ('))
})

test('the interactive-routine sweep maps Code session ids to terminal ids', () => {
  assert.ok(CLI.includes('...terminalLookupsBySession(() => getTerminalManager(deps)),'))
  assert.ok(!/getTerminalManager\(deps\)\.(isActive|isAgentExited|getExitCode|kill)\(codeSessionId\)/.test(CLI),
    'TerminalManager is keyed by terminal id, not the Code session id')
})
