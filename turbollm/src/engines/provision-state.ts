// Live status of default-engine provisioning (ADR-024), surfaced via GET
// /api/v1/status so the web UI can show a download/extract progress bar.
// Single in-process holder; provisioning runs once at startup.

import { emitInvalidation } from '../events/bus'
import { classifyProvisionFailure } from '../telemetry/classify'
import type { PROVISION_FAIL_REASONS, PROVISION_TRIGGERS } from '../telemetry/core/enums'

type ProvisionFailReason = (typeof PROVISION_FAIL_REASONS)[number]
export type ProvisionTrigger = (typeof PROVISION_TRIGGERS)[number]

export interface ProvisionStatus {
  active: boolean
  phase: 'idle' | 'downloading' | 'extracting' | 'error'
  backend: string
  pct: number // 0..1 while downloading; -1 = indeterminate (extracting)
  part: number // 1-based current archive (multi-asset backends like CUDA)
  parts: number // total archives for this backend
  error: string | null
  /** When this run began (epoch ms), kept on its failure; 0 when idle. It identifies the run: the web banner keys a
   *  dismissed failure to it, since a retry can fail the same way between two of its 2 s status polls, which then
   *  never see it running. */
  startedAt: number
}

/** The keys a run's start and end stand for: the status bar, and the engine list a finished install changes. */
const SETTLED_KEYS = ['status', 'engines'] as const

/** How finely download progress is announced: once per tenth, not per chunk. */
const PROGRESS_STEPS = 10

export class ProvisionState {
  private s: ProvisionStatus = { active: false, phase: 'idle', backend: '', pct: 0, part: 1, parts: 1, error: null, startedAt: 0 }

  /** @param announce Where changes are announced; the daemon's invalidation bus by default. */
  constructor(private readonly announce: (key: string) => void = emitInvalidation) {}

  get(): ProvisionStatus {
    return { ...this.s }
  }

  /** What caused this provisioning run. Carried through to `engine_installed`
   *  because, until the 2026-08-21 data-integrity audit, that one event name
   *  covered four unrelated things — the unattended boot-time seed, a user
   *  clicking Install, a user clicking Update, and the MLX/vLLM runtime
   *  installers — with no way to tell them apart. 761 events over 322 machines
   *  read as "2.4 engine installs per user", when most of them were the seed
   *  running on its own, which made "installed an engine" look like a milestone
   *  a user had reached when frequently nobody had done anything. */
  private trigger: ProvisionTrigger = 'seed'

  private starts = 0

  /** How many runs have begun. A caller compares it before and after an async
   *  operation to learn whether that operation ever reached `start`. */
  startCount(): number {
    return this.starts
  }

  start(backend: string, trigger: ProvisionTrigger = 'user_install'): void {
    this.starts++
    this.trigger = trigger
    this.s = { active: true, phase: 'downloading', backend, pct: 0, part: 1, parts: 1, error: null, startedAt: Date.now() }
    this.announceSettled()
  }

  progress(phase: 'downloading' | 'extracting', pct: number, part = 1, parts = 1): void {
    if (!this.s.active) return
    const milestone = this.isMilestone(phase, pct, part)
    this.s.phase = phase
    this.s.pct = pct
    this.s.part = part
    this.s.parts = parts
    if (milestone) this.announce('status')
  }

  /** A new phase, a new archive, or the download into another tenth. */
  private isMilestone(phase: ProvisionStatus['phase'], pct: number, part: number): boolean {
    const step = (p: number) => Math.floor(p * PROGRESS_STEPS)
    return phase !== this.s.phase || part !== this.s.part || step(pct) !== step(this.s.pct)
  }

  private announceSettled(): void {
    SETTLED_KEYS.forEach((key) => this.announce(key))
  }

  /** Optional observer for the terminal outcome, wired in cli.ts to the
   *  `engine_installed` event (spec 23 §4). The raw error STRING is
   *  deliberately never passed — only `failReason`, a `classifyProvisionFailure`
   *  enum member, so the only consumer still never sees free text even though
   *  it now learns *why*. */
  onSettled?: (ok: boolean, trigger: ProvisionTrigger, failReason?: ProvisionFailReason) => void

  done(): void {
    const trigger = this.trigger
    this.s = { active: false, phase: 'idle', backend: '', pct: 0, part: 1, parts: 1, error: null, startedAt: 0 }
    this.announceSettled()
    this.settle(true, trigger)
  }

  fail(error: string): void {
    const trigger = this.trigger
    this.s = { active: false, phase: 'error', backend: this.s.backend, pct: 0, part: 1, parts: 1, error, startedAt: this.s.startedAt }
    this.announceSettled()
    this.settle(false, trigger, classifyProvisionFailure(error))
  }

  private settle(ok: boolean, trigger: ProvisionTrigger, failReason?: ProvisionFailReason): void {
    try {
      this.onSettled?.(ok, trigger, failReason)
    } catch {
      // Observers are advisory — they must not affect an engine install.
    }
  }
}
