// Telling a process we spawned apart from an unrelated one that later got the same pid. A pidfile
// outlives its process whenever the daemon dies without its exit handler (SIGKILL, OS shutdown,
// power loss), and after a reboot the pid usually belongs to something else — which a startup
// reaper's SIGKILL / `taskkill /F /T` would take down with its whole tree. The pidfile records
// when the process was spawned (`startedAt`); a reaper kills only a pid whose process started
// then. Shared by reapStaleTerminals (terminal-manager.ts) and reapStaleTunnels
// (remote/child-process.ts).
import { spawnSync } from 'node:child_process'

/** How far apart the pidfile's `startedAt` and the process's own start time may be for the pid
 *  to still count as the process we spawned. `ps` reports elapsed time in whole seconds. */
export const START_TIME_TOLERANCE_MS = 5_000

/** The start time (epoch ms) of each of `pids` that is running and readable, from ONE `ps` /
 *  PowerShell call (PowerShell alone takes about a second to start). A pid missing from the
 *  result could not be checked. */
export function processStartTimes(pids: number[]): Map<number, number> {
  const out = new Map<number, number>()
  if (pids.length === 0) return out
  try {
    if (process.platform === 'win32') {
      const script =
        `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { ` +
        `try { if ($_.StartTime) { '{0} {1}' -f $_.Id, ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } } catch {} }`
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 15_000, windowsHide: true,
      })
      for (const m of String(r.stdout ?? '').matchAll(/^\s*(\d+)\s+(\d+)\s*$/gm)) out.set(Number(m[1]), Number(m[2]))
    } else {
      // etime is [[dd-]hh:]mm:ss on procps, BSD/macOS and toybox ps alike.
      const now = Date.now()
      const r = spawnSync('ps', ['-o', 'pid=,etime=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 5_000 })
      for (const m of String(r.stdout ?? '').matchAll(/^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/gm)) {
        const secs = ((Number(m[2] ?? 0) * 24 + Number(m[3] ?? 0)) * 60 + Number(m[4])) * 60 + Number(m[5])
        out.set(Number(m[1]), now - secs * 1000)
      }
    }
  } catch {
    /* no way to check — nothing is verified, so nothing gets killed */
  }
  return out
}
