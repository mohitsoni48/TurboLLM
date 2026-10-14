// Security hardening for built-in tools.
// SSRF block: rejects private/loopback destinations before fetch_url executes.
import { lookup } from 'node:dns/promises'

/** RFC-1918, loopback, link-local, CGNAT and IPv6 unique-local CIDR ranges to block. */
const PRIVATE_RANGES: Array<(ip: string) => boolean> = [
  // 127.0.0.0/8
  (ip) => ip === '::1' || /^127\./.test(ip),
  // 0.0.0.0/8 and :: — connecting to the unspecified address reaches this host on Linux/macOS
  (ip) => ip === '::' || /^0\./.test(ip),
  // 10.0.0.0/8
  (ip) => /^10\./.test(ip),
  // 172.16.0.0/12
  (ip) => { const m = ip.match(/^172\.(\d+)\./) ; return !!m && +m[1] >= 16 && +m[1] <= 31 },
  // 192.168.0.0/16
  (ip) => /^192\.168\./.test(ip),
  // 169.254.0.0/16 link-local
  (ip) => /^169\.254\./.test(ip),
  // 100.64.0.0/10 carrier-grade NAT (also Tailscale's address space)
  (ip) => { const m = ip.match(/^100\.(\d+)\./); return !!m && +m[1] >= 64 && +m[1] <= 127 },
  // fc00::/7 unique-local
  (ip) => /^f[cd][0-9a-f]{2}:/i.test(ip),
  // fe80::/10 link-local
  (ip) => /^fe[89ab][0-9a-f]:/i.test(ip),
]

/** Exported for its tests. */
export function isPrivateIp(ip: string): boolean {
  // An IPv4-mapped IPv6 address (an AAAA answer of `::ffff:127.0.0.1`) connects to the embedded
  // IPv4 host, so it is tested against the IPv4 ranges — in dotted or hex form.
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (dotted) ip = dotted[1]
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    ip = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return PRIVATE_RANGES.some((fn) => fn(ip))
}

/**
 * Checks whether the given http/https URL targets a private or loopback address.
 * Returns an error string if blocked, or null if the URL is safe to fetch.
 * Bare hostnames (no dot in the hostname) are always blocked.
 */
export async function checkSsrf(url: string): Promise<string | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const hostname = parsed.hostname

  // Block bare hostnames (no dot = likely an internal alias like "localhost", "internal").
  if (!hostname.includes('.')) {
    return 'Error: fetch_url blocked — private/loopback addresses are not allowed'
  }

  // Resolve the hostname and check every returned address.
  let addresses: string[]
  try {
    const results = await lookup(hostname, { all: true })
    addresses = results.map((r) => r.address)
  } catch {
    // DNS resolution failed — treat as non-private (let the actual fetch fail naturally).
    return null
  }

  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      return 'Error: fetch_url blocked — private/loopback addresses are not allowed'
    }
  }

  return null
}

/** Redirect hops followed (each one re-checked) before giving up. */
const MAX_REDIRECTS = 5

/**
 * `fetch()` with the SSRF check applied to EVERY hop. fetch's default `redirect: 'follow'` checks
 * nothing after the first URL, so a public page answering `302 Location: http://127.0.0.1:<port>/…`
 * (or a cloud metadata address) would have that internal response fetched and returned. Redirects
 * are therefore followed by hand, and each Location is checked before it is requested.
 * Returns the final response, or checkSsrf's error string when a hop is blocked; throws like
 * fetch() does on a network error, and on too many redirects.
 */
export async function fetchWithSsrfCheck(url: string, init: RequestInit): Promise<Response | string> {
  let current = url
  for (let hop = 0; ; hop++) {
    const blocked = await checkSsrf(current)
    if (blocked) return blocked
    const resp = await fetch(current, { ...init, redirect: 'manual' })
    const location = resp.status >= 300 && resp.status < 400 ? resp.headers.get('location') : null
    if (!location) return resp
    await resp.body?.cancel().catch(() => {})
    if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`)
    current = new URL(location, current).toString()
    // fetch() would happily read a data: URL; the automatic follow only ever allowed http(s).
    if (!/^https?:$/.test(new URL(current).protocol)) throw new Error('redirected to a non-HTTP URL')
  }
}
