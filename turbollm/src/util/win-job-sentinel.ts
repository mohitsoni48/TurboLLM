// The daemon's side of the Windows job sentinel (win-job-sentinel.ps1, which says what it does and why). Started at
// boot as a plain, non-detached child, so it sits in libuv's own kill-on-close job and dies with the daemon. It
// holds nothing of its own: every job it makes has its only lasting handle in the daemon, so the jobs close, killing
// their trees, when the daemon dies, however it dies, and the sentinel dying alone changes nothing. It is restarted
// (up to 3 times, with a back-off), and the requests it had not answered are sent again, except an `end` or an `idle`
// it had been sent: a handle may be closed only once, and one the dead sentinel had already closed (an `end`, or an
// `idle` that found the job empty) may since have been given to the daemon for another job. Such an idle is answered
// `lost`, and that handle is never used again.
//
// Without PowerShell, with Add-Type blocked (Constrained Language Mode), a script refused by Group Policy or an EDR
// that blocks it, the daemon logs one line and goes on with libuv's job and tree kills on graceful stops.
//
// This module imports only child_process, path and url, so it stays in the Android bundle (where it never runs).
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export type AddReply = { kind: 'ok'; handle: string; members: number } | { kind: 'gone' } | { kind: 'refused'; reason: string } | { kind: 'unavailable' }
/** 'lost': the sentinel died after it was sent the idle and before it answered; the handle may be closed already. */
export type IdleReply = 'closed' | 'held' | 'lost' | 'unavailable'

/** The script, beside this module in src/util and beside cli.js in dist (package.json's build copies it there). */
export function sentinelScriptPath(): string {
  return fileURLToPath(new URL('./win-job-sentinel.ps1', import.meta.url))
}

export interface JobSentinelOptions {
  /** The program and arguments; powershell.exe running the script by default. Tests run a stand-in. */
  command?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
  /** How long the first start may take to say `ready` (PowerShell plus Add-Type's compile). */
  readyTimeoutMs?: number
  /** Back-off before each restart; its length is how many restarts are tried. */
  restartDelaysMs?: number[]
}

interface Pending {
  line: string
  resolve: (reply: string[] | null) => void
  /** Sent again, unanswered, to a restarted sentinel: an `add`. Not an `idle` (see the header). */
  resend: boolean
  /** Written to the sentinel running now. */
  sent: boolean
}

export class JobSentinel {
  private child: ChildProcess | null = null
  private state: 'starting' | 'ready' | 'restarting' | 'unavailable' | 'stopped' = 'starting'
  private nextId = 1
  /** Requests sent (or waiting for `ready`) and not yet answered, by id. */
  private pending = new Map<number, Pending>()
  private restarts = 0
  private buffer = ''
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private readonly command: string
  private readonly args: string[]
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly log: (line: string) => void
  private readonly readyTimeoutMs: number
  private readonly restartDelaysMs: number[]

  constructor(o: JobSentinelOptions = {}) {
    this.command = o.command ?? 'powershell.exe'
    this.args = o.args ?? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', sentinelScriptPath(), '-DaemonPid', String(process.pid)]
    this.env = o.env
    this.log = o.log ?? ((line) => console.warn(line))
    this.readyTimeoutMs = o.readyTimeoutMs ?? 30_000
    this.restartDelaysMs = o.restartDelaysMs ?? [1000, 3000, 9000]
  }

  /** Whether requests are answered now (a child added meanwhile waits for the answer, or for a restart). */
  available(): boolean {
    return this.state === 'ready' || this.state === 'starting' || this.state === 'restarting'
  }

  start(): this {
    this.launch()
    return this
  }

  private launch(): void {
    this.buffer = ''
    let child: ChildProcess
    try {
      child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env })
    } catch (err) {
      this.down(`it could not be started: ${(err as Error).message}`)
      return
    }
    this.child = child
    let stderr = ''
    child.stdin?.on('error', () => { /* it died: its exit is handled below */ })
    child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000) })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => this.onData(d))
    child.once('error', (err) => {
      if (this.child === child) this.down(`it could not be started: ${err.message}`)
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      if (this.state === 'stopped' || this.state === 'unavailable') return
      const why = stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).slice(-2).join(' / ')}` : ''
      if (this.state === 'starting') this.down(`it exited (${code ?? signal}) before it was ready${why}`)
      else {
        this.loseSentIdles()
        this.restart(`it exited (${code ?? signal})${why}`)
      }
    })
    if (this.state === 'starting') {
      this.readyTimer = setTimeout(() => this.down(`it was not ready within ${this.readyTimeoutMs / 1000} s`), this.readyTimeoutMs)
      this.readyTimer.unref?.()
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    for (let nl = this.buffer.indexOf('\n'); nl >= 0; nl = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line) this.onLine(line)
    }
  }

  private onLine(line: string): void {
    const f = line.split(' ')
    if (f[0] === 'ready') {
      if (this.readyTimer) clearTimeout(this.readyTimer)
      this.readyTimer = null
      this.state = 'ready'
      for (const p of this.pending.values()) {
        this.write(p.line)
        p.sent = true
      }
      return
    }
    if (f[0] === 'error' && f[1] === '0') {
      // The script's own start failed (Add-Type blocked, the daemon not openable): it exits next.
      this.down(f.slice(2).join(' ') || 'it failed to start')
      return
    }
    if (f[0] === 'error' && f[1] === 'end') {
      // An `end` has no request id: its failure names the handle, which must not be read as one (it resolved an
      // unrelated add or idle whose id had the same value).
      this.log(`[tether] windows job sentinel could not end job ${f[2] ?? '?'}: ${f.slice(3).join(' ')}`)
      return
    }
    const id = Number(f[1])
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.resolve(f)
  }

  private write(line: string): void {
    try {
      this.child?.stdin?.write(`${line}\n`)
    } catch {
      /* it died: its exit restarts it, and pending requests are sent again */
    }
  }

  private request(build: (id: number) => string, resend: boolean): Promise<string[] | null> {
    if (!this.available()) return Promise.resolve(null)
    const id = this.nextId++
    return new Promise((resolve) => {
      const p: Pending = { line: build(id), resolve, resend, sent: false }
      this.pending.set(id, p)
      if (this.state === 'ready') {
        this.write(p.line)
        p.sent = true
      }
    })
  }

  /** The sentinel died: each idle it had been sent and not answered is answered `lost` (the dead sentinel may have
   *  closed its handle), and the rest wait to be sent to the next one. */
  private loseSentIdles(): void {
    for (const [id, p] of this.pending) {
      if (p.sent && !p.resend) {
        this.pending.delete(id)
        p.resolve(['lost'])
      }
      p.sent = false
    }
  }

  /** Put `pid` (a child the daemon spawned between `startMs` and `endMs`) and what it has started in a job of its
   *  own, whose only handle ends up in the daemon. */
  async add(pid: number, startMs: number, endMs: number): Promise<AddReply> {
    const f = await this.request((id) => `add ${id} ${pid} ${startMs} ${endMs}`, true)
    if (!f) return { kind: 'unavailable' }
    if (f[0] === 'ok' && f[2] && /^\d+$/.test(f[2])) return { kind: 'ok', handle: f[2], members: Number(f[3]) || 0 }
    if (f[0] === 'gone') return { kind: 'gone' }
    return { kind: 'refused', reason: f.slice(2).join(' ') || f[0] }
  }

  /** Close the job `handle` when it has no live member ('closed'); 'held' while it has one. */
  async idle(handle: string): Promise<IdleReply> {
    const f = await this.request((id) => `idle ${id} ${handle}`, false)
    if (!f) return 'unavailable'
    return f[0] === 'closed' ? 'closed' : f[0] === 'held' ? 'held' : f[0] === 'lost' ? 'lost' : 'unavailable'
  }

  /** Kill the job `handle`'s whole tree and close the handle. Sent at most once per handle (util/tether.ts). */
  end(handle: string): boolean {
    if (this.state !== 'ready') return false
    this.write(`end ${handle}`)
    return true
  }

  /** End the sentinel (the restart keeper; tests). Its stdin ends, and it exits. */
  stop(): void {
    this.state = 'stopped'
    if (this.readyTimer) clearTimeout(this.readyTimer)
    for (const p of this.pending.values()) p.resolve(null)
    this.pending.clear()
    try {
      this.child?.stdin?.end()
    } catch {
      /* already gone */
    }
  }

  /** The sentinel's pid (tests). */
  pid(): number | undefined {
    return this.child?.pid
  }

  private restart(why: string): void {
    const delay = this.restartDelaysMs[this.restarts]
    if (delay === undefined) {
      this.down(`${why}, and it was restarted ${this.restarts} times already`)
      return
    }
    this.restarts++
    this.state = 'restarting'
    this.log(`[tether] windows job sentinel ${why}; restarting it (${this.restarts}/${this.restartDelaysMs.length}). The jobs it made are the daemon's and stay`)
    const timer = setTimeout(() => {
      if (this.state !== 'restarting') return
      this.state = 'starting'
      this.launch()
    }, delay)
    timer.unref?.()
  }

  private down(why: string): void {
    if (this.state === 'unavailable' || this.state === 'stopped') return
    const first = this.state === 'starting' && this.restarts === 0
    this.state = 'unavailable'
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    for (const p of this.pending.values()) p.resolve(null)
    this.pending.clear()
    try {
      this.child?.kill()
    } catch {
      /* already gone */
    }
    this.log(first
      ? `windows job sentinel unavailable (${why}): the children of TurboLLM's children are not tied to it; stops fall back to taskkill /T`
      : `windows job sentinel unavailable from now on (${why}): new children of TurboLLM's children are not tied to it; stops fall back to taskkill /T`)
  }
}
