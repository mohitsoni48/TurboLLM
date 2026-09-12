// Chat export / debug snapshot builder (F-023, F-024).
// Pure function — no side-effects, no Date.now() calls; pass `exportedAt` in so
// the output is deterministic and unit-testable.
import type { Conversation, Message, ToolCallRecord } from './db.js'
import type { Config } from '../config/config.js'

/** Discriminator for the two export modes:
 *  - 'debug'  — clipboard / bug report; no download headers
 *  - 'export' — download as .turbollm-chat.json; portable cross-machine format */
export type ExportFormat = 'debug' | 'export'

export interface SnapshotMessage {
  role: string
  content: string
  tool_calls?: ToolCallRecord[]
  tool_call_id?: string
  ts: string
}

export interface ChatSnapshot {
  turbollm_version: string
  exported_at: string
  format: ExportFormat
  chat_id: string
  title: string
  model: string
  persona: string
  messages: SnapshotMessage[]
  settings_snapshot: {
    keepN: number
    autoSwap: boolean
    tavilyConfigured: boolean
  }
  /** Compaction state (ADR-420) — present only when the conversation has been compacted at
   *  least once. A round-tripped import without this field is simply an uncompacted chat;
   *  no migration needed on the import side. Import deliberately does NOT restore this field
   *  either: it mints fresh message ids, so `uptoMessageId` could never re-anchor to the right
   *  message, and a cut that cannot resolve would pin the imported chat permanently on the
   *  never-lossy fallback (summary PLUS every message, every turn) with no divider ever
   *  rendering to explain it. Exported for the reader of a snapshot, not for replay. */
  compaction?: { summary: string; uptoMessageId: string; tokensBefore: number }
}

/**
 * Build a portable chat snapshot.
 *
 * @param conv        - Conversation row (must include `.messages`).
 * @param cfg         - Current config snapshot (for settings_snapshot).
 * @param version     - Value of `turbollm_version` in `package.json`.
 * @param exportedAt  - ISO timestamp string (passed in so the fn is pure / testable).
 * @param format      - 'debug' for clipboard/bug-report; 'export' for file download.
 */
export function buildSnapshot(
  conv: Conversation & { messages: Message[] },
  cfg: Config,
  version: string,
  exportedAt: string,
  format: ExportFormat,
): ChatSnapshot {
  const msgs: SnapshotMessage[] = (conv.messages ?? []).map((m) => {
    const entry: SnapshotMessage = {
      role: m.role,
      content: m.content,
      ts: m.createdAt,
    }
    // Include tool call records on assistant turns that used tools.
    if (m.toolCalls && m.toolCalls.length > 0) {
      entry.tool_calls = m.toolCalls
    }
    return entry
  })

  // Derive persona from toolPolicy: force_web_search → 'research', else 'default'.
  const persona = conv.toolPolicy === 'force_web_search' ? 'research' : 'default'

  return {
    turbollm_version: version,
    exported_at: exportedAt,
    format,
    chat_id: conv.id,
    title: conv.title,
    model: conv.modelKey,
    persona,
    messages: msgs,
    settings_snapshot: {
      keepN: cfg.gateway?.keepN ?? 1,
      autoSwap: cfg.gateway?.autoSwap ?? true,
      tavilyConfigured: !!(cfg.tools?.tavily?.apiKey),
    },
    ...(conv.compactionSummary && conv.compactionUpToMessageId
      ? { compaction: { summary: conv.compactionSummary, uptoMessageId: conv.compactionUpToMessageId, tokensBefore: conv.compactionTokensBefore ?? 0 } }
      : {}),
  }
}
