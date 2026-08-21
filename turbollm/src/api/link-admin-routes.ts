import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { generateApiKey } from '../auth'
import type { Deps } from '../deps'
import { applyProbeResult } from '../link/apply-probe'
import { LinkClient } from '../link/link-client'
import { decodeLinkString, encodeLinkString } from '../link/link-string'
import { LINK_CAPABILITIES, redactLink, type LinkCapability, type LinkRecord } from '../link/types'
import { emit } from '../telemetry/runtime/typed-emit'
import { linkMinted, linkAdded, LINK_PRESETS, LINK_ADDED_OUTCOMES } from '../telemetry/events/link'

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

  // ── Host side: mint a scoped token for another machine.
  app.post('/api/v1/links/mint', async (c) => {
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
      const preset = typeof body?.preset === 'string' && (LINK_PRESETS as readonly string[]).includes(body.preset)
        ? (body.preset as (typeof LINK_PRESETS)[number])
        : undefined
      emit(d.telemetry, linkMinted, { capabilityCount: caps.length, ...(preset ? { preset } : {}) })
    }

    // Revealed ONCE — only the hash is stored, same rule as every other key.
    return c.json({ keyId, token: full, linkString: encodeLinkString(baseUrl, full) })
  })

  // ── Host side: who is linked to me.
  app.get('/api/v1/links/inbound', (c) => {
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
    return c.json({ links: (d.store.snapshot().links ?? []).map(redactLink) })
  })

  // ── Peer side: add / edit / remove a link.
  app.post('/api/v1/links', async (c) => {
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
      name: new URL(decoded.baseUrl).hostname,
      baseUrl: decoded.baseUrl,
      token: decoded.token,
      machineId: null,
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
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => null) as { baseUrl?: string; name?: string } | null
    if (!current(id)) return c.json({ error: { code: 'not_found', message: 'No such link.' } }, 404)
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
      if (body?.name) l.name = body.name
    })
    await probe(id)
    const stored = current(id)
    return c.json({ link: stored ? redactLink(stored) : null })
  })

  app.delete('/api/v1/links/:id', (c) => {
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
      applyProbeResult(l, p)
      if (p.kind === 'ok' && p.raw?.machineName) l.name = p.raw.machineName
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
