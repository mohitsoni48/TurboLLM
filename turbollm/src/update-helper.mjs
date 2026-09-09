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

import { spawn } from 'node:child_process'
import { openSync, writeFileSync } from 'node:fs'
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

/** Is the daemon PID still alive? `kill(pid, 0)` is the portable liveness probe: it sends
 *  no signal and throws ESRCH once the process is gone. EPERM means it exists but belongs
 *  to someone else — still alive, so keep waiting. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e && e.code === 'EPERM'
  }
}

async function waitForExit(pid) {
  const deadline = Date.now() + WAIT_FOR_EXIT_MS
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  return false
}

function run(cmd, args) {
  return new Promise((res) => {
    log(`> ${cmd} ${args.join(' ')}`)
    // `shell: false`. On Windows the executable is `npm.cmd`, which Node spawns directly;
    // going through a shell would mean quoting user-influenced strings into a command
    // line, and there is no reason to when every argument here is a fixed literal.
    const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
    child.on('error', (e) => res({ ok: false, error: String(e && e.message ? e.message : e) }))
    child.on('exit', (code) => res(code === 0 ? { ok: true } : { ok: false, error: `${cmd} exited with code ${code}` }))
  })
}

/** Relaunch the daemon EXACTLY as it was launched, from the identity the daemon recorded
 *  at boot (spec 29 B.1 step 3 — "so the helper never has to guess"). Detached with its
 *  own log file: this helper is about to exit, so inheriting its streams would break the
 *  new daemon's stdio the moment it does. */
function relaunch() {
  let out = 'ignore'
  try {
    out = openSync(join(opts.dataDir, 'update.log'), 'a')
  } catch {
    out = 'ignore'
  }
  const exe = opts.method === 'npx' ? (process.platform === 'win32' ? 'npx.cmd' : 'npx') : opts.execPath
  const args = opts.method === 'npx' ? ['-y', 'turbollm@latest', ...(opts.argv ?? []).slice(1)] : opts.argv ?? []
  log(`relaunching: ${exe} ${args.join(' ')}`)
  const child = spawn(exe, args, { cwd: opts.cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true })
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
