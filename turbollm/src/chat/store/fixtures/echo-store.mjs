// turbollm/src/chat/store/fixtures/echo-store.mjs
// A minimal in-memory ChatStore used only by load-adapter.test.ts. Not shipped.
export default function createStore(options = {}) {
  const chats = new Map()
  const messages = new Map()
  const key = (s) => `${s.tenant}/${s.owner}`
  return {
    capabilities: { branching: false, folders: false, search: false, batch: false },
    marker: options.marker ?? 'default',
    async createChat(s, input) {
      const chat = {
        id: `echo-${chats.size + 1}`, owner: s.owner, title: input.title ?? 'New chat',
        model: input.model ?? '', systemPrompt: input.systemPrompt ?? '', sampling: {},
        metadata: input.metadata ?? {}, messageCount: 0, lastMessageAt: null, version: 1,
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      }
      chats.set(`${key(s)}:${chat.id}`, chat)
      return chat
    },
    async getChat(s, id) { return chats.get(`${key(s)}:${id}`) ?? null },
    async listChats(s) {
      const data = [...chats.entries()].filter(([k]) => k.startsWith(`${key(s)}:`)).map(([, v]) => v)
      return { data, hasMore: false, nextCursor: null }
    },
    async updateChat() { return null },
    async deleteChat(s, id) { return chats.delete(`${key(s)}:${id}`) },
    async addMessage(s, chatId, input) {
      const list = messages.get(`${key(s)}:${chatId}`) ?? []
      const msg = {
        id: `echo-m${list.length + 1}`, chatId, seq: list.length + 1, role: input.role,
        content: input.content, status: input.status ?? 'complete', version: 1,
        createdAt: new Date(0).toISOString(), edited: false, reasoning: '', attachments: [],
        toolCalls: [], usage: {}, metadata: {},
      }
      list.push(msg); messages.set(`${key(s)}:${chatId}`, list)
      return msg
    },
    async getMessage() { return null },
    async listMessages(s, chatId) {
      return { data: messages.get(`${key(s)}:${chatId}`) ?? [], hasMore: false, nextCursor: null }
    },
    async updateMessage() { return null },
    async deleteMessage() { return false },
    async getLastMessage(s, chatId) {
      const list = messages.get(`${key(s)}:${chatId}`) ?? []
      return list[list.length - 1] ?? null
    },
    async health() { return { ok: true } },
    async close() {},
  }
}
