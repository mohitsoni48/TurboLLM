import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { generateApiKey } from '../auth'
import type { Deps } from '../deps'
import { LinkClient } from '../link/link-client'
import { nextStatus, describeStatus } from '../link/link-state'
import { decodeLinkString, encodeLinkString } from '../link/link-string'
import { LINK_CAPABILITIES, type LinkCapability, type LinkRecord } from '../link/types'

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
      { name?: string; capabilities?: string[]; models?: string[] } | null
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
          ...(body?.models?.length ? { models: body.models } : {}),
        },
      })
    })

    const cfg = d.store.snapshot()
    const port = (cfg.daemon as { port?: number }).port ?? 6996
    const tunnelUrl = d.tunnel?.url() ?? null
    const baseUrl = tunnelUrl ?? `http://${lanHost()}:${port}`
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
    return c.json({ links: d.store.snapshot().links ?? [] })
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
    return c.json({ link: current(rec.id) })
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
    return c.json({ link: current(id) })
  })

  app.delete('/api/v1/links/:id', (c) => {
    const id = c.req.param('id')
    d.store.update((cfg) => { cfg.links = (cfg.links ?? []).filter((l) => l.id !== id) })
    return c.json({ ok: true })
  })

  function current(id: string): LinkRecord | undefined {
    return (d.store.snapshot().links ?? []).find((l) => l.id === id)
  }

  /** Single-link probe. Duplicates LinkManager.probeOnce deliberately little: the admin
   *  routes must work in tests where no LinkManager is wired (same optional-dep
   *  convention as tunnel/gate), so it goes through LinkClient directly. */
  async function probe(id: string): Promise<void> {
    const rec = current(id)
    if (!rec) return
    const p = await new LinkClient(rec, { fetchImpl }).hello()
    const status = nextStatus(rec.status, p)
    d.store.update((cfg) => {
      const l = (cfg.links ?? []).find((x) => x.id === id)
      if (!l) return
      l.status = status
      if (p.kind === 'ok') {
        l.grantedCapabilities = p.capabilities
        l.linkApiVersion = p.version
        l.machineId = p.machineId
        l.lastSeenAt = new Date().toISOString()
        l.lastError = null
        if (p.raw?.machineName) l.name = p.raw.machineName
      } else {
        l.lastError = describeStatus(status, l.name)
      }
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
