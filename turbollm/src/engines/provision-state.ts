// Live status of default-engine provisioning (ADR-024), surfaced via GET
// /api/v1/status so the web UI can show a download/extract progress bar.
// Single in-process holder; provisioning runs once at startup.

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
}

export class ProvisionState {
  private s: ProvisionStatus = { active: false, phase: 'idle', backend: '', pct: 0, part: 1, parts: 1, error: null }

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

  start(backend: string, trigger: ProvisionTrigger = 'user_install'): void {
    this.trigger = trigger
    this.s = { active: true, phase: 'downloading', backend, pct: 0, part: 1, parts: 1, error: null }
  }

  progress(phase: 'downloading' | 'extracting', pct: number, part = 1, parts = 1): void {
    if (!this.s.active) return
    this.s.phase = phase
    this.s.pct = pct
    this.s.part = part
    this.s.parts = parts
  }

  /** Optional observer for the terminal outcome, wired in cli.ts to the
   *  `engine_installed` event (spec 23 §4). The raw error STRING is
   *  deliberately never passed — only `failReason`, a `classifyProvisionFailure`
   *  enum member, so the only consumer still never sees free text even though
   *  it now learns *why*. */
  onSettled?: (ok: boolean, trigger: ProvisionTrigger, failReason?: ProvisionFailReason) => void

  done(): void {
    const trigger = this.trigger
    this.s = { active: false, phase: 'idle', backend: '', pct: 0, part: 1, parts: 1, error: null }
    this.settle(true, trigger)
  }

  fail(error: string): void {
    const trigger = this.trigger
    this.s = { active: false, phase: 'error', backend: this.s.backend, pct: 0, part: 1, parts: 1, error }
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
