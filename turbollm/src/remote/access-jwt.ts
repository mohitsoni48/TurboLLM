// Cloudflare Access assertion verification (spec 30 §6.2).
//
// Cloudflare's docs say a tunnel-connected origin MAY trust the Cf-Access-Jwt-Assertion
// header without validating it. We validate anyway: it is roughly eighty lines and it
// removes the "unless" from that sentence, which is the sort of qualifier that stops being
// true the moment someone changes how the origin is reachable.
//
// No new dependency — Node's crypto reads a JWK directly. `turbollm` stays at 14 production
// deps, and a JWT library is not worth the fifteenth.
import { createPublicKey, createVerify, verify as cryptoVerify } from 'node:crypto'

export interface Jwks {
  keys: Array<Record<string, string>>
}

export type AccessResult = { ok: true; sub: string; email: string } | { ok: false; reason: string }

const JWKS_TTL_MS = 60 * 60_000
// I2 (Phase 5 final review): a failed fetch used to cache nothing at all, so an unauthenticated
// party sending a junk assertion at the public URL forced one untimed outbound HTTPS request
// per request, inside the auth path, before any credential was even checked. A short negative
// TTL bounds that to at most one real fetch per window, while staying far shorter than the
// success TTL so a transient outage self-heals quickly once the team domain is reachable again.
const JWKS_FAILURE_TTL_MS = 30_000
// Bounds how long a single JWKS fetch can hang the auth path when the team domain is
// unreachable — previously unbounded, so an unreachable domain could stall every tunneled
// request indefinitely.
const JWKS_FETCH_TIMEOUT_MS = 5_000
const cache = new Map<string, { at: number; jwks: Jwks | null }>()

/** Fetch and cache a team's signing keys. A success is cached for an hour: Cloudflare rotates
 *  these rarely, and a fetch on every request would put an outbound network call in the auth
 *  path of every single tunneled request. A FAILURE is cached too, briefly (see
 *  JWKS_FAILURE_TTL_MS above) — the caller (`lanAuth`) treats "could not fetch" as "no verified
 *  assertion", so without this a failing team domain would be re-fetched on every single
 *  request that presents any assertion at all, junk or not. */
export async function fetchJwks(teamDomain: string, fetchImpl: typeof fetch = fetch): Promise<Jwks> {
  const url = `${teamDomain.replace(/\/+$/, '')}/cdn-cgi/access/certs`
  const hit = cache.get(url)
  if (hit) {
    const ttl = hit.jwks ? JWKS_TTL_MS : JWKS_FAILURE_TTL_MS
    if (Date.now() - hit.at < ttl) {
      if (hit.jwks) return hit.jwks
      throw new Error('could not fetch Access signing keys (cached failure)')
    }
  }
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`could not fetch Access signing keys (${res.status})`)
    const jwks = (await res.json()) as Jwks
    cache.set(url, { at: Date.now(), jwks })
    return jwks
  } catch (e) {
    cache.set(url, { at: Date.now(), jwks: null })
    throw e
  }
}

function decodeSegment(seg: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function verifyAccessJwt(
  token: string,
  opts: { teamDomain: string; aud: string; jwks: Jwks },
): Promise<AccessResult> {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed assertion' }
  const [headB64, bodyB64, sigB64] = parts

  const header = decodeSegment(headB64)
  const claims = decodeSegment(bodyB64)
  if (!header || !claims) return { ok: false, reason: 'malformed assertion' }

  // Explicit allow-list, never "whatever the header says". Honouring an attacker-chosen alg
  // — 'none' above all — is the classic JWT break, and the header is attacker-controlled.
  const alg = String(header.alg ?? '')
  if (alg !== 'RS256' && alg !== 'ES256') return { ok: false, reason: `unsupported signature algorithm ${alg || 'none'}` }

  const kid = String(header.kid ?? '')
  const jwk = opts.jwks.keys.find((k) => k.kid === kid)
  if (!jwk) return { ok: false, reason: 'no signing key matches this assertion' }

  const signingInput = `${headB64}.${bodyB64}`
  const signature = Buffer.from(sigB64, 'base64url')
  let signatureOk = false
  try {
    const key = createPublicKey({ key: jwk as never, format: 'jwk' })
    signatureOk =
      alg === 'RS256'
        ? createVerify('RSA-SHA256').update(signingInput).verify(key, signature)
        : cryptoVerify('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' }, signature)
  } catch {
    signatureOk = false
  }
  if (!signatureOk) return { ok: false, reason: 'signature does not verify' }

  // Claims are only meaningful AFTER the signature check — checking them first would be
  // reading attacker-controlled data and calling it validation.
  const iss = String(claims.iss ?? '')
  if (iss.replace(/\/+$/, '') !== opts.teamDomain.replace(/\/+$/, '')) {
    return { ok: false, reason: 'issuer does not match your Access team domain' }
  }
  const audClaim = claims.aud
  const auds = Array.isArray(audClaim) ? audClaim.map(String) : [String(audClaim ?? '')]
  if (!auds.includes(opts.aud)) return { ok: false, reason: 'audience does not match this application' }

  const now = Math.floor(Date.now() / 1000)
  // M2 (Phase 5 final review): `exp` must be mandatory, not merely checked-when-present — an
  // assertion with no `exp` claim at all, or a non-numeric one, previously read as "never
  // expires". Cloudflare always sets this in practice, so this is defense-in-depth rather
  // than a live bug; it stops being latent the moment a signer other than Cloudflare enters
  // the picture (see C3(b)/M1 in the same review).
  if (typeof claims.exp !== 'number') return { ok: false, reason: 'assertion has no expiry' }
  if (claims.exp < now) return { ok: false, reason: 'assertion has expired' }
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return { ok: false, reason: 'assertion is not yet valid' }

  return { ok: true, sub: String(claims.sub ?? ''), email: String(claims.email ?? '') }
}
