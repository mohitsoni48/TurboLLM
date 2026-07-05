import { authHeaders, ApiError } from './api'
import type { Skill } from './agent-types'

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

// ── Skills (the shared library any chat conversation can enable) ──────────────

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

/** Create a skill from a raw SKILL.md file's text (the upload path). */
export async function importSkillText(text: string): Promise<Skill> {
  return req<Skill>('/api/v1/skills/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

export async function learnFromFolder(folder: string): Promise<{ ok: true; learning: boolean }> {
  return req('/api/v1/skills/learn-folder', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }),
  })
}

/** Distill this conversation's transcript into a reusable skill (Voyager-style). */
export async function saveConversationAsSkill(convId: string): Promise<{ ok: true; learning: boolean }> {
  return req(`/api/v1/conversations/${convId}/save-skill`, { method: 'POST' })
}
