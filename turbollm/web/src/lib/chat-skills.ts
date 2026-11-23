/** Library skills a chat cannot run (their tools need Code's filesystem access): never offered in chat pickers or as defaults. */
export const CHAT_UNSUPPORTED_SKILLS: ReadonlySet<string> = new Set(['filesystem'])

interface NewConversationSkills {
  /** What the user picked in Thread settings; null while they have not touched it. */
  selection: string[] | null
  /** The skills on by default, as the web UI could read them. */
  defaults: string[]
  /** The chosen agent's own skill list, set only for custom agents. */
  agentSkillIds: string[] | undefined
  isBlankAgent: boolean
  /** Skills the message itself names, with '/' or '@'. */
  named: string[]
}

/** Whether a new chat on this agent starts with the user's default skills: not Blank (raw output), and not an agent that lists
 *  skills of its own (that list is its whole allow-list). */
const takesDefaultSkills = (isBlankAgent: boolean, agentSkillIds: string[] | undefined) => !isBlankAgent && agentSkillIds === undefined

/** The skills an empty chat (no first message yet) shows as on: what the user picked, else what a chat on this agent would
 *  start with. The picker and Thread settings build their next selection from this, so it must not include skills the new
 *  chat would not get, or picking one skill on Blank would turn every default on. */
export function pendingSkillsFor({ selection, defaults, agentSkillIds, isBlankAgent }: Omit<NewConversationSkills, 'named'>): string[] {
  return selection ?? (takesDefaultSkills(isBlankAgent, agentSkillIds) ? defaults : [])
}

/** The skills the current screen has on: an open chat's own list (none when the daemon stored none, as for every chat made
 *  before defaults existed: defaults only seed a new chat), else the pending ones of the empty chat. */
export function enabledSkillsOf({ chatOpen, convSkillIds, pending }: { chatOpen: boolean; convSkillIds: string[] | undefined; pending: string[] }): string[] {
  return chatOpen ? (convSkillIds ?? []) : pending
}

/** The skills a new conversation is created with, or undefined to let the daemon seed the defaults (which a client
 *  that cannot read settings, such as a remote-access token, could not do itself). Blank and an agent with a skill
 *  list of its own never get the defaults: Blank is raw output, and an agent's list is its whole allow-list. */
export function skillIdsForNewConversation({ selection, defaults, agentSkillIds, isBlankAgent, named }: NewConversationSkills): string[] | undefined {
  const takesDefaults = takesDefaultSkills(isBlankAgent, agentSkillIds)
  if (selection === null && takesDefaults && named.length === 0) return undefined
  const base = selection ?? (takesDefaults ? defaults : [])
  return [...new Set([...base, ...(agentSkillIds ?? []), ...named])]
}
