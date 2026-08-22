// Turbo Link (ADR-376 §6.3): the two reads the chat model picker needs.
//
// Separate from queries.ts on purpose — that module is the status/engines/models core
// every screen mounts, and these two are optional extras that 403 outright on a machine
// browsing its own daemon from off-box (the whole /api/v1/links surface is host-gated).
// `retry: false` plus the `?? []` at the call site is what turns that 403, and a daemon
// too old to know the route, into "no links" rather than an error banner on a screen that
// has nothing to do with Turbo Link.
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { getSettings } from './api'
import {
  cancelRemoteDownload,
  getLinkStatus,
  listLinks,
  listRemoteDownloads,
  listRemoteModels,
  remoteLoad,
  remoteUnload,
  startRemoteDownload,
  type LinkRecord,
  type LinkRecordId,
  type LinkSummary,
  type RemoteDownload,
  type RemoteStatus,
} from './link-api'
import type { RemoteModelRow } from './remote-models'

/** Poll cadence, matching the daemon's own link heartbeat: the server refreshes each
 *  link's status and catalog on that loop, so asking faster only adds requests. */
const LINK_POLL_MS = 15_000

/** Is Turbo Link unlocked? (`daemon.experimental.turboLink`, ADR-376 — the same
 *  Settings → Experimental toggle the daemon gates on, see `turbollm/src/link/gate.ts`.)
 *
 *  Reads the settings query DIRECTLY rather than through `useSettings` so this module keeps
 *  its existing independence from `queries.ts` — that module is the status/engines/models
 *  core every screen mounts and this one is deliberately not coupled to it. The query key is
 *  the same `['settings']`, so react-query serves both from one cache entry and one request.
 *
 *  `=== true` is not decoration: while the settings read is in flight `data` is undefined,
 *  and the gate must read as OFF until the daemon has actually said otherwise. That is what
 *  keeps a page load from firing one round of link polls before the flag arrives. */
function useTurboLinkEnabled(): boolean {
  const { data } = useQuery({ queryKey: ['settings'], queryFn: getSettings, retry: false })
  return data?.experimental?.turboLink === true
}

/** Every linked machine.
 *
 *  This hook and `useRemoteModels` below are the only two roots the front end reaches Turbo
 *  Link through, so `enabled` here is the whole front-end gate: with the feature off both
 *  stay `idle` (no request, not a discarded answer), every call site's `?? []` yields an
 *  empty fleet, `machineOptions` collapses to All/This-machine and the filter hides itself,
 *  `showOrigin` goes false, and the per-link fan-outs below are handed nothing to poll.
 *  Every screen is then byte-for-byte the screen it was before Turbo Link existed. */
export function useLinks() {
  const enabled = useTurboLinkEnabled()
  return useQuery<LinkRecord[]>({
    queryKey: ['links'],
    queryFn: listLinks,
    enabled,
    refetchInterval: LINK_POLL_MS,
    // A background tab has no picker open to keep fresh.
    refetchIntervalInBackground: false,
    retry: false,
  })
}

export function useRemoteModels() {
  const enabled = useTurboLinkEnabled()
  return useQuery<RemoteModelRow[]>({
    queryKey: ['link-models'],
    queryFn: listRemoteModels,
    enabled,
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
  // Gated too, though with the feature off nothing can hand this a `linkId` in the first
  // place (the link list it comes from is empty). Belt and braces for the one case that
  // could: a chat still pointed at a remote model when the flag was flipped.
  const turboLink = useTurboLinkEnabled()
  return useQuery<RemoteStatus>({
    queryKey: ['link-status', linkId],
    queryFn: () => getLinkStatus(linkId as LinkRecordId),
    enabled: turboLink && !!linkId,
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
    retry: false,
  })
}

/** How often a linked host's download queue is re-read. Slower than the local 1.5 s poll on
 *  purpose: each tick is a real network round-trip to another machine, multiplied by the
 *  number of online links, and a progress bar that updates every 4 s is fine while a
 *  multi-gigabyte transfer runs. */
const REMOTE_DOWNLOAD_POLL_MS = 4_000

/** Every online link's download queue, fanned out one query per link.
 *
 *  The fan-out lives HERE rather than in the Downloads screen deliberately: it is
 *  concurrency plus per-machine error isolation, which is exactly the kind of logic the
 *  dispatch says must not sit in a component. One machine being slow, unreachable, or
 *  refusing for want of `downloads:read` leaves the others' rows on screen — each query
 *  fails alone.
 *
 *  Only ONLINE links are queried at all. A non-online link contributes no rows by the same
 *  rule `mergeFleet` enforces, so polling it would be a request per tick that could only
 *  ever fail — and `retry: false` keeps even that single attempt from becoming a hang.
 */
export function useRemoteDownloads(links: LinkSummary[]) {
  const online = links.filter((l) => l.status === 'online')
  const results = useQueries({
    queries: online.map((l) => ({
      queryKey: ['link-downloads', l.id],
      queryFn: () => listRemoteDownloads(l.id as LinkRecordId),
      refetchInterval: REMOTE_DOWNLOAD_POLL_MS,
      refetchIntervalInBackground: false,
      retry: false,
    })),
  })
  // Flattened and tagged with the link id, so the shape matches what `sourcesByLink` takes
  // and the component never has to know a fan-out happened.
  const rows: (RemoteDownload & { linkId: string })[] = []
  online.forEach((l, i) => {
    for (const d of results[i]?.data ?? []) rows.push({ ...d, linkId: l.id })
  })
  return {
    rows,
    /** Per-link failure, for the machine header. A machine whose queue could not be read
     *  must say so — an unreadable queue and an empty one look identical otherwise. */
    errorByLink: new Map(online.map((l, i) => [l.id, results[i]?.error ?? null])),
    isLoading: results.some((r) => r.isLoading),
  }
}

/** Invalidate everything a remote action can change. The load/unload/start routes answer
 *  202 — QUEUED, not done — so the real feedback comes from the next status/downloads poll;
 *  these invalidations just stop that first poll being up to a full interval away. */
function useFleetInvalidation() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['link-status'] })
    void qc.invalidateQueries({ queryKey: ['link-models'] })
    void qc.invalidateQueries({ queryKey: ['link-downloads'] })
  }
}

/** Load / unload a model on a linked host.
 *
 *  Both resolve on the host's 202, which means QUEUED. Nothing here waits for the model to
 *  actually come up — `useLinkStatus` reports that — so a slow load never blocks the UI and
 *  an unreachable host fails as a typed 503 rather than a spinner that never resolves. */
export function useRemoteModelActions() {
  const invalidate = useFleetInvalidation()
  return {
    load: useMutation({
      mutationFn: (v: { linkId: string; modelKey: string }) =>
        remoteLoad(v.linkId as LinkRecordId, v.modelKey),
      onSuccess: invalidate,
    }),
    unload: useMutation({
      mutationFn: (v: { linkId: string }) => remoteUnload(v.linkId as LinkRecordId),
      onSuccess: invalidate,
    }),
  }
}

/** Start / cancel a download on a linked host. The host owns the queue, the concurrency cap
 *  and the repo/filename validation; this only asks. */
export function useRemoteDownloadActions() {
  const invalidate = useFleetInvalidation()
  return {
    start: useMutation({
      mutationFn: (v: { linkId: string; repo: string; rfilename: string; size?: number; sha256?: string }) =>
        startRemoteDownload(v.linkId as LinkRecordId, {
          repo: v.repo,
          rfilename: v.rfilename,
          ...(v.size !== undefined ? { size: v.size } : {}),
          ...(v.sha256 !== undefined ? { sha256: v.sha256 } : {}),
        }),
      onSuccess: invalidate,
    }),
    cancel: useMutation({
      mutationFn: (v: { linkId: string; downloadId: string }) =>
        cancelRemoteDownload(v.linkId as LinkRecordId, v.downloadId),
      onSuccess: invalidate,
    }),
  }
}

/** Every online link's live engine/model state, one query per link.
 *
 *  Same fan-out shape (and same reasons) as `useRemoteDownloads`: per-machine isolation, and
 *  only online links are asked at all. Feeds the Engines screen's read-only remote rows.
 *
 *  Polls on the link cadence rather than `useLinkStatus`'s 3 s: that hook exists for the ONE
 *  host a chat is actively pointed at, where "what is it generating right now" is the whole
 *  point. A fleet list is a list — refreshing every machine's engine card every 3 s would be
 *  a request per link per tick for a screen nobody is watching that closely. */
export function useRemoteEngines(links: LinkSummary[]) {
  const online = links.filter((l) => l.status === 'online')
  const results = useQueries({
    queries: online.map((l) => ({
      queryKey: ['link-engine', l.id],
      queryFn: () => getLinkStatus(l.id as LinkRecordId),
      refetchInterval: LINK_POLL_MS,
      refetchIntervalInBackground: false,
      retry: false,
    })),
  })
  return online.map((link, i) => ({
    link,
    status: results[i]?.data ?? null,
    // A machine that refused (no `models:use`) or dropped must say so rather than sit on a
    // spinner: `LinkClient` never throws by contract, so this is always a typed answer.
    error: results[i]?.error ?? null,
    isLoading: results[i]?.isLoading ?? false,
  }))
}
