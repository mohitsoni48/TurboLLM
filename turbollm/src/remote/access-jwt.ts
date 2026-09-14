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
const cache = new Map<string, { at: number; jwks: Jwks }>()

/** Fetch and cache a team's signing keys. Cached for an hour: Cloudflare rotates these
 *  rarely, and a fetch on every request would put an outbound network call in the auth path
 *  of every single tunneled request. */
export async function fetchJwks(teamDomain: string, fetchImpl: typeof fetch = fetch): Promise<Jwks> {
  const url = `${teamDomain.replace(/\/+$/, '')}/cdn-cgi/access/certs`
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < JWKS_TTL_MS) return hit.jwks
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`could not fetch Access signing keys (${res.status})`)
  const jwks = (await res.json()) as Jwks
  cache.set(url, { at: Date.now(), jwks })
  return jwks
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
  if (typeof claims.exp === 'number' && claims.exp < now) return { ok: false, reason: 'assertion has expired' }
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return { ok: false, reason: 'assertion is not yet valid' }

  return { ok: true, sub: String(claims.sub ?? ''), email: String(claims.email ?? '') }
}
