// Security hardening for built-in tools.
// SSRF block: rejects private/loopback destinations before fetch_url executes.
import { lookup } from 'node:dns/promises'

/** RFC-1918, loopback, and link-local CIDR ranges to block. */
const PRIVATE_RANGES: Array<(ip: string) => boolean> = [
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
]

function isPrivateIp(ip: string): boolean {
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
