// Security hardening for built-in tools.
// SSRF block: rejects private/loopback destinations before fetch_url executes, on the first
// URL and on every redirect it follows (ssrfSafeFetch).
import { lookup } from 'node:dns/promises'

/** RFC-1918, loopback, and link-local CIDR ranges to block. */
const PRIVATE_RANGES: Array<(ip: string) => boolean> = [
  // 0.0.0.0/8 "this host": connecting to 0.0.0.0 reaches loopback on Linux and macOS
  (ip) => /^0\./.test(ip),
  // 127.0.0.0/8
  (ip) => ip === '::1' || /^127\./.test(ip),
  // 10.0.0.0/8
  (ip) => /^10\./.test(ip),
  // 172.16.0.0/12
  (ip) => { const m = ip.match(/^172\.(\d+)\./) ; return !!m && +m[1] >= 16 && +m[1] <= 31 },
  // 192.168.0.0/16
  (ip) => /^192\.168\./.test(ip),
  // 169.254.0.0/16 link-local
  (ip) => /^169\.254\./.test(ip),
  // IPv6 unspecified, unique-local fc00::/7 and link-local fe80::/10
  (ip) => ip === '::' || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe[89ab][0-9a-f]:/i.test(ip),
]

function isPrivateIp(ip: string): boolean {
  // An IPv4-mapped IPv6 address (::ffff:127.0.0.1) is the IPv4 address underneath.
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  const addr = v4 ? v4[1] : ip
  return PRIVATE_RANGES.some((fn) => fn(addr))
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

/** Redirects ssrfSafeFetch follows before giving up. */
export const SSRF_MAX_REDIRECTS = 5

/**
 * fetch() with checkSsrf applied to EVERY hop, not only the first URL. A plain fetch follows
 * redirects on its own, so a public page that passed the check could 302 the request to
 * loopback (the daemon's own API trusts loopback callers), the LAN or a cloud metadata address.
 * Redirects are followed by hand here, each new location checked before it is requested.
 * Returns the final Response, or an error string in checkSsrf's shape when a hop is blocked.
 * Network errors from fetch propagate to the caller as before.
 */
export async function ssrfSafeFetch(url: string, init: RequestInit = {}): Promise<Response | string> {
  let current = url
  for (let hop = 0; hop <= SSRF_MAX_REDIRECTS; hop++) {
    const blocked = await checkSsrf(current)
    if (blocked) return blocked
    const resp = await fetch(current, { ...init, redirect: 'manual' })
    const location = resp.headers.get('location')
    if (resp.status < 300 || resp.status >= 400 || !location) return resp
    await resp.body?.cancel().catch(() => {})
    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      return 'Error: fetch_url blocked — the page redirected to an invalid URL'
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      return 'Error: fetch_url blocked — the page redirected to a non-http(s) URL'
    }
    current = next.toString()
  }
  return `Error: fetch_url blocked — more than ${SSRF_MAX_REDIRECTS} redirects`
}
