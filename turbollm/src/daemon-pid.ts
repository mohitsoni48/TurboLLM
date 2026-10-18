// Pidfile utilities for F-035: write/read/remove the daemon's PID file and
// implement `turbollm --stop`. Isolated here so it can be unit-tested without
// touching cli.ts (which is the entrypoint and spins up a full daemon).
import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync, writeSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import http from 'node:http'
import { isIP } from 'node:net'
import { START_TIME_TOLERANCE_MS, processStartTimes } from './util/process-start-time'

export interface PidfileData {
  pid: number
  port: number
  /** The address the daemon bound. A daemon bound to one interface (`--addr 192.168.1.5:…`,
   *  `daemon.host`) does not answer on 127.0.0.1, so the identity probe must go here. Absent
   *  from a pidfile written before it was recorded (probed on loopback, as before). */
  host?: string
}

/** Write `{ pid, port, host? }` as JSON to <dir>/daemon.pid. Best-effort. */
export function writePidfile(dir: string, pid: number, port: number, host?: string): void {
  const path = join(dir, 'daemon.pid')
  writeFileSync(path, JSON.stringify({ pid, port, ...(host ? { host } : {}) } satisfies PidfileData))
}

/** Read and parse <dir>/daemon.pid. Returns null if absent, unparseable or out of range. */
export function readPidfile(dir: string): PidfileData | null {
  const path = join(dir, 'daemon.pid')
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    // A real pid and port only. `process.kill(-1, …)` signals every process this user owns and
    // `process.kill(0, …)` our own process group, and both pass the signal-0 liveness probe: a
    // hand-edited pidfile with pid -1 or 0 next to a live TurboLLM on its port would have had
    // --stop SIGTERM (then SIGKILL) all of them. The daemon only ever writes process.pid.
    const { pid, port, host } = (parsed ?? {}) as { pid?: unknown; port?: unknown; host?: unknown }
    if (
      typeof pid === 'number' && Number.isInteger(pid) && pid > 0 &&
      typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
    ) {
      // A malformed host is dropped (probe loopback), never put into a URL.
      return typeof host === 'string' && host ? { pid, port, host } : { pid, port }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Resolve the TCP port to reach the daemon on, WITHOUT assuming a fixed default.
 * Priority:
 *   1. `explicitPort` — an explicit `--port` the caller passed.
 *   2. The running daemon's pidfile (`<dir>/daemon.pid`) — its ACTUAL bound port,
 *      which is correct even when the daemon was started with `--port`/`--addr` or a
 *      custom config that moved it off the shipped default.
 *   3. `fallbackPort` — the caller's configured / shipped default (last resort, used
 *      when no daemon is running or its pidfile is missing).
 */
export function resolveDaemonPort(
  dir: string,
  explicitPort: number | undefined,
  fallbackPort: number,
): number {
  if (explicitPort && explicitPort > 0) return explicitPort
  const data = readPidfile(dir)
  if (data && data.port > 0) return data.port
  return fallbackPort
}

/** Remove <dir>/daemon.pid. Best-effort — never throws. */
export function removePidfile(dir: string): void {
  try {
    unlinkSync(join(dir, 'daemon.pid'))
  } catch {
    /* best-effort */
  }
}

/** Remove <dir>/daemon.pid only when it is `pid`'s own record — what a daemon's shutdown/exit
 *  path must use. A second daemon started on the same data dir never wrote one, so on its way
 *  out it would otherwise delete the RUNNING daemon's pidfile (and `--stop` could no longer
 *  find it). Best-effort — never throws. */
export function removeOwnPidfile(dir: string, pid: number = process.pid): void {
  if (readPidfile(dir)?.pid === pid) removePidfile(dir)
}

/** The host to reach a daemon that bound `host` on: that address, except that a wildcard bind
 *  (all interfaces) or an older pidfile with no host is reached over loopback, and an IPv6
 *  literal is bracketed for a URL. */
export function daemonReachHost(host: string | undefined): string {
  if (!host || host === '0.0.0.0' || host === '::') return '127.0.0.1'
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/** The daemon that already owns <dir>/daemon.pid and is alive, or null. Alive means the same
 *  proof {@link stopDaemon} demands before it kills anything: the PID exists AND a TurboLLM
 *  answers on the recorded address and port — so a stale pidfile, a recycled PID or a daemon
 *  that already closed its listener (a self-restart handing over) never blocks a start. */
export async function findRunningDaemon(
  dir: string,
  hooks: Pick<StopHooks, 'processExists' | 'confirmTurbollm'> = defaultHooks,
  selfPid: number = process.pid,
): Promise<PidfileData | null> {
  const data = readPidfile(dir)
  if (!data || data.pid === selfPid || !hooks.processExists(data.pid)) return null
  return (await hooks.confirmTurbollm(data.port, data.host, data.pid)) ? data : null
}

// ── Start claim (<dir>/daemon.lock) ───────────────────────────────────────────
// The pidfile is written only once a daemon has bound, a second or more after its start guard
// (engine/tunnel reaps, sql.js, the DB open and migrations, the schedulers). Two daemons started
// together therefore both found no pidfile, both booted on one database (on a fresh data dir one
// could crash in a migration the other was running) and both kept running on their own ports,
// with only one of them in daemon.pid for --stop. So a start first claims the data dir: it
// creates daemon.lock with O_EXCL ('wx'), which of two starts at once only one can do, and keeps
// it until its pidfile is written; from then on the pidfile guards on its own (findRunningDaemon),
// except while an in-place rebind has no listener up, which takes the claim again (cli.ts
// deps.rebind).

/** How far a claim with no readable record (a start between the 'wx' create and its write, or
 *  junk) is honoured: only while it is this fresh. */
const CLAIM_UNWRITTEN_GRACE_MS = 5_000
/** A claim whose holder's start time cannot be read (no `ps`, a process this user may not inspect)
 *  is honoured only this long after it was taken: longer than any boot to the bind or rebind to
 *  the new listener, so a live start is never cut off, and a claim left by a boot that was killed,
 *  with its pid since reused, still expires. */
const CLAIM_UNVERIFIED_MAX_AGE_MS = 120_000

export interface ClaimHooks {
  /** Returns true when the process is still alive (EPERM counts as alive, as for --stop). */
  processExists: (pid: number) => boolean
  /** When `pid` started (epoch ms), or undefined when that cannot be read. */
  startTime: (pid: number) => number | undefined
  now: () => number
}

/** A claim's record: the claiming process and when it started (epoch ms), so a claim left by a
 *  boot that was killed (SIGKILL, Ctrl+C before the signal handlers exist, power loss) is told
 *  apart from a live one even after its pid has gone to another process. */
export interface ClaimRecord {
  pid: number
  startedAt: number
}

/** What daemon.lock holds: the record, and when the claim was taken (epoch ms). A boot claims
 *  within a moment of its start, a rebind (cli.ts deps.rebind) hours or days after it, so the age
 *  limit on a holder that cannot be checked counts from `claimedAt`. A record without it (written
 *  by an older version) is aged from its start. */
interface StoredClaim extends ClaimRecord {
  claimedAt: number
}

const defaultClaimHooks: ClaimHooks = {
  processExists: (pid) => defaultHooks.processExists(pid),
  startTime: (pid) => processStartTimes([pid]).get(pid),
  now: () => Date.now(),
}

/** Worked out once, at this process's first claim (its boot's), and reused by every later one (a
 *  rebind's, see cli.ts deps.rebind). process.uptime() runs on a monotonic clock that stops while
 *  the machine sleeps, and the start time another start checks the record against (ps etime) does
 *  not, so a record worked out after a suspend lay that much later than the process's real start
 *  and read as a reused pid. A wall-clock jump of over 5 s after the boot (NTP's first sync on a
 *  board with no RTC, a manual change) is not followed: on Linux, where ps derives the start from
 *  the time since the machine booted, the record is then off by the jump, and a start mid-rebind
 *  removes the claim as a reused pid's, as when a rebind took no claim. */
let ownRecord: ClaimRecord | undefined
function ownClaimRecord(): ClaimRecord {
  ownRecord ??= { pid: process.pid, startedAt: Date.now() - Math.round(process.uptime() * 1000) }
  return ownRecord
}

/** The live start holding the claim at `path`, or null when it is stale or gone. */
function liveClaimHolder(path: string, hooks: ClaimHooks, self: ClaimRecord): { pid: number | null } | null {
  let rec: unknown
  try {
    rec = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null // released meanwhile
    try {
      return hooks.now() - statSync(path).mtimeMs < CLAIM_UNWRITTEN_GRACE_MS ? { pid: null } : null
    } catch {
      return null
    }
  }
  const { pid, startedAt, claimedAt } = (rec ?? {}) as { pid?: unknown; startedAt?: unknown; claimedAt?: unknown }
  // Every writer records both, in one write: anything else is junk. A record with our own pid
  // was left by an earlier process that had it (ours is not written yet).
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof startedAt !== 'number') return null
  if (pid === self.pid || !hooks.processExists(pid)) return null
  const actual = hooks.startTime(pid)
  if (actual !== undefined) return Math.abs(actual - startedAt) <= START_TIME_TOLERANCE_MS ? { pid } : null
  // Aged from the claim, not the start: from the start, a rebind's claim read as stale once its
  // daemon had been up two minutes, and a start mid-rebind removed it and booted beside it,
  // wherever the start time cannot be read (no `ps`, as in a minimal container image; an elevated
  // daemon's StartTime on Windows).
  const since = typeof claimedAt === 'number' ? claimedAt : startedAt
  return hooks.now() - since < CLAIM_UNVERIFIED_MAX_AGE_MS ? { pid } : null
}

/**
 * Claim <dir> for this starting daemon (see the section comment). Returns the start that already
 * holds the claim and so blocks this one (`pid` null when its record is not written yet), or null
 * when this process may start: it now holds the claim, or the data dir cannot hold one (read-only,
 * missing), in which case the pidfile guard alone applies, as before the claim existed.
 *
 * Call it BEFORE {@link findRunningDaemon}: the holder writes its pidfile before it releases the
 * claim, so a start that gets the claim after that release always sees the holder's pidfile.
 * A stale claim (holder dead, pid reused, junk) is removed and the claim retried once. Two starts
 * that both find the same stale claim can both take it; that needs a boot killed inside its own
 * claim window and then two starts at once.
 */
export function claimDataDir(
  dir: string,
  hooks: ClaimHooks = defaultClaimHooks,
  self: ClaimRecord = ownClaimRecord(),
): { pid: number | null } | null {
  const path = join(dir, 'daemon.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number
    try {
      fd = openSync(path, 'wx')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null
      const holder = liveClaimHolder(path, hooks, self)
      if (holder || attempt === 1) return holder
      try {
        unlinkSync(path)
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code !== 'ENOENT') return null
      }
      continue
    }
    try {
      writeSync(fd, JSON.stringify({ pid: self.pid, startedAt: self.startedAt, claimedAt: hooks.now() } satisfies StoredClaim))
    } catch {
      // Unwritten, the claim would block others for its grace period and never be released.
      try { closeSync(fd) } catch { /* best-effort */ }
      try { unlinkSync(path) } catch { /* best-effort */ }
      return null
    }
    closeSync(fd)
    return null
  }
  return null
}

/** Remove <dir>/daemon.lock when it is `pid`'s own claim (once its pidfile is written, or on its
 *  way out) — never another start's. Best-effort — never throws. */
export function releaseDataDirClaim(dir: string, pid: number = process.pid): void {
  const path = join(dir, 'daemon.lock')
  try {
    if ((JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown } | null)?.pid === pid) unlinkSync(path)
  } catch {
    /* absent, unreadable or already gone */
  }
}

// Injection hook types so unit tests can replace the real OS calls.
export interface StopHooks {
  /** Returns true when the process is still alive (an exited one not yet reaped is not). */
  processExists: (pid: number) => boolean
  /** Send a signal to the process (Unix only). */
  kill: (pid: number, signal: NodeJS.Signals) => void
  /** Run taskkill on Windows. */
  taskkill: (pid: number) => void
  /** Confirm a TurboLLM daemon is actually answering on `port` of the bound `host` (see
   *  {@link daemonReachHost}), and that it is process `pid` when it reports one — the identity
   *  check that guards against killing a recycled PID (stale pidfile whose PID the OS reused). */
  confirmTurbollm: (port: number, host?: string, pid?: number) => Promise<boolean>
  /** Platform — injectable so the Windows vs Unix branch is testable on any OS. */
  platform: NodeJS.Platform
}

/** Whether `pid` has exited and only waits for its parent to reap it (a zombie). Signal 0 still
 *  reaches a zombie, so one read as running: a daemon whose parent does not reap (a Python Popen
 *  handle kept and never waited on, a container PID 1 that is not an init) held --stop through the
 *  whole SIGTERM grace, then still counted as running after SIGKILL, and --stop exited 1 with
 *  nothing left running. False when it cannot be told. Windows has none to tell: libuv's signal 0
 *  there checks the exit code. */
function isZombie(pid: number): boolean {
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

/** Default production hooks. */
const defaultHooks: StopHooks = {
  processExists(pid) {
    try {
      process.kill(pid, 0)
    } catch (e) {
      // EPERM: it exists but this user may not signal it (a daemon run elevated or as another
      // user) — alive, so a start beside it is refused and --stop keeps its pidfile. A recycled
      // PID is still caught by the identity probe that follows every use of this.
      if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false
    }
    return !isZombie(pid)
  },
  kill(pid, signal) {
    process.kill(pid, signal)
  },
  taskkill(pid) {
    // On Windows, graceful SIGTERM is not reliably deliverable to another console
    // process, so we use taskkill /T (kill tree) /F (force). Any VRAM left by the
    // engine subprocess will be freed by the startup orphan-reaper on the next launch.
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  },
  async confirmTurbollm(port, host, pid) {
    // Probe the recorded address and port. /healthz, not /api/v1/status: a daemon bound to a
    // non-loopback address is LAN-exposed, so with requireApiKey (the default) it answers
    // /api/v1/status 401 to this probe, which reaches it from that address, not from loopback;
    // /healthz is open on every bind (auth.ts isExempt). Identity: every TurboLLM response
    // carries `Server: TurboLLM/<version>` (server.ts) and /healthz's JSON body a `version`.
    // Anything else (refused, non-JSON, foreign app) → not ours. Short timeout; never throws.
    //
    // And it must be the pidfile's own process: a pidfile outlives a hard kill and its pid can go
    // to an unrelated process while another TurboLLM (another data dir's) comes to answer on that
    // port, which passed and had --stop kill the unrelated process. /healthz reports the daemon's
    // `pid`; a body without one is a TurboLLM older than that, taken as before (the CLI is often
    // updated while its daemon still runs). `pid: null` comes through remote access (server.ts):
    // another daemon's ingress listener on that loopback port, never the pidfile's daemon.
    //
    // Only a listener on THIS machine may answer: a pidfile outlives an unclean exit (power
    // loss, SIGKILL), the recorded address may since have gone to another machine (a new DHCP
    // lease), and its TurboLLM answering is no proof about a local pid that --stop then kills.
    // So the probe's own socket is bound to the recorded address (localAddress): the kernel
    // allows that only for an address this machine has (EADDRNOTAVAIL at once otherwise), and
    // traffic to it never leaves the machine. Not os.networkInterfaces(): it leaves out an
    // interface that is up but has no carrier (docker0 or virbr0 with nothing attached), where a
    // daemon can still be bound and answer, and it throws on some Android versions.
    const wildcard = !host || host === '0.0.0.0' || host === '::'
    const addr = wildcard ? '127.0.0.1' : host.replace(/^\[(.*)\]$/, '$1')
    // A hostname or junk from a hand-edited pidfile is never probed. Port: http.get throws
    // synchronously on one out of range and quietly turns 0 into 80.
    if (!isIP(addr) || !Number.isInteger(port) || port < 1 || port > 65535) return false
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let req: http.ClientRequest | undefined
      const done = (ok: boolean): void => {
        clearTimeout(timer)
        req?.destroy()
        resolve(ok)
      }
      const onResponse = (res: http.IncomingMessage): void => {
        const status = res.statusCode ?? 0
        if (status < 200 || status > 299 || !String(res.headers.server ?? '').startsWith('TurboLLM/')) return done(false)
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
          if (text.length > 65_536) done(false) // /healthz is tiny; not an unbounded read
        })
        res.on('end', () => {
          try {
            const body = JSON.parse(text) as unknown
            done(
              typeof body === 'object' && body !== null && 'version' in body &&
                (pid === undefined || !('pid' in body) || body.pid === pid),
            )
          } catch {
            done(false)
          }
        })
        res.on('error', () => done(false))
      }
      try {
        // agent: false — one connection, closed after; nothing pooled keeps the CLI alive.
        req = http.get(
          { host: addr, port, path: '/healthz', agent: false, ...(wildcard ? {} : { localAddress: addr }) },
          onResponse,
        )
      } catch {
        return done(false) // the startup guard awaits this at top level: a throw would crash the start
      }
      req.on('error', () => done(false))
      timer = setTimeout(() => done(false), 2000)
    })
  },
  platform: process.platform,
}

/** Poll until `processExists(pid)` returns false or `timeoutMs` elapses (~100 ms steps). */
async function waitForExit(
  pid: number,
  timeoutMs: number,
  hooks: StopHooks,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!hooks.processExists(pid)) return true
    await new Promise<void>((r) => setTimeout(r, 100))
  }
  return !hooks.processExists(pid)
}

export interface StopResult {
  /** Whether a running daemon was found and stopped. */
  stopped: boolean
  /** A running daemon was found (the pid alive and a TurboLLM with that pid answering, what the
   *  start guard counts as running) and it is still running, or a start or rebind holding the
   *  claim was still at it when --stop gave up waiting: `turbollm --stop` exits 1. False when
   *  there was nothing to stop, as well as when it was stopped. */
  failed: boolean
  /** The port the daemon was listening on (when stopped = true). */
  port?: number
  /** Human-readable message to print. */
  message: string
}

/** What changes each time the daemon writes its pidfile: the text, and the mtime for a rewrite of
 *  the same text (a rebind's revert to the old address). '' when there is none. */
function pidfileStamp(dir: string): string {
  const path = join(dir, 'daemon.pid')
  try {
    return `${statSync(path).mtimeMs} ${readFileSync(path, 'utf8')}`
  } catch {
    return ''
  }
}

/** How long --stop waits for a start or an in-place rebind holding the claim (daemon.lock) to
 *  finish: past a boot's way to its bind and a rebind's drain (3 s) and busy-port retries (10 s). */
const STOP_CLAIM_WAIT_MS = 30_000

export interface StopOptions {
  /** The claim's process checks (tests). */
  claimHooks?: ClaimHooks
  /** How long to wait for a start or rebind in progress (default {@link STOP_CLAIM_WAIT_MS}). */
  claimWaitMs?: number
  /** Told once, when --stop starts waiting for one. */
  onWait?: (message: string) => void
}

/**
 * Stop the running TurboLLM daemon by reading its pidfile from `dir`.
 *
 * Cross-platform:
 * - Unix: SIGTERM → wait up to 10 s → SIGKILL if still alive.
 * - Windows: taskkill /PID /T /F (graceful signals aren't reliably deliverable
 *   to another console process on Windows).
 *
 * The pidfile is removed after a successful stop.
 */
export async function stopDaemon(dir: string, hooks: StopHooks = defaultHooks, opts: StopOptions = {}): Promise<StopResult> {
  // A start or rebind in progress holds the claim (see the claim section) and has nothing
  // answering at a pidfile's address: a boot has written none yet, and a rebind's old listener is
  // closed until its new bind writes the new one. --stop then exited 0 with "No running TurboLLM
  // daemon found" while a boot went on to start, or called the daemon mid-rebind stale, said its
  // PID may have been reused and handed out `kill -9`. So it waits for the holder to finish, then
  // stops the daemon its pidfile names; one that does not finish in time is reported as such and
  // exits 1, without anything being killed.
  const claimPath = join(dir, 'daemon.lock')
  const claimHooks = opts.claimHooks ?? defaultClaimHooks
  const deadline = Date.now() + (opts.claimWaitMs ?? STOP_CLAIM_WAIT_MS)
  let waiting = false
  let data: PidfileData | null
  for (;;) {
    const holder = liveClaimHolder(claimPath, claimHooks, ownClaimRecord())
    if (holder) {
      const who = holder.pid ? ` (pid ${holder.pid})` : ''
      if (Date.now() >= deadline) {
        return {
          stopped: false,
          failed: true,
          message:
            `TurboLLM is starting, or moving to a new address, for ${dir}${who}, and was not done after ` +
            `${Math.ceil((opts.claimWaitMs ?? STOP_CLAIM_WAIT_MS) / 1000)} s. Nothing was stopped: run \`turbollm --stop\` again once it is up.`,
        }
      }
      if (!waiting) opts.onWait?.(`TurboLLM is starting, or moving to a new address${who}; waiting for it to finish…`)
      waiting = true
      await new Promise<void>((r) => setTimeout(r, 250))
      continue
    }

    const stamp = pidfileStamp(dir) // see the recheck after the probe
    data = readPidfile(dir)
    if (!data) {
      return { stopped: false, failed: false, message: 'No running TurboLLM daemon found.' }
    }

    // Check if the process is actually still alive before attempting to stop it.
    if (!hooks.processExists(data.pid)) {
      removeOwnPidfile(dir, data.pid)
      return { stopped: false, failed: false, message: 'No running TurboLLM daemon found.' }
    }

    // Identity check (guards against a recycled PID): the pidfile is removed on every
    // clean-exit path, so a stale pidfile only survives a hard kill — and if the OS then
    // reassigns that PID to an unrelated process, blindly killing it would be a footgun
    // (worse on Windows, where taskkill /T also kills the child tree). Confirm a TurboLLM
    // daemon is actually answering on the recorded port before we kill the PID. If it
    // isn't, refuse and hand the user the manual command rather than risk the wrong process.
    if (await hooks.confirmTurbollm(data.port, data.host, data.pid)) break
    // A rebind that began after the check above: it takes the claim before it closes the old listener.
    if (liveClaimHolder(claimPath, claimHooks, ownClaimRecord())) continue
    // One that began and ended during the probe (took the claim, bound, wrote its new pidfile and
    // gave the claim up) leaves no claim to find: its pidfile, rewritten, names where it answers now.
    if (pidfileStamp(dir) !== stamp) continue
    const manual = hooks.platform === 'win32' ? `taskkill /PID ${data.pid} /T /F` : `kill -9 ${data.pid}`
    return {
      stopped: false,
      // Not a failure: nothing the start guard counts as a running daemon was found.
      failed: false,
      message:
        `Found a pidfile (pid ${data.pid}, port ${data.port}), but no TurboLLM daemon with that pid is responding there — ` +
        `it may be stale or the PID was reused by another process. Not killing it automatically.\n` +
        `If you're sure it's TurboLLM, stop it manually: ${manual}`,
    }
  }

  const { pid, port } = data

  let refused: string | undefined
  try {
    if (hooks.platform === 'win32') {
      // taskkill is synchronous and force-kills, so by the time it returns the
      // process should be gone (the grace window below is just in case).
      hooks.taskkill(pid)
    } else {
      // Unix: send SIGTERM and wait up to 10 s for a graceful shutdown.
      hooks.kill(pid, 'SIGTERM')
      const exited = await waitForExit(pid, 10_000, hooks)
      if (!exited) {
        // Still alive after 10 s — force kill.
        try {
          hooks.kill(pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
  } catch (e) {
    // A failure only if the daemon is still there (below). It can be gone already: it exited
    // between the /healthz probe and the SIGTERM (Ctrl+C in its terminal, a self-restart, a second
    // --stop), which kill reports as ESRCH, and taskkill /T /F exits non-zero when a process of
    // its tree had already gone ("There is no running instance of the task") although the daemon
    // is dead.
    refused = `Failed to stop daemon (pid ${pid}): ${e instanceof Error ? e.message : e}`
  }
  // taskkill /F and SIGKILL end a process at once, short of one stuck in the kernel (a hung disk
  // or network mount). Reported as stopped, with its pidfile removed and --stop exiting 0, such a
  // daemon went on holding its port and data dir with nothing left to find it by.
  if (!(await waitForExit(pid, 2_000, hooks))) {
    const how = hooks.platform === 'win32' ? 'taskkill' : 'SIGKILL'
    return { stopped: false, failed: true, message: refused ?? `TurboLLM daemon (pid ${pid}) is still running after ${how}.` }
  }

  // Only the stopped daemon's own record: it removes its pidfile as soon as shutdown starts,
  // so a daemon started while this one was still stopping can bind and write its own before
  // the poll above sees the old pid gone — deleting that would hide the new daemon from
  // --stop and from the one-daemon-per-data-dir start guard.
  removeOwnPidfile(dir, pid)
  return { stopped: true, failed: false, port, message: `TurboLLM daemon stopped (port ${port})` }
}
