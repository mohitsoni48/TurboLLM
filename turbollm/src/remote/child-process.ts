// Shared child-process machinery for remote-access providers that own a spawned binary
// (cloudflared quick, cloudflared named, ngrok). Lifted verbatim in behaviour from
// tunnel/manager.ts, which had exactly one provider hardcoded into it.
//
// The pidfile-with-owner orphan safety matters MORE here than it does for engines, not less:
// a leaked provider process keeps a PUBLIC URL alive pointing at a port that may be serving
// something else entirely.
import { type ChildProcess, execFile, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pidDir(dataDir: string): string {
  return join(dataDir, 'run')
}
function pidFile(dataDir: string, pid: number): string {
  return join(pidDir(dataDir), `tunnel-${pid}.pid`)
}
function writePid(dataDir: string, pid: number): void {
  try {
    mkdirSync(pidDir(dataDir), { recursive: true })
    writeFileSync(pidFile(dataDir, pid), JSON.stringify({ pid, owner: process.pid }))
  } catch {
    /* best-effort — tracking is a safety net, never block a start on it */
  }
}
function clearPid(dataDir: string, pid: number): void {
  try {
    rmSync(pidFile(dataDir, pid), { force: true })
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
function readPidFiles(dataDir: string): Array<{ pid: number; owner: number; file: string }> {
  let names: string[]
  try {
    names = readdirSync(pidDir(dataDir)).filter((n) => /^tunnel-\d+\.pid$/.test(n))
  } catch {
    return []
  }
  const out: Array<{ pid: number; owner: number; file: string }> = []
  for (const name of names) {
    const file = join(pidDir(dataDir), name)
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

/** Reap provider processes left behind by a previous daemon that didn't shut down cleanly.
 *  Called once at startup alongside reapStaleEngines. An orphan is one whose owner daemon
 *  is gone. Returns the number reaped. Kills by exact PID only, never by name. */
export function reapStaleTunnels(dataDir: string): number {
  let killed = 0
  for (const { pid, owner, file } of readPidFiles(dataDir)) {
    if (owner && pidAlive(owner)) continue
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

/** Synchronous best-effort kill of provider processes THIS daemon owns, for a process 'exit'
 *  handler (which can't await). Owner-scoped so a daemon exiting during a restart overlap
 *  never kills the incoming daemon's provider. */
export function killTrackedTunnelsSync(dataDir: string): void {
  for (const { pid, owner, file } of readPidFiles(dataDir)) {
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

/** One spawned provider binary: start it, pull the public URL out of its output, and tear it
 *  down cleanly (or force-kill a stuck one). */
export class ChildTunnel {
  private child: ChildProcess | null = null
  private exited: Promise<void> = Promise.resolve()
  private exitCb: ((code: number | null) => void) | undefined

  constructor(private dataDir: string) {}

  alive(): boolean {
    return this.child !== null
  }

  /** Called when the child exits for ANY reason. The supervisor uses this to distinguish an
   *  unexpected death (restart with backoff) from a stop() it asked for. */
  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb
  }

  /** Spawn and resolve with the first substring matching `urlPattern` in the child's combined
   *  stdout+stderr. cloudflared logs everything to stderr (verified in ADR-153) and ngrok's
   *  useful line is on stdout, so both streams feed one buffer rather than guessing. */
  async spawnAndWait(binPath: string, args: string[], urlPattern: RegExp, timeoutMs = 30_000): Promise<string> {
    await this.stop()
    return new Promise<string>((resolve, reject) => {
      const child = spawn(binPath, args, { windowsHide: true })
      this.child = child
      writePid(this.dataDir, child.pid ?? 0)

      let settled = false
      let buf = ''
      const onData = (chunk: Buffer) => {
        if (settled) return
        buf += chunk.toString()
        const m = urlPattern.exec(buf)
        if (!m) return
        settled = true
        child.stderr?.off('data', onData)
        child.stdout?.off('data', onData)
        resolve(m[0])
      }
      child.stderr?.on('data', onData)
      child.stdout?.on('data', onData)

      this.exited = new Promise((res) => {
        child.on('exit', (code) => {
          if (this.child === child) this.child = null
          clearPid(this.dataDir, child.pid ?? 0)
          if (!settled) {
            settled = true
            reject(new Error(`provider exited before a URL appeared (code ${code})`))
          }
          this.exitCb?.(code)
          res()
        })
      })

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        this.forceKill(child)
        reject(new Error('timed out waiting for the provider to report a public URL'))
      }, timeoutMs)
      timeout.unref()
      void this.exited.then(() => clearTimeout(timeout))
    })
  }

  /** Graceful stop with a force-kill fallback. No-op if nothing is running. Clears the exit
   *  callback FIRST so a deliberate stop never looks like an unexpected death. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.exitCb = undefined
    this.child = null
    if (child.pid) {
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T'], () => {})
      else child.kill('SIGTERM')
    }
    const result = await Promise.race([
      this.exited.then(() => 'exited' as const),
      sleep(8000).then(() => 'timeout' as const),
    ])
    if (result === 'timeout') this.forceKill(child)
    clearPid(this.dataDir, child.pid ?? 0)
  }

  private forceKill(child: ChildProcess): void {
    if (!child.pid) return
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/F', '/T'], () => {})
    else child.kill('SIGKILL')
  }
}
