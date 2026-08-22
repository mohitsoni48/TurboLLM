// Turbo Link (ADR-376 phase 3, task 6): what a FAILED remote action says to the user, as a
// PURE function.
//
// `capability-ui.ts` answers the pre-flight question ("may this control be clicked at all?")
// from the handshake. This module answers the post-flight one: the click happened, the peer
// proxied it, and the host refused. Those are different failures with different fixes, and
// the peer-side admin proxy (task 5b) went to real trouble to keep them apart — it lifts the
// host's `error.code` and `error.capability` and relays them with the original status
// precisely so this screen can tell "you were never granted models:load" from "the machine
// is busy right now" from "that machine is offline". Flattening them back into one generic
// "request failed" here would throw all of that away and send the user to debug the wrong
// machine.
//
// Works from the CODE alone, never from the host's own `message`. The proxy composes every
// sentence locally out of the link's display name for a reason: `DownloadRecord.error` and
// friends routinely carry a raw `Error.message` with an absolute host path in it, and this
// feature has already had several host-filesystem leaks. This module is the last place that
// could reintroduce one, so it simply never reads the message.
import { ApiError } from './api'
import { capabilityReason } from './capability-ui'
import { LINK_CAPABILITIES, type LinkCapability } from './link-constants'

export interface RemoteFailure {
  /** One actionable sentence, safe to render. Always names the machine. */
  message: string
  /** The relayed machine token, or `'unknown'`. Exposed for tests and telemetry, not copy. */
  code: string
  /** True when the remedy really is "wait and try the same thing again" — a busy host or a
   *  rate limit. False for everything the user has to go and FIX (a missing grant, a
   *  revoked link, an offline machine), where offering a retry button would just invite
   *  them to click it forever. */
  retryable: boolean
}

/** Is this string one of the capabilities we know? The proxy already validates
 *  `capability` against `LINK_CAPABILITIES` server-side; re-checking here is what lets
 *  `capabilityReason` be called with a properly-typed argument instead of a cast. */
function asCapability(v: string | undefined): LinkCapability | undefined {
  return v && (LINK_CAPABILITIES as readonly string[]).includes(v) ? (v as LinkCapability) : undefined
}

/**
 * Turn a rejected remote action into the sentence the row shows.
 *
 * `machine` is the link's LIVE display name, so a rename between the click and the failure
 * still names the machine the user is looking at.
 */
export function describeRemoteFailure(err: unknown, machine: string): RemoteFailure {
  const api = err instanceof ApiError ? err : undefined
  const code = api?.code ?? 'unknown'
  const cap = asCapability(api?.capability)

  switch (code) {
    // ── The grant ────────────────────────────────────────────────────────────────
    case 'forbidden':
      // The host named the capability it wanted, so say exactly what `actionState` would
      // have said had the handshake been current. Reaching here at all means the two ends
      // disagree — the UI greys these controls off `grantedCapabilities` — so the wording
      // being identical is what stops it reading as a different, mysterious second problem.
      return {
        code,
        retryable: false,
        message: cap
          ? capabilityReason(cap, machine)
          : `${machine} refused this action: this link was not granted permission for it. Mint a new link key on ${machine} that includes it.`,
      }
    case 'revoked':
      return {
        code,
        retryable: false,
        message: `${machine} revoked this link. Paste a new link string from ${machine} to reconnect.`,
      }

    // ── The machine ──────────────────────────────────────────────────────────────
    case 'unavailable':
      return {
        code,
        retryable: false,
        message: `${machine} did not answer. It may be offline, asleep, or its address may have changed.`,
      }
    case 'incompatible':
      return {
        code,
        retryable: false,
        message: `${machine} is running an incompatible version of TurboLLM. Update TurboLLM on ${machine}.`,
      }

    // ── The machine is fine, it is just busy ─────────────────────────────────────
    case 'host_busy':
      return {
        code,
        retryable: true,
        message: `${machine} is busy with its own work right now. Try again in a moment.`,
      }
    case 'comfyui_busy':
      return {
        code,
        retryable: true,
        message: `ComfyUI is using the GPU on ${machine} right now. Try again once it finishes.`,
      }
    case 'rate_limited':
      return {
        code,
        retryable: true,
        message: `${machine} is rate-limiting requests from this machine. Try again shortly.`,
      }

    // ── The thing we asked about ─────────────────────────────────────────────────
    case 'model_not_loaded':
      return {
        code,
        retryable: false,
        message: `No model is loaded on ${machine}, so there is nothing to unload.`,
      }
    case 'no_such_model':
      return {
        code,
        retryable: false,
        message: `${machine} no longer has that model. Its library may have changed since this list was refreshed.`,
      }
    case 'remote_not_found':
      return {
        code,
        retryable: false,
        message: `${machine} could not find what this action referred to. It may have already finished or been removed there.`,
      }
    case 'conflict':
      return {
        code,
        retryable: true,
        message: `${machine} could not do that in its current state. Check what it is doing, then try again.`,
      }

    // ── The download the host was asked to start ─────────────────────────────────
    // These three used to fall through to the default's "try again" — which cannot help
    // with any of them, and for `hf_unauthorized` the peer proxy used to relabel the whole
    // thing as "your link was revoked". Each names the machine that has to be fixed, which
    // is the host, not this one.
    case 'hf_unauthorized':
      return {
        code,
        retryable: false,
        message: `${machine} has no Hugging Face token for that repository. Add one in Settings on ${machine} — this link is fine.`,
      }
    case 'hf_gated':
      return {
        code,
        retryable: false,
        message: `That repository is gated, and the Hugging Face account on ${machine} has not been granted access to it. Accept its terms with that account, then try again.`,
      }
    case 'no_model_dir':
      return {
        code,
        retryable: false,
        message: `${machine} has no model folder to download into. Add one in Settings on ${machine}.`,
      }
    case 'no_such_download':
      return {
        code,
        retryable: false,
        message: `${machine} no longer has that download. It may have finished or been removed there.`,
      }

    // ── This machine's own view is stale ─────────────────────────────────────────
    case 'not_found':
      // Deliberately NOT the same as `remote_not_found`: this one means THIS machine has no
      // such link any more, which is a local problem with a local fix.
      return {
        code,
        retryable: false,
        message: `This machine no longer has a link to ${machine}. Add the link again to use it.`,
      }
    case 'invalid_input':
    case 'invalid_request':
      return {
        code,
        retryable: false,
        message: `${machine} rejected the request as malformed. This is a bug in TurboLLM — please report it.`,
      }

    default:
      // Total by construction: an unknown or absent code still produces a machine-named
      // sentence rather than an empty tooltip or a literal "undefined".
      return {
        code,
        retryable: true,
        message: `Something went wrong talking to ${machine}. Try again, and check that it is still reachable.`,
      }
  }
}
