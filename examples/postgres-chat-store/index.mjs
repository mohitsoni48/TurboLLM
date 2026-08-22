// examples/postgres-chat-store/index.mjs
//
// A worked, non-SQLite ChatStore adapter over Postgres (spec 27 §4). This is the
// end-to-end proof that the interface at turbollm/src/chat/store/chat-store.ts is
// genuinely implementable outside TurboLLM's own SQLite path — it implements all 13
// required methods and is exercised by the SAME conformance suite CI runs against
// SqliteChatStore (see conformance.test.mjs).
//
// This is example code, not a supported product (see README.md).
//
// ── On importing StoreError from the real interface module ─────────────────────
// This file imports `StoreError` from turbollm/src/chat/store/chat-store.js via a
// relative path rather than defining its own class. That is a deliberate, interim
// choice, not an oversight: spec §14 defers publishing a standalone
// `@turbollm/chat-store-conformance` package to Phase 5, so there is nothing on npm
// to depend on yet. Importing the real class means `e instanceof StoreError` in
// turbollm/src/ext/errors.ts's mapStoreError() correctly recognizes errors this
// adapter throws WHEN this file is actually loaded in-process by the daemon (the
// `module` adapter kind in config.json, spec §4.5) — the daemon's own dev/start
// scripts already run under tsx, so a relative import into a `.ts` file resolves
// exactly as it does everywhere else in this codebase. A genuinely separate,
// external repository cannot depend on a relative path into this one; until Phase 5
// ships a published package, an integrator in that position should vendor the ~10
// line StoreError class from chat-store.ts directly (it has no dependencies of its
// own) rather than inventing an incompatible one.
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { StoreError } from '../../turbollm/src/chat/store/chat-store.js'

const { Pool } = pg

// ── cursor helpers ───────────────────────────────────────────────────────────────
// Cursors are opaque to callers (spec 27 §5.2) — this adapter's encoding only has to
// be internally consistent, not match SqliteChatStore's byte format.

function encodeChatCursor(updatedAt, id) {
  return Buffer.from(JSON.stringify({ u: updatedAt, i: id }), 'utf8').toString('base64url')
}

function decodeChatCursor(raw) {
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    // invalid_cursor, not contract_violation: this is the CALLER's bad cursor, not the
    // adapter returning malformed data — matches SqliteChatStore's identical fix (release-gate
    // I3) so both reference adapters answer a caller's mistake with the same 400, not one 400
    // and one 500 for the same request shape.
    throw new StoreError('invalid_cursor', 'invalid_cursor: not decodable')
  }
  if (typeof parsed?.u !== 'string' || typeof parsed?.i !== 'string') {
    throw new StoreError('invalid_cursor', 'invalid_cursor: wrong shape')
  }
  return { updatedAt: parsed.u, id: parsed.i }
}

function encodeSeqCursor(seq) {
  return Buffer.from(JSON.stringify({ s: seq }), 'utf8').toString('base64url')
}

function decodeSeqCursor(raw) {
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new StoreError('invalid_cursor', 'invalid_cursor: not decodable')
  }
  if (typeof parsed?.s !== 'number') {
    throw new StoreError('invalid_cursor', 'invalid_cursor: wrong shape')
  }
  return parsed.s
}

function clampLimit(n) {
  if (!n || n < 1) return 50
  return Math.min(n, 200)
}

// ── row <-> public-DTO mapping ───────────────────────────────────────────────────
// The public shape (types.ts's Chat/ChatMessage) is camelCase and never exposes
// `tenant` — a caller only ever sees its own tenant's data (spec 27 §3.2).

function rowToChat(row) {
  const body = row.body ?? {}
  return {
    id: row.id,
    owner: row.owner,
    title: row.title,
    model: body.model ?? '',
    systemPrompt: body.systemPrompt ?? '',
    sampling: body.sampling ?? {},
    metadata: body.metadata ?? {},
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function rowToMessage(row) {
  const body = row.body ?? {}
  return {
    id: row.id,
    chatId: row.chat_id,
    seq: row.seq,
    role: row.role,
    content: body.content ?? '',
    status: row.status,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    edited: body.edited ?? false,
    reasoning: body.reasoning ?? '',
    attachments: body.attachments ?? [],
    toolCalls: body.toolCalls ?? [],
    usage: body.usage ?? {},
    metadata: body.metadata ?? {},
  }
}

export class PostgresChatStore {
  /** Honest capabilities (spec 27 §4.2): this adapter implements neither optional
   *  group. `search` is real — `listChats({ q })` filters on the typed `title`
   *  column, never the opaque body, per spec §4.2 obligation 3. */
  capabilities = { branching: false, folders: false, search: true, batch: false }

  constructor(pool) {
    this.pool = pool
  }

  async health() {
    try {
      await this.pool.query('SELECT 1')
      return { ok: true }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  }

  async close() {
    await this.pool.end()
  }

  async createChat(s, input) {
    const id = randomUUID()
    const now = new Date().toISOString()
    const body = {
      model: input.model ?? '',
      systemPrompt: input.systemPrompt ?? '',
      sampling: input.sampling ?? {},
      metadata: input.metadata ?? {},
    }
    const res = await this.pool.query(
      `INSERT INTO chats (id, tenant, owner, title, status, message_count, last_message_at, version, created_at, updated_at, body)
       VALUES ($1, $2, $3, $4, 'active', 0, NULL, 1, $5, $5, $6)
       RETURNING *`,
      [id, s.tenant, s.owner, input.title ?? 'New chat', now, body],
    )
    return rowToChat(res.rows[0])
  }

  async getChat(s, id) {
    const res = await this.pool.query(
      'SELECT * FROM chats WHERE id = $1 AND tenant = $2 AND owner = $3',
      [id, s.tenant, s.owner],
    )
    return res.rowCount ? rowToChat(res.rows[0]) : null
  }

  async listChats(s, opts) {
    const limit = clampLimit(opts.limit)
    const params = [s.tenant, s.owner]
    let where = 'tenant = $1 AND owner = $2'

    if (opts.q) {
      params.push(`%${opts.q}%`)
      where += ` AND title ILIKE $${params.length}`
    }
    if (opts.cursor) {
      const c = decodeChatCursor(opts.cursor)
      params.push(c.updatedAt, c.id)
      // Row-constructor comparison: (updated_at, id) < (cursor.updated_at, cursor.id)
      // is exactly "strictly before the cursor in (updated_at DESC, id DESC) order".
      where += ` AND (updated_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`
    }
    params.push(limit + 1)

    const res = await this.pool.query(
      `SELECT * FROM chats WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT $${params.length}`,
      params,
    )
    const hasMore = res.rows.length > limit
    const page = hasMore ? res.rows.slice(0, limit) : res.rows
    const tail = page[page.length - 1]
    return {
      data: page.map(rowToChat),
      hasMore,
      nextCursor: hasMore && tail ? encodeChatCursor(tail.updated_at.toISOString(), tail.id) : null,
    }
  }

  async updateChat(s, id, patch, ifVersion) {
    const patchBody = {}
    if (patch.model !== undefined) patchBody.model = patch.model
    if (patch.systemPrompt !== undefined) patchBody.systemPrompt = patch.systemPrompt
    if (patch.sampling !== undefined) patchBody.sampling = patch.sampling
    if (patch.metadata !== undefined) patchBody.metadata = patch.metadata
    const now = new Date().toISOString()

    // Single-statement compare-and-swap: the ifVersion check rides in the WHERE
    // clause itself, so there is no separate read-then-write race window. `body ||
    // $patch` is jsonb's shallow-merge operator — only the keys present in
    // patchBody are overwritten, everything else in the document is untouched.
    const res = await this.pool.query(
      `UPDATE chats
       SET title = COALESCE($1, title), body = body || $2::jsonb, version = version + 1, updated_at = $3
       WHERE id = $4 AND tenant = $5 AND owner = $6
         AND ($7::int IS NULL OR version = $7)
       RETURNING *`,
      [patch.title ?? null, patchBody, now, id, s.tenant, s.owner, ifVersion ?? null],
    )
    if (res.rowCount > 0) return rowToChat(res.rows[0])

    // Zero rows: distinguish "doesn't exist" (return null) from "version mismatch"
    // (throw) — this second read is diagnostic only, nothing is mutated by it.
    const exists = await this.pool.query(
      'SELECT version FROM chats WHERE id = $1 AND tenant = $2 AND owner = $3',
      [id, s.tenant, s.owner],
    )
    if (exists.rowCount === 0) return null
    throw new StoreError(
      'version_conflict',
      `version_conflict: chat ${id} is at ${exists.rows[0].version}, caller held ${ifVersion}`,
    )
  }

  async deleteChat(s, id) {
    // messages.chat_id is ON DELETE CASCADE (schema.sql), so message rows go with it.
    const res = await this.pool.query(
      'DELETE FROM chats WHERE id = $1 AND tenant = $2 AND owner = $3',
      [id, s.tenant, s.owner],
    )
    return res.rowCount > 0
  }

  async addMessage(s, chatId, input) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Lock the parent chat row for the duration of the transaction. This is what
      // makes seq allocation atomic and gapless under concurrent appends (spec 27
      // §4.2 obligation 1): a second concurrent addMessage on the SAME chat blocks
      // here until this transaction commits or rolls back, then re-reads MAX(seq)
      // under READ COMMITTED and sees this insert — no lost update, no gap.
      const chatRes = await client.query(
        'SELECT id FROM chats WHERE id = $1 AND tenant = $2 AND owner = $3 FOR UPDATE',
        [chatId, s.tenant, s.owner],
      )
      if (chatRes.rowCount === 0) {
        throw new StoreError('not_found', `not_found: chat ${chatId}`)
      }

      const seqRes = await client.query(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE chat_id = $1 AND tenant = $2 AND owner = $3',
        [chatId, s.tenant, s.owner],
      )
      const seq = seqRes.rows[0].next_seq

      const id = randomUUID()
      const now = new Date().toISOString()
      const body = {
        content: input.content,
        reasoning: input.reasoning ?? '',
        attachments: input.attachments ?? [],
        toolCalls: input.toolCalls ?? [],
        usage: input.usage ?? {},
        metadata: input.metadata ?? {},
        edited: false,
      }
      const status = input.status ?? 'complete'

      const inserted = await client.query(
        `INSERT INTO messages (id, tenant, owner, chat_id, seq, role, status, is_active, version, created_at, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, 1, $8, $9)
         RETURNING *`,
        [id, s.tenant, s.owner, chatId, seq, input.role, status, now, body],
      )

      // Counter maintenance rides inside the SAME transaction (spec 27 §4.2
      // obligation 2) — no separate touch call, no N+1 on listChats.
      await client.query(
        `UPDATE chats SET message_count = message_count + 1, last_message_at = $1, updated_at = $1
         WHERE id = $2 AND tenant = $3 AND owner = $4`,
        [now, chatId, s.tenant, s.owner],
      )

      await client.query('COMMIT')
      return rowToMessage(inserted.rows[0])
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  async getMessage(s, id) {
    const res = await this.pool.query(
      'SELECT * FROM messages WHERE id = $1 AND tenant = $2 AND owner = $3',
      [id, s.tenant, s.owner],
    )
    return res.rowCount ? rowToMessage(res.rows[0]) : null
  }

  async listMessages(s, chatId, opts) {
    const limit = clampLimit(opts.limit)
    const afterSeq = opts.cursor ? decodeSeqCursor(opts.cursor) : 0

    const res = await this.pool.query(
      `SELECT * FROM messages
       WHERE chat_id = $1 AND tenant = $2 AND owner = $3 AND is_active = true AND seq > $4
       ORDER BY seq ASC LIMIT $5`,
      [chatId, s.tenant, s.owner, afterSeq, limit + 1],
    )
    const hasMore = res.rows.length > limit
    const page = hasMore ? res.rows.slice(0, limit) : res.rows
    const tail = page[page.length - 1]
    return {
      data: page.map(rowToMessage),
      hasMore,
      nextCursor: hasMore && tail ? encodeSeqCursor(tail.seq) : null,
    }
  }

  async updateMessage(s, id, patch, ifVersion) {
    const patchBody = {}
    if (patch.content !== undefined) patchBody.content = patch.content
    if (patch.reasoning !== undefined) patchBody.reasoning = patch.reasoning
    if (patch.toolCalls !== undefined) patchBody.toolCalls = patch.toolCalls
    if (patch.usage !== undefined) patchBody.usage = patch.usage
    if (patch.metadata !== undefined) patchBody.metadata = patch.metadata
    if (patch.edited !== undefined) patchBody.edited = patch.edited

    const res = await this.pool.query(
      `UPDATE messages
       SET status = COALESCE($1, status), body = body || $2::jsonb, version = version + 1
       WHERE id = $3 AND tenant = $4 AND owner = $5
         AND ($6::int IS NULL OR version = $6)
       RETURNING *`,
      [patch.status ?? null, patchBody, id, s.tenant, s.owner, ifVersion ?? null],
    )
    if (res.rowCount > 0) return rowToMessage(res.rows[0])

    const exists = await this.pool.query(
      'SELECT version FROM messages WHERE id = $1 AND tenant = $2 AND owner = $3',
      [id, s.tenant, s.owner],
    )
    if (exists.rowCount === 0) return null
    throw new StoreError(
      'version_conflict',
      `version_conflict: message ${id} is at ${exists.rows[0].version}, caller held ${ifVersion}`,
    )
  }

  async deleteMessage(s, id) {
    // NOTE ON A SPEC/REFERENCE DIVERGENCE, found while implementing this faithfully:
    // spec 27 §4.2 obligation 2 states plainly that message_count/last_message_at
    // are "maintained by addMessage/deleteMessage, in the same transaction" — but
    // the actual SqliteChatStore.deleteMessage (turbollm/src/chat/store/
    // sqlite-chat-store.ts) does NOT decrement message_count; it only deletes the
    // row. That looks like a real gap in the reference implementation (a deleted
    // message leaves listChats/getChat reporting a stale, too-high count), not an
    // intentional simplification — nothing in spec §4.2 argues for deleteMessage
    // being exempt the way it does for the "no separate touch call" reasoning
    // around addMessage. This adapter follows the WRITTEN spec rather than
    // silently reproducing that gap. Flagged here, and in this task's report, as a
    // finding for the spec/implementation owners rather than something silently
    // "fixed" behind the interface's back.
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const del = await client.query(
        'DELETE FROM messages WHERE id = $1 AND tenant = $2 AND owner = $3 RETURNING chat_id',
        [id, s.tenant, s.owner],
      )
      if (del.rowCount === 0) {
        await client.query('ROLLBACK')
        return false
      }
      const now = new Date().toISOString()
      await client.query(
        `UPDATE chats SET message_count = GREATEST(message_count - 1, 0), updated_at = $1
         WHERE id = $2 AND tenant = $3 AND owner = $4`,
        [now, del.rows[0].chat_id, s.tenant, s.owner],
      )
      await client.query('COMMIT')
      return true
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  async getLastMessage(s, chatId) {
    const res = await this.pool.query(
      `SELECT * FROM messages
       WHERE chat_id = $1 AND tenant = $2 AND owner = $3 AND is_active = true
       ORDER BY seq DESC LIMIT 1`,
      [chatId, s.tenant, s.owner],
    )
    return res.rowCount ? rowToMessage(res.rows[0]) : null
  }
}

/** The factory shape turbollm/src/chat/store/load-adapter.ts requires for the
 *  `module` adapter kind (spec 27 §4.5): a default export that is a function taking
 *  the config's `options` object and returning a ChatStore (or a promise of one). */
export default async function createPostgresChatStore(options = {}) {
  const pool = new Pool({
    connectionString: options.connectionString ?? process.env.DATABASE_URL,
    max: options.poolSize ?? 10,
  })
  return new PostgresChatStore(pool)
}
