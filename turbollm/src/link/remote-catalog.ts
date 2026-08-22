import { LinkClient } from './link-client'
import type { LinkRecord, RemoteModel } from './types'

/** The slice of `LinkManager` this catalog needs. Narrowed to one method so the catalog
 *  can be driven by the real manager in production and by a plain array in tests. */
export interface LinkSource {
  list(): LinkRecord[]
}

export interface RemoteModelRow {
  linkId: string
  machine: string
  model: RemoteModel
}

/** The peer's cache of what each ONLINE linked host currently has.
 *
 *  Two rules do all the work here, and both exist because the alternative is a silent
 *  wrong answer rather than a visible failure (design invariant 5):
 *
 *   1. **Never throws.** A catalog refresh talks to remote hardware on someone's flaky
 *      Wi-Fi or an expiring Kaggle tunnel. A refresh failure is a status change, not an
 *      exception — it leaves the machine with no advertised models, which routing then
 *      reports as a 503 naming the machine.
 *   2. **A link's models are gone the instant its status leaves `online`.** Not at the
 *      next poll — instantly, because every read re-checks the live `LinkRecord`. A
 *      cache that outlives the connection is precisely what would make an offline
 *      machine's model look available and get answered by something else.
 *
 *  The cache is keyed by link **id**, never by machine name, so a user renaming a link
 *  re-keys for free: `linkByName` resolves against the live record and the models come
 *  back by id. */
export class RemoteCatalog {
  /** linkId → the models that link advertised on its last successful refresh. */
  private readonly cache = new Map<string, RemoteModel[]>()
  private readonly fetchImpl: typeof fetch | undefined
  /** Live check for `daemon.experimental.turboLink` (ADR-376, link/gate.ts). A getter, not a
   *  snapshot, so the flag takes effect without a daemon restart — and because it is
   *  consulted from `isUsable`, it is re-evaluated on EVERY read, which is what makes
   *  disabling the feature drop remote models instantly rather than at the next poll. Exactly
   *  the rule a link going offline already follows.
   *
   *  REQUIRED, with no default — see the matching note on `LinkManager.isEnabled`. A gate
   *  whose absence means "fully enabled" makes a forgotten construction site silent, and a
   *  silent missed call site is the exact failure this gate exists to prevent. Required means
   *  TypeScript reports it instead. */
  private readonly isEnabled: () => boolean

  constructor(
    private readonly links: LinkSource,
    opts: { fetchImpl?: typeof fetch; isEnabled: () => boolean },
  ) {
    this.fetchImpl = opts.fetchImpl
    this.isEnabled = opts.isEnabled
  }

  /** Re-fetch every online link's model list, concurrently and in isolation. Never
   *  rejects: one hanging host must not delay or break the others, and nothing in the
   *  local request path may be broken by a remote failure. */
  async refresh(): Promise<void> {
    const usable = this.links.list().filter((l) => this.isUsable(l))
    const alive = new Set(usable.map((l) => l.id))
    // Anything no longer online (or removed outright) loses its cached models here, so
    // a later reconnection starts from a fresh fetch rather than resurrecting stale rows.
    for (const id of [...this.cache.keys()]) {
      if (!alive.has(id)) this.cache.delete(id)
    }
    await Promise.allSettled(usable.map((l) => this.refreshOne(l)))
  }

  /** Every model on every currently-online link, with the link's LIVE display name. */
  models(): RemoteModelRow[] {
    const rows: RemoteModelRow[] = []
    for (const link of this.links.list()) {
      if (!this.isUsable(link)) continue
      for (const model of this.cache.get(link.id) ?? []) {
        rows.push({ linkId: link.id, machine: link.name, model })
      }
    }
    return rows
  }

  /** The link whose display name is `machineName`, case-insensitively. Exact name only —
   *  no prefix or substring matching, which would let one machine answer for another. */
  linkByName(machineName: string): LinkRecord | undefined {
    // Gated as well as `models()`, and this is the one that makes chat fail CLOSED. It is
    // what `ModelRouter.resolveRemote` asks first, and `undefined` there means "this is not
    // a remote id at all" — so with the feature off, `rig/Qwen3-35B` falls through to
    // ordinary local resolution and ends as a plain "no such model" instead of a 503 that
    // names a machine the user can no longer reach.
    if (!this.isEnabled()) return undefined
    const wanted = machineName.trim().toLowerCase()
    if (!wanted) return undefined
    return this.links.list().find((l) => l.name.trim().toLowerCase() === wanted)
  }

  /** The model `modelKey` on link `linkId`, or undefined.
   *
   *  The match is EXACT and case-sensitive, deliberately: the local resolver is forgiving
   *  (it ends in a substring match on the model name) and that forgiveness is safe only
   *  because a wrong local guess still runs on the user's own machine with a model they
   *  can see. Guessing across a link would silently send a prompt to different weights on
   *  a different box. Returns undefined whenever the link is not currently online, so a
   *  cache entry can never outlive the connection it describes. */
  modelOn(linkId: string, modelKey: string): RemoteModel | undefined {
    const link = this.links.list().find((l) => l.id === linkId)
    if (!link || !this.isUsable(link)) return undefined
    return this.cache.get(linkId)?.find((m) => m.key === modelKey)
  }

  // ── internal ──────────────────────────────────────────────────────────────

  /** A link may advertise models only while it is online AND its token actually grants
   *  `models:use` — without that capability the host answers 403, so asking is pure noise. */
  private isUsable(link: LinkRecord): boolean {
    // The experimental gate rides on the SAME predicate as "is this link online", rather
    // than being a fourth check bolted onto each public method. That is deliberate: this one
    // function is what `models()`, `modelOn()` and `refresh()` already agree on, so gating it
    // makes remote models disappear from every downstream surface at once — `/v1/models`
    // (gateway.ts), `ModelRouter.resolveRemoteTarget`, in-app chat (chat-upstream.ts), the
    // Settings model list, and `turbollm launch claude`'s remote id resolution — with no
    // chance of one of them being missed. `refresh()` filters on it too, so a cache that was
    // warm when the flag flipped is EVICTED on the next refresh, not merely hidden.
    if (!this.isEnabled()) return false
    return link.status === 'online' && link.grantedCapabilities.includes('models:use')
  }

  private async refreshOne(link: LinkRecord): Promise<void> {
    const res = await new LinkClient(link, { fetchImpl: this.fetchImpl }).models()
    if (res.kind !== 'models') {
      // Any non-`models` outcome means "we do not know what this machine has". Empty is
      // the only honest answer; keeping the previous list would advertise models we can
      // no longer confirm.
      this.cache.delete(link.id)
      return
    }
    this.cache.set(link.id, res.models)
  }
}
