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
import { LINK_CAPABILITIES, redactDownload, redactLink, type LinkCapability, type LinkRecord } from '../link/types'
import { describeStatus, type LinkProbe } from '../link/link-state'
import { LINK_PRESETS } from '../link/capabilities'
import { scrubRemoteConfig } from '../link/config-scope'
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

  /** ── Peer side: fleet control over one linked host (spec §5.3, §5.7) ─────────────────
   *
   *  WHY THESE EXIST AT ALL: the browser cannot talk to a host's `/api/link/v1` façade
   *  itself, because `redactLink` strips `token` from every `LinkRecord` it ever sees
   *  (design invariant 7 — the peer must never leak the link token to its own clients).
   *  So the proxy hop happens here, in the peer daemon, which is the only thing holding
   *  the credential. Tasks 1–3 shipped the host half and `LinkClient`'s methods; these
   *  five routes are their first and only callers.
   *
   *  Every one of them is THIN on purpose: gate, resolve the link, call the existing
   *  `LinkClient` method, map the result. Nothing here re-derives a load, a queue, or a
   *  validation rule the host already owns — the host holds the grant, the model list and
   *  the download allowlist, and a second copy on this side would drift from it.
   *
   *  Same host gate as every other route in this file. These act on ANOTHER machine using
   *  a stored credential, so an unauthenticated open-LAN caller reaching them would be
   *  strictly worse than reaching `GET /api/v1/links`: not disclosure but remote control. */
  app.post('/api/v1/links/:id/load', async (c) => {
    const denied = gate(c, MANAGE)
    if (denied) return denied
    const rec = current(c.req.param('id'))
    if (!rec) return noSuchLink(c)
    const body = await c.req.json().catch(() => ({})) as { modelKey?: unknown }
    const modelKey = typeof body.modelKey === 'string' ? body.modelKey.trim() : ''
    // Required here as well as on the host: `startEngine` reads an empty request as
    // "re-load lastLoaded", and a click that silently loads a DIFFERENT model than the one
    // on screen is the worst possible outcome of a missing field.
    if (!modelKey) {
      return c.json({ error: { code: 'invalid_input', message: 'modelKey is required.' } }, 400)
    }
    const out = await new LinkClient(rec, { fetchImpl }).load(modelKey)
    // 202, matching the host: the load is QUEUED, not finished. The UI learns the outcome
    // from its normal `/status` polling, exactly as it does for a local load.
    return out.kind === 'accepted' ? c.json({ ok: true }, 202) : remoteFailure(c, rec, out)
  })

  app.post('/api/v1/links/:id/unload', async (c) => {
    const denied = gate(c, MANAGE)
    if (denied) return denied
    const rec = current(c.req.param('id'))
    if (!rec) return noSuchLink(c)
    const out = await new LinkClient(rec, { fetchImpl }).unload()
    return out.kind === 'accepted' ? c.json({ ok: true }, 202) : remoteFailure(c, rec, out)
  })

  /** `downloads:read` missing is a NAMED 403 from the host, and it stays one here — never
   *  an empty 200. An empty queue and an unreadable queue look identical on screen and
   *  send the user debugging the wrong machine. */
  app.get('/api/v1/links/:id/downloads', async (c) => {
    const denied = gate(c, VIEW)
    if (denied) return denied
    const rec = current(c.req.param('id'))
    if (!rec) return noSuchLink(c)
    const out = await new LinkClient(rec, { fetchImpl }).downloads()
    if (out.kind !== 'downloads') return remoteFailure(c, rec, out)
    // `redactDownload` a SECOND time, on this side of the wire. The host already applies it
    // (link-routes.ts), so this is pure defence in depth and idempotent — but the host is a
    // separate install on a separate release cadence, and an older or hostile one can still
    // put an absolute path in `name` or a raw `ENOENT … open 'C:\…\x.gguf.part'` in `error`.
    // Four host-filesystem leaks have been found in this feature already; the peer does not
    // get to assume the far end is current.
    return c.json({ downloads: out.downloads.map(redactDownload) })
  })

  /** Start a download on the host. `repo`/`rfilename` are checked only for PRESENCE here —
   *  the host owns the real validation (`HF_REPO_ID`, `isSafeRepoFile`) because it owns the
   *  filesystem those values resolve against, and a second copy of those rules on this side
   *  would be the drift-prone half of the pair. `url` and `subdir` are not accepted at all:
   *  `LinkClient.startDownload` cannot send them and the host drops them. */
  app.post('/api/v1/links/:id/downloads', async (c) => {
    const denied = gate(c, MANAGE)
    if (denied) return denied
    const rec = current(c.req.param('id'))
    if (!rec) return noSuchLink(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
    const rfilename = typeof body.rfilename === 'string' ? body.rfilename.trim() : ''
    if (!repo || !rfilename) {
      return c.json(
        { error: { code: 'invalid_input', message: 'repo and rfilename are required.' } },
        400,
      )
    }
    const out = await new LinkClient(rec, { fetchImpl }).startDownload(repo, rfilename, {
      ...(typeof body.size === 'number' && Number.isFinite(body.size) && body.size >= 0
        ? { size: body.size }
        : {}),
      ...(typeof body.sha256 === 'string' ? { sha256: body.sha256 } : {}),
    })
    return out.kind === 'accepted' ? c.json({ ok: true }, 202) : remoteFailure(c, rec, out)
  })

  app.delete('/api/v1/links/:id/downloads/:downloadId', async (c) => {
    const denied = gate(c, MANAGE)
    if (denied) return denied
    const rec = current(c.req.param('id'))
    if (!rec) return noSuchLink(c)
    const out = await new LinkClient(rec, { fetchImpl }).cancelDownload(c.req.param('downloadId'))
    return out.kind === 'accepted' ? c.json({ ok: true }) : remoteFailure(c, rec, out)
  })

  /** The host's peer-visible settings (spec §5.8, `config:read`).
   *
   *  Sixth route of the same shape as its five neighbours above and gated the same way —
   *  it exists because `config:read`/`config:write` were the one pair of capabilities the
   *  mint UI could grant with NOTHING in the product able to exercise them: the host façade
   *  and `LinkClient.config()`/`writeConfig()` shipped, the peer hop did not. A grant the
   *  user was told they were giving and cannot use is worse than one that was never
   *  offered.
   *
   *  The body is projected AGAIN on this side, through the same allowlist the host used
   *  (`scrubRemoteConfig`). Identical reasoning to the second `redactDownload` on
   *  `GET :id/downloads`: the host is a separate install on a separate release cadence, and
   *  this is precisely where a fifth host-filesystem leak would arrive. */
  app.get('/api/v1/links/:id/config', async (c) => {
    const denied = gate(c, VIEW)
    if (denied) return denied
    const rec = current(c.req.param('id'))
    if (!rec) return noSuchLink(c)
    const out = await new LinkClient(rec, { fetchImpl }).config()
    if (out.kind !== 'config') return remoteFailure(c, rec, out)
    return c.json({ config: scrubRemoteConfig(out.config) })
  })

  /** Write a scoped setting on the host (`config:write`). Body: `{ patch: { '<dotted.path>':
   *  value } }`, exactly the façade's own shape.
   *
   *  The host owns the allowlist and the bounds — a second copy of `WRITABLE_CONFIG_PATHS`
   *  on this side would be the drift-prone half of a pair, and the host must refuse an
   *  out-of-scope path anyway. So this checks only that a patch is a non-empty object, and
   *  a rejected path comes back as the host's own 403 through `remoteFailure`.
   *
   *  200, not 202: unlike load/unload the write is DONE when the host answers. Nothing of
   *  the host's echo is returned — the peer asks `GET :id/config` for the new values, which
   *  keeps one projection on the read path rather than two. */
  app.patch('/api/v1/links/:id/config', async (c) => {
    const denied = gate(c, MANAGE)
    if (denied) return denied
    const rec = current(c.req.param('id'))
    if (!rec) return noSuchLink(c)
    const body = await c.req.json().catch(() => ({})) as { patch?: unknown }
    const patch = body.patch
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)
      || Object.keys(patch).length === 0) {
      return c.json(
        {
          error: {
            code: 'invalid_input',
            message: "Body must be { patch: { '<config.path>': value } }.",
          },
        },
        400,
      )
    }
    const out = await new LinkClient(rec, { fetchImpl }).writeConfig(patch as Record<string, unknown>)
    return out.kind === 'accepted' ? c.json({ ok: true }) : remoteFailure(c, rec, out)
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

/** An id that names no link at all. Distinct from a host 404 (`remote_not_found`, or the
 *  host's own code): "you have no such machine" and "that machine has no such thing" are
 *  different problems with different fixes, and one 404 code for both hides which. */
function noSuchLink(c: Context): Response {
  return c.json({ error: { code: 'not_found', message: 'No such link.' } }, 404)
}

/** The statuses a host refusal is allowed to keep. Anything outside this set is a host
 *  misbehaving rather than a decision it made, and becomes a 502. Enumerated rather than
 *  passed through so a host can never make this daemon answer 101, 204 or 3xx. */
const RELAYED: Record<number, 400 | 403 | 404 | 409 | 429 | 503 | undefined> = {
  400: 400, 403: 403, 404: 404, 409: 409, 429: 429, 503: 503,
}

/** The codes a host 401 may carry that really do mean "your token is no longer honoured".
 *  `unauthorized` is what `linkAuth` emits; the other two are spellings an older or
 *  differently-worded build could use for the same fact. Anything else on a 401 is some
 *  OTHER credential the host is missing (`hf_unauthorized`), not this link's. */
const AUTH_CODES: ReadonlySet<string> = new Set(['unauthorized', 'revoked', 'invalid_token'])

/** Fallback code when the host named none. Never a stand-in for a code it DID name. */
const DEFAULT_CODE: Record<number, string | undefined> = {
  400: 'invalid_request',
  403: 'forbidden',
  404: 'remote_not_found',
  409: 'conflict',
  429: 'rate_limited',
  502: 'unavailable',
  503: 'unavailable',
}

/** Render a failed remote call for the browser, PRESERVING the distinction the host drew.
 *
 *  This is the whole point of the proxy hop being honest. The fleet UI renders "you were
 *  not granted `models:load`" (403, with the capability named, remedy: re-mint the token),
 *  "the host is in use locally" (503 `host_busy`, remedy: wait), "ComfyUI is rendering"
 *  (409 `comfyui_busy`) and "that machine is offline" (503 `unavailable`) as four different
 *  states. Flattening any of them into a generic 500 destroys the screen.
 *
 *  What crosses: the status (from the allowlist above) and the host's `code`/`capability`
 *  (sanitised in `LinkClient.failureDetail`). What does NOT: the host's `message`. That
 *  field is routinely a raw `Error.message` carrying an absolute host path — the fifth
 *  member of a family of leaks this feature has already had four of — so every sentence
 *  here is composed locally, out of the link's own display name.
 *
 *  `LinkClient` never throws by contract, so there is no exception path to guard: an
 *  offline host arrives here as `network` and leaves as a typed 503, never as a hang and
 *  never as a 500. */
function remoteFailure(c: Context, rec: LinkRecord, probe: LinkProbe): Response {
  if (probe.kind === 'network' || probe.kind === 'ok') {
    // `ok` is unreachable — it is `hello()`'s success shape, which none of these callers
    // can produce — but treating it as "we did not get an answer we understand" keeps this
    // total rather than leaving a union member to fall off the end as `undefined`.
    return c.json(
      { error: { code: 'unavailable', message: `${rec.name} did not answer.` } },
      503,
    )
  }
  if (probe.kind === 'incompatible') {
    return c.json(
      { error: { code: 'incompatible', message: describeStatus('incompatible', rec.name) } },
      503,
    )
  }
  // 401 is the one status NOT relayed as itself: a 401 from the host would read in the
  // browser as "you need to sign in to THIS daemon", which is the opposite of what
  // happened.
  //
  // But "401" and "the host revoked this machine" are NOT the same fact, and this route
  // used to equate them. `linkAuth` answers 401 `unauthorized` for a token the host no
  // longer honours — that IS revocation — while `downloadErrorStatus` maps `hf_unauthorized`
  // to 401 as well, i.e. "the HOST has no Hugging Face credential for that gated repo".
  // Told the second was the first, the user re-mints a token that was never the problem,
  // re-links, and hits exactly the same wall. So revocation is claimed only when the host
  // named no code at all, or named an auth one; a host that named something else keeps its
  // own code and the peer says only that the host refused.
  if (probe.status === 401) {
    if (probe.code === undefined || AUTH_CODES.has(probe.code)) {
      return c.json({ error: { code: 'revoked', message: describeStatus('revoked', rec.name) } }, 403)
    }
    // 403 rather than a relayed 401, for the reason above: this is the host refusing, not
    // this daemon demanding a credential. The CODE is what the UI switches on.
    return c.json(
      { error: { code: probe.code, message: `${rec.name} refused this request.` } },
      403,
    )
  }
  const status = RELAYED[probe.status] ?? 502
  const code = probe.code ?? DEFAULT_CODE[status] ?? 'unavailable'
  const message = probe.capability
    ? `${rec.name} did not grant this machine '${probe.capability}'.`
    : status === 403
      ? `${rec.name} refused this request.`
      : status === 404
        ? `${rec.name} does not have what this request named.`
        : status === 502
          ? `${rec.name} answered with an unexpected error.`
          : `${rec.name} could not do that right now.`
  return c.json(
    { error: { code, message, ...(probe.capability ? { capability: probe.capability } : {}) } },
    status,
  )
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
