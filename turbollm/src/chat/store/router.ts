// ChatStoreRouter — spec 27 §4.3.
//
// tenant='local' (TurboLLM's own UI) is ALWAYS served by SQLite; every other tenant goes
// to the configured adapter. This is what guarantees an integrator's database cannot break
// the desktop app, and what keeps the interface at 13 methods instead of the ~38 the UI
// would otherwise need.
import { StoreError, type ChatStore, type StoreCapabilities } from './chat-store.js'
import type {
  Chat, ChatInput, ChatMessage, ChatPatch, ListOpts, MessageInput, MessagePatch, Page, Scope,
} from './types.js'

export const LOCAL_TENANT = 'local'

export class ChatStoreRouter implements ChatStore {
  constructor(
    private readonly local: ChatStore,
    private readonly adapter: ChatStore | null,
  ) {}

  /** The INTERSECTION of both backends: never advertise a capability the store that will
   *  actually serve a given request lacks. With no adapter, the local capabilities stand. */
  get capabilities(): StoreCapabilities {
    if (!this.adapter) return this.local.capabilities
    const a = this.local.capabilities
    const b = this.adapter.capabilities
    return {
      branching: a.branching === true && b.branching === true,
      folders: a.folders === true && b.folders === true,
      search: a.search === true && b.search === true,
      batch: a.batch === true && b.batch === true,
    }
  }

  private pick(s: Scope): ChatStore {
    if (s.tenant === LOCAL_TENANT) return this.local
    if (!this.adapter) {
      throw new StoreError('not_supported', `not_supported: no chat-store adapter is configured, so tenant '${s.tenant}' cannot be served`)
    }
    return this.adapter
  }

  // NOTE: each of these is deliberately `async` even though the body is a single
  // delegating call. `pick()` throws synchronously when a non-local tenant has no
  // adapter configured; without `async` here that throw would escape as a *synchronous*
  // exception instead of a Promise rejection, which breaks every caller (including
  // `assert.rejects`) that correctly expects a `ChatStore` method to only ever fail by
  // rejecting its returned Promise.
  async createChat(s: Scope, i: ChatInput): Promise<Chat> { return this.pick(s).createChat(s, i) }
  async getChat(s: Scope, id: string): Promise<Chat | null> { return this.pick(s).getChat(s, id) }
  async listChats(s: Scope, o: ListOpts): Promise<Page<Chat>> { return this.pick(s).listChats(s, o) }
  async updateChat(s: Scope, id: string, p: ChatPatch, v?: number): Promise<Chat | null> { return this.pick(s).updateChat(s, id, p, v) }
  async deleteChat(s: Scope, id: string): Promise<boolean> { return this.pick(s).deleteChat(s, id) }

  async addMessage(s: Scope, c: string, i: MessageInput): Promise<ChatMessage> { return this.pick(s).addMessage(s, c, i) }
  async getMessage(s: Scope, id: string): Promise<ChatMessage | null> { return this.pick(s).getMessage(s, id) }
  async listMessages(s: Scope, c: string, o: ListOpts): Promise<Page<ChatMessage>> { return this.pick(s).listMessages(s, c, o) }
  async updateMessage(s: Scope, id: string, p: MessagePatch, v?: number): Promise<ChatMessage | null> { return this.pick(s).updateMessage(s, id, p, v) }
  async deleteMessage(s: Scope, id: string): Promise<boolean> { return this.pick(s).deleteMessage(s, id) }
  async getLastMessage(s: Scope, c: string): Promise<ChatMessage | null> { return this.pick(s).getLastMessage(s, c) }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    const local = await this.local.health()
    if (!local.ok) return { ok: false, detail: `local: ${local.detail ?? 'unhealthy'}` }
    if (!this.adapter) return { ok: true }
    const remote = await this.adapter.health()
    return remote.ok ? { ok: true } : { ok: false, detail: `adapter: ${remote.detail ?? 'unhealthy'}` }
  }

  async close(): Promise<void> {
    await this.local.close()
    if (this.adapter) await this.adapter.close()
  }
}
