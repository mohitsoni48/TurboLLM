// Remote-access REST surface (spec 30 §5).
//
// Config carries DESIRED state; these routes carry RUNTIME state. Starting a tunnel is a
// slow, failure-prone action rather than a setting, so a synchronous PATCH response cannot
// carry its outcome — which is why this is deliberately not modelled on lanBind's `rebind`
// response field. The client reads progress back from /status.
import type { Hono } from 'hono'
import type { Context } from 'hono'
import type { Deps } from '../deps'
import { hostGate, provisionRemoteApiKey, revokeRemoteKeys } from '../auth'
import { isRemoteAccessEnabled, REMOTE_DISABLED } from './gate'
import { REMOTE_PROVIDERS, type RemoteProviderId } from '../config/config'
import { LINK_CAPABILITIES, type LinkCapability } from '../link/types'
import { emit } from '../telemetry/runtime/typed-emit'
import { remoteAccessEnabled, remoteAccessDisabled, remoteAccessPreflightFailed } from '../telemetry/events/remote'

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T
  } catch {
    return {} as T
  }
}

/** The stored scope, narrowed to capabilities that actually exist. An unknown string is
 *  dropped rather than passed through — a grant is an allow-list, and an allow-list that
 *  carries entries nothing understands is one nobody can audit. */
export function sanitizeTokenGrant(stored: { capabilities: string[]; models?: string[] }): {
  capabilities: LinkCapability[]
  models?: string[]
} {
  const caps = stored.capabilities.filter((c): c is LinkCapability =>
    (LINK_CAPABILITIES as readonly string[]).includes(c),
  )
  return { capabilities: caps.length ? caps : ['models:use'], models: stored.models }
}

// I5 (Phase 5 final review): the scoped remote token is cached for the DAEMON PROCESS's
// lifetime — spec 30 §6.3's own words — so a reconnect (another Retry click, toggling off
// and back on) re-shows the SAME token instead of minting and orphaning a fresh one every
// time. Mirrors cli.ts's own `let tunnelToken: string | null = null` convention for the
// legacy tunnel token. Cleared by `/stop` below, and only by `/stop` — that is the one
// action that actually revokes it (`revokeRemoteKeys`), so it is also the only action that
// may make the NEXT `/start` mint genuinely fresh.
let cachedRemoteToken: string | null = null

export function registerRemoteApi(app: Hono, d: Deps): void {
  // Every route carries hostGate. Remote-access config IS credential management — it holds a
  // Cloudflare tunnel token and an ngrok authtoken, and turning it on publishes the daemon.
  // ADR-376's review found this exact gate missing twice on this exact class of route.
  const guard = (c: Context): Response | null => {
    if (!isRemoteAccessEnabled(d)) return c.json(REMOTE_DISABLED, 403)
    if (!hostGate(c, d)) return c.json({ error: { code: 'forbidden', message: 'Host-only action.' } }, 403)
    return null
  }

  app.get('/api/v1/remote/status', (c) => {
    const refused = guard(c)
    if (refused) return refused
    const cfg = d.store.snapshot().remoteAccess
    return c.json({
      provider: cfg.provider,
      enabled: cfg.enabled,
      state: d.remote?.state() ?? { kind: 'off' },
      url: d.remote?.url() ?? cfg.lastUrl ?? '',
      ingressPort: d.remote?.ingressPort() ?? null,
    })
  })

  app.post('/api/v1/remote/start', async (c) => {
    const refused = guard(c)
    if (refused) return refused
    const provider = d.store.snapshot().remoteAccess.provider
    d.store.update((cfg) => {
      cfg.remoteAccess.enabled = true
    })
    // I5 (Phase 5 final review): mint AFTER `enable()` resolves, and only when it actually
    // reached 'connected' — minting BEFORE used to reveal a freshly-minted token for a tunnel
    // that never came up (a preflight failure, or a `failed` state), and every Retry click
    // minted and orphaned another key on top of it. `provisionRemoteApiKey`/`revokeRemoteKeys`
    // are the ones that make a remote token capability-checked and revocable at all
    // (`grantKind === 'remote'`) — a token for a connection that never happened is neither
    // useful nor safe to hand out.
    await d.remote?.enable()
    const state = d.remote?.state() ?? { kind: 'off' }
    // Cached for the daemon PROCESS's lifetime (spec 30 §6.3), not re-minted on every
    // successful `/start` — a reconnect re-shows the SAME token instead of orphaning keys.
    // Only `/stop` clears the cache (see below), which is also the only thing that revokes it.
    if (state.kind === 'connected') {
      cachedRemoteToken ??= provisionRemoteApiKey(d, {
        kind: 'remote',
        ...sanitizeTokenGrant(d.store.snapshot().remoteAccess.tokenGrant),
      })
    }
    const token = state.kind === 'connected' ? (cachedRemoteToken ?? undefined) : undefined
    // Provider choice only — never the token or the URL this just minted (ADR-422 spec 30
    // §9). `d.telemetry` is optional (absent under tests), same convention as link-admin's
    // `linkMinted` call site. I5: gated on an actual successful connect, not emitted
    // unconditionally on every call regardless of outcome — a failed attempt now emits only
    // `remoteAccessPreflightFailed` below, not both (part of M5's "Retry double-counts" report).
    if (d.telemetry && state.kind === 'connected') emit(d.telemetry, remoteAccessEnabled, { provider })
    // `RemoteAccessManager.enable()` runs its own preflight before ever binding anything
    // (manager.ts) and, on failure, leaves `state()` at 'unavailable'/'needs-setup' instead of
    // 'connected'. The manager has no `Deps` and cannot emit this itself (by design — see
    // manager.ts's `onState` doc comment on why persistence-shaped concerns live in the
    // caller); this is the same enable-time preflight outcome the standalone
    // `/api/v1/remote/preflight` route above reports for an explicit pre-check.
    if (d.telemetry && (state.kind === 'unavailable' || state.kind === 'needs-setup')) {
      emit(d.telemetry, remoteAccessPreflightFailed, { provider, state: state.kind })
    }
    return c.json({ state, token })
  })

  app.post('/api/v1/remote/stop', async (c) => {
    const refused = guard(c)
    if (refused) return refused
    const provider = d.store.snapshot().remoteAccess.provider
    d.store.update((cfg) => {
      cfg.remoteAccess.enabled = false
    })
    // Awaited, not fire-and-forget: for a system-state provider this call is what
    // un-exposes the box, and a disabled toggle in front of a live public URL is the worst
    // failure this feature can have.
    await d.remote?.disable()
    const revoked = revokeRemoteKeys(d)
    // I5: the ONLY place the cached token is cleared — this is also the only action that
    // actually revokes it, so it is the only action that may make the next `/start` mint
    // genuinely fresh rather than handing back a token that no longer exists.
    cachedRemoteToken = null
    if (d.telemetry) emit(d.telemetry, remoteAccessDisabled, { provider })
    return c.json({ state: d.remote?.state() ?? { kind: 'off' }, revoked })
  })

  app.post('/api/v1/remote/preflight', async (c) => {
    const refused = guard(c)
    if (refused) return refused
    const { provider } = await body<{ provider?: string }>(c)
    if (!provider || !(REMOTE_PROVIDERS as readonly string[]).includes(provider)) {
      return c.json({ error: { code: 'bad_request', message: 'Unknown provider.' } }, 400)
    }
    const { makeProvider } = await import('./providers/factory')
    const state = await makeProvider(provider as RemoteProviderId, d).preflight()
    // Only the closed `kind` discriminant — never `state.reason`, which is free text meant
    // for the user's own screen, not the wire (see events/remote.ts's doc comment).
    if (d.telemetry && (state.kind === 'unavailable' || state.kind === 'needs-setup')) {
      emit(d.telemetry, remoteAccessPreflightFailed, {
        provider: provider as RemoteProviderId,
        state: state.kind,
      })
    }
    return c.json({ provider, state })
  })
}
