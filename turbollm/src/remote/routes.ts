// Remote-access REST surface (spec 30 §5).
//
// Config carries DESIRED state; these routes carry RUNTIME state. Starting a tunnel is a
// slow, failure-prone action rather than a setting, so a synchronous PATCH response cannot
// carry its outcome — which is why this is deliberately not modelled on lanBind's `rebind`
// response field. The client reads progress back from /status.
import type { Hono } from 'hono'
import type { Context } from 'hono'
import type { Deps } from '../deps'
import { hostGate } from '../auth'
import { isRemoteAccessEnabled, REMOTE_DISABLED } from './gate'
import { REMOTE_PROVIDERS, type RemoteProviderId } from '../config/config'

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T
  } catch {
    return {} as T
  }
}

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
    d.store.update((cfg) => {
      cfg.remoteAccess.enabled = true
    })
    await d.remote?.enable()
    return c.json({ state: d.remote?.state() ?? { kind: 'off' } })
  })

  app.post('/api/v1/remote/stop', async (c) => {
    const refused = guard(c)
    if (refused) return refused
    d.store.update((cfg) => {
      cfg.remoteAccess.enabled = false
    })
    // Awaited, not fire-and-forget: for a system-state provider this call is what
    // un-exposes the box, and a disabled toggle in front of a live public URL is the worst
    // failure this feature can have.
    await d.remote?.disable()
    return c.json({ state: d.remote?.state() ?? { kind: 'off' } })
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
    return c.json({ provider, state })
  })
}
