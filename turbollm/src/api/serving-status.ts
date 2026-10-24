// Which server features this daemon has on: a listener beyond loopback, remote access, Turbo Link peers it hosts
// (GET /api/v1/status's `serving`). The Android app quits the daemon when it is closed with nothing running, and
// keeps it running while any of these is on, as it does while a model is loaded or work runs: a quit then would take
// a LAN client's server, the remote-access URL or a linked machine's models away. A local-only field, like `jev`,
// `laya` and `poolModels`: never part of the shared `buildModelStatus` the Turbo Link façade re-exports.
import { grantKind, isLoopbackBindHost } from '../auth'
import type { Deps } from '../deps'
import { isTurboLinkEnabledIn } from '../link/gate'

export interface ServingStatus {
  /** The main listener is bound beyond loopback: 0.0.0.0 once LAN access is on (the rebind its setting runs has
   *  happened), or a non-loopback `--addr`/`daemon.host`. The address really bound (`bindHost`), not the setting:
   *  `--addr 127.0.0.1:…` wins over LAN access at boot, and a LAN client can reach none of that. */
  lan: boolean
  /** Remote access is up, or on its way up or back: a tunnel (Cloudflare, ngrok, a URL of the user's own) or
   *  Tailscale Serve/Funnel, in the states `tunnel.active` counts (starting, connected, reconnecting). Off, failed,
   *  unavailable and needs-setup serve nothing: the ingress is down in each. */
  remote: boolean
  /** How many Turbo Link peers this daemon hosts: the link tokens minted for other machines (POST
   *  /api/v1/links/mint, the host's inbound links), while Turbo Link is switched on. Off, the façade answers every
   *  peer with turbo_link_disabled, so it serves none: 0. A remote-access token is not a peer (its own grant kind),
   *  and an ordinary key a peer was given by hand cannot be told from any other key, so neither is counted. */
  linkPeers: number
}

export function servingStatus(d: Pick<Deps, 'bindHost' | 'remote' | 'store'>): ServingStatus {
  const cfg = d.store.snapshot()
  const remote = d.remote?.state().kind
  return {
    lan: d.bindHost !== undefined && !isLoopbackBindHost(d.bindHost),
    remote: remote === 'starting' || remote === 'connected' || remote === 'reconnecting',
    linkPeers: isTurboLinkEnabledIn(cfg) ? cfg.apiKeys.filter((k) => grantKind(k) === 'link').length : 0,
  }
}
