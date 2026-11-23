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

const NO_PERSONALIZATION: Personalization = { assistantName: '', userName: '', customInstructions: '' }
const withoutDate = (text: string) => text.replace(/^Today's date is .*$/m, '')

/** The sections a chat's creation (or a switch) appends after the agent's own prompt: the assistant's name, the user's name,
 *  the user's custom instructions (Settings, Personalization), the memory facts, and for the Expert agent the hardware.
 *  Each is one block, separated from the rest by a blank line (buildSystemPrompt, hardwareSection). */
function isGeneratedBlock(block: string, personalization: Personalization): boolean {
  if (/^Your name is [^\n]+\.$/.test(block) || /^The user's name is [^\n]+\.$/.test(block)) return true
  const custom = personalization.customInstructions.trim()
  if (custom && block === custom) return true
  if (block.startsWith('What you know about the user from past conversations:\n')) {
    return block.split('\n').slice(1).every((line) => /^- \S/.test(line))
  }
  return /^## User's hardware\nGPU: [^\n]*\nRAM: \d+ GB\nOS: [^\n]*$/.test(block)
}

/** Whether a chat's system prompt holds something `agentId` did not generate. A chat's prompt is baked in when it is created:
 *  capability text, the date, the agent's own prompt, then blocks for the user's personalization, memory and (Expert) hardware.
 *  Text that is not one of those blocks (a line appended in Thread settings, a prompt replaced outright, an agent edited since)
 *  is the user's, and a switch replaces it, so the user is asked first. The blocks are matched by shape, not by value: memory
 *  facts and personalization change over time, and a changed value must not read as an edit. The one value compared is the
 *  user's custom instructions, which have no shape; changing them after the chat began shows the dialog once (noise, not loss).
 *  Text glued onto the end of a memory fact or a name line reads as part of it (that line has no shape to tell it apart).
 *  An empty prompt is what Blank generates. */
export function promptLooksCustomised(current: string, agentId: string, agent: ResolvedAgent | undefined, personalization: Personalization = NO_PERSONALIZATION): boolean {
  const expected = withoutDate(buildSystemPrompt(agentId, agent?.systemPrompt ?? '', NO_PERSONALIZATION))
  const actual = withoutDate(current)
  // Blank generates nothing, and every string starts with the empty string: any text there is the user's own.
  if (!expected) return actual.trim() !== ''
  if (!actual.startsWith(expected)) return true
  let tail = actual.slice(expected.length)
  if (tail === '') return false
  if (!tail.startsWith('\n\n')) return true
  // Custom instructions may contain blank lines of their own. Match the whole
  // generated segment before splitting the remaining name/memory/hardware blocks.
  // Require block boundaries so an appended edit cannot hide behind a prefix match.
  const custom = personalization.customInstructions.trim()
  if (custom) {
    const segment = `\n\n${custom}`
    const start = tail.indexOf(segment)
    if (start !== -1) {
      const end = start + segment.length
      if (end === tail.length || tail.startsWith('\n\n', end)) tail = tail.slice(0, start) + tail.slice(end)
    }
  }
  if (!tail) return false
  return !tail.slice(2).split('\n\n').every((block) => isGeneratedBlock(block, personalization))
}

/** The PATCH body that moves a running conversation onto `next`. `null` clears the tool allow-list or the policy, which
 *  a plain `undefined` could not do over JSON. */
export function agentSwitchPatch(agentId: string, next: AgentConversationConfig, skillIds: string[]) {
  return {
    chatAgentId: agentId,
    systemPrompt: next.systemPrompt,
    allowedTools: next.allowedTools ?? null,
    toolPolicy: next.toolPolicy ?? null,
    skillIds,
  }
}

/** The open chat as it is after a switch, from what the PATCH answered. The answer is the stored chat without its messages,
 *  and JSON drops a cleared (undefined) field, so spreading it over the old chat would keep the old `allowedTools` and
 *  `toolPolicy`: the fields the switch sends are replaced outright instead. */
export function conversationAfterSwitch<C extends { messages?: unknown }>(
  old: C,
  updated: { chatAgentId?: string; systemPrompt?: string; allowedTools?: string[]; toolPolicy?: string; skillIds?: string[] },
): Omit<C, keyof typeof updated> & typeof updated {
  return {
    ...old,
    ...updated,
    chatAgentId: updated.chatAgentId,
    systemPrompt: updated.systemPrompt,
    allowedTools: updated.allowedTools,
    toolPolicy: updated.toolPolicy,
    skillIds: updated.skillIds,
    messages: old.messages,
  }
}
