// turbollm/src/ext/audit.ts
//
// Spec 27 §10. Records THAT a tenant-scoped mutation happened — actor, action, target,
// request id, outcome — and never what was written. Reads are not audited: they would
// dwarf the mutations without adding accountability. There is deliberately NO content
// column anywhere in this module or the `ext_audit` table it drives (db.ts's v48 migration
// block) — an audit trail that carried content would just be a second, unscoped copy of
// every conversation, defeating the tenancy boundary it exists to police.
import { randomUUID } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import type { ConversationStore } from '../chat/db.js'

export interface AuditEntry {
  tenant: string
  owner: string
  /** Dotted verb: chat.create | chat.update | chat.delete | message.create |
   *  message.update | message.delete | run.start | run.cancel */
  action: string
  targetId: string | null
  requestId: string
  status: number
  /** The key prefix only — never the key, never its hash. */
  keyPrefix: string
}

export interface AuditRow extends AuditEntry { id: string; at: string }

/** Default retention window for `prune()` (server.ts drives this off the existing 30s
 *  idempotency/run-reaper tick). Not mandated by spec 27 beyond "must be bounded" — 30 days
 *  mirrors the window the tests exercise and gives an operator a full billing-cycle's worth
 *  of "who did what" before entries age out. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 30

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

export class AuditLog {
  constructor(private readonly db: ConversationStore) {}

  shouldAudit(method: string): boolean {
    return MUTATING.has(method.toUpperCase())
  }

  record(e: AuditEntry): void {
    this.db.handle.prepare(
      `INSERT INTO ext_audit (id,tenant,owner,action,target_id,request_id,status,key_prefix,at)
       VALUES ($id,$t,$o,$a,$tg,$r,$s,$k,$at)`,
    ).run({
      $id: randomUUID(), $t: e.tenant, $o: e.owner, $a: e.action,
      $tg: e.targetId, $r: e.requestId, $s: e.status, $k: e.keyPrefix,
      $at: new Date().toISOString(),
    })
  }

  list(tenant: string, opts: { limit?: number; since?: string }): AuditRow[] {
    const rows = this.db.handle.prepare(
      `SELECT * FROM ext_audit WHERE tenant = $t AND ($since IS NULL OR at >= $since)
       ORDER BY at DESC LIMIT $l`,
    ).all({ $t: tenant, $since: opts.since ?? null, $l: opts.limit ?? 200 }) as unknown as Array<{
      id: string; tenant: string; owner: string; action: string; target_id: string | null
      request_id: string; status: number; key_prefix: string; at: string
    }>
    return rows.map((r) => ({
      id: r.id, tenant: r.tenant, owner: r.owner, action: r.action,
      targetId: r.target_id, requestId: r.request_id, status: r.status,
      keyPrefix: r.key_prefix, at: r.at,
    }))
  }

  prune(maxAgeDays: number): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()
    const r = this.db.handle.prepare(`DELETE FROM ext_audit WHERE at < $c`).run({ $c: cutoff }) as unknown as { changes: number }
    return r.changes
  }
}

/** Store row → wire shape. `tenant` is deliberately absent (dto.ts's `toChatDTO` doc comment
 *  explains why: a caller only ever sees its own tenant's data, so echoing it back is noise
 *  and removes a class of cross-tenant leak). */
export function toAuditDTO(r: AuditRow): Record<string, unknown> {
  return {
    id: r.id, owner: r.owner, action: r.action, target_id: r.targetId,
    request_id: r.requestId, status: r.status, key_prefix: r.keyPrefix, at: r.at,
  }
}

/** Best-effort actor key prefix. Mirrors auth.ts's own `presented()` (Bearer header first,
 *  then `X-Api-Key`) without importing it — that function is intentionally private to auth.ts,
 *  and duplicating four lines here is cheaper than widening its export surface for one caller.
 *  Only the first 8 characters of the PRESENTED key are kept, never the whole key. */
function keyPrefixFrom(c: Context): string {
  const auth = c.req.header('Authorization') ?? ''
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
  const key = bearer || (c.req.header('X-Api-Key')?.trim() ?? '')
  return key.slice(0, 8)
}

/** Best-effort actor. Most mutating routes (spec 27 §10) carry `owner` in the JSON body, not
 *  the query string — a POST/PATCH's `owner` only shows up as a query param on the odd route
 *  that has no body at all (e.g. DELETE). Hono caches the parsed body after the FIRST
 *  `c.req.json()` call, so re-reading it here (after the handler already awaited it) is a
 *  cache hit, not a second stream consumption. */
async function ownerOf(c: Context): Promise<string> {
  const q = c.req.query('owner')
  if (q?.trim()) return q.trim()
  try {
    const b = (await c.req.json()) as { owner?: string }
    return b?.owner?.trim() || 'default'
  } catch {
    return 'default'
  }
}

/** Wraps one mutating route with an audit record of its outcome. `action` is supplied by the
 *  call site (routes.chats.ts / routes.runs.ts) rather than inferred from the path — the two
 *  are 1:1 with the dotted verbs in `AuditEntry`'s doc comment, and passing it explicitly
 *  means there is no path-regex to keep in sync as routes change. Runs `next()` FIRST so the
 *  recorded status reflects what the client actually received, including error responses —
 *  an attempted-but-refused mutation (404, 409, ...) is itself worth recording. */
export function auditMiddleware(audit: AuditLog, action: string): MiddlewareHandler {
  return async (c, next) => {
    await next()
    if (!audit.shouldAudit(c.req.method)) return
    const tenant = c.get('extTenant') as string | undefined
    if (!tenant) return   // an unauthenticated request has no tenant to attribute
    audit.record({
      tenant,
      owner: await ownerOf(c),
      action,
      targetId: c.req.param('id') ?? null,
      requestId: c.res.headers.get('X-Request-Id') ?? 'unknown',
      status: c.res.status,
      keyPrefix: keyPrefixFrom(c),
    })
  }
}
