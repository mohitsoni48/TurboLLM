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

/** The skills a new conversation is created with, or undefined to let the daemon seed the defaults (which a client
 *  that cannot read settings, such as a remote-access token, could not do itself). Blank and an agent with a skill
 *  list of its own never get the defaults: Blank is raw output, and an agent's list is its whole allow-list. */
export function skillIdsForNewConversation({ selection, defaults, agentSkillIds, isBlankAgent, named }: NewConversationSkills): string[] | undefined {
  const takesDefaults = !isBlankAgent && agentSkillIds === undefined
  if (selection === null && takesDefaults && named.length === 0) return undefined
  const base = selection ?? (takesDefaults ? defaults : [])
  return [...new Set([...base, ...(agentSkillIds ?? []), ...named])]
}
