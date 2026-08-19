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
    // A brand-new chat reads more naturally as version 1 than as an epoch millisecond.
    return { ...made, version: 1 }
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

  // listChats / updateChat / deleteChat land in Task 4.
  // Message methods land in Task 5.
  async listChats(_s: Scope, _o: ListOpts): Promise<Page<Chat>> { throw new StoreError('not_supported', 'listChats: Task 4') }
  async updateChat(_s: Scope, _i: string, _p: ChatPatch, _v?: number): Promise<Chat | null> { throw new StoreError('not_supported', 'updateChat: Task 4') }
  async deleteChat(_s: Scope, _i: string): Promise<boolean> { throw new StoreError('not_supported', 'deleteChat: Task 4') }
  async addMessage(_s: Scope, _c: string, _i: MessageInput): Promise<ChatMessage> { throw new StoreError('not_supported', 'addMessage: Task 5') }
  async getMessage(_s: Scope, _i: string): Promise<ChatMessage | null> { throw new StoreError('not_supported', 'getMessage: Task 5') }
  async listMessages(_s: Scope, _c: string, _o: ListOpts): Promise<Page<ChatMessage>> { throw new StoreError('not_supported', 'listMessages: Task 5') }
  async updateMessage(_s: Scope, _i: string, _p: MessagePatch, _v?: number): Promise<ChatMessage | null> { throw new StoreError('not_supported', 'updateMessage: Task 5') }
  async deleteMessage(_s: Scope, _i: string): Promise<boolean> { throw new StoreError('not_supported', 'deleteMessage: Task 5') }
  async getLastMessage(_s: Scope, _c: string): Promise<ChatMessage | null> { throw new StoreError('not_supported', 'getLastMessage: Task 5') }
}
