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

// isLanExposed (auth.ts) keys the key enforcement off deps.bindHost, and this is the only line that
// sets it: without it `--addr 0.0.0.0:6996` or a daemon.host bind with lanBind off reads as
// loopback, and every LAN peer gets the API keyless.
test('every successful bind records the bound host for the auth gates before the listener awaits or announces anything', () => {
  const listen = blockFrom(LISTEN)
  const callback = listen.indexOf('async (info) => {')
  const set = listen.indexOf('deps.bindHost = host', callback)
  assert.ok(callback >= 0 && set > callback, 'the serve callback must record the bound host in deps.bindHost')
  // The callback runs ahead of the listener's first request only up to its first await; the
  // banner and the remote-access start must also see the gate set.
  for (const later of ['await ', '  TurboLLM ${version} is ready!', 'Re-bound to ', 'void remote.enable()']) {
    const at = listen.indexOf(later, callback)
    assert.ok(at > set, `deps.bindHost must be set before "${later}"`)
  }
})

test('signal shutdown drops open connections before close() (an SSE stream otherwise holds it 12 s)', () => {
  const signals = blockFrom(SIGNALS)
  const drop = signals.indexOf('closeAllConnections?.()')
  assert.ok(drop >= 0, 'the signal path must call closeAllConnections')
  assert.ok(drop < signals.indexOf('server.close(() => process.exit(0))'))
})

// The behaviour itself is terminal-routes.test.ts's "dropStaleTerminalSockets" tests. A terminal
// WebSocket is no HTTP connection a listener's close ends: a LAN peer's stayed after LAN access
// was turned off, and a remote client's after remote access was stopped.
test('every bind and every remote-access state change drop terminal WebSockets whose way in is gone', () => {
  const listen = blockFrom(LISTEN)
  const bound = listen.indexOf('deps.bindHost = host')
  const drop = listen.indexOf('dropStaleTerminalSockets(deps)')
  assert.ok(bound >= 0 && drop > bound, 'listen() must drop them after recording the address it bound (isLanExposed reads it)')
  const onState = blockFrom('function onRemoteState(s: RemoteState): void {')
  const remoteDrop = onState.indexOf('dropStaleTerminalSockets(deps)')
  assert.ok(remoteDrop >= 0 && remoteDrop < onState.indexOf("if (s.kind !== 'connected') return"), 'onRemoteState must drop them for every state, Stop\'s off included')
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

// `turbollm --stop && …` must not carry on when the daemon is still running. Which results count
// as a failure is daemon-pid.test.ts's "stopDaemon: failed only when …" test.
test('--stop exits 1 when the daemon it found is still running, 0 otherwise', () => {
  const stop = blockFrom("if (hasFlag('--stop')) {")
  assert.match(stop, /const result = await stopDaemon\([\s\S]*process\.exit\(result\.failed \? 1 : 0\)/)
})

// A load could save config.json, as whoever ran it: `sudo turbollm --stop` left the file root's,
// mode 0600, and the owner's next start crashed with an uncaught EACCES on the read. How a load
// treats another user's file is config.test.ts's "a config.json of another user's" test.
test('--stop never loads config.json, and a start that may not read or write it says why', () => {
  const stop = blockFrom("if (hasFlag('--stop')) {")
  assert.ok(CLI.indexOf("if (hasFlag('--stop')) {") < CLI.indexOf('ConfigStore.load('), '--stop comes before the config load')
  assert.ok(!stop.includes('store.'), '--stop uses no ConfigStore')
  assert.ok(stop.includes("stopDaemon(dirname(argValue('--config', defaultConfigPath()))"), "the data dir is the config file's")
  assert.match(
    CLI,
    /try \{\n\s*return ConfigStore\.load\(configPath\)\n\s*\} catch \(e\) \{\n\s*const problem = configAccessProblem\(configPath, e\)\n\s*if \(!problem\) throw e\n\s*console\.error\(problem\)\n\s*return process\.exit\(CONFIG_ACCESS_EXIT_CODE\)/,
  )
  // An unparsable one of another user's is not reset by the load: the start must not say it was
  // reset, nor that it stays, as a save of the run (such as of the telemetry id it mints)
  // replaces it.
  assert.match(CLI, /store\.brokenLeftInPlace\(\)\n\s*\? `config \$\{store\.path\(\)\} could not be parsed and belongs to another user \(a copy is at /)
  assert.match(CLI, /any save it ` \+\n\s*`makes \(such as of the telemetry id it mints\) writes them over the file as this user`/)
})

test('pidfile removal is owner-scoped and a second daemon on the data dir is refused before boot side effects', () => {
  assert.ok(!CLI.includes('removePidfile('), "only removeOwnPidfile — never delete another daemon's pidfile")
  const guard = CLI.indexOf('const runningDaemon = await findRunningDaemon(store.dir())')
  assert.ok(guard > CLI.indexOf("if (hasFlag('--stop')) {"), 'after --stop handling')
  for (const sideEffect of ['reapStaleEngines(store.dir())', 'reconcileTailscale(', 'sweepInteractiveCliRuns(cliInteractiveSweepDeps)']) {
    assert.ok(guard < CLI.indexOf(sideEffect), `the guard must run before ${sideEffect}`)
  }
  assert.match(CLI.slice(guard, guard + 600), /if \(runningDaemon\) \{[\s\S]*process\.exit\(DATA_DIR_IN_USE_EXIT_CODE\)/)
})

// Two daemons started together both passed findRunningDaemon (no pidfile until the bind). The
// behaviour of the claim is daemon-pid.test.ts's "two daemons starting at once" test.
test('the start guard claims the data dir first and gives the claim up once the pidfile is written', () => {
  const claim = CLI.indexOf('const claimHolder = claimDataDir(store.dir())')
  const guard = CLI.indexOf('const runningDaemon = await findRunningDaemon(store.dir())')
  assert.ok(claim > CLI.indexOf("if (hasFlag('--stop')) {") && claim < guard, 'claimed after --stop, before the pidfile is read')
  assert.match(CLI.slice(claim, guard), /if \(claimHolder\) \{[\s\S]*process\.exit\(DATA_DIR_IN_USE_EXIT_CODE\)[\s\S]*process\.on\('exit', \(\) => releaseDataDirClaim\(store\.dir\(\)\)\)/)
  const listen = blockFrom(LISTEN)
  const write = listen.indexOf('writePidfile(store.dir(), process.pid, info.port, info.address)')
  assert.ok(write > 0 && listen.indexOf('releaseDataDirClaim(store.dir())', write) > write, 'released only after the pidfile is written')
  // A restart's replacement (spawned, or started by the desktop app / update helper) must never
  // find the old process's claim.
  const restart = blockFrom('if (!packagedAndroidApp()) deps.requestRestart = (')
  const release = restart.indexOf('releaseDataDirClaim(store.dir())')
  assert.ok(release > 0 && release < restart.indexOf('spawnReplacement()') && release < restart.indexOf('process.exit(plan.exitCode)'))
})

// `--addr [::1]:6996` (the IPv6 form --help gives) binds nothing on 127.0.0.1, and these all dialed
// http://127.0.0.1:<port>: "Could not reach TurboLLM". What the address works out to is
// daemon-pid.test.ts's localDaemonOrigin and resolveDaemonAddress tests.
test("launch, its exit report, mcp-server and the harness resync dial the daemon's loopback address, not a fixed 127.0.0.1", () => {
  assert.ok(!/http:\/\/127\.0\.0\.1:\$\{(port|mcpPort)\}/.test(CLI), 'no client URL on a fixed 127.0.0.1')
  const launch = blockFrom("if (argv[0] === 'launch') {")
  assert.match(launch, /const \{ port, host: daemonHost \} = resolveDaemonAddress\(/)
  assert.match(launch, /await launchCli\([^)]*, daemonHost\)/)
  assert.match(launch, /fetch\(`\$\{localDaemonOrigin\(daemonHost, port\)\}\/api\/v1\/code\/sessions\//)
  const mcp = blockFrom("if (argv[0] === 'mcp-server') {")
  assert.match(mcp, /const mcpDaemon = resolveDaemonAddress\([\s\S]*runMcpServer\(localDaemonOrigin\(mcpDaemon\.host, mcpDaemon\.port\), version\)/)
  const call = CLI.indexOf('await syncHarnessModelConfig(target, {')
  assert.match(CLI.slice(call, call + 600), /\n\s*host: readPidfile\(store\.dir\(\)\)\?\.host,/)
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

// The app updates through the Play Store; the npm check reached registry.npmjs.org from the phone
// at every launch, for a release nothing there can apply. With no checker, GET /api/v1/app/update
// answers "no update" (routes.ts) and the boot check does not run.
test('the packaged Android app never checks npm for an app update', () => {
  assert.ok(CLI.includes('const appUpdates = packagedAndroidApp() ? undefined : new AppUpdateChecker(version)'))
  assert.equal(CLI.split('new AppUpdateChecker(').length, 2, 'one checker')
  assert.match(CLI, /if \(appUpdates\) setTimeout\(\(\) => \{\n\s*void appUpdates\n\s*\.check\(/, 'the boot check needs the checker')
  assert.equal(CLI.split('appUpdates.check(').length, 1, 'no other check from cli.ts')
})

// The finalize's restore passes `restoreAfter` (ModelRouter.undoSwapRecord): dropped here, a keep-N 2 restore that
// found the user's model still running left the routine's model recorded as the one last loaded. The behaviour is
// tested in routines/cli-interactive-runner.test.ts against a real router.
test("the interactive-routine sweep passes a restore's options on to the router", () => {
  assert.ok(CLI.includes('  loadExplicit: (modelKey, overrides, opts) => modelRouter.loadExplicit(modelKey, overrides, opts),'))
})

test('the interactive-routine sweep maps Code session ids to terminal ids', () => {
  assert.ok(CLI.includes('...terminalLookupsBySession(() => getTerminalManager(deps)),'))
  assert.ok(!/getTerminalManager\(deps\)\.(isActive|isAgentExited|getExitCode|kill)\(codeSessionId\)/.test(CLI),
    'TerminalManager is keyed by terminal id, not the Code session id')
})

// util/tether.ts ties every tethered child to this process; these pin where cli.ts drives it. The behaviour itself
// is util/tether.test.ts's: "stopTethered: SIGTERM first, then a group kill after the grace" and the daemon-SIGKILL
// tests.
test('both teardowns stop the tethered children beside the engine, and the exit handler kills them first', () => {
  const WITH_TETHER = /Promise\.all\(\[[^\]]*\bmanager\.shutdown\(\)[^\]]*\bstopTethered\(\)[^\]]*\]\)\.finally\(/
  assert.match(blockFrom('if (!packagedAndroidApp()) deps.requestRestart = ('), WITH_TETHER, 'the restart teardown')
  assert.match(blockFrom(SIGNALS), WITH_TETHER, 'the signal teardown')
  const exit = CLI.indexOf("process.on('exit', () => {\n  // Every tethered child")
  assert.ok(exit > 0, "the last-resort 'exit' handler")
  const firstCall = CLI.indexOf('try {', exit)
  assert.equal(CLI.slice(firstCall, CLI.indexOf('\n', firstCall)), 'try { killTetheredSync() } catch { /* best-effort */ }', 'killTetheredSync runs first')
})

test('boot waits for the tether (the Android helper\'s self-test) before anything is spawned', () => {
  const hide = CLI.indexOf('\nhideChildConsoleWindows()\n')
  const ready = CLI.indexOf('\nawait tetherReady()\n')
  assert.ok(hide > 0 && ready > hide, 'after hideChildConsoleWindows()')
  const between = CLI.slice(hide + '\nhideChildConsoleWindows()\n'.length, ready + 1).split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'))
  assert.deepEqual(between, [], 'right after it, with nothing but comments between')
  for (const later of ['reapStaleEngines(store.dir())', 'reconcileTailscale(', 'void runAutoLoad({']) {
    assert.ok(ready < CLI.indexOf(later), `before ${later}`)
  }
})
