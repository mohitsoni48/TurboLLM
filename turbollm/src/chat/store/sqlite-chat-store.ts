// SqliteChatStore — the default ChatStore, over TurboLLM's existing chat tables.
//
// Runs on the SAME DatabaseSync handle as ConversationStore and reads/writes the SAME
// `conversations` / `messages` rows, so a chat created here is visible in the web UI and
// vice versa. Phase 1 adds no columns: fields the public model has but the schema does
// not (status, version, metadata) are derived — see the notes on each.
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { StoreError, type ChatStore, type StoreCapabilities } from './chat-store.js'
import type {
  Chat, ChatInput, ChatMessage, ChatPatch, ListOpts, MessageInput, MessagePatch, Page, Scope,
} from './types.js'

type P = Record<string, SQLInputValue>

interface ConvRow {
  id: string; title: string; system_prompt: string; model_key: string; sampling: string
  created_at: string; updated_at: string
}

function safeJson(s: string | null): Record<string, unknown> {
  if (!s) return {}
  try {
    const v = JSON.parse(s) as unknown
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch { return {} }
}

interface ChatCursor { u: string; i: string }

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ u: updatedAt, i: id } satisfies ChatCursor), 'utf8').toString('base64url')
}

function decodeCursor(raw: string): ChatCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new StoreError('contract_violation', 'invalid_cursor: not decodable')
  }
  const c = parsed as Partial<ChatCursor>
  if (typeof c?.u !== 'string' || typeof c?.i !== 'string') {
    throw new StoreError('contract_violation', 'invalid_cursor: wrong shape')
  }
  return { u: c.u, i: c.i }
}

function clampLimit(n?: number): number {
  if (!n || n < 1) return 50
  return Math.min(n, 200)
}

interface Changes { changes: number }

export class SqliteChatStore implements ChatStore {
  readonly capabilities: StoreCapabilities = {
    branching: true, folders: true, search: true, batch: false,
  }

  constructor(private readonly db: DatabaseSync) {}

  /** Phase 1 has no tenant/owner columns, so scoping cannot be enforced yet. Rather than
   *  silently ignore a security-bearing argument, refuse anything but the local scope —
   *  Phase 2 adds the columns and replaces this with a real WHERE clause. */
  private guard(s: Scope): void {
    if (s.tenant !== 'local' || s.owner !== 'default') {
      throw new StoreError(
        'invalid_scope',
        `invalid_scope: tenancy lands in Phase 2; only {tenant:'local',owner:'default'} is servable, got {tenant:'${s.tenant}',owner:'${s.owner}'}`,
      )
    }
  }

  /** `version` has no column in Phase 1. Deriving it from updated_at gives a token that
   *  changes on every write, which is exactly what optimistic concurrency needs; Phase 2
   *  replaces it with a real monotonic counter. */
  private rowToChat(r: ConvRow, messageCount: number, lastMessageAt: string | null): Chat {
    return {
      id: r.id,
      owner: 'default',
      title: r.title,
      model: r.model_key,
      systemPrompt: r.system_prompt,
      sampling: safeJson(r.sampling),
      metadata: {},
      messageCount,
      lastMessageAt,
      version: Date.parse(r.updated_at) || 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  private chatById(id: string): Chat | null {
    const row = this.db.prepare(`SELECT id,title,system_prompt,model_key,sampling,created_at,updated_at FROM conversations WHERE id = $id`)
      .get({ $id: id } as P) as unknown as ConvRow | undefined
    if (!row) return null
    const agg = this.db.prepare(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE conv_id = $id AND is_active = 1`)
      .get({ $id: id } as P) as unknown as { n: number; last: string | null }
    return this.rowToChat(row, agg.n, agg.last)
  }

  async createChat(s: Scope, input: ChatInput): Promise<Chat> {
    this.guard(s)
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO conversations (id,title,system_prompt,model_key,sampling,expert_mode,kind,preserve_thinking,created_at,updated_at) VALUES ($id,$t,$sp,$mk,$samp,0,'chat',1,$now,$now)`)
      .run({
        $id: id,
        $t: input.title ?? 'New chat',
        $sp: input.systemPrompt ?? '',
        $mk: input.model ?? '',
        $samp: JSON.stringify(input.sampling ?? {}),
        $now: now,
      } as P)
    const made = this.chatById(id)
    if (!made) throw new StoreError('contract_violation', 'createChat: row vanished immediately after insert')
    return made
  }

  async getChat(s: Scope, id: string): Promise<Chat | null> {
    this.guard(s)
    return this.chatById(id)
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      this.db.prepare('SELECT 1').get()
      return { ok: true }
    } catch (e) {
      return { ok: false, detail: (e as Error).message }
    }
  }

  /** No-op: the handle is owned by ConversationStore, which closes it. */
  async close(): Promise<void> {}

  async listChats(s: Scope, opts: ListOpts): Promise<Page<Chat>> {
    this.guard(s)
    const limit = clampLimit(opts.limit)
    const where: string[] = [`kind = 'chat'`]
    const params: Record<string, SQLInputValue> = { $lim: limit + 1 }

    if (opts.q) { where.push(`title LIKE $q`); params.$q = `%${opts.q}%` }
    if (opts.cursor) {
      // Keyset pagination on the same (updated_at DESC, id DESC) order the query uses.
      const c = decodeCursor(opts.cursor)
      where.push(`(updated_at < $cu OR (updated_at = $cu AND id < $ci))`)
      params.$cu = c.u
      params.$ci = c.i
    }

    const rows = this.db.prepare(
      `SELECT id,title,system_prompt,model_key,sampling,created_at,updated_at FROM conversations
       WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT $lim`,
    ).all(params as P) as unknown as ConvRow[]

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const data = page.map((r) => {
      const agg = this.db.prepare(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE conv_id = $id AND is_active = 1`)
        .get({ $id: r.id } as P) as unknown as { n: number; last: string | null }
      return this.rowToChat(r, agg.n, agg.last)
    })
    const tail = page[page.length - 1]
    return {
      data,
      hasMore,
      nextCursor: hasMore && tail ? encodeCursor(tail.updated_at, tail.id) : null,
    }
  }

  async updateChat(s: Scope, id: string, patch: ChatPatch, ifVersion?: number): Promise<Chat | null> {
    this.guard(s)
    const current = this.chatById(id)
    if (!current) return null
    if (ifVersion !== undefined && ifVersion !== current.version) {
      throw new StoreError('version_conflict', `version_conflict: chat ${id} is at ${current.version}, caller held ${ifVersion}`)
    }

    const sets = ['updated_at = $now']
    const params: Record<string, SQLInputValue> = { $id: id, $now: new Date().toISOString() }
    if (patch.title !== undefined)        { sets.push('title = $t');           params.$t    = patch.title }
    if (patch.systemPrompt !== undefined) { sets.push('system_prompt = $sp');  params.$sp   = patch.systemPrompt }
    if (patch.model !== undefined)        { sets.push('model_key = $mk');      params.$mk   = patch.model }
    if (patch.sampling !== undefined)     { sets.push('sampling = $samp');     params.$samp = JSON.stringify(patch.sampling) }

    this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $id`).run(params as P)
    return this.chatById(id)
  }

  async deleteChat(s: Scope, id: string): Promise<boolean> {
    this.guard(s)
    // messages.conv_id is ON DELETE CASCADE and the migration sets PRAGMA foreign_keys=ON,
    // so the message rows go with the conversation.
    const r = this.db.prepare(`DELETE FROM conversations WHERE id = $id`).run({ $id: id } as P) as unknown as Changes
    return r.changes > 0
  }

  // Message methods land in Task 5.
  async addMessage(_s: Scope, _c: string, _i: MessageInput): Promise<ChatMessage> { throw new StoreError('not_supported', 'addMessage: Task 5') }
  async getMessage(_s: Scope, _i: string): Promise<ChatMessage | null> { throw new StoreError('not_supported', 'getMessage: Task 5') }
  async listMessages(_s: Scope, _c: string, _o: ListOpts): Promise<Page<ChatMessage>> { throw new StoreError('not_supported', 'listMessages: Task 5') }
  async updateMessage(_s: Scope, _i: string, _p: MessagePatch, _v?: number): Promise<ChatMessage | null> { throw new StoreError('not_supported', 'updateMessage: Task 5') }
  async deleteMessage(_s: Scope, _i: string): Promise<boolean> { throw new StoreError('not_supported', 'deleteMessage: Task 5') }
  async getLastMessage(_s: Scope, _c: string): Promise<ChatMessage | null> { throw new StoreError('not_supported', 'getLastMessage: Task 5') }
}
