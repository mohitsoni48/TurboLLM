// Live status of default-engine provisioning (ADR-024), surfaced via GET
// /api/v1/status so the web UI can show a download/extract progress bar.
// Single in-process holder; provisioning runs once at startup.

import { classifyProvisionFailure } from '../telemetry/classify'
import type { PROVISION_FAIL_REASONS } from '../telemetry/core/enums'

type ProvisionFailReason = (typeof PROVISION_FAIL_REASONS)[number]

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

  start(backend: string): void {
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
  onSettled?: (ok: boolean, failReason?: ProvisionFailReason) => void

  done(): void {
    this.s = { active: false, phase: 'idle', backend: '', pct: 0, part: 1, parts: 1, error: null }
    this.settle(true)
  }

  fail(error: string): void {
    this.s = { active: false, phase: 'error', backend: this.s.backend, pct: 0, part: 1, parts: 1, error }
    this.settle(false, classifyProvisionFailure(error))
  }

  private settle(ok: boolean, failReason?: ProvisionFailReason): void {
    try {
      this.onSettled?.(ok, failReason)
    } catch {
      // Observers are advisory — they must not affect an engine install.
    }
  }
}
