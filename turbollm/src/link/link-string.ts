const PREFIX = 'tllink_'

/** Pack a host URL and its token into ONE copyable string, so linking is a single paste
 *  rather than two fields the user can mismatch (spec §6.1). Not encryption — the token
 *  is in there in the clear, exactly as it would be in two separate fields. */
export function encodeLinkString(baseUrl: string, token: string): string {
  const u = baseUrl.trim().replace(/\/+$/, '')
  const json = JSON.stringify({ u, t: token.trim() })
  return PREFIX + Buffer.from(json, 'utf8').toString('base64url')
}

/** Parse a pasted link string. Returns null — never throws — for ANY malformed input:
 *  this is untrusted, hand-pasted text and the UI needs a friendly rejection, not a
 *  stack trace. Also rejects non-http(s) schemes so a pasted file:// or javascript:
 *  URL can never become a baseUrl the peer then fetches. */
export function decodeLinkString(s: string): { baseUrl: string; token: string } | null {
  const trimmed = s.trim()
  if (!trimmed.startsWith(PREFIX)) return null
  let parsed: unknown
  try {
    const json = Buffer.from(trimmed.slice(PREFIX.length), 'base64url').toString('utf8')
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { u, t } = parsed as { u?: unknown; t?: unknown }
  if (typeof u !== 'string' || typeof t !== 'string' || !u || !t) return null
  let url: URL
  try {
    url = new URL(u)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return { baseUrl: u.replace(/\/+$/, ''), token: t }
}
