import type { Deps } from '../../deps'
import type { RemoteProviderId } from '../../config/config'
import type { RemoteProvider } from '../types'
import { CloudflareQuickProvider } from './cloudflare-quick'
import { CloudflareNamedProvider } from './cloudflare-named'
import { TailscaleServeProvider, TailscaleFunnelProvider } from './tailscale'
import { NgrokProvider } from './ngrok'
import { CustomProvider } from './custom'

/** The one place a provider id becomes an instance. `factory.test.ts` asserts that every id
 *  in REMOTE_PROVIDERS resolves here, so adding an id without wiring it fails a test rather
 *  than silently falling back to the quick tunnel — which is what the Phase 2 stub did, and
 *  would have meant a user picking Tailscale quietly getting a public trycloudflare URL. */
export function makeProvider(id: RemoteProviderId, d: Deps): RemoteProvider {
  const cfg = d.store.snapshot().remoteAccess
  switch (id) {
    case 'cloudflare-quick':
      return new CloudflareQuickProvider(d.store.dir())
    case 'cloudflare-named':
      return new CloudflareNamedProvider(d.store.dir(), {
        tunnelToken: cfg.cloudflare.tunnelToken,
        hostname: cfg.cloudflare.hostname,
      })
    case 'tailscale-serve':
      return new TailscaleServeProvider({ port: cfg.tailscale.port })
    case 'tailscale-funnel':
      return new TailscaleFunnelProvider({ port: cfg.tailscale.port })
    case 'ngrok':
      return new NgrokProvider(d.store.dir(), { authtoken: cfg.ngrok.authtoken, domain: cfg.ngrok.domain })
    case 'custom':
      return new CustomProvider({ publicUrl: cfg.custom.publicUrl })
  }
}
