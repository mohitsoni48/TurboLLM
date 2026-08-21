import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { Deps } from '../deps'
import type { ApiKey } from '../config/config'
import { linkAuth, requireCapability } from './link-auth'
import { gatewayV1Handler } from '../gateway/gateway'
import { buildModelStatus } from '../api/status-view'
import { allowsModel, hasCapability } from './capabilities'
import { canWake, hostIdleState } from './host-idle'
import { LINK_API_VERSIONS } from './protocol'
import { LINK_CAPABILITIES, type HelloResponse } from './types'

// linkAuth (link-auth.ts) puts the resolved key on the context as `linkKey`, but the
// plain `Hono` type in this function's signature carries no Variables — so route
// handlers below see it through this narrowed local alias rather than widening the
// exported signature (which task 6's interface pins to `Hono`).
type LinkEnv = { Variables: { linkKey: ApiKey } }

/** Stable identity for THIS install, minted once and persisted. The peer keeps it so it
 *  can tell "the tunnel URL changed but it's the same box" (normal, every Kaggle session)
 *  from "this URL now points at a DIFFERENT box" (needs a warning, not a silent adopt). */
export function machineId(d: Deps): string {
  const daemon = d.store.snapshot().daemon as { machineId?: string }
  if (daemon.machineId) return daemon.machineId
  const id = randomUUID()
  d.store.update((cfg) => {
    ;(cfg.daemon as unknown as { machineId?: string }).machineId ??= id
  })
  return id
}

/** What this box calls itself to a peer.
 *
 *  `daemon.machineName` is the user's own choice (Settings → Turbo Link). When it is unset
 *  — which it is on every existing install, since nothing wrote the field before this —
 *  fall back to the OS HOSTNAME rather than the literal string "TurboLLM": every host
 *  answering with an identical constant makes the peer's "Linked machines" list, and
 *  `describeStatus`'s deliberately machine-naming copy, useless the moment there are two
 *  links. `os.hostname()` is cross-platform and needs no configuration; the constant
 *  survives only as a last resort for the (theoretical) empty-hostname case. */
export function resolveMachineName(configured: string | undefined): string {
  const chosen = configured?.trim()
  if (chosen) return chosen
  try {
    return hostname().trim() || 'TurboLLM'
  } catch {
    return 'TurboLLM'
  }
}

/** Mount ONLY the façade's gate. Split out from `registerLinkApi` so `createApp` can put
 *  the gate before the feature-telemetry middleware and the handlers after it: telemetry
 *  must not count a request that was rejected, and a handler registered BEFORE the
 *  telemetry middleware short-circuits it entirely (Hono composes in registration order),
 *  which is why the `link` feature previously only ever recorded 404s. Callers that do not
 *  care about that ordering — every test, and any future embedder — get both from
 *  `registerLinkApi` in one call, unchanged. */
export function registerLinkAuth(app: Hono, d: Deps): void {
  ;(app as unknown as Hono<LinkEnv>).use('/api/link/v1/*', linkAuth(d))
}

/** Mount the Turbo Link façade (ADR-376).
 *
 *  Deliberately NARROW and explicitly versioned: this is the contract two
 *  independently-updated TurboLLM installs agree on. Routes added here mount EXISTING
 *  handlers behind requireCapability — never reimplement a handler, or the façade
 *  becomes a fork that drifts from the internal API it mirrors.
 *
 *  Register AFTER lanAuth in server.ts. linkAuth then exempts nothing (spec §3.3). */
export function registerLinkApi(app: Hono, d: Deps, opts?: { authAlreadyRegistered?: boolean }): void {
  const linkApp = app as unknown as Hono<LinkEnv>
  if (!opts?.authAlreadyRegistered) registerLinkAuth(app, d)

  linkApp.post('/api/link/v1/hello', (c) => {
    const key = c.get('linkKey')
    // A legacy key (no grant) is full-access, so it must report EVERY capability —
    // reporting [] would grey out every control on the peer for an otherwise valid key.
    const capabilities = key.grant ? key.grant.capabilities : [...LINK_CAPABILITIES]
    const models = key.grant?.models?.length ? key.grant.models : undefined
    const daemon = d.store.snapshot().daemon as { machineName?: string }
    const body: HelloResponse = {
      machineId: machineId(d),
      machineName: resolveMachineName(daemon.machineName),
      appVersion: d.version,
      linkApiVersions: [...LINK_API_VERSIONS],
      capabilities,
      ...(models ? { models } : {}),
    }
    return c.json(body)
  })

  linkApp.get('/api/link/v1/models', requireCapability('models:use'), (c) => {
    const key = c.get('linkKey')
    const loadedKey = d.manager.status().model?.key ?? null
    const models = d.scanner.list().models
      .filter((e) => allowsModel(key, e.key))
      .map((e) => ({
        key: e.key,
        name: e.name,
        quant: e.quant ?? null,
        nativeCtx: e.nativeCtx ?? null,
        vision: Boolean(e.vision),
        loaded: e.key === loadedKey,
      }))
    // Deliberately does NOT include `path`. A peer has no business knowing the host's
    // filesystem layout, and it is the kind of field that leaks by accident when a
    // handler spreads the whole entry.
    const daemon = d.store.snapshot().daemon as { machineName?: string }
    return c.json({ machineName: resolveMachineName(daemon.machineName), models })
  })

  /** Stats parity (spec §5.4). The host re-exports its EXISTING status shape; the peer
   *  renders it with the components it already uses for its own engine card. There is no
   *  remote-stats model and no translation layer — both this route and the local
   *  `/api/v1/status` are fed by `buildModelStatus`, which is the only thing that keeps
   *  them from drifting.
   *
   *  Gated on `models:use` rather than being open to any valid key: live t/s, TTFT and
   *  context use describe what the machine's owner is doing right now, and a link that may
   *  not use the models has no business watching them.
   *
   *  `engine.launchCommand` — the engine's absolute binary + model paths — is NOT part of
   *  the shared builder, so it cannot cross here. See status-view.ts. */
  linkApp.get('/api/link/v1/status', requireCapability('models:use'), (c) =>
    c.json(buildModelStatus(d)),
  )

  linkApp.post('/api/link/v1/chat/completions', requireCapability('models:use'), async (c) => {
    const key = c.get('linkKey')
    const body = await c.req.json().catch(() => ({})) as { model?: string }
    const requested = body.model ?? ''
    if (requested && !allowsModel(key, requested)) {
      return c.json({ error: { code: 'forbidden', message: `This link may not use '${requested}'.` } }, 403)
    }

    // Wake gating (spec §5.5). The idle judgement lives HERE because only the host can
    // make it. A peer with models:use but not models:wake may use what is already up;
    // anything else is a TYPED 503 the peer renders as "in use locally", never a
    // generic error the user cannot act on.
    //
    // The loaded/cold comparison is an EXACT key match, deliberately, even though
    // ModelRouter.resolveEntry matches fuzzily downstream: `loaded` is precisely the flag
    // GET /api/link/v1/models already reported to this peer, so the gate answers the
    // question the peer actually asked. A fuzzier test here would let a near-miss id slip
    // past the gate and reach the swap machinery anyway.
    const loaded = d.manager.status().model?.key ?? null
    if (requested && requested !== loaded) {
      if (hasCapability(key, 'models:load')) {
        // Unconditional by design: models:load IS the "you may take the machine" grant.
        // Fall through to the normal auto-swap path.
      } else if (hasCapability(key, 'models:wake')) {
        if (!canWake(hostIdleState(d))) {
          return c.json(
            { error: { code: 'host_busy', message: 'The host is in use locally. Try again shortly.' } },
            503,
          )
        }
      } else {
        return c.json(
          {
            error: {
              code: 'model_not_loaded',
              message: `'${requested}' is not loaded on this machine, and this link may not load it.`,
            },
          },
          503,
        )
      }
    }

    // The SAME function the public /v1/chat/completions mount calls — never a
    // reimplementation. `pathname` is what makes the peer's /api/link/v1 URL behave as
    // the /v1 route it proxies; `origin: 'link'` keeps this out of the local-activity
    // ledger the wake gate above reads.
    return gatewayV1Handler(c, d, { pathname: '/v1/chat/completions', origin: 'link' })
  })
}
