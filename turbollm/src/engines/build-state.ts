// Live status of an in-app compile-from-source run (ADR-100), surfaced via GET
// /api/v1/status as `engineBuild` so the web UI can show a phase + a live log tail while
// `git clone` + `cmake` run. A build can take many minutes, so — unlike a download — the
// useful signal is the streaming compiler output, not a byte percentage. Single in-process
// holder; only one build runs at a time (guarded alongside the download ProvisionState).

/** Coarse build phase, in order. `provisioning` is the optional CUDA-download step (ADR-101)
 *  that runs before a build when no CUDA Toolkit is found. `done`/`error` are terminal. */
export type BuildPhase = 'provisioning' | 'preparing' | 'cloning' | 'configuring' | 'compiling' | 'registering' | 'done' | 'error'

export interface BuildStatus {
  active: boolean
  phase: BuildPhase
  /** Human label for the engine being built (e.g. "ik_llama.cpp"). */
  engine: string
  /** Tail of the most recent log lines (clone/cmake stdout+stderr), oldest→newest. */
  log: string[]
  /** Error message when `phase === 'error'`; null otherwise. */
  error: string | null
}

const LOG_TAIL = 200

export class BuildState {
  private s: BuildStatus = { active: false, phase: 'preparing', engine: '', log: [], error: null }

  get(): BuildStatus {
    return { ...this.s, log: [...this.s.log] }
  }

  /** True while a build is running — used to reject a concurrent build/download. */
  isActive(): boolean {
    return this.s.active
  }

  start(engine: string): void {
    this.s = { active: true, phase: 'preparing', engine, log: [], error: null }
  }

  phase(phase: BuildPhase): void {
    if (!this.s.active) return
    this.s.phase = phase
  }

  /** Append a log line (split multi-line chunks upstream). Keeps only the last N. */
  log(line: string): void {
    if (!this.s.active) return
    const trimmed = line.replace(/\r?\n$/, '')
    if (trimmed === '') return
    this.s.log.push(trimmed)
    if (this.s.log.length > LOG_TAIL) this.s.log.splice(0, this.s.log.length - LOG_TAIL)
  }

  /** Optional observer for the terminal outcome, wired in cli.ts to the `error`
   *  event (ADR-327) — building from source was never part of the onboarding
   *  funnel (ADR-323), so there is no funnel-step event here, only the ongoing
   *  crash signal. A plain callback so this module keeps no telemetry
   *  dependency; the error STRING is deliberately never passed, because the
   *  only consumer may never send free text. Three outcomes, not two —
   *  `cancelled` is distinct from `fail` (PR #105 review finding): a build the
   *  user deliberately aborted must not be reported as a crash. */
  onSettled?: (outcome: 'ok' | 'fail' | 'cancelled') => void

  done(): void {
    // Keep the log visible but mark inactive + terminal so the UI can show "Built".
    this.s = { ...this.s, active: false, phase: 'done', error: null }
    this.settle('ok')
  }

  fail(error: string): void {
    this.s = { ...this.s, active: false, phase: 'error', error }
    this.settle('fail')
  }

  /** A deliberate user cancellation. Same terminal UI shape as `fail()` (phase
   *  'error', so the UI still shows the run ended and why) — only the observer
   *  outcome differs. A cancel is a choice, not a failure, and must not be
   *  reported as one. */
  cancel(message: string): void {
    this.s = { ...this.s, active: false, phase: 'error', error: message }
    this.settle('cancelled')
  }

  private settle(outcome: 'ok' | 'fail' | 'cancelled'): void {
    try {
      this.onSettled?.(outcome)
    } catch {
      // Observers are advisory — they must not affect a build's outcome.
    }
  }
}
