// SqliteChatStore — the default ChatStore, over TurboLLM's existing chat tables.
//
// Runs on the SAME DatabaseSync handle as ConversationStore and reads/writes the SAME
// `conversations` / `messages` rows, so a chat created here is visible in the web UI and
// vice versa. Phase 2 (spec 27 §9.1) adds real tenant/owner/version/metadata/status
// columns, so every statement below is scoped with `AND tenant = $t AND owner = $o`
// (or the differently-named equivalent where `$t` already means something else in that
// statement) — an unscoped query here would let one tenant read or clobber another's rows.
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { branchingMethods, folderMethods } from './capabilities.js'
import { StoreError, type BranchingStore, type ChatStore, type FolderStore, type StoreCapabilities } from './chat-store.js'
import type {
  Chat, ChatInput, ChatMessage, ChatPatch, ListOpts, MessageInput, MessagePatch, MessageStatus, Page, Scope,
} from './types.js'

type P = Record<string, SQLInputValue>

interface ConvRow {
  id: string; title: string; system_prompt: string; model_key: string; sampling: string
  tenant: string; owner: string; metadata: string; version: number
  created_at: string; updated_at: string
}

interface MsgRow {
  id: string; conv_id: string; seq: number; role: 'user' | 'assistant'; content: string
  reasoning: string; attachments: string; tool_calls: string | null; stats: string
  tenant: string; owner: string; status: string; version: number; metadata: string
  created_at: string; is_active: number; edited: number
}

function safeJson(s: string | null): Record<string, unknown> {
  if (!s) return {}
  try {
    const v = JSON.parse(s) as unknown
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch { return {} }
}

function safeArray(s: string | null): unknown[] {
  if (!s) return []
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v : []
  } catch { return [] }
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
    throw new StoreError('invalid_cursor', 'invalid_cursor: not decodable')
  }
  const c = parsed as Partial<ChatCursor>
  if (typeof c?.u !== 'string' || typeof c?.i !== 'string') {
    throw new StoreError('invalid_cursor', 'invalid_cursor: wrong shape')
  }
  return { u: c.u, i: c.i }
}

function clampLimit(n?: number): number {
  if (!n || n < 1) return 50
  return Math.min(n, 200)
}

function encodeSeqCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ s: seq }), 'utf8').toString('base64url')
}

function decodeSeqCursor(raw: string): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new StoreError('invalid_cursor', 'invalid_cursor: not decodable')
  }
  const c = parsed as { s?: unknown }
  if (typeof c?.s !== 'number') throw new StoreError('invalid_cursor', 'invalid_cursor: wrong shape')
  return c.s
}

interface Changes { changes: number }

export class SqliteChatStore implements ChatStore, FolderStore, BranchingStore {
  readonly capabilities: StoreCapabilities = {
    branching: true, folders: true, search: true, batch: false,
  }

  // Mixed in from ./capabilities.js in the constructor.
  declare listFolders: FolderStore['listFolders']
  declare getFolder: FolderStore['getFolder']
  declare createFolder: FolderStore['createFolder']
  declare renameFolder: FolderStore['renameFolder']
  declare deleteFolder: FolderStore['deleteFolder']
  declare moveChatToFolder: FolderStore['moveChatToFolder']
  declare getMessageVariants: BranchingStore['getMessageVariants']
  declare setActiveVariant: BranchingStore['setActiveVariant']
  declare deactivateMessage: BranchingStore['deactivateMessage']
  declare deactivateMessagesFrom: BranchingStore['deactivateMessagesFrom']
  declare reactivateMessagesFrom: BranchingStore['reactivateMessagesFrom']
  declare freezeTail: BranchingStore['freezeTail']
  declare restoreTail: BranchingStore['restoreTail']

  constructor(private readonly db: DatabaseSync) {
    Object.assign(this, folderMethods(db), branchingMethods(db))
  }

  private rowToChat(r: ConvRow, messageCount: number, lastMessageAt: string | null): Chat {
    return {
      id: r.id,
      owner: r.owner,
      title: r.title,
      model: r.model_key,
      systemPrompt: r.system_prompt,
      sampling: safeJson(r.sampling),
      metadata: safeJson(r.metadata),
      messageCount,
      lastMessageAt,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  private rowToMessage(r: MsgRow): ChatMessage {
    return {
      id: r.id,
      chatId: r.conv_id,
      seq: r.seq,
      role: r.role,
      content: r.content,
      status: r.status as MessageStatus,
      version: r.version,
      createdAt: r.created_at,
      edited: r.edited === 1,
      reasoning: r.reasoning ?? '',
      attachments: safeArray(r.attachments) as string[],
      toolCalls: safeArray(r.tool_calls),
      usage: safeJson(r.stats),
      metadata: safeJson(r.metadata),
    }
  }

  private chatById(s: Scope, id: string): Chat | null {
    const row = this.db.prepare(
      `SELECT id,title,system_prompt,model_key,sampling,metadata,version,tenant,owner,created_at,updated_at
       FROM conversations WHERE id = $id AND tenant = $t AND owner = $o`,
    ).get({ $id: id, $t: s.tenant, $o: s.owner } as P) as unknown as ConvRow | undefined
    if (!row) return null
    const agg = this.db.prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages
       WHERE conv_id = $id AND tenant = $t AND owner = $o AND is_active = 1`,
    ).get({ $id: id, $t: s.tenant, $o: s.owner } as P) as unknown as { n: number; last: string | null }
    return this.rowToChat(row, agg.n, agg.last)
  }

  async createChat(s: Scope, input: ChatInput): Promise<Chat> {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO conversations (id,title,system_prompt,model_key,sampling,expert_mode,kind,preserve_thinking,tenant,owner,metadata,version,created_at,updated_at) VALUES ($id,$t,$sp,$mk,$samp,0,'chat',1,$tenant,$owner,$meta,1,$now,$now)`)
      .run({
        $id: id,
        $t: input.title ?? 'New chat',
        $sp: input.systemPrompt ?? '',
        $mk: input.model ?? '',
        $samp: JSON.stringify(input.sampling ?? {}),
        $tenant: s.tenant,
        $owner: s.owner,
        $meta: JSON.stringify(input.metadata ?? {}),
        $now: now,
      } as P)
    const made = this.chatById(s, id)
    if (!made) throw new StoreError('contract_violation', 'createChat: row vanished immediately after insert')
    return made
  }

  async getChat(s: Scope, id: string): Promise<Chat | null> {
    return this.chatById(s, id)
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
    const limit = clampLimit(opts.limit)
    const where: string[] = [`kind = 'chat'`, `tenant = $t`, `owner = $o`]
    const params: Record<string, SQLInputValue> = { $lim: limit + 1, $t: s.tenant, $o: s.owner }

    if (opts.q) { where.push(`title LIKE $q`); params.$q = `%${opts.q}%` }
    if (opts.cursor) {
      // Keyset pagination on the same (updated_at DESC, id DESC) order the query uses.
      const c = decodeCursor(opts.cursor)
      where.push(`(updated_at < $cu OR (updated_at = $cu AND id < $ci))`)
      params.$cu = c.u
      params.$ci = c.i
    }

    const rows = this.db.prepare(
      `SELECT id,title,system_prompt,model_key,sampling,metadata,version,tenant,owner,created_at,updated_at FROM conversations
       WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT $lim`,
    ).all(params as P) as unknown as ConvRow[]

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const data = page.map((r) => {
      const agg = this.db.prepare(
        `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages
         WHERE conv_id = $id AND tenant = $t AND owner = $o AND is_active = 1`,
      ).get({ $id: r.id, $t: s.tenant, $o: s.owner } as P) as unknown as { n: number; last: string | null }
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
    const current = this.chatById(s, id)
    if (!current) return null
    if (ifVersion !== undefined && ifVersion !== current.version) {
      throw new StoreError('version_conflict', `version_conflict: chat ${id} is at ${current.version}, caller held ${ifVersion}`)
    }

    const sets = ['updated_at = $now', 'version = version + 1']
    const params: Record<string, SQLInputValue> = {
      $id: id, $now: new Date().toISOString(), $tenant: s.tenant, $owner: s.owner,
    }
    if (patch.title !== undefined)        { sets.push('title = $t');           params.$t    = patch.title }
    if (patch.systemPrompt !== undefined) { sets.push('system_prompt = $sp');  params.$sp   = patch.systemPrompt }
    if (patch.model !== undefined)        { sets.push('model_key = $mk');      params.$mk   = patch.model }
    if (patch.sampling !== undefined)     { sets.push('sampling = $samp');     params.$samp = JSON.stringify(patch.sampling) }
    if (patch.metadata !== undefined)     { sets.push('metadata = $meta');     params.$meta = JSON.stringify(patch.metadata) }

    this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $id AND tenant = $tenant AND owner = $owner`).run(params as P)
    return this.chatById(s, id)
  }

  async deleteChat(s: Scope, id: string): Promise<boolean> {
    // messages.conv_id is ON DELETE CASCADE and the migration sets PRAGMA foreign_keys=ON,
    // so the message rows go with the conversation.
    const r = this.db.prepare(`DELETE FROM conversations WHERE id = $id AND tenant = $t AND owner = $o`)
      .run({ $id: id, $t: s.tenant, $o: s.owner } as P) as unknown as Changes
    return r.changes > 0
  }

  async addMessage(s: Scope, chatId: string, input: MessageInput): Promise<ChatMessage> {
    const id = randomUUID()
    const now = new Date().toISOString()

    // Atomic seq allocation (spec 27 §4.2). ConversationStore.addMessage does the same
    // MAX(seq)+1 read OUTSIDE a transaction, so two concurrent appends there can collide;
    // the adapter contract forbids that, so this path wraps both statements.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const exists = this.db.prepare(`SELECT 1 AS ok FROM conversations WHERE id = $id AND tenant = $t AND owner = $o`)
        .get({ $id: chatId, $t: s.tenant, $o: s.owner } as P) as unknown as { ok: number } | undefined
      if (!exists) throw new StoreError('not_found', `not_found: chat ${chatId}`)

      const { ms } = this.db.prepare(`SELECT COALESCE(MAX(seq),0) AS ms FROM messages WHERE conv_id = $id AND tenant = $t AND owner = $o`)
        .get({ $id: chatId, $t: s.tenant, $o: s.owner } as P) as unknown as { ms: number }

      this.db.prepare(`INSERT INTO messages (id,conv_id,seq,role,content,reasoning,attachments,tool_calls,stats,tenant,owner,status,version,metadata,created_at,is_active,edited) VALUES ($id,$cid,$seq,$role,$content,$reasoning,$att,$tc,$stats,$t,$o,$status,1,$meta,$now,1,0)`)
        .run({
          $id: id, $cid: chatId, $seq: ms + 1, $role: input.role, $content: input.content,
          $reasoning: input.reasoning ?? '',
          $att: JSON.stringify(input.attachments ?? []),
          $tc: input.toolCalls?.length ? JSON.stringify(input.toolCalls) : null,
          $stats: JSON.stringify(input.usage ?? {}),
          $t: s.tenant, $o: s.owner,
          $status: input.status ?? 'complete',
          $meta: JSON.stringify(input.metadata ?? {}),
          $now: now,
        } as P)

      // Counter maintenance rides inside the same transaction (spec 27 §4.2), so there is
      // no separate touch call and listChats never needs an N+1 recount.
      this.db.prepare(`UPDATE conversations SET updated_at = $now WHERE id = $id AND tenant = $t AND owner = $o`)
        .run({ $id: chatId, $now: now, $t: s.tenant, $o: s.owner } as P)

      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }

    const made = this.messageById(s, id)
    if (!made) throw new StoreError('contract_violation', 'addMessage: row vanished after commit')
    return made
  }

  private messageById(s: Scope, id: string): ChatMessage | null {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = $id AND tenant = $t AND owner = $o`)
      .get({ $id: id, $t: s.tenant, $o: s.owner } as P) as unknown as MsgRow | undefined
    return row ? this.rowToMessage(row) : null
  }

  async getMessage(s: Scope, id: string): Promise<ChatMessage | null> {
    return this.messageById(s, id)
  }

  async listMessages(s: Scope, chatId: string, opts: ListOpts): Promise<Page<ChatMessage>> {
    const limit = clampLimit(opts.limit)
    const params: Record<string, SQLInputValue> = { $cid: chatId, $lim: limit + 1, $t: s.tenant, $o: s.owner }
    let afterSeq = 0
    if (opts.cursor) { afterSeq = decodeSeqCursor(opts.cursor) }
    params.$seq = afterSeq

    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE conv_id = $cid AND tenant = $t AND owner = $o AND is_active = 1 AND seq > $seq ORDER BY seq ASC LIMIT $lim`,
    ).all(params as P) as unknown as MsgRow[]

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const tail = page[page.length - 1]
    return {
      data: page.map((r) => this.rowToMessage(r)),
      hasMore,
      nextCursor: hasMore && tail ? encodeSeqCursor(tail.seq) : null,
    }
  }

  async updateMessage(s: Scope, id: string, patch: MessagePatch, ifVersion?: number): Promise<ChatMessage | null> {
    const current = this.messageById(s, id)
    if (!current) return null
    if (ifVersion !== undefined && ifVersion !== current.version) {
      throw new StoreError('version_conflict', `version_conflict: message ${id} is at ${current.version}, caller held ${ifVersion}`)
    }

    const sets: string[] = []
    const params: Record<string, SQLInputValue> = { $id: id, $t: s.tenant, $o: s.owner }
    if (patch.content   !== undefined) { sets.push('content = $c');     params.$c  = patch.content }
    if (patch.reasoning !== undefined) { sets.push('reasoning = $r');   params.$r  = patch.reasoning }
    if (patch.toolCalls !== undefined) { sets.push('tool_calls = $tc'); params.$tc = JSON.stringify(patch.toolCalls) }
    if (patch.usage     !== undefined) { sets.push('stats = $st');      params.$st = JSON.stringify(patch.usage) }
    if (patch.edited    !== undefined) { sets.push('edited = $e');      params.$e  = patch.edited ? 1 : 0 }
    if (patch.status    !== undefined) { sets.push('status = $status'); params.$status = patch.status }
    if (patch.metadata  !== undefined) { sets.push('metadata = $meta'); params.$meta = JSON.stringify(patch.metadata) }
    if (!sets.length) return current
    sets.push('version = version + 1')

    this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = $id AND tenant = $t AND owner = $o`).run(params as P)
    return this.messageById(s, id)
  }

  async deleteMessage(s: Scope, id: string): Promise<boolean> {
    const r = this.db.prepare(`DELETE FROM messages WHERE id = $id AND tenant = $t AND owner = $o`)
      .run({ $id: id, $t: s.tenant, $o: s.owner } as P) as unknown as Changes
    return r.changes > 0
  }

  async getLastMessage(s: Scope, chatId: string): Promise<ChatMessage | null> {
    const row = this.db.prepare(
      `SELECT * FROM messages WHERE conv_id = $cid AND tenant = $t AND owner = $o AND is_active = 1 ORDER BY seq DESC LIMIT 1`,
    ).get({ $cid: chatId, $t: s.tenant, $o: s.owner } as P) as unknown as MsgRow | undefined
    return row ? this.rowToMessage(row) : null
  }
}
