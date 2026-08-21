// Turbo Link (ADR-376 §6.3): the two reads the chat model picker needs.
//
// Separate from queries.ts on purpose — that module is the status/engines/models core
// every screen mounts, and these two are optional extras that 403 outright on a machine
// browsing its own daemon from off-box (the whole /api/v1/links surface is host-gated).
// `retry: false` plus the `?? []` at the call site is what turns that 403, and a daemon
// too old to know the route, into "no links" rather than an error banner on a screen that
// has nothing to do with Turbo Link.
import { useQuery } from '@tanstack/react-query'
import { listLinks, listRemoteModels, type LinkRecord } from './link-api'
import type { RemoteModelRow } from './remote-models'

/** Poll cadence, matching the daemon's own link heartbeat: the server refreshes each
 *  link's status and catalog on that loop, so asking faster only adds requests. */
const LINK_POLL_MS = 15_000

export function useLinks() {
  return useQuery<LinkRecord[]>({
    queryKey: ['links'],
    queryFn: listLinks,
    refetchInterval: LINK_POLL_MS,
    // A background tab has no picker open to keep fresh.
    refetchIntervalInBackground: false,
    retry: false,
  })
}

export function useRemoteModels() {
  return useQuery<RemoteModelRow[]>({
    queryKey: ['link-models'],
    queryFn: listRemoteModels,
    refetchInterval: LINK_POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  })
}
