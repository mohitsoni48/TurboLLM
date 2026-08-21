import type { Deps } from '../deps'
import { applyProbeResult } from './apply-probe'
import { LinkClient } from './link-client'
import type { LinkRecord } from './types'
import { emit } from '../telemetry/runtime/typed-emit'
import { linkStatusChanged } from '../telemetry/events/link'

const DEFAULT_INTERVAL_MS = 15_000

/** Did this probe change anything worth a `config.json` rewrite? Every field of
 *  `LinkRecord` EXCEPT `lastSeenAt` — which is a heartbeat, not state — plus the fields
 *  only a user edits (`name`, `baseUrl`), because `applyProbeResult` can rename a link on
 *  its first handshake. */
function durableChange(before: LinkRecord, after: LinkRecord): boolean {
  return (
    before.status !== after.status ||
    before.machineId !== after.machineId ||
    (before.machineIdChanged ?? false) !== (after.machineIdChanged ?? false) ||
    before.linkApiVersion !== after.linkApiVersion ||
    before.lastError !== after.lastError ||
    before.name !== after.name ||
    before.baseUrl !== after.baseUrl ||
    before.grantedCapabilities.length !== after.grantedCapabilities.length ||
    before.grantedCapabilities.some((cap, i) => cap !== after.grantedCapabilities[i])
  )
}

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
  /** In-memory heartbeat: the `lastSeenAt` of a probe that changed NOTHING else.
   *  See `probeOnce` for why it does not go to disk. */
  private readonly heartbeats = new Map<string, string>()
  private readonly intervalMs: number
  private readonly fetchImpl: typeof fetch | undefined
  /** The peer's remote-model cache, refreshed on the back of this same poll loop (ADR-376).
   *  Structural, not a `RemoteCatalog` import, so this class keeps no dependency on routing.
   *  Optional: every pre-Turbo-Link construction site (and every test) works without one. */
  private readonly catalog: { refresh(): Promise<void> } | undefined

  constructor(
    private readonly d: Deps,
    opts?: { intervalMs?: number; fetchImpl?: typeof fetch; catalog?: { refresh(): Promise<void> } },
  ) {
    this.intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS
    this.fetchImpl = opts?.fetchImpl
    this.catalog = opts?.catalog
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
    // AFTER the probes, never before: the catalog drops the models of anything not `online`,
    // so refreshing on stale statuses is what would leave an offline machine's model looking
    // available. `RemoteCatalog.refresh` never rejects by contract; the guard is here anyway
    // because probeAll's own "never rejects" promise is what the poll timer relies on.
    await this.catalog?.refresh().catch(() => {})
  }

  /** Freshest known contact time for a link — the persisted value, or a newer in-memory
   *  heartbeat from a poll that was not worth a disk write. */
  lastSeenAt(id: string): string | null {
    return this.heartbeats.get(id) ?? this.get(id)?.lastSeenAt ?? null
  }

  async probeOnce(id: string): Promise<void> {
    const rec = this.get(id)
    if (!rec) return
    const fromStatus = rec.status
    const probe = await new LinkClient(rec, { fetchImpl: this.fetchImpl }).hello()

    // Persist ONLY when the probe actually changed something durable.
    //
    // `ConfigStore.update` has no dirty check: it structuredClones the whole config,
    // validates it, then writeFileSync + renameSync the entire file — synchronously, on
    // the thread that also serves inference. `applyProbeResult` stamps a fresh
    // `lastSeenAt` on every successful probe, so an unconditional update meant one full
    // config rewrite per link per 15 s tick, forever: ~5.8k/day with one link, ~17k with
    // three, none of them carrying new information. Phase 2 routes every inference
    // request and every progress poll through this same path, so the answer has to be
    // "only durable state goes to disk", not "it is only 15 seconds".
    //
    // The decision is made by running the SAME `applyProbeResult` against a copy — never
    // a second, hand-written notion of what a probe changes, which is exactly the drift
    // Ruling 7 closed.
    const next: LinkRecord = { ...rec, grantedCapabilities: [...rec.grantedCapabilities] }
    applyProbeResult(next, probe)
    if (durableChange(rec, next)) {
      this.heartbeats.delete(id)
      this.d.store.update((cfg) => {
        const l = (cfg.links ?? []).find((x) => x.id === id)
        if (!l) return
        applyProbeResult(l, probe)
      })
    } else if (next.lastSeenAt && next.lastSeenAt !== rec.lastSeenAt) {
      // Nothing but the heartbeat moved — keep it in memory (see `lastSeenAt`).
      this.heartbeats.set(id, next.lastSeenAt)
    }

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
