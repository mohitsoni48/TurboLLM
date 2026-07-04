// Tunnel process manager (Cloud Launch, ADR-045/152): spawns cloudflared pointed at
// the daemon's own local port, parses the assigned public URL out of its stderr
// (verified empirically against a real cloudflared run: it logs everything to
// stderr, nothing to stdout), and tracks it with the same pidfile-owner pattern
// engines/manager.ts uses for orphan safety — a leaked cloudflared process is worse
// than a leaked engine here, since it keeps a PUBLIC URL alive pointing at a port
// nothing may be serving anymore.
import { type ChildProcess, execFile, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureCloudflared } from './provision'

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function signalTerm(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T'], () => {})
  else child.kill('SIGTERM')
}

function forceKill(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/F', '/T'], () => {})
  else child.kill('SIGKILL')
}

// ── Orphan-safety pidfile (mirrors engines/manager.ts's engine-<pid>.pid pattern) ──
// Simpler than the engine version: no portAlive cross-check before killing a
// suspected orphan. The engine check exists because a recycled pid holding a
// meaningful serving port is worth confirming; a stray non-cloudflared process
// recycling this exact pid within the same boot is unlikely enough that the
// simpler owner-only check is the right amount of caution here.

function tunnelPidDir(dataDir: string): string {
  return join(dataDir, 'run')
}
function tunnelPidFile(dataDir: string, pid: number): string {
  return join(tunnelPidDir(dataDir), `tunnel-${pid}.pid`)
}
function writeTunnelPid(dataDir: string, pid: number): void {
  try {
    mkdirSync(tunnelPidDir(dataDir), { recursive: true })
    writeFileSync(tunnelPidFile(dataDir, pid), JSON.stringify({ pid, owner: process.pid }))
  } catch {
    /* best-effort — tracking is a safety net, never block a start on it */
  }
}
function clearTunnelPid(dataDir: string, pid: number): void {
  try {
    rmSync(tunnelPidFile(dataDir, pid), { force: true })
  } catch {
    /* best-effort */
  }
}
function pidAlive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
function readTunnelPidFiles(dataDir: string): Array<{ pid: number; owner: number; file: string }> {
  const dir = tunnelPidDir(dataDir)
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => /^tunnel-\d+\.pid$/.test(n))
  } catch {
    return [] // no run dir yet
  }
  const out: Array<{ pid: number; owner: number; file: string }> = []
  for (const name of names) {
    const file = join(dir, name)
    try {
      const { pid, owner } = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; owner?: number }
      if (typeof pid === 'number' && pid > 0) out.push({ pid, owner: typeof owner === 'number' ? owner : 0, file })
      else rmSync(file, { force: true })
    } catch {
      try {
        rmSync(file, { force: true })
      } catch {
        /* best-effort */
      }
    }
  }
  return out
}

/** Reap cloudflared processes left behind by a previous daemon that didn't shut down
 *  cleanly. Called once at startup, alongside reapStaleEngines. An orphan is one whose
 *  owner daemon is gone. Returns the number reaped. */
export function reapStaleTunnels(dataDir: string): number {
  let killed = 0
  for (const { pid, owner, file } of readTunnelPidFiles(dataDir)) {
    if (owner && pidAlive(owner)) continue // still managed by a live daemon
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'])
      else process.kill(pid, 'SIGKILL')
      killed++
    } catch {
      /* already gone */
    }
    try {
      rmSync(file, { force: true })
    } catch {
      /* best-effort */
    }
  }
  return killed
}

/** Synchronous best-effort kill of tunnels THIS daemon owns, for a process 'exit'
 *  handler (which can't await). Mirrors killTrackedEnginesSync. Owner-scoped so a
 *  daemon exiting during a restart overlap never kills the incoming daemon's tunnel. */
export function killTrackedTunnelsSync(dataDir: string): void {
  for (const { pid, owner, file } of readTunnelPidFiles(dataDir)) {
    if (owner !== process.pid) continue
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'])
      else process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    try {
      rmSync(file, { force: true })
    } catch {
      /* best-effort */
    }
  }
}

export interface TunnelSnapshot {
  active: boolean
  url: string | null
  error: string | null
}

/** Owns the cloudflared child process for the lifetime it's needed: spawn, parse the
 *  assigned public URL from stderr, and tear down cleanly (or force-kill a stuck
 *  process) on shutdown/rebind/restart. One instance per daemon process. */
export class TunnelManager {
  private child: ChildProcess | null = null
  private _url: string | null = null
  private _error: string | null = null
  private exited: Promise<void> = Promise.resolve()

  constructor(private dataDir: string) {}

  active(): boolean {
    return this.child !== null
  }
  url(): string | null {
    return this._url
  }
  snapshot(): TunnelSnapshot {
    return { active: this.active(), url: this._url, error: this._error }
  }

  /** Start cloudflared pointed at the given local port. Resolves once the public URL
   *  is parsed out of its output, or rejects if it exits first (bad binary, network
   *  failure) or 30s elapses without a URL appearing. Idempotent: replaces any prior
   *  tunnel first, so it's safe to call again on a rebind/restart (new port). */
  async start(localPort: number): Promise<string> {
    await this.shutdown()
    this._error = null
    const { binPath } = await ensureCloudflared(this.dataDir)

    return new Promise((resolve, reject) => {
      const child = spawn(binPath, ['tunnel', '--url', `http://127.0.0.1:${localPort}`], { windowsHide: true })
      this.child = child
      writeTunnelPid(this.dataDir, child.pid ?? 0)

      let settled = false
      let buf = ''
      const onData = (chunk: Buffer) => {
        if (settled) return
        buf += chunk.toString()
        const m = URL_RE.exec(buf)
        if (m) {
          settled = true
          this._url = m[0]
          child.stderr?.off('data', onData)
          child.stdout?.off('data', onData)
          resolve(m[0])
        }
      }
      // cloudflared logs to stderr today (verified); also listen on stdout in case a
      // future version changes that — harmless either way since both feed the same buffer.
      child.stderr?.on('data', onData)
      child.stdout?.on('data', onData)

      this.exited = new Promise((res) => {
        child.on('exit', (code) => {
          if (this.child === child) this.child = null
          clearTunnelPid(this.dataDir, child.pid ?? 0)
          if (!settled) {
            settled = true
            this._error = `cloudflared exited before a tunnel URL appeared (code ${code})`
            reject(new Error(this._error))
          }
          res()
        })
      })

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        this._error = 'timed out waiting for cloudflared to report a tunnel URL'
        forceKill(child)
        reject(new Error(this._error))
      }, 30_000)
      timeout.unref()
      void this.exited.then(() => clearTimeout(timeout))
    })
  }

  /** Graceful stop with a force-kill fallback, mirroring engines/manager.ts's
   *  gracefulStop. No-op if no tunnel is running. */
  async shutdown(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = null
    this._url = null
    signalTerm(child)
    const forced = sleep(8000).then(() => 'timeout' as const)
    const result = await Promise.race([this.exited.then(() => 'exited' as const), forced])
    if (result === 'timeout') forceKill(child)
    clearTunnelPid(this.dataDir, child.pid ?? 0)
  }
}
