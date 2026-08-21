import { negotiateVersion, LINK_API_VERSIONS } from './protocol'
import type { LinkProbe } from './link-state'
import type { HelloResponse, LinkRecord } from './types'

const DEFAULT_TIMEOUT_MS = 8000

/** The peer's HTTP client for one linked host.
 *
 *  Every method returns a LinkProbe and NEVER throws. That is the whole contract: a
 *  linked host is remote hardware on someone's flaky Wi-Fi or an expiring Kaggle tunnel,
 *  and design invariant 3 says a link failure must never degrade local operation. A
 *  rejected promise escaping this class is a bug, not an edge case.
 *
 *  Every request is timeout-bounded — an unreachable host that accepts a TCP connection
 *  and then never answers is the realistic failure, and an unbounded fetch would hang
 *  the poll loop forever. */
export class LinkClient {
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly rec: Pick<LinkRecord, 'baseUrl' | 'token'>,
    opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
  ) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = opts?.fetchImpl ?? fetch
  }

  async hello(): Promise<LinkProbe & { raw?: HelloResponse }> {
    const res = await this.call('/api/link/v1/hello', 'POST')
    if (res.kind !== 'body') return res
    const body = res.body as Partial<HelloResponse>
    const version = negotiateVersion(LINK_API_VERSIONS, body.linkApiVersions)
    if (version === null) {
      return { kind: 'incompatible', theirVersions: Array.isArray(body.linkApiVersions) ? body.linkApiVersions : [] }
    }
    if (typeof body.machineId !== 'string' || !Array.isArray(body.capabilities)) {
      // 200 OK with a shape we don't recognise: a proxy, a captive portal, or an HTML
      // page. Treat as unreachable rather than adopting garbage into the link record.
      return { kind: 'network' }
    }
    return {
      kind: 'ok',
      machineId: body.machineId,
      capabilities: body.capabilities,
      version,
      raw: body as HelloResponse,
    }
  }

  /** Shared request path. Returns a discriminated result so callers never see an
   *  exception: `body` on a parsed 2xx, otherwise an http/network probe. */
  private async call(
    path: string,
    method: string,
  ): Promise<LinkProbe | { kind: 'body'; body: unknown }> {
    try {
      const res = await this.fetchImpl(`${this.rec.baseUrl}${path}`, {
        method,
        headers: { 'X-TurboLLM-Auth': this.rec.token, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) return { kind: 'http', status: res.status }
      const ct = res.headers.get('content-type') ?? ''
      if (!ct.includes('application/json')) return { kind: 'network' }
      const parsed: unknown = await res.json()
      // `application/json` guarantees valid JSON, not a useful shape: `null`, an array,
      // or a bare string/number all parse without throwing. A proxy, captive portal, or
      // misconfigured host can hand back any of those on a 200. Guarding here — not just
      // in hello() — means every future method on this class (models(), status(), …)
      // inherits the same total "never throws, never adopts garbage" guarantee.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { kind: 'network' }
      }
      return { kind: 'body', body: parsed }
    } catch {
      // Covers DNS failure, connection refused, TLS error, timeout abort, and malformed
      // JSON alike. All of them are "we could not talk to it" — never "revoked".
      return { kind: 'network' }
    }
  }
}
