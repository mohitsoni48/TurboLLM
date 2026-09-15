import { ApiError } from './api'

/** Classifies a failed `/api/v1/status` poll into the two cases the shell must treat
 *  differently from a genuinely unreachable daemon (App.tsx's "Lost connection" overlay):
 *
 *  - `needsAuth` (401): the daemon is up but wants a credential — show the key prompt.
 *  - `scopedTokenLimited` (403, C2 follow-up — Phase 5 final-review-fix re-review, ADR-422):
 *    the daemon is up, a credential WAS presented, but it is a capability-scoped remote-access
 *    token that was never granted `config:read` — `/api/v1/status` deliberately stays behind
 *    that capability because it carries the engine's launchCommand and raw stderr, real
 *    filesystem detail (auth.ts's `requiredCapability`). There is nothing to prompt the user
 *    for here — a different token SCOPE would fix it, not a different token — so this exists
 *    only to suppress the overlay, never to show a dialog.
 *
 *  Exported and tested directly (not re-derived in a test) for the same reason
 *  `chatCodeAuthorization` is: this codebase has previously shipped a regression where a
 *  reviewer re-derived an inline boolean instead of importing the real one, measured the
 *  re-derivation, and missed that production diverged from it (chat-routes.test.ts's own
 *  account of that incident). */
export function classifyStatusError(isError: boolean, error: unknown): { needsAuth: boolean; scopedTokenLimited: boolean } {
  if (!isError || !(error instanceof ApiError)) return { needsAuth: false, scopedTokenLimited: false }
  return { needsAuth: error.status === 401, scopedTokenLimited: error.status === 403 }
}
