// Which sandbox process runs a chat's Python (GitHub #52). A process is never shared between chats: variables and
// files one chat's code left behind must never be readable by another's. It stays warm between runs of the same chat
// (a cold start is 5–15 s) and closes after IDLE_MS without a run.
//
// PR 2 keeps at most one process at a time: a run in another chat closes an idle one first, and is refused while one
// is running. The pool of two on machines with 16 GB or more, and warming up while the approval bar shows, come with
// the memory watchdog (PR 4), which is what makes a second process safe to keep.
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { SandboxRuntime } from './runtime-install'
import { SandboxError, SandboxProcess, type SandboxFile, type SandboxProcessOptions, type SandboxRunResult } from './sandbox-process'

export const IDLE_MS = 10 * 60_000

export interface SandboxManagerOptions {
  runtime: Pick<SandboxRuntime, 'dir' | 'denoPath' | 'pyodideDir' | 'view'>
  idleMs?: number
  /** Tests start a stand-in process. */
  createProcess?: (opts: SandboxProcessOptions) => SandboxProcess
  /** Passed to every process (tests shorten the timeouts). */
  processOptions?: Partial<SandboxProcessOptions>
}

interface Slot {
  convId: string
  proc: SandboxProcess
  ready: Promise<void>
  idle: ReturnType<typeof setTimeout> | null
}

export class SandboxManager {
  private slot: Slot | null = null

  constructor(private readonly opts: SandboxManagerOptions) {}

  /** Runs `code` in the chat's sandbox, starting one when it has none. Stopping `signal` kills the process (a hard
   *  stop: its variables are lost; the polite stop that keeps them is PR 4). */
  async run(convId: string, code: string, files: SandboxFile[], signal?: AbortSignal): Promise<SandboxRunResult> {
    if (!this.opts.runtime.view().installed) throw new SandboxError('start_failed', 'The Python sandbox is not installed (Settings → Experimental).')
    const slot = this.slotFor(convId)
    const stop = () => slot.proc.kill(new SandboxError('crashed', 'Stopped.'))
    if (signal?.aborted) stop()
    signal?.addEventListener('abort', stop, { once: true })
    try {
      await slot.ready
      if (slot.idle) clearTimeout(slot.idle)
      slot.idle = null
      return await slot.proc.run(code, files)
    } finally {
      signal?.removeEventListener('abort', stop)
      if (slot.proc.alive) this.armIdle(slot)
    }
  }

  /** Whether a chat has a warm sandbox. */
  has(convId: string): boolean {
    return this.slot?.convId === convId && this.slot.proc.alive
  }

  /** Closes the chat's sandbox, if it has one (a reset: its variables and files are gone). */
  close(convId: string): void {
    if (this.slot?.convId === convId) this.closeSlot()
  }

  /** Closes every sandbox and waits until its process has gone: the runtime is being removed, and a running Deno
   *  holds its own binary open (Windows refuses to delete it). */
  async closeAll(): Promise<void> {
    const proc = this.slot?.proc
    this.closeSlot()
    await proc?.whenExited()
  }

  private slotFor(convId: string): Slot {
    const cur = this.slot
    if (cur?.convId === convId && cur.proc.alive) return cur
    if (cur?.proc.alive && cur.proc.busy && cur.convId !== convId) {
      throw new SandboxError('busy', 'Another chat is running Python right now. Try again when it has finished.')
    }
    this.closeSlot()
    const rt = this.opts.runtime
    const denoDir = join(rt.dir(), 'deno-dir')
    mkdirSync(denoDir, { recursive: true })
    const procOpts: SandboxProcessOptions = {
      denoPath: rt.denoPath(), pyodideDir: rt.pyodideDir(), cwd: rt.dir(), denoDir, ...this.opts.processOptions,
    }
    const proc = (this.opts.createProcess ?? ((o) => new SandboxProcess(o)))(procOpts)
    const slot: Slot = { convId, proc, ready: proc.start(), idle: null }
    slot.ready.catch(() => { /* the run awaiting it reports the failure */ })
    proc.onExit(() => {
      if (slot.idle) clearTimeout(slot.idle)
      if (this.slot === slot) this.slot = null
    })
    this.slot = slot
    return slot
  }

  private armIdle(slot: Slot): void {
    if (slot.idle) clearTimeout(slot.idle)
    slot.idle = setTimeout(() => { if (this.slot === slot) this.closeSlot() }, this.opts.idleMs ?? IDLE_MS)
    slot.idle.unref?.()
  }

  private closeSlot(): void {
    const s = this.slot
    this.slot = null
    if (!s) return
    if (s.idle) clearTimeout(s.idle)
    s.proc.kill(new SandboxError('crashed', 'The sandbox was closed.'))
  }
}
