// turbollm/src/chat/store/fixtures/echo-store.mjs
//
// A real, non-SQLite ChatStore over plain in-memory Maps. It exists to prove the
// conformance suite (../conformance.ts) is a genuine backend-agnostic contract rather
// than a fixture tailored to SQLite's shape — so every behavior the suite asserts on
// (gapless per-chat seq allocation, cursor pagination, counter maintenance, version-conflict
// rejection, cascade delete, title search) is implemented for real here, not stubbed out.
//
// Deliberately dependency-free plain JS (no imports from the TS source tree) so it stays
// a portable example of what an integrator's own adapter module can look like.
export default function createStore(options = {}) {
  const chats = new Map() // `${tenant}/${owner}:${id}` -> chat object
  const messagesByChat = new Map() // `${tenant}/${owner}:${chatId}` -> ChatMessage[] in seq order
  const messagesById = new Map() // messageId -> { message, scopeStr, ck }
  const seqCounters = new Map() // `${tenant}/${owner}:${chatId}` -> next seq to allocate
  let nextChatSeq = 1
  let nextMsgSeq = 1

  const keyOf = (s) => `${s.tenant}/${s.owner}`
  const chatKey = (s, id) => `${keyOf(s)}:${id}`

  function encodeCursor(obj) {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
  }
  function decodeCursor(raw) {
    let parsed
    try {
      parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    } catch {
      throw new Error('invalid_cursor: not decodable')
    }
    if (parsed === null || typeof parsed !== 'object') throw new Error('invalid_cursor: wrong shape')
    return parsed
  }
  function decodeChatCursor(raw) {
    const c = decodeCursor(raw)
    if (typeof c.u !== 'string' || typeof c.i !== 'string') throw new Error('invalid_cursor: wrong shape')
    return c
  }
  function decodeMessageCursor(raw) {
    const c = decodeCursor(raw)
    if (typeof c.s !== 'number') throw new Error('invalid_cursor: wrong shape')
    return c
  }
  function clampLimit(n) {
    if (!n || n < 1) return 50
    return Math.min(n, 200)
  }
  function chatsForScope(s) {
    const prefix = `${keyOf(s)}:`
    return [...chats.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v)
  }

  return {
    capabilities: { branching: false, folders: false, search: true, batch: false },
    marker: options.marker ?? 'default',

    async createChat(s, input) {
      const id = `echo-${nextChatSeq++}`
      const now = new Date().toISOString()
      const chat = {
        id, owner: s.owner, title: input.title ?? 'New chat',
        model: input.model ?? '', systemPrompt: input.systemPrompt ?? '',
        sampling: input.sampling ?? {}, metadata: input.metadata ?? {},
        messageCount: 0, lastMessageAt: null, version: 1,
        createdAt: now, updatedAt: now,
      }
      const ck = chatKey(s, id)
      chats.set(ck, chat)
      messagesByChat.set(ck, [])
      seqCounters.set(ck, 1)
      return { ...chat }
    },

    async getChat(s, id) {
      const c = chats.get(chatKey(s, id))
      return c ? { ...c } : null
    },

    async listChats(s, opts = {}) {
      const limit = clampLimit(opts.limit)
      let all = chatsForScope(s)
      if (opts.q) {
        const needle = opts.q.toLowerCase()
        all = all.filter((c) => c.title.toLowerCase().includes(needle))
      }
      // Keyset order: updatedAt DESC, id DESC (mirrors SqliteChatStore's ordering).
      all.sort((a, b) => {
        if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
      })
      if (opts.cursor) {
        const c = decodeChatCursor(opts.cursor)
        all = all.filter((chat) => chat.updatedAt < c.u || (chat.updatedAt === c.u && chat.id < c.i))
      }
      const hasMore = all.length > limit
      const page = all.slice(0, limit)
      const tail = page[page.length - 1]
      return {
        data: page.map((c) => ({ ...c })),
        hasMore,
        nextCursor: hasMore && tail ? encodeCursor({ u: tail.updatedAt, i: tail.id }) : null,
      }
    },

    async updateChat(s, id, patch, ifVersion) {
      const ck = chatKey(s, id)
      const current = chats.get(ck)
      if (!current) return null
      if (ifVersion !== undefined && ifVersion !== current.version) {
        throw new Error(`version_conflict: chat ${id} is at ${current.version}, caller held ${ifVersion}`)
      }
      let changed = false
      if (patch.title !== undefined) { current.title = patch.title; changed = true }
      if (patch.model !== undefined) { current.model = patch.model; changed = true }
      if (patch.systemPrompt !== undefined) { current.systemPrompt = patch.systemPrompt; changed = true }
      if (patch.sampling !== undefined) { current.sampling = patch.sampling; changed = true }
      if (patch.metadata !== undefined) { current.metadata = patch.metadata; changed = true }
      if (changed) {
        current.updatedAt = new Date().toISOString()
        current.version += 1
      }
      return { ...current }
    },

    async deleteChat(s, id) {
      const ck = chatKey(s, id)
      if (!chats.has(ck)) return false
      chats.delete(ck)
      const list = messagesByChat.get(ck) ?? []
      for (const m of list) messagesById.delete(m.id)
      messagesByChat.delete(ck)
      seqCounters.delete(ck)
      return true
    },

    async addMessage(s, chatId, input) {
      const ck = chatKey(s, chatId)
      const chat = chats.get(ck)
      if (!chat) throw new Error(`not_found: chat ${chatId}`)

      // Synchronous critical section (no await before the seq is committed) so that
      // Promise.all-fired concurrent calls still allocate gapless, distinct seqs — the
      // in-memory equivalent of the SQLite adapter's BEGIN IMMEDIATE transaction.
      const seq = seqCounters.get(ck) ?? 1
      seqCounters.set(ck, seq + 1)
      const now = new Date().toISOString()
      const msg = {
        id: `echo-m${nextMsgSeq++}`, chatId, seq, role: input.role, content: input.content,
        status: input.status ?? 'complete', version: 1, createdAt: now, edited: false,
        reasoning: input.reasoning ?? '', attachments: input.attachments ?? [],
        toolCalls: input.toolCalls ?? [], usage: input.usage ?? {}, metadata: input.metadata ?? {},
      }
      const list = messagesByChat.get(ck) ?? []
      list.push(msg)
      messagesByChat.set(ck, list)
      messagesById.set(msg.id, { message: msg, scopeStr: keyOf(s), ck })

      // Counter maintenance rides in the same synchronous section as the append.
      chat.messageCount = list.length
      chat.lastMessageAt = now
      chat.updatedAt = now

      return { ...msg }
    },

    async getMessage(s, id) {
      const entry = messagesById.get(id)
      if (!entry || entry.scopeStr !== keyOf(s)) return null
      return { ...entry.message }
    },

    async listMessages(s, chatId, opts = {}) {
      const limit = clampLimit(opts.limit)
      let afterSeq = 0
      if (opts.cursor) afterSeq = decodeMessageCursor(opts.cursor).s
      const all = (messagesByChat.get(chatKey(s, chatId)) ?? [])
        .filter((m) => m.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
      const hasMore = all.length > limit
      const page = all.slice(0, limit)
      const tail = page[page.length - 1]
      return {
        data: page.map((m) => ({ ...m })),
        hasMore,
        nextCursor: hasMore && tail ? encodeCursor({ s: tail.seq }) : null,
      }
    },

    async updateMessage(s, id, patch, ifVersion) {
      const entry = messagesById.get(id)
      if (!entry || entry.scopeStr !== keyOf(s)) return null
      const current = entry.message
      if (ifVersion !== undefined && ifVersion !== current.version) {
        throw new Error(`version_conflict: message ${id} is at ${current.version}, caller held ${ifVersion}`)
      }
      let changed = false
      if (patch.content !== undefined) { current.content = patch.content; changed = true }
      if (patch.status !== undefined) { current.status = patch.status; changed = true }
      if (patch.reasoning !== undefined) { current.reasoning = patch.reasoning; changed = true }
      if (patch.toolCalls !== undefined) { current.toolCalls = patch.toolCalls; changed = true }
      if (patch.usage !== undefined) { current.usage = patch.usage; changed = true }
      if (patch.metadata !== undefined) { current.metadata = patch.metadata; changed = true }
      if (patch.edited !== undefined) { current.edited = patch.edited; changed = true }
      if (changed) current.version += 1
      return { ...current }
    },

    async deleteMessage(s, id) {
      const entry = messagesById.get(id)
      if (!entry || entry.scopeStr !== keyOf(s)) return false
      messagesById.delete(id)
      const list = messagesByChat.get(entry.ck)
      if (list) {
        const idx = list.findIndex((m) => m.id === id)
        if (idx !== -1) list.splice(idx, 1)
      }
      const chat = chats.get(entry.ck)
      if (chat) chat.messageCount = (messagesByChat.get(entry.ck) ?? []).length
      return true
    },

    async getLastMessage(s, chatId) {
      const list = messagesByChat.get(chatKey(s, chatId)) ?? []
      const last = list[list.length - 1]
      return last ? { ...last } : null
    },

    async health() { return { ok: true } },
    async close() {},
  }
}
