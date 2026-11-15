import { buildSystemPrompt, type Personalization, type ResolvedAgent } from './personas'

/** What a chat agent decides about a conversation: its hidden system prompt, the tools it may call, whether every turn
 *  is forced through web search, and the skills it brings. One place builds it for both starting a chat with an agent
 *  and switching a running chat to another, so the two can never disagree about what "this agent" means. */
export interface AgentConversationConfig {
  systemPrompt: string
  /** undefined: unrestricted (an untouched built-in); an explicit [] means no tools (Blank). */
  allowedTools: string[] | undefined
  toolPolicy: 'force_web_search' | undefined
  /** The skills the agent itself brings, not the user's other enabled ones. */
  agentSkillIds: string[]
}

export interface SysInfoForPrompt {
  gpus: Array<{ name: string; vramMb: number }>
  ramMB: number
  os: string
}

/** The TurboLLM Expert agent's "User's hardware" section. */
export function hardwareSection(sys: SysInfoForPrompt): string {
  const gpuLine = sys.gpus.length > 0
    ? sys.gpus.map((g) => `${g.name} (${Math.round(g.vramMb / 1024)} GB VRAM)`).join(', ')
    : 'No GPU detected (CPU inference)'
  return `## User's hardware\nGPU: ${gpuLine}\nRAM: ${Math.round(sys.ramMB / 1024)} GB\nOS: ${sys.os}`
}

export function buildAgentConfig(
  agentId: string,
  agent: ResolvedAgent | undefined,
  personalization: Personalization,
  extras: { memoryFacts?: string[]; hardware?: string } = {},
): AgentConversationConfig {
  let systemPrompt = buildSystemPrompt(agentId, agent?.systemPrompt ?? '', personalization, extras.memoryFacts ?? [])
  if (agentId === 'expert' && extras.hardware) systemPrompt = systemPrompt ? `${systemPrompt}\n\n${extras.hardware}` : extras.hardware
  return {
    systemPrompt,
    allowedTools: agent?.tools,
    toolPolicy: agentId === 'research' ? 'force_web_search' : undefined,
    agentSkillIds: agent?.skillIds ?? [],
  }
}

/** The skills a conversation has after its agent changes: the ones the old agent brought leave, the new agent's join, and
 *  every other skill (picked by the user, or matched from a slash command) stays. */
export function skillIdsAfterSwitch(current: readonly string[], previous: ResolvedAgent | undefined, next: AgentConversationConfig): string[] {
  const leaving = new Set(previous?.skillIds ?? [])
  return Array.from(new Set([...current.filter((id) => !leaving.has(id)), ...next.agentSkillIds]))
}

/** The PATCH body that moves a running conversation onto `next`. `null` clears the tool allow-list or the policy, which
 *  a plain `undefined` could not do over JSON. */
const NO_PERSONALIZATION: Personalization = { assistantName: '', userName: '', customInstructions: '' }
const withoutDate = (text: string) => text.replace(/^Today's date is .*$/m, '')

/** Whether a chat's system prompt is something other than what `agentId` generates. A chat's prompt is baked in when it is
 *  created: capability text, the date, the agent's own prompt, then the user's personalization and memory. Anything that
 *  does not start with that (the date aside) was written in Thread settings, or the agent itself was edited since, and a
 *  switch replaces it, so the user is asked first. An empty prompt is what Blank generates. */
export function promptLooksCustomised(current: string, agentId: string, agent: ResolvedAgent | undefined): boolean {
  const expected = buildSystemPrompt(agentId, agent?.systemPrompt ?? '', NO_PERSONALIZATION)
  // Blank generates nothing, and every string starts with the empty string: any text there is the user's own.
  if (!expected) return current.trim() !== ''
  return !withoutDate(current).startsWith(withoutDate(expected))
}

export function agentSwitchPatch(agentId: string, next: AgentConversationConfig, skillIds: string[]) {
  return {
    chatAgentId: agentId,
    systemPrompt: next.systemPrompt,
    allowedTools: next.allowedTools ?? null,
    toolPolicy: next.toolPolicy ?? null,
    skillIds,
  }
}
