// Turbo Link (ADR-376 phase 3, task 5): whether a fleet action is available, and — when
// it is not — the sentence the UI shows instead, as a PURE function.
//
// The spec is explicit that a missing capability is a DISABLED control carrying a tooltip
// that names the capability and the machine that would have to grant it. Never a silent
// no-op (the user clicks and nothing happens, so they click again), and never a 403 toast
// (the host is asked to do something the peer already knew it was not allowed to do, and
// the answer arrives after the fact, detached from the button that caused it).
//
// Every screen touched by task 6 asks this same question about a different control, so the
// answer is computed here and unit-tested without a browser: that is what makes "a disabled
// control always carries an actionable reason" a property with a test rather than a rule
// three components have to remember.
import type { FleetRow } from './fleet'
import type { LinkCapability, LinkStatus, LinkSummary } from './link-api'

export type ActionState = { enabled: true } | { enabled: false; reason: string }

/** What the capability MEANS, as a verb phrase that reads inside a sentence. The raw
 *  capability id is always shown too — it is what the user must tick when minting the new
 *  key on the host — but "models:load" alone does not tell them what they lost. */
const CAPABILITY_VERB: Record<LinkCapability, string> = {
  'models:use': 'Chatting with models on',
  'models:wake': 'Waking models on',
  'models:load': 'Loading models on',
  'models:unload': 'Unloading models on',
  'downloads:read': 'Seeing downloads on',
  'downloads:write': 'Starting downloads on',
  'config:read': 'Reading settings on',
  'config:write': 'Changing settings on',
}

/** The connectivity/lifecycle half of the answer: a reason a NON-online link cannot do
 *  anything at all, whatever it was granted.
 *
 *  Deliberately checked BEFORE capabilities. An unreachable machine that also happens to
 *  lack the permission must say it is offline: told "not granted", the user goes off to
 *  mint a new key and re-link, hunting a permission problem that does not exist. The three
 *  failure states stay separate here for the same reason the wire type never collapsed them
 *  into one "offline" — each one has a different fix.
 *
 *  Returns `null` for `online`, i.e. "connectivity is not the problem, keep going". */
function connectivityReason(name: string, status: LinkStatus, lastError: string | null): string | null {
  switch (status) {
    case 'online':
      return null
    case 'unreachable':
      // Must read as OFFLINE, and must not mention permissions at all.
      return append(`${name} is offline, so this action is unavailable.`, lastError)
    case 'revoked':
      return append(
        `${name} revoked this link, so this action is unavailable. Relink to ${name} with a new link key to restore it.`,
        lastError,
      )
    case 'incompatible':
      return append(
        `${name} is running an incompatible version of TurboLLM, so this action is unavailable. Update TurboLLM on ${name}.`,
        lastError,
      )
    case 'unknown':
      return append(
        `${name} has not been checked yet, so this action is unavailable until its status is known.`,
        lastError,
      )
    default: {
      // A new LinkStatus member is a COMPILE error here rather than a silent `undefined`
      // reaching a tooltip as an empty (or literally "undefined") string.
      const never: never = status
      return never
    }
  }
}

/** Append the link's own message when it has one — it is the only part of the sentence that
 *  can say what actually went wrong ("Connection refused.", "401 from host."). */
function append(sentence: string, lastError: string | null): string {
  const extra = lastError?.trim()
  return extra ? `${sentence} ${extra}` : sentence
}

/** The sentence for "this link was not granted `cap`".
 *
 *  Exported because there are TWO places the user can meet this fact and they must not
 *  drift: the pre-flight disabled control (below), and the post-flight 403 the host itself
 *  returns when the two ends disagree about the grant (see `describeRemoteFailure` in
 *  remote-failure.ts). The peer greys controls off the handshake, so reaching that 403 at
 *  all means the handshake was stale — but the user should read the same explanation either
 *  way, not two differently-worded ones for the same underlying problem.
 *
 *  Names BOTH the capability and the machine that would have to grant it, and says what to
 *  do about it — this is the only place the user will ever learn any of it. */
export function capabilityReason(cap: LinkCapability, name: string): string {
  return `${CAPABILITY_VERB[cap]} ${name} needs the ${cap} permission, which this link was not granted. Mint a new link key on ${name} that includes ${cap}.`
}

/**
 * Is this action available on this row, and if not, what does the tooltip say?
 *
 * - A LOCAL row is always enabled: capabilities describe what ANOTHER machine let this one
 *   do, and they have no bearing on this machine's own models, downloads, or settings.
 * - A REMOTE row is gated first on connectivity (see `connectivityReason`), then on the
 *   capability the host actually granted at handshake — read from `grantedCapabilities`,
 *   never guessed from what a link "probably" allows.
 *
 * `link` is optional because the caller looks it up by `origin.linkId` and that lookup can
 * miss (the machine was unlinked while the list was on screen). A miss disables the control
 * rather than falling through to enabled — an unknown link is not a permitted one.
 */
export function actionState(
  cap: LinkCapability,
  origin: FleetRow<unknown>['origin'],
  link?: LinkSummary,
): ActionState {
  if (origin.kind === 'local') return { enabled: true }

  // The link's LIVE name where there is one: `origin.machine` was captured when the list
  // was merged and a rename since then would send the user looking for a machine that no
  // longer answers to that name. Mirrors the same choice in remote-models.ts.
  const name = link?.name ?? origin.machine

  if (!link) {
    return {
      enabled: false,
      reason: `${name} is no longer linked from this machine. Add the link again to use it.`,
    }
  }

  const blocked = connectivityReason(name, link.status, link.lastError)
  if (blocked) return { enabled: false, reason: blocked }

  if (!link.grantedCapabilities.includes(cap)) {
    return { enabled: false, reason: capabilityReason(cap, name) }
  }

  return { enabled: true }
}
