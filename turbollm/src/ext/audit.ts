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
// Side-effect-only type import: pulls in hono/request-id's own `declare module 'hono' {
// interface ContextVariableMap { requestId: string } }` augmentation so `c.get('requestId')`
// below is typed, regardless of whether some OTHER file in the program happens to import the
// runtime middleware first. routes.chats.ts is the one that actually mounts it (see that
// file's own comment on WHY it must run ahead of extAuth/rate-limiting/every route).
import type {} from 'hono/request-id'
import type { ConversationStore } from '../chat/db.js'

// Same declaration-merging pattern auth.ts uses for `extTenant`/`extScopes`: a handler that
// creates something sets this on the way out (`c.set('auditTargetId', chat.id)`) so
// `auditMiddleware` can record the ACTUAL created resource's id instead of guessing from the
// route's own `:id` param — which for a `POST /chats` or `POST .../messages` create route
// either doesn't exist or names the PARENT, not the thing that was just created.
declare module 'hono' {
  interface ContextVariableMap {
    auditTargetId: string
  }
}

export interface AuditEntry {
  tenant: string
  owner: string
  /** Dotted verb: chat.create | chat.update | chat.delete | message.create |
   *  message.update | message.delete | run.start | run.cancel — plus the one sentinel value
   *  `request.rate_limited`, used ONLY by `recordRateLimitRefusal` below for a mutation
   *  rejected by the blanket per-tenant budget before any route-specific handler (and so
   *  before the specific verb it was headed for) was ever reached. */
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

  // `owner` is a required parameter, not optional — every other read on this surface (chats,
  // messages, runs, the idempotency replay check) is scoped by tenant AND owner via `scopeFor`;
  // this was the one exception (final-review security recheck, live-reproduced as a real
  // cross-owner leak — same class as C1/N1 — chaining with the caller-supplied-owner design
  // into full cross-owner chat/message content disclosure via harvested owner ids + chat ids).
  list(tenant: string, owner: string, opts: { limit?: number; since?: string }): AuditRow[] {
    const rows = this.db.handle.prepare(
      `SELECT * FROM ext_audit WHERE tenant = $t AND owner = $o AND ($since IS NULL OR at >= $since)
       ORDER BY at DESC LIMIT $l`,
    ).all({ $t: tenant, $o: owner, $since: opts.since ?? null, $l: opts.limit ?? 200 }) as unknown as Array<{
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
 *  recorded status reflects what the client actually received, including error responses — an
 *  attempted-but-refused mutation (403 insufficient_scope, 404, 409, ...) is itself worth
 *  recording, which is also WHY this must be registered as the OUTERMOST wrapper on each
 *  route — ahead of `requireScope`, not after it (see routes.chats.ts/routes.runs.ts's own
 *  comments on this ordering, and mount.ts's blanket rate-limit middleware for the one refusal
 *  path that can't be fixed by per-route ordering at all, since it runs before ANY route -
 *  specific middleware).
 *
 *  `targetId` prefers `c.get('auditTargetId')` — set by the handler itself right before it
 *  returns, when the handler just CREATED something the route's own `:id` param can't name
 *  (`POST /chats`, `POST .../messages`, `POST .../generate`) — falling back to the route's
 *  `:id` param for every route that already names its target that way (update/delete/cancel). */
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
      targetId: (c.get('auditTargetId') as string | undefined) ?? c.req.param('id') ?? null,
      requestId: (c.get('requestId') as string | undefined) ?? 'unknown',
      status: c.res.status,
      keyPrefix: keyPrefixFrom(c),
    })
  }
}

/** The blanket per-tenant request-budget middleware (routes.chats.ts) runs BEFORE any
 *  route-specific middleware at all — including a reordered `auditMiddleware` — so a 429
 *  refusal there never reaches it, and there is no route-specific `action` string to use
 *  either (no route has matched yet). Records the refusal directly from that middleware
 *  instead, under the `request.rate_limited` sentinel action. Gated by `shouldAudit` exactly
 *  like `auditMiddleware` itself: the budget covers read traffic too (limits.ts's own comment
 *  on why), but only mutations belong in the trail.
 *
 *  `status` is a required, EXPLICIT parameter rather than read off `c.res.status` — unlike
 *  `auditMiddleware` above (which reads `c.res` only after `await next()` has let Hono's own
 *  dispatch loop assign it from the downstream return value), this fires from inside the SAME
 *  middleware that is about to construct and return the error response. `c.json()`/`extError`
 *  build a `Response` object directly; they do not write it onto `c.res` themselves — only
 *  Hono's `compose()` does that, by assigning the HANDLER'S RETURN VALUE after the handler
 *  resolves. Called before that return, `c.res` would still reflect whatever it was already
 *  (typically an unset default), not the 429 about to be sent — reading it here would silently
 *  record the wrong status. */
export async function recordRateLimitRefusal(audit: AuditLog, c: Context, status: number): Promise<void> {
  if (!audit.shouldAudit(c.req.method)) return
  const tenant = c.get('extTenant') as string | undefined
  if (!tenant) return
  audit.record({
    tenant,
    owner: await ownerOf(c),
    action: 'request.rate_limited',
    targetId: c.req.param('id') ?? null,
    requestId: (c.get('requestId') as string | undefined) ?? 'unknown',
    status,
    keyPrefix: keyPrefixFrom(c),
  })
}
