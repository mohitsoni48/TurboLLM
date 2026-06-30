import { authHeaders, ApiError } from './api'
import type { AgentRun, AgentType, Skill } from './agent-types'

export const agentRunKeys = {
  all: ['agent-runs'] as const,
  list: () => [...agentRunKeys.all, 'list'] as const,
  detail: (id: string) => [...agentRunKeys.all, 'detail', id] as const,
}

export const agentKeys = {
  all: ['agents'] as const,
  list: () => [...agentKeys.all, 'list'] as const,
}

export const skillKeys = {
  all: ['skills'] as const,
  list: () => [...skillKeys.all, 'list'] as const,
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...authHeaders(),
    ...((init?.headers as Record<string, string>) ?? {}),
  }
  const res = await fetch(path, { ...init, headers })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : undefined
  if (!res.ok) {
    const env = data as { error?: { code?: string; message?: string } } | undefined
    throw new ApiError(
      env?.error?.code ?? 'http_error',
      env?.error?.message ?? `Request failed with status ${res.status}.`,
      res.status,
    )
  }
  return data as T
}

// ── Agent definitions ──────────────────────────────────────────────────────────

export async function fetchAgents(): Promise<AgentType[]> {
  return req<AgentType[]>('/api/v1/agents')
}

export async function createAgent(params: Partial<AgentType>): Promise<AgentType> {
  return req<AgentType>('/api/v1/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
}

export async function updateAgent(id: string, patch: Partial<AgentType>): Promise<AgentType> {
  return req<AgentType>(`/api/v1/agents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export async function deleteAgent(id: string): Promise<void> {
  await req<{ ok: boolean }>(`/api/v1/agents/${id}`, { method: 'DELETE' })
}

// ── Grown skills + lessons (spec 13 redesign §3.3) ─────────────────────────────

// A skill from the shared SKILL.md library (skill-creator model).
export interface LearnedSkill { id: string; name: string; description: string; instructions: string; tools: string[]; builtin?: boolean; source?: string }
export interface LearnedLesson { id: string; agentId: string; lesson: string; evidence?: string; createdAt: string }

export async function fetchLearned(agentId: string): Promise<{ skills: LearnedSkill[]; lessons: LearnedLesson[] }> {
  return req(`/api/v1/agents/${agentId}/learned`)
}

export async function deleteLearnedSkill(agentId: string, skillId: string): Promise<void> {
  await req<{ ok: boolean }>(`/api/v1/agents/${agentId}/skills/${skillId}`, { method: 'DELETE' })
}

export async function learnFromFolder(agentId: string, folder: string): Promise<{ ok: true; learning: boolean }> {
  return req(`/api/v1/agents/${agentId}/learn-folder`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }),
  })
}

export async function saveConversationAsSkill(convId: string): Promise<{ ok: true; learning: boolean }> {
  return req(`/api/v1/conversations/${convId}/save-skill`, { method: 'POST' })
}

// ── pi agent runs (each agent message = a pi run, spec 13 redesign) ─────────────

export type AgentMode = 'ask' | 'auto' | 'bypass' | 'read'

/** Set a conversation's pi permission mode. */
export function setAgentMode(convId: string, mode: AgentMode): Promise<{ ok: true; mode: AgentMode }> {
  return req(`/api/v1/agents/conversations/${encodeURIComponent(convId)}/mode`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
  })
}

/** Run a pi turn inside an agent conversation; returns the run id to stream. */
export function runAgentTurn(convId: string, userMessage: string): Promise<{ runId: string }> {
  return req(`/api/v1/agents/conversations/${encodeURIComponent(convId)}/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userMessage }),
  })
}

export interface AgentRunEvent { event: string; data: Record<string, unknown> }

/** Stream a pi run's events (SSE replay + live-tail). Reconnectable via fromSeq. */
export async function* streamAgentRun(runId: string, signal: AbortSignal, fromSeq = 0): AsyncGenerator<AgentRunEvent> {
  const res = await fetch(`/api/v1/agents/runs/${encodeURIComponent(runId)}/stream?fromSeq=${fromSeq}`, {
    headers: { ...authHeaders() }, signal,
  })
  if (!res.ok || !res.body) throw new ApiError('http_error', `Stream failed (${res.status}).`, res.status)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      let event = ''
      for (const line of lines) {
        if (line.startsWith('event: ')) { event = line.slice(7).trim() }
        else if (line.startsWith('data: ')) {
          const raw = line.slice(6).trim()
          try { const data = JSON.parse(raw); if (event) yield { event, data } } catch { /* skip */ }
          event = ''
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ── Skills ───────────────────────────────────────────────────────────────────

export async function fetchSkills(): Promise<Skill[]> {
  return req<Skill[]>('/api/v1/skills')
}

export async function saveSkill(skill: Skill): Promise<Skill> {
  return req<Skill>('/api/v1/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(skill),
  })
}

export async function deleteSkill(id: string): Promise<void> {
  await req<{ ok: boolean }>(`/api/v1/skills/${id}`, { method: 'DELETE' })
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export async function fetchAgentRuns(): Promise<AgentRun[]> {
  return req<AgentRun[]>('/api/v1/agents/runs')
}

export async function fetchAgentRun(id: string): Promise<AgentRun> {
  return req<AgentRun>(`/api/v1/agents/runs/${id}`)
}

/** Launch a run AS a given agent (the run inherits the agent's skills + scope). */
export async function createAgentRun(agentId: string, params: {
  title?: string
  userMessage: string
}): Promise<AgentRun> {
  return req<AgentRun>(`/api/v1/agents/${agentId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
}

export async function cancelAgentRun(id: string): Promise<void> {
  await req<{ ok: boolean }>(`/api/v1/agents/runs/${id}`, { method: 'DELETE' })
}

// ── Hitman layer: disposition, doc, track record, archive ──────────────────────

export async function completeRun(id: string): Promise<void> {
  await req<{ ok: boolean }>(`/api/v1/agents/runs/${id}/complete`, { method: 'POST' })
}

export async function flagMiss(id: string, feedback: string): Promise<void> {
  await req<{ ok: boolean }>(`/api/v1/agents/runs/${id}/flag-miss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback }),
  })
}

export async function fetchRunDoc(id: string): Promise<{ content: string }> {
  return req<{ content: string }>(`/api/v1/agents/runs/${id}/doc`)
}

export interface TrackRecord {
  rows: Array<{ id: string; agentId: string; runId: string; model: string; outcome: 'complete' | 'miss'; feedback?: string; ranAt: string }>
  modelStats: Array<{ model: string; total: number; complete: number; successRate: number }>
}

export async function fetchTrackRecord(agentId: string): Promise<TrackRecord> {
  return req<TrackRecord>(`/api/v1/agents/${agentId}/track-record`)
}

export async function fetchArchive(agentId: string): Promise<AgentRun[]> {
  return req<AgentRun[]>(`/api/v1/agents/${agentId}/archive`)
}

/** Async generator that replays buffered events from `fromSeq` then live-tails. */
export async function* subscribeRunStream(
  id: string,
  fromSeq = 0,
  signal?: AbortSignal,
): AsyncGenerator<{ event: string; data: unknown }> {
  const url = `/api/v1/agents/runs/${id}/stream?fromSeq=${fromSeq}`
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...authHeaders() },
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`Stream error: ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      let currentEvent = 'message'
      for (const line of lines) {
        if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue }
        if (line.startsWith('data: ')) {
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') return
          try {
            const data = JSON.parse(raw) as unknown
            yield { event: currentEvent, data }
            if (currentEvent === 'done' || currentEvent === 'error') return
          } catch { /* ignore malformed */ }
          currentEvent = 'message'
        }
      }
    }
  } finally {
    reader.cancel()
  }
}
