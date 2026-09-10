/** The narrow seam auth.ts needs from remote access (ADR-422, spec 30 §2.2).
 *
 *  Deliberately one method: `auth.ts` must be testable with a two-line fake, and must not
 *  acquire a dependency on the provider machinery that arrives in Phase 2. The full
 *  RemoteAccessManager satisfies this interface; so does `{ ingressPort: () => 6997 }`. */
export interface RemoteIngress {
  /** The loopback port providers connect to, or undefined when nothing is listening. */
  ingressPort(): number | undefined
}
