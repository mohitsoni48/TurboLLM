// Keeps "no process TurboLLM starts can outlive it" true as the code changes: every place in src that starts a
// process without util/tether.ts is listed below, per call site, with the reason it may. A new raw spawn, or one
// moved to another function, fails this test until it is tethered or listed (where a reviewer sees it); a listed
// site that is gone fails it too, so the table never claims more than the code does.
//
// Why per call site, not per file: a file-level allowlist let any new spawn into a listed file through unseen
// (cli.ts holds both the browser opener, which must outlive the daemon, and spawns that must not). The scanner
// (raw-spawn-sites.ts) uses the TypeScript AST and sees every route to child_process and node-pty: static and
// dynamic imports, require, createRequire, process.getBuiltinModule, promisify wrappers and aliases.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { allRawSpawnSites, rawSpawnSites, sourceFilesUnder, untimedCalls } from './raw-spawn-sites'
import { tmpDir } from './tmp'

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url))

const SYNC = 'synchronous and bounded by its own timeout; it blocks the daemon, so it cannot be held, and a daemon killed in the middle of one leaves it to finish (Known)'
const LOOKUP = 'a synchronous PATH lookup (`which`, `where`) with no timeout of its own: it only reads directories and exits; it blocks the daemon, so it cannot be held, and a daemon killed in the middle of one leaves it to finish (Known)'
const WIN_KILL = 'a Windows kill helper (taskkill or a WMI walk): bounded, and it only kills'

/** `<file>#<enclosing function>:<callee>` → why it may start a process without the tether. */
const RAW_SPAWN_SITES: Record<string, string> = {
  // ── Meant to outlive the daemon (the daemon hands over to the user or to its successor) ──
  'cli.ts#openBrowser:spawn': 'the user\'s browser, which must outlive the daemon',
  'app-update-apply.ts#spawnUpdateHelper:spawn': 'the self-update helper: it waits for this daemon to exit, then installs and relaunches it',
  'update-helper.mjs#relaunch:spawn': 'runs in the update helper after the daemon has exited: the relaunched daemon',
  'update-helper.mjs#spawnNpm:spawn': 'runs in the update helper after the daemon has exited: npm installs the update',
  'update-helper.mjs#isZombie:spawnSync': 'runs in the update helper after the daemon has exited: `ps` reads a pid\'s state',
  'cli.ts#startReplacement:spawn': 'a Settings restart\'s replacement daemon: the keeper\'s own non-detached child (libuv\'s job on Windows), tied to it by a stdin lifeline bound to its pid, and the keeper relays the terminal\'s signals to it',

  // ── Not the daemon ──
  'daemon-pid.ts#isZombie:spawnSync': '`turbollm --stop`, run in the user\'s own terminal: `ps` reads the daemon\'s state',
  'daemon-pid.ts#taskkill:execFileSync': '`turbollm --stop` on Windows, run in the user\'s own terminal: it kills the daemon',
  'cli-launch.ts#realSpawn:spawn': '`turbollm launch <cli>` in the user\'s own terminal: the agent CLI is that terminal\'s',

  // ── The tether itself ──
  'util/tether.ts#startTethered:spawn': 'the implementation: the lifeline wrapper, and the plain Windows spawn in libuv\'s job',
  'util/tether.ts#startUnwrapped:spawn': 'the implementation: a program the resolver cannot find, so Node reports ENOENT/EACCES as before (a pid is registered and logged)',
  'util/tether.ts#startUnderHelper:spawn': 'the implementation: the Android helper, which arms PR_SET_PDEATHSIG and execs the program',
  'util/tether.ts#tetherTerminal:spawn': 'the implementation: a Code terminal\'s stand-alone watcher, which ends the terminal\'s session when the daemon closes its lifeline or dies',
  'util/tether.ts#selfTestHelper:spawn': 'the Android helper\'s boot self-test: a `sh` and a `sleep` it kills by pid whatever the outcome',
  'util/tether.ts#countGroupMembers:execFile': 'macOS group counts (`ps -A -o pgid=,stat=`): instant',
  'util/tether.ts#killTetheredSync:spawnSync': WIN_KILL,
  'util/tether.ts#killTetheredTree:execFile': WIN_KILL,
  'util/tether.ts#win32TreeKill:execFile': WIN_KILL,
  'util/pid1.ts#checkOrphansReaped:spawn': 'the boot check of whether anything reaps orphans: a `sh` that exits at once, leaving the one orphan the check watches',
  'util/hide-console-windows.ts#hideChildConsoleWindows:ChildProcess.prototype': 'patches windowsHide into every spawn on Windows; starts nothing itself',

  // ── Windows kill helpers ──
  'code/robust-bash.ts#killDescendantsViaWmi:spawn': WIN_KILL,
  'code/robust-bash.ts#killProcessTreeFast:spawn': WIN_KILL,
  'routines/cli-process.ts#killCliProcessTree:spawn': WIN_KILL,
  'engines/manager.ts#forceKill:execFile': WIN_KILL,
  'engines/manager.ts#killPidTree:execFile': WIN_KILL,
  'engines/manager.ts#killTrackedEnginesSync:spawnSync': WIN_KILL,
  'engines/build-runner.ts#onAbort:execFile': WIN_KILL,
  'engines/build-runner.ts#killTreeSync:spawnSync': WIN_KILL,
  'remote/child-process.ts#ChildTunnel.forceKill:execFile': WIN_KILL,
  'remote/child-process.ts#killSync:spawnSync': WIN_KILL,
  'terminal/terminal-manager.ts#killShell:spawnSync': WIN_KILL,

  // ── Synchronous calls ──
  'api/routes.ts#git:execFileSync': SYNC,
  'artifacts/screenshot.ts#chromeCandidates:execFileSync': LOOKUP,
  'engines/download.ts#stripMacOsQuarantine:execFileSync': SYNC,
  'sysinfo/sysinfo.ts#detectGpus:execFileSync': SYNC,
  'sysinfo/sysinfo.ts#enumLinuxGpus:execFileSync': SYNC,
  'sysinfo/sysinfo.ts#enumVulkanGpus:execFileSync': SYNC,
  'sysinfo/sysinfo.ts#enumWindowsGpus:execFileSync': SYNC,
  'sysinfo/sysinfo.ts#getCpuCoreCount:execFileSync': SYNC,
  'sysinfo/sysinfo.ts#prop:execFileSync': SYNC,
  'sysinfo/sysinfo.ts#readWindowsVramRegistry:execFileSync': SYNC,
  'sysinfo/sysinfo.ts#rocmSmiGpus:execFileSync': SYNC,
  'terminal/pty-session.ts#resolveWindowsShell:execFileSync': LOOKUP,
  'util/process-start-time.ts#processStartTimes:spawnSync': SYNC,

  // ── Tied another way ──
  'terminal/pty-session.ts#PTYSession.doSpawn:ptyModule.spawn': 'a Code terminal\'s shell: node-pty forks it, so it cannot get a lifeline fd; tetherTerminal (util/tether.ts) gives it a stand-alone watcher that ends its whole session (POSIX; Windows keeps the exit handler\'s taskkill /T)',
}

test('every raw spawn in src is a listed call site, and every listed one still exists', () => {
  const found = allRawSpawnSites(SRC_ROOT)
  const listed = Object.keys(RAW_SPAWN_SITES).sort()
  const unlisted = found.filter((s) => !(s in RAW_SPAWN_SITES))
  const stale = listed.filter((s) => !found.includes(s))
  assert.deepEqual(unlisted, [],
    `raw spawns not in RAW_SPAWN_SITES. Start the process with util/tether.ts (spawnTethered, spawnHeld, tetheredExecFile), ` +
    `or list the call site with the reason it may outlive or bypass the daemon's tie:\n${unlisted.join('\n')}`)
  assert.deepEqual(stale, [], `listed in RAW_SPAWN_SITES but no longer in the code (remove them):\n${stale.join('\n')}`)
})

test('every call the table says is bounded by its own timeout passes one', () => {
  const sync = Object.keys(RAW_SPAWN_SITES).filter((s) => RAW_SPAWN_SITES[s] === SYNC)
  assert.ok(sync.length >= 10, `the synchronous calls are listed (${sync.length})`)
  assert.deepEqual(untimedCalls(SRC_ROOT, sync), [],
    'pass these a `timeout` in the options object at the call, or list them with a reason that is true of them')
})

test('the scanner sees every route to child_process and node-pty, and no type-only use', () => {
  const dir = tmpDir('tllm-spawn-guard-')
  const file = join(dir, 'fixture.ts')
  writeFileSync(file, `
import { spawn, execFile as ef, type ChildProcess } from 'node:child_process'
import cp from 'child_process'
import * as cpNs from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
const req = createRequire(import.meta.url)
const run = promisify(ef)
type T = typeof spawn
function a(): ChildProcess { return spawn('a') }
async function b() { const { fork } = await import('node:child_process'); fork('b') }
function c() { cp.execSync('c'); cpNs.spawnSync('c') }
function d() { const pty = req('node-pty'); pty.spawn('d') }
const e = () => require('child_process').exec('e')
function f() { const m = process.getBuiltinModule('node:child_process'); m.execFileSync('f') }
async function g() { await run('g', []) }
function h(spawner: typeof spawn = spawn) { return spawner }
`)
  assert.deepEqual([...rawSpawnSites(file, dir)].sort(), [
    'fixture.ts#<module>:ef',
    'fixture.ts#a:spawn',
    'fixture.ts#b:fork',
    'fixture.ts#c:cp.execSync',
    'fixture.ts#c:cpNs.spawnSync',
    'fixture.ts#d:pty.spawn',
    'fixture.ts#e:exec',
    'fixture.ts#f:m.execFileSync',
    'fixture.ts#g:run',
    'fixture.ts#h:spawn',
  ])
})

// Code that pi loads from a repository (`.pi/extensions/*.js`) or from its agentDir runs inside the
// daemon, where neither the spawn guard above nor the tether sees what it starts. Every pi resource loader in src
// must refuse them; only the inline extensionFactories TurboLLM passes load.
test('every pi resource loader in src loads no extensions from the repository (noExtensions: true)', () => {
  const loaders: string[] = []
  const offenders: string[] = []
  for (const file of sourceFilesUnder(SRC_ROOT)) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('DefaultResourceLoader')) continue
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (n: ts.Node): void => {
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'DefaultResourceLoader') {
        const at = `${relative(SRC_ROOT, file).split(sep).join('/')}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`
        loaders.push(at)
        const opts = n.arguments?.[0]
        const off = !opts || !ts.isObjectLiteralExpression(opts) || !opts.properties.some((p) =>
          ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'noExtensions' && p.initializer.kind === ts.SyntaxKind.TrueKeyword)
        if (off) offenders.push(at)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  assert.ok(loaders.length >= 5, `found the Code sessions' loaders (${loaders.join(', ')})`)
  assert.deepEqual(offenders, [], 'pass `noExtensions: true` (a literal) to these DefaultResourceLoaders')
})
