export type AgentRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

// ── Agent definitions (the persona-like "Hitman" configs) ──────────────────────

export interface AgentType {
  id: string
  name: string
  description: string
  systemPrompt?: string     // the agent's persona
  builtin?: boolean
  skills: string[]          // skill ids, or ['*'] for all
  readRoots: string[]
  writeRoots: string[]      // fixed to ~/.turbollm server-side; not user-settable
  callableAgents: string[]
  disabledTools?: string[]  // per-agent tool denylist (Pass D); empty = all tools on
  maxIterations?: number
}

// A tool the agent could use (built-in or MCP), from GET /api/v1/agents/tools.
export interface ToolInfo {
  name: string
  description: string
}

// ── Skills (the global library) ────────────────────────────────────────────────

export interface Skill {
  id: string
  name: string
  description: string
  instructions: string
  tools: string[]
  builtin?: boolean
}

// ── Runs ("contracts") ─────────────────────────────────────────────────────────

export interface AgentRun {
  id: string
  convId: string
  title: string
  status: AgentRunStatus
  agentId?: string
  error?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  endedAt?: string
  archivedAt?: string
  completion?: 'complete' | 'miss'
  messages?: AgentMessage[]
}

export interface AgentToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  result: string
}

export interface AgentMessage {
  id: string
  convId: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  toolCalls?: AgentToolCall[]
  createdAt: string
}

export interface AgentSseEvent {
  seq: number
  event: string
  data: unknown
}
