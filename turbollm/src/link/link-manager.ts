import type { Deps } from '../deps'
import { applyProbeResult } from './apply-probe'
import { LinkClient } from './link-client'
import type { LinkRecord } from './types'
import { emit } from '../telemetry/runtime/typed-emit'
import { linkStatusChanged } from '../telemetry/events/link'

const DEFAULT_INTERVAL_MS = 15_000

/** Owns the peer's poll loop over every linked host.
 *
 *  Design invariant 3 (spec §4.4): a link going down must NEVER degrade local operation.
 *  Concretely, in this class that means:
 *    - links are probed CONCURRENTLY and each is isolated, so one hanging host cannot
 *      delay the others;
 *    - probeAll() never rejects — a failure is a status change, not an exception;
 *    - nothing in the local request path ever awaits this class. */
export class LinkManager {
  private timer: NodeJS.Timeout | undefined
  private readonly intervalMs: number
  private readonly fetchImpl: typeof fetch | undefined

  constructor(private readonly d: Deps, opts?: { intervalMs?: number; fetchImpl?: typeof fetch }) {
    this.intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS
    this.fetchImpl = opts?.fetchImpl
  }

  list(): LinkRecord[] {
    return this.d.store.snapshot().links ?? []
  }

  get(id: string): LinkRecord | undefined {
    return this.list().find((l) => l.id === id)
  }

  start(): void {
    if (this.timer) return
    void this.probeAll()
    this.timer = setInterval(() => void this.probeAll(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Probe every link concurrently. Resolves once all have settled; never rejects. */
  async probeAll(): Promise<void> {
    await Promise.allSettled(this.list().map((l) => this.probeOnce(l.id)))
  }

  async probeOnce(id: string): Promise<void> {
    const rec = this.get(id)
    if (!rec) return
    const fromStatus = rec.status
    const probe = await new LinkClient(rec, { fetchImpl: this.fetchImpl }).hello()

    this.d.store.update((cfg) => {
      const l = (cfg.links ?? []).find((x) => x.id === id)
      if (!l) return
      applyProbeResult(l, probe)
    })

    // Telemetry (ADR-376 Task 11): from/to status only — never baseUrl, hostname, or
    // token. Only fires on an actual transition, not on every poll tick (most polls
    // don't change anything). `d.telemetry` is optional, same convention as
    // tunnel/gate/links elsewhere on Deps, so this must be a no-op when unset.
    const toStatus = this.get(id)?.status
    if (this.d.telemetry && toStatus !== undefined && toStatus !== fromStatus) {
      emit(this.d.telemetry, linkStatusChanged, { from: fromStatus, to: toStatus })
    }
  }
}
