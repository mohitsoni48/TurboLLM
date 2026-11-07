// What the chat database's query groups share (db.ts, usage-stats.ts, routine-repo.ts,
// agent-run-repo.ts): named-parameter and change-count types, tolerant JSON, and keyset paging.
import type { SqlDb, SqlValue } from './store/sqlite-adapter.js'

// Named-param objects need an explicit cast to Record<string, SqlValue>
export type P = Record<string, SqlValue>

export interface Changes { changes: number }

export function safeJson(s: string): unknown { try { return JSON.parse(s) } catch { return {} } }

/** Thrown for a list cursor this store did not issue; the list routes answer 400 invalid_cursor. */
export class InvalidCursorError extends Error {
  constructor() {
    super('invalid_cursor: not a cursor this list issued')
    this.name = 'InvalidCursorError'
  }
}

/** One page request of a newest-first list. `cursor` is the previous page's `nextCursor`. */
export interface PageOpts { limit?: number; cursor?: string }

/** Keyset position (sort value, id) as opaque base64url JSON — the same shape
 *  sqlite-chat-store.ts's chat list uses. */
export function encodePageCursor(sortValue: string, id: string): string {
  return Buffer.from(JSON.stringify({ u: sortValue, i: id }), 'utf8').toString('base64url')
}

export function decodePageCursor(raw: string): { u: string; i: string } {
  let parsed: { u?: unknown; i?: unknown } | null
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { u?: unknown; i?: unknown } | null
  } catch {
    throw new InvalidCursorError()
  }
  if (typeof parsed?.u !== 'string' || typeof parsed?.i !== 'string') throw new InvalidCursorError()
  return { u: parsed.u, i: parsed.i }
}

export function clampPageLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return fallback
  return Math.min(Math.floor(limit), max)
}

/** One newest-first page of `table` in (sortColumn DESC, id DESC) order. Keyset, not OFFSET:
 *  the cursor is the last row's position, so a deep page costs what the first one does, and a
 *  row updated between pages can't shift the others into a duplicate or a gap. */
export function keysetPage<R extends { id: string }>(
  db: SqlDb,
  q: { columns: string; table: string; sortColumn: string; sortValue: (row: R) => string; where: string[]; params: P },
  page: PageOpts, defaultLimit: number, maxLimit: number,
): { rows: R[]; nextCursor: string | null } {
  const limit = clampPageLimit(page.limit, defaultLimit, maxLimit)
  const where = [...q.where]
  const params: P = { ...q.params, $lim: limit + 1 }
  if (page.cursor) {
    const at = decodePageCursor(page.cursor)
    where.push(`(${q.sortColumn}, id) < ($cu, $ci)`)
    params.$cu = at.u
    params.$ci = at.i
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT ${q.columns} FROM ${q.table}${whereSql} ORDER BY ${q.sortColumn} DESC, id DESC LIMIT $lim`)
    .all(params) as unknown as R[]
  if (rows.length <= limit) return { rows, nextCursor: null }
  const pageRows = rows.slice(0, limit)
  const last = pageRows[limit - 1]
  return { rows: pageRows, nextCursor: encodePageCursor(q.sortValue(last), last.id) }
}
