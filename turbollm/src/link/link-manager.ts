import type { Deps } from '../deps'
import { LinkClient } from './link-client'
import { describeStatus, nextStatus } from './link-state'
import type { LinkRecord } from './types'

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
    const probe = await new LinkClient(rec, { fetchImpl: this.fetchImpl }).hello()
    const status = nextStatus(rec.status, probe)

    this.d.store.update((cfg) => {
      const l = (cfg.links ?? []).find((x) => x.id === id)
      if (!l) return
      l.status = status
      if (probe.kind === 'ok') {
        l.grantedCapabilities = probe.capabilities
        l.linkApiVersion = probe.version
        l.lastSeenAt = new Date().toISOString()
        // A changed machineId means this URL now serves a DIFFERENT box. Flag it loudly
        // rather than silently adopting it — a reused tunnel hostname must not let a
        // stranger's daemon inherit a link the user believes is their workstation.
        l.lastError = l.machineId && l.machineId !== probe.machineId
          ? `This URL now answers as a different machine than the one you linked.`
          : null
        l.machineId = probe.machineId
      } else {
        l.lastError = describeStatus(status, l.name)
      }
    })
  }
}
