import type { Deps } from '../../deps'
import type { RemoteProviderId } from '../../config/config'
import type { RemoteProvider } from '../types'
import { CloudflareQuickProvider } from './cloudflare-quick'
import { CloudflareNamedProvider } from './cloudflare-named'
import { TailscaleServeProvider, TailscaleFunnelProvider } from './tailscale'

/** One place that maps a provider id to an instance. Phase 3 adds the remaining five here;
 *  until then anything else falls back to the quick tunnel rather than throwing, so an id
 *  saved by a newer build never bricks an older daemon's startup. */
export function makeProvider(id: RemoteProviderId, d: Deps): RemoteProvider {
  switch (id) {
    case 'cloudflare-quick':
      return new CloudflareQuickProvider(d.store.dir())
    case 'cloudflare-named': {
      const cfg = d.store.snapshot().remoteAccess.cloudflare
      return new CloudflareNamedProvider(d.store.dir(), { tunnelToken: cfg.tunnelToken, hostname: cfg.hostname })
    }
    case 'tailscale-serve':
      return new TailscaleServeProvider({ port: d.store.snapshot().remoteAccess.tailscale.port })
    case 'tailscale-funnel':
      return new TailscaleFunnelProvider({ port: d.store.snapshot().remoteAccess.tailscale.port })
    default:
      return new CloudflareQuickProvider(d.store.dir())
  }
}
