// Download lifecycle (spec 10 §5–6): the ONE implementation of "start a download",
// "list the downloads" and "drop a download", extracted from routes.ts so more than one
// transport can mount it.
//
// Same rationale as engine-lifecycle.ts, and the same two callers: the local
// `/api/v1/downloads` routes (routes.ts) and the Turbo Link façade's
// `/api/link/v1/downloads` (link/link-routes.ts). Both go through these functions rather
// than re-deriving the DownloadError → HTTP-status table, which is the part that would
// silently drift: this project has already paid three times in this feature alone for two
// implementations of one idea.
//
// These return DATA, not a `Response`, because the two transports must serialize
// DIFFERENTLY and that difference is deliberate: the local UI gets the full
// `DownloadRecord` (it is the same machine, `dest` is its own path), while the façade must
// hand back an allowlist projection with no host filesystem detail in it (see
// `redactDownload` in link/types.ts). A shared function that returned a finished Response
// would force one of those two to be wrong.
import { DownloadError, type DownloadRecord, type EnqueueInput } from '../downloads/downloads'
import type { Deps } from '../deps'

export type DownloadFailureStatus = 400 | 401 | 403 | 404 | 409 | 500

export interface DownloadFailure {
  ok: false
  status: DownloadFailureStatus
  code: string
  message: string
  /** True when `message` is host-authored free text (a raw `Error.message`) rather than one
   *  of DownloadManager's own fixed, reviewed strings. A caller that crosses a trust
   *  boundary MUST NOT relay such a message: an fs failure's message carries an absolute
   *  path. The local UI relays it, because it is the same machine. */
  hostDetail: boolean
}

export type EnqueueOutcome = { ok: true; downloads: DownloadRecord[] } | DownloadFailure

/** The DownloadError → HTTP status table. One definition, both transports. */
export function downloadErrorStatus(code: string): DownloadFailureStatus {
  if (code === 'no_model_dir') return 409
  if (code === 'hf_unauthorized') return 401
  if (code === 'hf_gated') return 403
  return 400
}

/** Normalise anything thrown out of the DownloadManager into a typed failure.
 *
 *  A `DownloadError` is caller-actionable and its message is a fixed string written for a
 *  user ("Add a model folder in Settings…"), so it is safe to show anywhere. Anything else
 *  is an unexpected host fault whose message is uncontrolled — flagged `hostDetail` so a
 *  remote transport can refuse to relay it. */
export function toDownloadFailure(e: unknown): DownloadFailure {
  if (e instanceof DownloadError) {
    return { ok: false, status: downloadErrorStatus(e.code), code: e.code, message: e.message, hostDetail: false }
  }
  return {
    ok: false,
    status: 500,
    code: 'internal',
    message: e instanceof Error ? e.message : String(e),
    hostDetail: true,
  }
}

export function listDownloads(d: Deps): DownloadRecord[] {
  return d.downloads.list()
}

/** Enqueue a download. One request may fan out into several files (split shards + a shared
 *  mmproj), so the whole created set comes back. */
export async function enqueueDownload(d: Deps, input: EnqueueInput): Promise<EnqueueOutcome> {
  try {
    return { ok: true, downloads: await d.downloads.enqueue(input) }
  } catch (e) {
    return toDownloadFailure(e)
  }
}

/** Drop a download record: aborts an in-flight stream, deletes the `.part`, forgets the row.
 *
 *  Downloads are HOST-OWNED. There is no per-link ownership model and deliberately none to
 *  add: a download is a change to the host's disk that its owner can see in their own UI,
 *  and a peer that may write downloads may equally stop one. */
export function removeDownload(d: Deps, id: string): { ok: true } | DownloadFailure {
  if (d.downloads.remove(id)) return { ok: true }
  return {
    ok: false,
    status: 404,
    code: 'no_such_download',
    message: 'No download with that id.',
    hostDetail: false,
  }
}
