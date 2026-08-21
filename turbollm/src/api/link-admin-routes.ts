import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { generateApiKey, hostGate } from '../auth'
import type { Context } from 'hono'
import type { Deps } from '../deps'
import { applyProbeResult } from '../link/apply-probe'
import { isValidMachineName, uniqueMachineName } from '../link/machine-name'
import { LinkClient } from '../link/link-client'
import { decodeLinkString, encodeLinkString } from '../link/link-string'
import { LINK_CAPABILITIES, redactLink, type LinkCapability, type LinkRecord } from '../link/types'
import { LINK_PRESETS } from '../link/capabilities'
import { emit } from '../telemetry/runtime/typed-emit'
import { linkMinted, linkAdded, LINK_ADDED_OUTCOMES } from '../telemetry/events/link'

/** Turbo Link admin surface, on the NORMAL /api/v1 API — this is the user's own browser
 *  talking to their own daemon, so it is governed by lanAuth like everything else. The
 *  peer-facing contract is /api/link/v1 and lives in link/link-routes.ts; do not confuse
 *  the two. */
export function registerLinkAdminRoutes(
  app: Hono,
  d: Deps,
  opts?: { fetchImpl?: typeof fetch },
): void {
  const fetchImpl = opts?.fetchImpl

  /** EVERY route in this file is credential management and therefore carries the same
   *  host gate as `/api/v1/keys` (auth.ts's `hostGate`).
   *
   *  Without it, on the documented open-LAN posture (lanBind=true, requireApiKey=false)
   *  `lanAuth` lets an unauthenticated stranger through, and `POST /api/v1/links/mint`
   *  would hand them a real, permanent `ApiKey` — one that keeps working after the user
   *  later turns `requireApiKey` ON. That is exactly the self-escalation `keysHostGate`
   *  was added to stop on `POST /api/v1/keys`; this surface is a second door into the
   *  same room. `inbound` leaks every grant's shape, `GET /api/v1/links` leaks the
   *  baseUrl of every machine this box links to, and PATCH/DELETE let a stranger
   *  re-point or destroy those links. */
  function gate(c: Context, what: string) {
    if (hostGate(c, d)) return null
    return c.json(
      {
        error: {
          code: 'forbidden',
          message: `${what} from this machine until "Require an API key" is turned on.`,
        },
      },
      403,
    )
  }
  const MINT = 'Turbo Link tokens can only be minted'
  const VIEW = 'Turbo Link details are only visible'
  const MANAGE = 'Linked machines can only be managed'

  // ── Host side: mint a scoped token for another machine.
  app.post('/api/v1/links/mint', async (c) => {
    const denied = gate(c, MINT)
    if (denied) return denied
    // ── A capability grant is only a boundary if there IS a boundary (final-review I-2) ──
    // On the documented open-LAN posture (lanBind on, requireApiKey off), `bypassesAuth`
    // (auth.ts) waves LAN traffic through before any credential is examined. A peer on that
    // LAN can POST straight to this machine's PUBLIC /v1/chat/completions and reach the full
    // auto-swap path — loading and evicting models — without presenting the link token at
    // all, so `verifyKeyValue`'s grant refusal never runs and "Inference only" is a label
    // rather than a limit.
    //
    // Refused rather than warned: a token that silently means nothing is worse than one that
    // was never minted, and the remedy is one switch away.
    //
    // Checked AFTER `hostGate`, which stays the first word on credential management: an
    // unauthenticated open-LAN caller must keep getting its 403 rather than a message
    // explaining the machine's posture to a stranger. This gate is for the person who DID
    // clear that bar — the owner, at the keyboard — and it is the one that actually decides
    // the mint, since hostGate lets a local caller straight through in this posture.
    //
    // With `lanBind` off there is no open LAN to close (a tunneled request always enforces
    // regardless of requireApiKey, see bypassesAuth), so this never fires there.
    const daemon = d.store.snapshot().daemon
    if (daemon.lanBind && daemon.requireApiKey !== true) {
      return c.json(
        {
          error: {
            code: 'open_lan',
            message:
              'Turn on Settings → Network → "Require an API key" before minting a Turbo Link ' +
              'token. This machine is currently open on the local network, so any device on ' +
              'it can already use these models directly and the link limits would not be enforced.',
          },
        },
        409,
      )
    }
    const body = await c.req.json().catch(() => null) as
      { name?: string; capabilities?: string[]; models?: unknown; preset?: string } | null
    const name = body?.name?.trim()
    const caps = body?.capabilities ?? []
    if (!name) return c.json({ error: { code: 'bad_request', message: 'A name is required.' } }, 400)
    if (!Array.isArray(caps) || caps.length === 0) {
      return c.json({ error: { code: 'bad_request', message: 'Grant at least one capability.' } }, 400)
    }
    const known: readonly string[] = LINK_CAPABILITIES
    const unknown = caps.filter((x) => !known.includes(x))
    if (unknown.length) {
      // Catches 'engines:*' among everything else — engines is not in LINK_CAPABILITIES
      // by design (ADR-139), so it can never be minted even by a hand-crafted request.
      return c.json(
        { error: { code: 'bad_request', message: `Unknown capabilities: ${unknown.join(', ')}` } },
        400,
      )
    }
    // `models` MUST be validated as an array of non-empty strings, not merely truthy-
    // `.length`-checked — a bare string also has `.length`, and if one slipped through
    // into grant.models, capabilities.ts's `allowsModel` (Array.prototype.includes) would
    // never see it, but a caller who later stores a string there would silently get
    // String.prototype.includes' SUBSTRING semantics instead of exact match, widening a
    // token meant to be scoped to one model into "any model key containing this text".
    // An absent or empty array stays legal and means "every local model" (unchanged).
    const rawModels = body?.models
    let models: string[] | undefined
    if (rawModels !== undefined) {
      if (!Array.isArray(rawModels) || rawModels.some((m) => typeof m !== 'string' || m.trim() === '')) {
        return c.json(
          { error: { code: 'bad_request', message: 'models must be an array of model keys.' } },
          400,
        )
      }
      models = rawModels
    }

    const { full, hash, prefix } = generateApiKey()
    const keyId = randomUUID()
    d.store.update((cfg) => {
      cfg.apiKeys.push({
        id: keyId,
        name: `link:${name}`,
        hash,
        prefix,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        grant: {
          capabilities: caps as LinkCapability[],
          ...(models && models.length ? { models } : {}),
        },
      })
    })

    const cfg = d.store.snapshot()
    const port = (cfg.daemon as { port?: number }).port ?? 6996
    const tunnelUrl = d.tunnel?.url() ?? null
    const baseUrl = tunnelUrl ?? `http://${lanHost()}:${port}`

    // Telemetry (ADR-376 Task 11): count and preset name only — never the token, the
    // capability list itself, or baseUrl. `preset` is a hint the caller may pass for
    // reporting purposes alone; it does not affect what capabilities were actually
    // granted (`caps`, validated above), so a bogus value here can only be dropped,
    // never widen a grant. `d.telemetry` is optional (absent under tests, same
    // convention as tunnel/gate/links), so this must be a no-op when unset.
    if (d.telemetry) {
      const preset = typeof body?.preset === 'string' && Object.prototype.hasOwnProperty.call(LINK_PRESETS, body.preset)
        ? (body.preset as keyof typeof LINK_PRESETS)
        : undefined
      emit(d.telemetry, linkMinted, { capabilityCount: caps.length, ...(preset ? { preset } : {}) })
    }

    // Revealed ONCE — only the hash is stored, same rule as every other key. The raw
    // token is returned ONLY inside `linkString` (which is what the user copies): a
    // separate `token` field would be a second copy of the same one-time secret on the
    // wire, in the response body, and in whatever the browser does with it — for a
    // field no caller reads.
    return c.json({ keyId, linkString: encodeLinkString(baseUrl, full) })
  })

  // ── Host side: who is linked to me.
  app.get('/api/v1/links/inbound', (c) => {
    const denied = gate(c, VIEW)
    if (denied) return denied
    const keys = d.store.snapshot().apiKeys.filter((k) => k.grant)
    return c.json({
      inbound: keys.map((k) => ({
        id: k.id,
        name: k.name.replace(/^link:/, ''),
        capabilities: k.grant!.capabilities,
        models: k.grant!.models ?? null,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      })),
    })
  })

  // ── Peer side: list all links (settings UI's "linked machines" panel).
  app.get('/api/v1/links', (c) => {
    const denied = gate(c, VIEW)
    if (denied) return denied
    // `lastSeenAt` is overlaid from LinkManager when it holds a newer heartbeat: an
    // unchanged link's contact time deliberately stays in memory rather than triggering a
    // full config rewrite every 15 s (see link-manager.ts), so the stored value can lag.
    return c.json({
      links: (d.store.snapshot().links ?? []).map((l) => {
        const seen = d.links?.lastSeenAt(l.id)
        return seen ? { ...redactLink(l), lastSeenAt: seen } : redactLink(l)
      }),
    })
  })

  // ── Peer side: what every ONLINE linked machine currently advertises, for the chat
  //    model picker (spec §5.3). A thin read over `RemoteCatalog`, which re-checks each
  //    link's LIVE status on every call — so a machine that dropped stops contributing
  //    models immediately rather than at the next poll, and this route needs no copy of
  //    that rule. Registered before `/:id` is irrelevant (that route is PATCH/DELETE only),
  //    but it sits with the other peer-side reads for the same reason `inbound` does.
  //
  //    Same host gate as the rest of this file: the row set is a full inventory of every
  //    machine this box links to, which is exactly the disclosure `GET /api/v1/links` is
  //    gated for. Rows carry no `path` and no token — `RemoteCatalog` stores only what the
  //    host's own façade chose to advertise.
  app.get('/api/v1/links/models', (c) => {
    const denied = gate(c, VIEW)
    if (denied) return denied
    return c.json({ models: d.remoteCatalog?.models() ?? [] })
  })

  // ── Peer side: add / edit / remove a link.
  app.post('/api/v1/links', async (c) => {
    const denied = gate(c, MANAGE)
    if (denied) return denied
    const body = await c.req.json().catch(() => null) as { linkString?: string } | null
    const decoded = decodeLinkString(body?.linkString ?? '')
    if (!decoded) {
      return c.json(
        { error: { code: 'bad_request', message: 'That does not look like a TurboLLM link string.' } },
        400,
      )
    }
    const rec: LinkRecord = {
      id: randomUUID(),
      // A URL hostname cannot contain `/`, but it CAN duplicate an existing link's name
      // (two tunnels on the same domain, two boxes both called `localhost`), and a
      // duplicate name makes two links share one qualified-id namespace. Uniquified here,
      // at the one moment the seed name is assigned. See machine-name.ts.
      name: uniqueMachineName(
        new URL(decoded.baseUrl).hostname,
        (d.store.snapshot().links ?? []).map((l) => l.name),
      ),
      baseUrl: decoded.baseUrl,
      token: decoded.token,
      machineId: null,
      machineIdChanged: false,
      grantedCapabilities: [],
      linkApiVersion: null,
      status: 'unknown',
      lastSeenAt: null,
      lastError: null,
    }
    d.store.update((cfg) => { (cfg.links ??= []).push(rec) })
    // Probe once so the user gets an immediate verdict. An unreachable host is still
    // STORED — Kaggle hands back a new tunnel URL every session, so the relink flow must
    // be "edit the URL", never "delete and start over".
    await probe(rec.id)
    const stored = current(rec.id)

    // Telemetry (ADR-376 Task 11): the outcome enum only — never baseUrl, hostname, or
    // token. `nextStatus()` (link-state.ts) never leaves a just-probed link at
    // 'unknown', so `stored.status` is always one of LINK_ADDED_OUTCOMES here; the
    // includes() guard is defensive rather than expected to ever reject a real value.
    if (d.telemetry && stored && (LINK_ADDED_OUTCOMES as readonly string[]).includes(stored.status)) {
      emit(d.telemetry, linkAdded, { outcome: stored.status as (typeof LINK_ADDED_OUTCOMES)[number] })
    }

    return c.json({ link: stored ? redactLink(stored) : null })
  })

  app.patch('/api/v1/links/:id', async (c) => {
    const denied = gate(c, MANAGE)
    if (denied) return denied
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => null) as
      { baseUrl?: string; name?: string; acknowledgeMachineChange?: boolean } | null
    if (!current(id)) return c.json({ error: { code: 'not_found', message: 'No such link.' } }, 404)
    if (body?.name !== undefined) {
      // Refused, never silently rewritten: a human typed this, and quietly turning
      // `lab/rig` into `lab-rig` behind their back is worse than saying it is not allowed.
      // `/` is barred because the name becomes the machine segment of every qualified
      // `<machine>/<model>` id (machine-name.ts); a duplicate is barred because
      // `RemoteCatalog.linkByName` takes the FIRST case-insensitive match, so two links
      // sharing a name silently answer for each other.
      if (!isValidMachineName(body.name)) {
        return c.json(
          {
            error: {
              code: 'bad_request',
              message: "A machine name cannot be empty or contain '/' or '\\'.",
            },
          },
          400,
        )
      }
      const wanted = body.name.trim().toLowerCase()
      const clash = (d.store.snapshot().links ?? []).some(
        (l) => l.id !== id && l.name.trim().toLowerCase() === wanted,
      )
      if (clash) {
        return c.json(
          { error: { code: 'bad_request', message: `Another linked machine is already called '${body.name.trim()}'.` } },
          400,
        )
      }
    }
    if (body?.baseUrl) {
      try {
        const u = new URL(body.baseUrl)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme')
      } catch {
        return c.json({ error: { code: 'bad_request', message: 'Enter a valid http(s) URL.' } }, 400)
      }
    }
    d.store.update((cfg) => {
      const l = (cfg.links ?? []).find((x) => x.id === id)
      if (!l) return
      if (body?.baseUrl) l.baseUrl = body.baseUrl.replace(/\/+$/, '')
      if (body?.name) l.name = body.name.trim()
      // The ONLY way the anti-hijack latch clears: a human looked at the warning and
      // said this machine is the one they meant. No probe result ever clears it.
      if (body?.acknowledgeMachineChange) {
        l.machineIdChanged = false
        l.lastError = null
      }
    })
    await probe(id)
    const stored = current(id)
    return c.json({ link: stored ? redactLink(stored) : null })
  })

  /** Peer side: one linked host's LIVE engine/model stats (spec §5.4).
   *
   *  The last unwired half of the stats-parity claim (final-review I-5): `LinkClient.status()`
   *  and the host's `GET /api/link/v1/status` both existed and nothing called them, so
   *  nothing in the peer UI ever read a host's state. Mounted here rather than polled on the
   *  daemon's heartbeat deliberately — this is a live number with exactly one consumer (a
   *  chat pointed at that machine), so it is fetched while that view is open and not at all
   *  otherwise. Nothing in the local request path depends on it.
   *
   *  The payload is the host's own `buildModelStatus` output, handed back untranslated: any
   *  reshaping here would be exactly the divergence §5.4 forbids. It carries no host
   *  filesystem detail — `launchCommand` and `engine.error`'s log tail are structurally
   *  absent from that builder (status-view.ts).
   *
   *  A host that cannot be reached, or a token without `models:use`, is a typed 503 — never
   *  an empty-but-successful body, which would render as "the machine is idle". */
  app.get('/api/v1/links/:id/status', async (c) => {
    const denied = gate(c, VIEW)
    if (denied) return denied
    const rec = current(c.req.param('id'))
    if (!rec) return c.json({ error: { code: 'not_found', message: 'No such link.' } }, 404)
    const probe = await new LinkClient(rec, { fetchImpl }).status()
    if (probe.kind !== 'status') {
      const forbidden = probe.kind === 'http' && probe.status === 403
      return c.json(
        {
          error: {
            code: forbidden ? 'forbidden' : 'unavailable',
            message: forbidden
              ? `${rec.name} did not grant this machine permission to watch its models.`
              : `${rec.name} did not answer.`,
          },
        },
        503,
      )
    }
    return c.json({ status: probe.status })
  })

  app.delete('/api/v1/links/:id', (c) => {
    const denied = gate(c, MANAGE)
    if (denied) return denied
    const id = c.req.param('id')
    d.store.update((cfg) => { cfg.links = (cfg.links ?? []).filter((l) => l.id !== id) })
    return c.json({ ok: true })
  })

  function current(id: string): LinkRecord | undefined {
    return (d.store.snapshot().links ?? []).find((l) => l.id === id)
  }

  /** Single-link probe. Constructs its own `LinkClient` (deliberately NOT going through
   *  `LinkManager`, which is optional and absent in these tests — same optional-dep
   *  convention as tunnel/gate), but the actual record-mutation logic — including the
   *  machineId-change protection — lives in ONE place, `applyProbeResult`, shared with
   *  `LinkManager.probeOnce`, so the two call sites cannot drift again. */
  async function probe(id: string): Promise<void> {
    const rec = current(id)
    if (!rec) return
    const p = await new LinkClient(rec, { fetchImpl }).hello()
    d.store.update((cfg) => {
      const l = (cfg.links ?? []).find((x) => x.id === id)
      if (!l) return
      applyProbeResult(l, p, (cfg.links ?? []).filter((x) => x.id !== id).map((x) => x.name))
    })
  }
}

/** Best-effort LAN address for the minted link string. Falls back to a placeholder the
 *  user can edit rather than guessing wrong silently — a wrong-but-editable URL is a
 *  better failure than a confidently wrong one. */
function lanHost(): string {
  for (const iface of Object.values(networkInterfaces())) {
    for (const a of iface ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return 'localhost'
}
