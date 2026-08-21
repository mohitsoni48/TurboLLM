// Turbo Link (ADR-376 §6.3): the two reads the chat model picker needs.
//
// Separate from queries.ts on purpose — that module is the status/engines/models core
// every screen mounts, and these two are optional extras that 403 outright on a machine
// browsing its own daemon from off-box (the whole /api/v1/links surface is host-gated).
// `retry: false` plus the `?? []` at the call site is what turns that 403, and a daemon
// too old to know the route, into "no links" rather than an error banner on a screen that
// has nothing to do with Turbo Link.
import { useQuery } from '@tanstack/react-query'
import { getLinkStatus, listLinks, listRemoteModels, type LinkRecord, type LinkRecordId, type RemoteStatus } from './link-api'
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

/** Live state of the ONE host a view is currently pointed at (spec §5.4, final-review I-5).
 *
 *  Deliberately per-link and `enabled`-gated rather than folded into the 15 s links poll:
 *  this is a live number — what the machine is generating right now — so it is only worth
 *  fetching while something is actually looking at it, and it must not add a request per
 *  link per tick for every install with links it is not using.
 *
 *  `retry: false` plus a soft read at the call site keeps a host that dropped mid-chat from
 *  turning into an error banner: the chat itself is what fails loudly if the machine is
 *  really gone (the daemon answers a typed 503 naming it).
 */
export function useLinkStatus(linkId: string | null) {
  return useQuery<RemoteStatus>({
    queryKey: ['link-status', linkId],
    queryFn: () => getLinkStatus(linkId as LinkRecordId),
    enabled: !!linkId,
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
    retry: false,
  })
}
