// Security hardening for built-in tools.
// SSRF block: rejects private/loopback destinations before fetch_url executes, and again as each of its connections
// resolves its host (checkedLookup).
import type { LookupAddress, LookupOptions } from 'node:dns'
import { lookup } from 'node:dns/promises'
import type { LookupFunction } from 'node:net'
import { Agent } from 'undici'

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

const BLOCKED = 'Error: fetch_url blocked — private/loopback addresses are not allowed'

/** Every address a host name has, as Node's lookup gives them; `options` are the family and hints a connection asks
 *  for. */
type Resolve = (hostname: string, options: LookupOptions) => Promise<LookupAddress[]>
const systemResolve: Resolve = (hostname, options) => lookup(hostname, { ...options, all: true })
let resolveHost: Resolve = systemResolve

/** For tests: resolve host names with `resolve` instead of the system's resolver (null restores it). */
export function _setSsrfResolver(resolve: Resolve | null): void {
  resolveHost = resolve ?? systemResolve
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
    return BLOCKED
  }

  // Resolve the hostname and check every returned address.
  let addresses: string[]
  try {
    const results = await resolveHost(hostname, {})
    addresses = results.map((r) => r.address)
  } catch {
    // DNS resolution failed: let the fetch fail naturally. If its own lookup succeeds, checkedLookup checks that.
    return null
  }

  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      return BLOCKED
    }
  }

  return null
}

/** checkedLookup's refusal, which fetchWithSsrfCheck answers with checkSsrf's error text. */
class PrivateAddressError extends Error {}

/**
 * The lookup of each connection fetchWithSsrfCheck makes, so it connects only to addresses checked here. checkSsrf
 * resolves the host once and fetch() resolved it again to connect: a name answering a public address to the first
 * and 127.0.0.1 to the second (DNS rebinding) reached the daemon's own API, and so did a name whose first lookup
 * failed. An IP literal is connected to without a lookup; checkSsrf has checked it. An answer of no address fails
 * as Node's own lookup does, with ENOTFOUND. Exported for its tests.
 */
export const checkedLookup: LookupFunction = (hostname, options, callback) => {
  resolveHost(hostname, options).then(
    (addresses) => {
      if (addresses.length === 0) callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname }), '')
      else if (addresses.some((a) => isPrivateIp(a.address))) callback(new PrivateAddressError(BLOCKED), '')
      else if (options.all) callback(null, addresses)
      else callback(null, addresses[0].address, addresses[0].family)
    },
    (e: NodeJS.ErrnoException) => callback(e, ''),
  )
}

/** fetch_url's connections, each resolving its host through checkedLookup (on every redirect hop). An undici Agent,
 *  which the runtime's fetch takes as it takes server.ts's global one; its types are the package's, not fetch's. */
const checkedDispatcher = new Agent({ connect: { lookup: checkedLookup } }) as unknown as RequestInit['dispatcher']

/** Whether fetch() failed because checkedLookup refused the address: the error is fetch's "fetch failed", with
 *  the refusal as its cause. */
function refusedByLookup(e: unknown): boolean {
  for (let c = e, depth = 0; c instanceof Error && depth < 4; c = c.cause, depth++) {
    if (c instanceof PrivateAddressError) return true
  }
  return false
}

/** Redirect hops followed (each one re-checked) before giving up. */
const MAX_REDIRECTS = 5

/**
 * fetch() hands header values over one char per byte (latin1), so a server sending a raw UTF-8
 * Location (`/café` as the bytes C3 A9) reads as `/cafÃ©`, which new URL() would percent-encode
 * into a different path. fetch()'s own follow re-decodes such a value as UTF-8, as browsers do;
 * this does the same. A value that isn't a valid UTF-8 byte string that way (a runtime that already
 * decoded it, or a latin1 Location) is kept as it is.
 */
function decodeLocation(location: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for non-ASCII/non-Latin1 bytes is the point of this guard
  if (!/[^\x20-\x7e]/.test(location) || /[^\x00-\xff]/.test(location)) return location
  const bytes = Buffer.from(location, 'latin1')
  const utf8 = bytes.toString('utf8')
  // Invalid UTF-8 decodes to U+FFFD, which doesn't encode back to the same bytes. (Not
  // TextDecoder's `fatal`, which a Node built without ICU refuses.)
  return Buffer.from(utf8, 'utf8').equals(bytes) ? utf8 : location
}

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
    let resp: Response
    try {
      resp = await fetch(current, { ...init, redirect: 'manual', dispatcher: checkedDispatcher })
    } catch (e) {
      if (refusedByLookup(e)) return BLOCKED
      throw e
    }
    const location = resp.status >= 300 && resp.status < 400 ? resp.headers.get('location') : null
    if (!location) return resp
    await resp.body?.cancel().catch(() => {})
    if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`)
    current = new URL(decodeLocation(location), current).toString()
    // fetch() would happily read a data: URL; the automatic follow only ever allowed http(s).
    if (!/^https?:$/.test(new URL(current).protocol)) throw new Error('redirected to a non-HTTP URL')
  }
}
