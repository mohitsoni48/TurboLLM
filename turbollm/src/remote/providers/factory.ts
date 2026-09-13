import type { Deps } from '../../deps'
import type { RemoteProviderId } from '../../config/config'
import type { RemoteProvider } from '../types'
import { CloudflareQuickProvider } from './cloudflare-quick'

/** One place that maps a provider id to an instance. Phase 3 adds the remaining five here;
 *  until then anything else falls back to the quick tunnel rather than throwing, so an id
 *  saved by a newer build never bricks an older daemon's startup. */
export function makeProvider(id: RemoteProviderId, d: Deps): RemoteProvider {
  switch (id) {
    case 'cloudflare-quick':
      return new CloudflareQuickProvider(d.store.dir())
    default:
      return new CloudflareQuickProvider(d.store.dir())
  }
}
