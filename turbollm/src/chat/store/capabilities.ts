// BranchingStore + FolderStore for SQLite (spec 27 §4.2). Split out of
// sqlite-chat-store.ts so the required 13-method core stays readable on its own.
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Folder } from './chat-store.js'
import type { ChatMessage, MessageStatus, Scope } from './types.js'

type P = Record<string, SQLInputValue>
interface Changes { changes: number }

interface FolderRow { id: string; name: string; sort_order: number; created_at: string; updated_at: string }

function rowToFolder(r: FolderRow): Folder {
  return { id: r.id, name: r.name, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at }
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

function rowToMessage(r: MsgRow): ChatMessage {
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

export function folderMethods(db: DatabaseSync) {
  return {
    async listFolders(s: Scope): Promise<Folder[]> {
      return (db.prepare(`SELECT * FROM folders WHERE tenant = $t AND owner = $o ORDER BY sort_order ASC, created_at ASC`)
        .all({ $t: s.tenant, $o: s.owner } as P) as unknown as FolderRow[])
        .map(rowToFolder)
    },

    async getFolder(s: Scope, id: string): Promise<Folder | null> {
      const r = db.prepare(`SELECT * FROM folders WHERE id = $id AND tenant = $t AND owner = $o`)
        .get({ $id: id, $t: s.tenant, $o: s.owner } as P) as unknown as FolderRow | undefined
      return r ? rowToFolder(r) : null
    },

    async createFolder(s: Scope, name: string): Promise<Folder> {
      const id = randomUUID()
      const now = new Date().toISOString()
      const { n } = db.prepare(`SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM folders WHERE tenant = $t AND owner = $o`)
        .get({ $t: s.tenant, $o: s.owner } as P) as unknown as { n: number }
      db.prepare(`INSERT INTO folders (id,name,sort_order,tenant,owner,created_at,updated_at) VALUES ($id,$n,$so,$t,$o,$now,$now)`)
        .run({ $id: id, $n: name, $so: n, $t: s.tenant, $o: s.owner, $now: now } as P)
      return { id, name, sortOrder: n, createdAt: now, updatedAt: now }
    },

    async renameFolder(s: Scope, id: string, name: string): Promise<boolean> {
      const r = db.prepare(`UPDATE folders SET name = $n, updated_at = $now WHERE id = $id AND tenant = $t AND owner = $o`)
        .run({ $id: id, $n: name, $now: new Date().toISOString(), $t: s.tenant, $o: s.owner } as P) as unknown as Changes
      return r.changes > 0
    },

    /** Unassigns member chats rather than cascading — the guarantee folders.test.ts pins. */
    async deleteFolder(s: Scope, id: string): Promise<boolean> {
      db.prepare(`UPDATE conversations SET folder_id = NULL WHERE folder_id = $id AND tenant = $t AND owner = $o`)
        .run({ $id: id, $t: s.tenant, $o: s.owner } as P)
      const r = db.prepare(`DELETE FROM folders WHERE id = $id AND tenant = $t AND owner = $o`)
        .run({ $id: id, $t: s.tenant, $o: s.owner } as P) as unknown as Changes
      return r.changes > 0
    },

    async moveChatToFolder(s: Scope, chatId: string, folderId: string | null): Promise<boolean> {
      const r = db.prepare(`UPDATE conversations SET folder_id = $f, updated_at = $now WHERE id = $id AND tenant = $t AND owner = $o`)
        .run({ $id: chatId, $f: folderId, $now: new Date().toISOString(), $t: s.tenant, $o: s.owner } as P) as unknown as Changes
      return r.changes > 0
    },
  }
}

export function branchingMethods(db: DatabaseSync) {
  const seqOf = (s: Scope, chatId: string, messageId: string): number | null => {
    const r = db.prepare(`SELECT seq FROM messages WHERE id = $id AND conv_id = $c AND tenant = $t AND owner = $o`)
      .get({ $id: messageId, $c: chatId, $t: s.tenant, $o: s.owner } as P) as unknown as { seq: number } | undefined
    return r ? r.seq : null
  }

  return {
    async getMessageVariants(s: Scope, messageId: string): Promise<ChatMessage[]> {
      const g = db.prepare(`SELECT variant_group FROM messages WHERE id = $id AND tenant = $t AND owner = $o`)
        .get({ $id: messageId, $t: s.tenant, $o: s.owner } as P) as unknown as { variant_group: string | null } | undefined
      if (!g?.variant_group) return []
      const rows = db.prepare(`SELECT * FROM messages WHERE variant_group = $g AND tenant = $t AND owner = $o ORDER BY seq ASC`)
        .all({ $g: g.variant_group, $t: s.tenant, $o: s.owner } as P) as unknown as MsgRow[]
      return rows.map(rowToMessage)
    },

    // NOTE ON GROUPING: ConversationStore's own regenerate flow (db.ts) establishes
    // variant_group EAGERLY — deactivateMessage there sets `variant_group =
    // COALESCE(variant_group, id)`, and the caller then creates the replacement via the
    // internal addMessage(..., { variantGroup: old.variantGroup }) overload, so both
    // siblings share a group from the moment the second one is created. The PUBLIC
    // MessageInput (./types.ts) deliberately has no variantGroup field — spec 27 §3.2
    // keeps internal-only concepts off the external wire — so a caller using only this
    // BranchingStore's public methods (deactivateMessage, then plain addMessage) cannot
    // establish that link at creation time. setActiveVariant is therefore where the group
    // gets completed lazily: it roots the target's group (mirroring deactivateMessage's
    // own COALESCE below) and folds in the still-ungrouped active reply of the same role
    // that currently occupies the slot right after it — the message a caller who just
    // did deactivate-then-addMessage obviously intended as the sibling.
    async setActiveVariant(s: Scope, messageId: string): Promise<boolean> {
      const target = db.prepare(`SELECT id, conv_id, seq, role, variant_group FROM messages WHERE id = $id AND tenant = $t AND owner = $o`)
        .get({ $id: messageId, $t: s.tenant, $o: s.owner } as P) as unknown as
        { id: string; conv_id: string; seq: number; role: string; variant_group: string | null } | undefined
      if (!target) return false

      const group = target.variant_group ?? target.id
      if (!target.variant_group) {
        db.prepare(`UPDATE messages SET variant_group = $g WHERE id = $id AND tenant = $t AND owner = $o`)
          .run({ $g: group, $id: target.id, $t: s.tenant, $o: s.owner } as P)
      }

      // Fold in the nearest still-ungrouped active message of the same role that comes
      // after target — a one-time bootstrap, harmless once every sibling already carries
      // variant_group (the WHERE ... IS NULL guard then matches nothing).
      db.prepare(`
        UPDATE messages SET variant_group = $g
        WHERE tenant = $t AND owner = $o AND id = (
          SELECT id FROM messages
          WHERE conv_id = $c AND tenant = $t AND owner = $o AND role = $role
            AND is_active = 1 AND seq > $seq AND variant_group IS NULL
          ORDER BY seq ASC LIMIT 1
        )
      `).run({ $g: group, $c: target.conv_id, $role: target.role, $seq: target.seq, $t: s.tenant, $o: s.owner } as P)

      db.prepare(`UPDATE messages SET is_active = 0 WHERE variant_group = $g AND tenant = $t AND owner = $o`)
        .run({ $g: group, $t: s.tenant, $o: s.owner } as P)
      const r = db.prepare(`UPDATE messages SET is_active = 1 WHERE id = $id AND tenant = $t AND owner = $o`)
        .run({ $id: messageId, $t: s.tenant, $o: s.owner } as P) as unknown as Changes
      return r.changes > 0
    },

    /** Mirrors ConversationStore.deactivateMessage (db.ts): deactivate without deleting,
     *  and root variant_group at this message's own id on its first regeneration so a
     *  later setActiveVariant has a stable group to switch within. */
    async deactivateMessage(s: Scope, messageId: string): Promise<boolean> {
      const r = db.prepare(`UPDATE messages SET is_active = 0, variant_group = COALESCE(variant_group, id) WHERE id = $id AND tenant = $t AND owner = $o`)
        .run({ $id: messageId, $t: s.tenant, $o: s.owner } as P) as unknown as Changes
      return r.changes > 0
    },

    async deactivateMessagesFrom(s: Scope, chatId: string, fromMessageId: string): Promise<number> {
      const seq = seqOf(s, chatId, fromMessageId)
      if (seq === null) return 0
      const r = db.prepare(`UPDATE messages SET is_active = 0 WHERE conv_id = $c AND seq >= $s AND tenant = $t AND owner = $o`)
        .run({ $c: chatId, $s: seq, $t: s.tenant, $o: s.owner } as P) as unknown as Changes
      return r.changes
    },

    async reactivateMessagesFrom(s: Scope, chatId: string, fromMessageId: string): Promise<number> {
      const seq = seqOf(s, chatId, fromMessageId)
      if (seq === null) return 0
      const r = db.prepare(`UPDATE messages SET is_active = 1 WHERE conv_id = $c AND seq >= $s AND tenant = $t AND owner = $o`)
        .run({ $c: chatId, $s: seq, $t: s.tenant, $o: s.owner } as P) as unknown as Changes
      return r.changes
    },

    async freezeTail(s: Scope, chatId: string, versionId: string): Promise<number> {
      const r = db.prepare(`UPDATE messages SET branch_of = $v WHERE conv_id = $c AND is_active = 0 AND branch_of IS NULL AND tenant = $t AND owner = $o`)
        .run({ $c: chatId, $v: versionId, $t: s.tenant, $o: s.owner } as P) as unknown as Changes
      return r.changes
    },

    async restoreTail(s: Scope, chatId: string, versionId: string): Promise<number> {
      const r = db.prepare(`UPDATE messages SET is_active = 1, branch_of = NULL WHERE conv_id = $c AND branch_of = $v AND tenant = $t AND owner = $o`)
        .run({ $c: chatId, $v: versionId, $t: s.tenant, $o: s.owner } as P) as unknown as Changes
      return r.changes
    },
  }
}
