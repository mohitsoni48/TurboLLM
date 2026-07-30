// Session-scoped auth tokens for terminal-agent CLI subprocesses (ADR-284) — lets the gateway
// identify WHICH Code session a given /v1/messages or /v1/* request came from, so it can apply
// that session's live settings (thinking-budget override, gateway.ts) and attribute usage stats
// to the right session (api_usage.code_session_id). Every terminal-launched CLI previously shared
// the same static 'turbollm-local' token (cli-launch.ts), which is fine for auth but gives the
// gateway no way to tell two concurrent terminal-agent sessions apart.
//
// Pure in-memory: this is ephemeral runtime state tied to a live CLI subprocess — a daemon
// restart already kills the PTY, so there's nothing here worth persisting to disk.
import { randomBytes } from 'node:crypto'

export class SessionAuthRegistry {
  private sessionToToken = new Map<string, string>()
  private tokenToSession = new Map<string, string>()
  private sessionThinkingBudget = new Map<string, number>()

  /** Mint a token for a Code session — idempotent: returns the SAME token on every call for a
   *  given session (a reconnect/remount must never invalidate the CLI's already-running auth). */
  mint(codeSessionId: string): string {
    const existing = this.sessionToToken.get(codeSessionId)
    if (existing) return existing
    const token = `tllm-cs-${randomBytes(24).toString('hex')}`
    this.sessionToToken.set(codeSessionId, token)
    this.tokenToSession.set(token, codeSessionId)
    return token
  }

  /** The Code session a presented token belongs to, or null for an unrecognized/expired token. */
  resolve(token: string): string | null {
    return this.tokenToSession.get(token) ?? null
  }

  /** Drop a session's token (terminal killed/exited) — safe to call even if none was ever
   *  minted. Deliberately does NOT clear the session's stored thinking budget: a model-relaunch
   *  (revoke + mint again under the same codeSessionId) should keep whatever the user had the
   *  slider set to, not silently reset it. */
  revoke(codeSessionId: string): void {
    const token = this.sessionToToken.get(codeSessionId)
    if (token) this.tokenToSession.delete(token)
    this.sessionToToken.delete(codeSessionId)
  }

  /** Set (or clear, with `null`) the live thinking-budget override for a session — takes effect
   *  on the session's NEXT gateway request, no CLI restart involved (gateway.ts injects it into
   *  the outbound request server-side). Keyed by codeSessionId, not by token, so it can be set
   *  before a terminal/token even exists yet (composer mounts before the terminal connects). */
  setThinkingBudget(codeSessionId: string, tokens: number | null): void {
    if (tokens === null) this.sessionThinkingBudget.delete(codeSessionId)
    else this.sessionThinkingBudget.set(codeSessionId, tokens)
  }

  /** The thinking-budget override for whichever session `token` belongs to, or null when the
   *  token is unrecognized or no override has been set. */
  getThinkingBudgetForToken(token: string): number | null {
    const sessionId = this.tokenToSession.get(token)
    if (!sessionId) return null
    return this.sessionThinkingBudget.get(sessionId) ?? null
  }
}

/** Process-wide singleton — both terminal-routes.ts (mint/revoke) and gateway.ts
 *  (resolve/getThinkingBudgetForToken) need to reach the SAME registry, and neither
 *  depends on per-request Deps, so a plain module singleton (not threaded through Deps)
 *  is the simplest correct choice here. */
export const sessionAuth = new SessionAuthRegistry()
