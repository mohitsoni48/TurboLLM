export interface MessageStats {
  promptTokens: number
  promptMs: number
  promptTps: number
  cachedTokens: number
  genTokens: number
  genMs: number
  tps: number
  ttftMs: number
  totalMs: number
  thinkMs: number
  ctxUsed: number
  ctxMax: number
  model: string
  aborted: boolean
}

export interface ToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
  error?: string
}

export interface LiveToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'pending' | 'done' | 'error' | 'awaiting_approval'
  result?: string
}

/** Tool-call approval gate policy (mirrors turbollm/src/tools/tool-policy.ts). */
export type ToolPolicy = 'ask' | 'allow' | 'deny'

/** F-021: a single ranked research result from the retrieval service. */
export interface ResearchSource {
  url: string
  title: string
  passage: string
  relevanceScore: number
  freshnessSignal: 'recent' | 'dated' | 'unknown'
  domain: string
}

/** F-022: per-sentence claim verdict from the heuristic referee. */
export interface ClaimVerdict {
  sentence: string
  citedUrl?: string
  verdict: 'verified' | 'unverified' | 'uncited'
  matchedPassage?: string
}

/** F-021/F-022: research metadata attached to Research-persona messages. */
export interface ResearchMeta {
  confidence?: number
  sources?: ResearchSource[]
  refereeVerdicts?: ClaimVerdict[]
}

export interface Message {
  id: string
  convId: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  attachments: string[]
  textAttachments: string[]
  toolCalls: ToolCallRecord[]
  stats: Partial<MessageStats>
  /** F-021/F-022: research metadata (confidence, sources, referee verdicts). */
  researchMeta?: ResearchMeta
  createdAt: string
  /** Chat branching (GitHub #52): shared by this message and its regenerated siblings.
   *  Null when it's never been regenerated — no branch switcher to show. */
  variantGroup: string | null
  /** Chat branching: whether this is the sibling currently shown/sent as history. */
  isActive: boolean
}

export interface Conversation {
  id: string
  title: string
  systemPrompt: string
  modelKey: string
  sampling: Record<string, number>
  /** Built-in TurboLLM Expert thread — its system prompt is managed server-side
   *  and hidden from the UI (spec 08 §2). */
  expertMode: boolean
  /** When set, the backend enforces a tool_choice policy on the first generation
   *  iteration. 'force_web_search' forces web_search before the model can reply. */
  toolPolicy?: string
  /** Folder this conversation is filed under (v10). null/undefined = uncategorized. */
  folderId?: string | null
  /** Skill ids enabled for this conversation (the shared SKILL.md library). Their
   *  instructions are injected into the system prompt; 'skill-creator' additionally
   *  grants the save_skill tool. Undefined/empty = a plain chat with no skills. */
  skillIds?: string[]
  /** Tool-name allow-list baked in from a custom chat Agent at creation (Customize →
   *  Agents). Undefined/empty = unrestricted (every built-in persona). */
  allowedTools?: string[]
  /** GitHub #52: when true, past turns' reasoning is resent to the engine (not just
   *  their final answer) so the model can see its own prior thinking. Off by default. */
  preserveThinking: boolean
  createdAt: string
  updatedAt: string
  messages?: Message[]
}

/** A chat folder for grouping conversations in the sidebar (v10). Flat — no nesting. */
export interface Folder {
  id: string
  name: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

// SSE event payloads
export type ChatSseEvent =
  | { event: 'meta';      data: { userMessageId: string; assistantMessageId: string } }
  | { event: 'progress';  data: { phase: string; processed: number; total: number; pct: number; tps: number } }
  | { event: 'reasoning'; data: { delta: string } }
  | { event: 'delta';     data: { delta: string } }
  | { event: 'tool_call'; data: { id: string; name: string; args: Record<string, unknown>; status: 'pending' | 'done' | 'error' | 'awaiting_approval'; result?: string } }
  | { event: 'done';      data: { message: Message } }
  | { event: 'error';     data: { code: string; message: string } }
