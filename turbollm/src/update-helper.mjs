#!/usr/bin/env node
// The detached app-updater helper (spec 29 B.1, steps 1/3/5).
//
// This exists because of one hard constraint: on Windows you CANNOT rewrite the package
// files of a running daemon. `node_modules` is locked by the live process and `npm i -g`
// fails with EPERM/EBUSY. So the update cannot be performed by the process being updated
// — something outside it has to wait for it to die, swap the files, and start it again.
// That something is this file.
//
// Deliberately a plain, dependency-free `.mjs` rather than a TypeScript module bundled
// into `dist/cli.js`:
//   - it must survive the moment the daemon's own package is being overwritten, so it
//     may not import anything out of that package;
//   - it is spawned as a real file (`node update-helper.mjs <json>`), so it has to exist
//     as a file on disk in both dev (src/) and the published package (dist/) — exactly
//     the same reasoning as run-code-worker (tools/builtin.ts's WORKER_PATH). It sits
//     beside app-update-apply.ts in src/ and beside cli.js in dist/, so the sibling-URL
//     resolution is identical in both worlds.
//
// Contract with the daemon (all via argv[2], one JSON blob — no shared imports):
//   { pid, dataDir, method, from, to, execPath, argv, cwd, npmCmd }
// It writes `<dataDir>/update-result.json` on the way out, ALWAYS — success or failure —
// which is what the restarted daemon reads once on boot and surfaces as a toast. A
// failed install leaves the old version installed and simply relaunches it.

import { spawn, spawnSync } from 'node:child_process'
import { fchmodSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** How long to wait for the old daemon to actually exit before giving up. Must comfortably
 *  exceed cli.ts's own 14s restart watchdog (a loaded model takes up to ~8s to force-kill
 *  on Windows). Giving up here is not a failure of the update — it means the daemon is
 *  still alive, and installing over a live process is precisely what this file exists to
 *  avoid, so we abort instead. */
const WAIT_FOR_EXIT_MS = 60_000
const POLL_MS = 250

const opts = JSON.parse(process.argv[2] ?? '{}')

function log(line) {
  process.stdout.write(`[${new Date().toISOString()}] ${line}\n`)
}

function writeResult(ok, error) {
  try {
    writeFileSync(
      join(opts.dataDir, 'update-result.json'),
      JSON.stringify({ ok, from: opts.from ?? '', to: opts.to ?? '', method: opts.method ?? 'unknown', ...(error ? { error } : {}), at: new Date().toISOString() }, null, 2),
    )
  } catch (e) {
    log(`could not write result file: ${e}`)
  }
}

/** Whether `pid` has exited and only waits for its parent to reap it (a zombie). Signal 0 still
 *  reaches a zombie, so a daemon whose parent does not reap it (a Python Popen handle kept and
 *  never waited on, a container PID 1 that is not an init) read as alive through the whole wait
 *  below: the update was abandoned and nothing relaunched the daemon, which was gone. False when
 *  it cannot be told. Windows has none to tell: libuv's signal 0 there checks the exit code. The
 *  same test as daemon-pid.ts's isZombie, which this file may not import (see the header). */
function isZombie(pid) {
  if (process.platform === 'win32') return false
  try {
    if (process.platform === 'linux' || process.platform === 'android') {
      // `<pid> (<comm>) <state> …`; the command name may hold spaces and parentheses.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return /^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2))
    }
    const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 })
    return /^\s*Z/.test(String(r.stdout ?? ''))
  } catch {
    return false
  }
}

/** Is the daemon PID still alive? `kill(pid, 0)` is the portable liveness probe: it sends
 *  no signal and throws ESRCH once the process is gone. EPERM means it exists but belongs
 *  to someone else — still alive, so keep waiting. A zombie is gone (isZombie). */
function alive(pid) {
  try {
    process.kill(pid, 0)
  } catch (e) {
    if (!e || e.code !== 'EPERM') return false
  }
  return !isZombie(pid)
}

async function waitForExit(pid) {
  const deadline = Date.now() + WAIT_FOR_EXIT_MS
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  return false
}

/** One argument for a cmd.exe line that runs one of npm's `.cmd` shims (npm.cmd/npx.cmd):
 *  MSVCRT-quoted for the node.exe the shim starts, then every cmd metacharacter ^-escaped
 *  TWICE — once for cmd.exe /c, once more for the shim's own `%*` re-parse (the scheme
 *  cross-spawn uses for npm's shims). So a recorded argv path with spaces, `&`, `(`, `%`
 *  or `"` arrives intact and can never start a second command. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g
function quoteForCmdShim(arg) {
  const quoted = `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1')
}

/** spawn() for `npm`/`npx`. On Windows they are `.cmd` shims, and since the CVE-2024-27980
 *  fix Node refuses to spawn a `.cmd` without a shell — it throws EINVAL synchronously,
 *  which used to leave an npx user with no daemon at all after Update. So there the whole
 *  line goes to cmd.exe as one pre-quoted string (no args array: with `shell` Node would
 *  only space-join it, unquoted — DEP0190). */
function spawnNpm(cmd, args, options) {
  if (process.platform !== 'win32') return spawn(cmd, args, options)
  return spawn([cmd, ...args.map(quoteForCmdShim)].join(' '), { ...options, shell: true })
}

function run(cmd, args) {
  return new Promise((res) => {
    log(`> ${cmd} ${args.join(' ')}`)
    const child = spawnNpm(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
    child.on('error', (e) => res({ ok: false, error: String(e && e.message ? e.message : e) }))
    child.on('exit', (code) => res(code === 0 ? { ok: true } : { ok: false, error: `${cmd} exited with code ${code}` }))
  })
}

/** Relaunch the daemon EXACTLY as it was launched, from the identity the daemon recorded
 *  at boot (spec 29 B.1 step 3 — "so the helper never has to guess"). Detached with its
 *  own log file: this helper is about to exit, so inheriting its streams would break the
 *  new daemon's stdio the moment it does. Owner-only, as util/owner-only-log.ts opens it for
 *  the helper (this file is copied to dist on its own, so it can't import that): a daemon
 *  started with --print-token or --tunnel prints its fresh API key into this log. */
function relaunch() {
  let out = 'ignore'
  try {
    out = openSync(join(opts.dataDir, 'update.log'), 'a', 0o600)
    try {
      fchmodSync(out, 0o600) // a mode passed to open applies only to a file it creates
    } catch {
      /* best-effort: the log still works */
    }
  } catch {
    out = 'ignore'
  }
  const exe = opts.method === 'npx' ? (process.platform === 'win32' ? 'npx.cmd' : 'npx') : opts.execPath
  const args = opts.method === 'npx' ? ['-y', 'turbollm@latest', ...(opts.argv ?? []).slice(1)] : opts.argv ?? []
  log(`relaunching: ${exe} ${args.join(' ')}`)
  const options = { cwd: opts.cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true }
  // npx is a .cmd shim on Windows (see spawnNpm); execPath is node itself and spawns directly.
  const child = opts.method === 'npx' ? spawnNpm(exe, args, options) : spawn(exe, args, options)
  child.unref()
}

async function main() {
  log(`update helper starting (pid=${opts.pid}, method=${opts.method}, ${opts.from} → ${opts.to})`)

  if (!(await waitForExit(opts.pid))) {
    writeResult(false, 'The running TurboLLM did not shut down in time, so the update was not applied.')
    log('daemon did not exit — aborting without touching anything')
    return
  }
  log('daemon exited')

  // npx has nothing installed to upgrade: the relaunch below re-resolves `turbollm@latest`
  // from the registry, which IS the update. Only the global-install path runs npm.
  if (opts.method === 'npm_global') {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const r = await run(npm, ['install', '-g', 'turbollm@latest'])
    if (!r.ok) {
      // The install failed, so the OLD version is still what's on disk, intact. Relaunch it
      // — leaving the user daemonless because an update failed would be far worse than the
      // update simply not happening.
      writeResult(false, r.error)
      log(`install failed: ${r.error} — relaunching the previous version`)
      relaunch()
      return
    }
  }

  writeResult(true)
  relaunch()
  log('done')
}

main().catch((e) => {
  writeResult(false, String(e && e.message ? e.message : e))
  log(`unexpected failure: ${e}`)
  // Still try to bring the daemon back — see the install-failure branch above.
  try {
    relaunch()
  } catch {
    /* nothing more we can do */
  }
})
