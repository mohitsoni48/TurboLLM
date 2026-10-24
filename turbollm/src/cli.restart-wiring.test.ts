// Source-level guard for the daemon's self-restart wiring (spec 08 §2, ADR-442).
//
// Why a source scan and not only a behavioural test: cli.ts is top-level module code. Importing it boots the real
// daemon (config, engines, a listening port), so it cannot be loaded from a test. cli.keeper.test.ts runs the real
// cli.ts as a process of its own and checks the keeper's behaviour end to end; these pin its wiring.
//
// The npm/CLI restart used to spawn a detached replacement that wrote to restart.log: it was beyond Ctrl+C, `docker
// stop` and the closing of the terminal, and it lost process.execArgv, so under `npm start` it died at once. The old
// process now becomes the keeper of its replacement (becomeKeeper), which is what these pin.
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

function occurrencesOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

const KEEPER_OPENING = 'function becomeKeeper(): void {'
const RESTART_HANDLER_OPENING = 'deps.requestRestart = ('
const RESTART_WATCHDOG = 'const watchdog = setTimeout(finish, 14_000)'
const DIRECT_RESTART_EXITS = ['process.exit(75)', 'exit(RESTART_REQUESTED_EXIT_CODE)']
const SUPERVISION_GATE = 'const supervised = boot.desktop || boot.keeperPid !== null'
const RESTART_PLAN_REQUEST = 'planRestartExit({ exitOnly: opts?.exitOnly === true, supervised })'
const PLANNED_EXIT = 'process.exit(plan.exitCode)'

test('the keeper runs the exit net, closes every lifeline, the listener, the store and the pidfile, then drops the daemon\'s own listeners, before the replacement starts', () => {
  const keeper = blockFrom(KEEPER_OPENING)
  const at = (needle: string) => {
    const i = keeper.indexOf(needle)
    assert.ok(i >= 0, `becomeKeeper must contain: ${needle}`)
    return i
  }
  const exitNet = at("for (const listener of process.listeners('exit')) {")
  const listenersGone = at("process.removeAllListeners('exit')")
  const lifelines = at('closeAllLifelines()')
  const server = at('server.close()')
  const store = at('db.close()')
  const pidfile = at('removeOwnPidfile(store.dir())')
  const signals = at("for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.removeAllListeners(sig)")
  const replacement = keeper.lastIndexOf('startReplacement()')
  assert.ok(exitNet < listenersGone && listenersGone < lifelines, 'every exit listener once, then none left, then every lifeline')
  for (const step of [lifelines, server, store, pidfile, signals]) assert.ok(step < replacement, 'all before the replacement starts')
})

test('the replacement gets execArgv (as fork does), the same argv and cwd, a stdin lifeline bound to the keeper, and is not detached', () => {
  const keeper = blockFrom(KEEPER_OPENING)
  assert.ok(keeper.includes('spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {'), 'execArgv first, so --import tsx reaches it')
  assert.ok(keeper.includes('cwd: process.cwd(),'))
  assert.ok(keeper.includes("stdio: ['pipe', 'inherit', 'inherit'],"), 'its stdin is the lifeline; its output goes to this terminal')
  assert.ok(keeper.includes('TURBOLLM_LIFELINE: `stdin:${process.pid}`, TURBOLLM_SUPERVISOR: `keeper:${process.pid}`'))
  assert.ok(!keeper.includes('detached'), 'not detached: it stays in the terminal\'s foreground job, and in the keeper\'s job on Windows')
  assert.ok(!keeper.includes('unref'), 'the keeper waits for it')
  assert.ok(!CLI.includes("'restart.log'"), 'no restart.log any more: the output is the terminal\'s')
})

test('the keeper relays the terminal\'s signals on POSIX, waits on Windows, and exits with the replacement\'s code; 75 starts the next one, unless the keeper was told to end', () => {
  const keeper = blockFrom(KEEPER_OPENING)
  assert.match(keeper, /if \(process\.platform === 'win32'\) \{\s*for \(const sig of \['SIGINT', 'SIGBREAK', 'SIGHUP'\] as const\) process\.on\(sig, \(\) => \{ ending = true /)
  assert.match(keeper, /for \(const sig of \['SIGINT', 'SIGTERM', 'SIGHUP'\] as const\) \{\s*process\.on\(sig, \(\) => \{\s*ending = true\s*try \{\s*replacement\?\.kill\(sig\)/)
  assert.match(keeper, /if \(code === RESTART_REQUESTED_EXIT_CODE && !ending\) \{[\s\S]*?try \{\s*startReplacement\(\)\s*\} catch \(e\) \{[\s\S]*?process\.exit\(1\)\s*\}\s*return\s*\}/,
    'a next replacement that cannot be spawned ends the keeper: its uncaughtException handler would keep it running with none')
  // A replacement whose restart finished just as the keeper was signalled exits 75: the keeper relayed (or, on
  // Windows, ignored) a signal meant to end TurboLLM, and a next replacement would run on after it.
  assert.match(keeper, /return\s*\}\s*(\/\/[^\n]*\n\s*)*if \(code === RESTART_REQUESTED_EXIT_CODE\) process\.exit\(0\)\s*process\.exit\(code \?\? 128 \+/,
    'a 75 after the keeper was told to end ends it with 0')
})

// A signal (or the stdin lifeline's end) during a restart's teardown: both teardowns waited on the same engine exits
// and ended in one server 'close', so finish() became the keeper and spawned the replacement, and the shutdown's exit
// ended that keeper in the same tick; the replacement ran on, parented to init. A supervised one exited 75, and its
// keeper started another daemon. cli.keeper.test.ts runs both end to end.
test('a signal or the lifeline\'s end during a restart\'s teardown wins: finish() then starts and exits nothing, and no restart starts once a shutdown has', () => {
  const restartHandler = blockFrom(RESTART_HANDLER_OPENING)
  assert.match(restartHandler, /^deps\.requestRestart = \(opts\?: \{ exitOnly\?: boolean \}\) => \{\s*(\/\/[^\n]*\n\s*)*if \(restarting \|\| shuttingDown\) return/,
    'no restart starts once a shutdown has')
  const finish = restartHandler.slice(restartHandler.indexOf('const finish = () => {'))
  const guard = finish.indexOf('if (shuttingDown) return')
  assert.ok(guard > finish.indexOf('releaseDataDirClaim(store.dir())'), 'the data-dir claim is still released')
  assert.ok(guard < finish.indexOf("if (plan.kind === 'become-keeper')") && guard < finish.indexOf(PLANNED_EXIT), 'before the keeper or the planned exit')
  assert.ok(CLI.indexOf('let shuttingDown = false') > 0 && /beginShutdown = \(reason: string\) => \{\s*if \(shuttingDown\) return\s*shuttingDown = true/.test(CLI),
    'shuttingDown is set by the one shutdown function, first')
})

// Every recurring tick of the old process ran on in the keeper, on its state: the ext API's reaper threw from its timer
// on the chat store the keeper had closed, 30 s after the restart, and ended the keeper and TurboLLM with it (the
// replacement's stdin lifeline); the telemetry ticks flushed with the consent from before the restart, and a Turbo Link
// heartbeat wrote the keeper's stale config over the replacement's. cli.keeper.test.ts runs the ext case end to end.
test('the keeper stops every recurring tick of the old daemon and its config saves, and survives an error from its leftover work, before the replacement starts', () => {
  const keeper = blockFrom(KEEPER_OPENING)
  const replacement = keeper.lastIndexOf('startReplacement()')
  for (const step of ['stopDaemonTicks()', 'deps.links?.stop()', 'stopUsageMonitor()', 'store.stopSaving()', "process.on('uncaughtException', "]) {
    const i = keeper.indexOf(step)
    assert.ok(i >= 0, `becomeKeeper must contain: ${step}`)
    assert.ok(i < replacement, `${step} before the replacement starts`)
  }
  const restartHandler = blockFrom(RESTART_HANDLER_OPENING)
  for (const stop of ['updateScheduler.stop()', 'routineScheduler.stop()', 'clearInterval(cliInteractiveSweepTimer)', 'comfy.stop()', 'remote.disableAll()']) {
    assert.ok(restartHandler.includes(stop), `the restart handler stops the rest: ${stop} (util/daemon-ticks.test.ts lists them)`)
  }
})

// A shutdown that came while a remote-access Stop, a provider switch or a restart's teardown was still running
// `tailscale serve|funnel … off`: its own remote.disable() found the provider taken and ended at once, the teardown
// settled, and the exit (the 'exit' handler, or the keeper's exit net) killed that `off` mid-call, leaving Serve or the
// public Funnel on after TurboLLM was gone. remote/child-process.tether.test.ts runs the manager's side.
test('both teardowns wait for every remote-access stop still running, not only their own', () => {
  const teardowns = [['the restart handler', blockFrom(RESTART_HANDLER_OPENING)], ['the signal shutdown', blockFrom('beginShutdown = (reason: string) => {')]] as const
  for (const [name, block] of teardowns) {
    assert.match(block, /void Promise\.all\(\[[^\]]*\bremote\.disableAll\(\)[^\]]*\]\)\.finally\(/, `${name}'s teardown waits for remote.disableAll()`)
    assert.ok(!block.includes('remote.disable()'), `${name} does not wait for its own remote.disable() alone`)
  }
})

test('the restart watchdog is still 14 s, and it reaches the keeper too', () => {
  assert.equal(occurrencesOf(CLI, RESTART_WATCHDOG), 1, `cli.ts must contain "${RESTART_WATCHDOG}" exactly once`)
  const restartHandler = blockFrom(RESTART_HANDLER_OPENING)
  assert.match(restartHandler, /if \(plan\.kind === 'become-keeper'\) \{\s*try \{\s*becomeKeeper\(\)\s*return/, 'finish() becomes the keeper, whichever path reached it')
})

test('no code path in cli.ts exits with the restart code directly', () => {
  const directExits = DIRECT_RESTART_EXITS.filter((exit) => CLI.includes(exit))
  assert.deepEqual(directExits, [], 'the restart exit code comes from planRestartExit, never a hand-written exit')
})

test('supervision comes from the boot environment, bound to the parent, evaluated once before the restart handler', () => {
  assert.ok(CLI.includes("from './daemon-restart'"), "cli.ts must import the restart planner from './daemon-restart'")
  assert.equal(occurrencesOf(CLI, SUPERVISION_GATE), 1, `cli.ts must contain "${SUPERVISION_GATE}" exactly once`)
  assert.ok(CLI.indexOf(SUPERVISION_GATE) < CLI.indexOf(RESTART_HANDLER_OPENING))
  assert.ok(CLI.indexOf('const boot = takeBootEnvironment()') < CLI.indexOf('hideChildConsoleWindows()\n'), 'taken first, before anything is spawned')
})

test('the restart handler asks planRestartExit how to end, passing exitOnly through unchanged', () => {
  const restartHandler = blockFrom(RESTART_HANDLER_OPENING)
  assert.ok(restartHandler.includes(RESTART_PLAN_REQUEST), `the restart handler must call ${RESTART_PLAN_REQUEST}`)
  assert.ok(!restartHandler.includes('const respawn'), 'the respawn decision belongs to planRestartExit')
})

test("finish() exits with the plan's code and never with a literal 0", () => {
  const restartHandler = blockFrom(RESTART_HANDLER_OPENING)
  assert.equal(occurrencesOf(restartHandler, PLANNED_EXIT), 1, `the restart handler must end with ${PLANNED_EXIT}`)
  assert.ok(!restartHandler.includes('process.exit(0)'), 'a literal exit 0 would hide the supervisor\'s restart code')
  assert.ok(restartHandler.includes('if (finished) return'), 'finish() must still run at most once')
})

test('the supervised plan spawns nothing itself', () => {
  const restartHandler = blockFrom(RESTART_HANDLER_OPENING)
  assert.ok(restartHandler.includes("plan.kind === 'supervisor-respawn'"))
  assert.ok(!restartHandler.includes('spawn('), 'under a supervisor, the supervisor starts the fresh daemon')
})

test('the signal shutdown is one function, run by SIGINT, SIGTERM and SIGHUP, by SIGBREAK on Windows, and by the stdin lifeline', () => {
  assert.ok(CLI.includes("const shutdownSignals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const : ['SIGINT', 'SIGTERM', 'SIGHUP'] as const"))
  assert.ok(CLI.includes("for (const sig of shutdownSignals) process.on(sig, () => beginShutdown?.(''))"))
  const lifeline = CLI.slice(CLI.indexOf('if (boot.stdinLifeline) {'), CLI.indexOf('hideChildConsoleWindows()\n'))
  for (const ending of ["process.stdin.once('end', onEnd)", "process.stdin.once('close', onEnd)", "process.stdin.once('error', onEnd)", 'process.stdin.resume()']) {
    assert.ok(lifeline.includes(ending), `the lifeline must have ${ending}`)
  }
  assert.match(lifeline, /if \(beginShutdown\) beginShutdown\(reason\)\s*else process\.exit\(0\)/, 'before the handler exists it exits at once')
})

// The signal shutdown disconnects every MCP server before its teardown; a restart did not, so each stdio server was
// left to notice its stdin's EOF after the exit, and one that ignores it ran on beside the replacement's own.
test('a restart disconnects the MCP servers before its teardown, as the signal shutdown does', () => {
  const restartHandler = blockFrom(RESTART_HANDLER_OPENING)
  const disconnect = restartHandler.indexOf('toolRegistry.disconnectAll()')
  assert.ok(disconnect > 0, 'the restart handler must call toolRegistry.disconnectAll()')
  assert.ok(disconnect < restartHandler.indexOf('void Promise.all(['), 'before the teardown')
})

// The restart's exit used to cut off the old process's in-flight work. A restart from a terminal now keeps that
// process alive as the keeper, where a Code turn would have gone on acting on its repository unseen, and a model
// download gone on writing the .part the replacement shows paused and resumes (two writers on one file).
test('a restart stops every Code run and pauses every download, and its teardown waits for their writers; the keeper starts nothing more', () => {
  const restartHandler = blockFrom(RESTART_HANDLER_OPENING)
  const stop = restartHandler.indexOf('for (const id of deps.codeRuns?.activeSessionIds() ?? []) deps.codeRuns?.stop(id)')
  assert.ok(stop > 0, 'the restart handler stops every Code run')
  assert.ok(stop < restartHandler.indexOf('void Promise.all(['), 'before the teardown, while the store is open')
  assert.match(restartHandler, /void Promise\.all\(\[[^\]]*\bdownloads\.pauseAll\(\)[^\]]*\]\)\.finally\(/, 'the teardown waits for the paused downloads')
  const keeper = blockFrom(KEEPER_OPENING)
  assert.ok(keeper.indexOf('refuseNewTetheredSpawns()') > keeper.indexOf('closeAllLifelines()'), 'after its lifelines are closed, the keeper starts no tethered child')
})
