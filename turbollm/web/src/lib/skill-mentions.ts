/** Library skills a chat cannot run (their tools need Code's filesystem access): never offered in chat pickers or as defaults. */
export const CHAT_UNSUPPORTED_SKILLS: ReadonlySet<string> = new Set(['filesystem'])

const TRAILING_MENTION = /(?:^|\s)@([a-z0-9-]*)$/i
const MENTION = /(?:^|\s)@([a-z0-9-]+)(?=$|[\s.,;:!?)\]])/gi

export function trailingMentionQuery(input: string): string | null {
  const match = TRAILING_MENTION.exec(input)
  return match ? match[1].toLowerCase() : null
}

export function completeMention(input: string, skillId: string): string {
  return input.replace(TRAILING_MENTION, (token) => `${token.slice(0, token.indexOf('@'))}@${skillId} `)
}

export function findMentionedSkillIds(text: string, skills: ReadonlyArray<{ id: string }>): string[] {
  const knownIds = new Set(skills.map((skill) => skill.id))
  const mentioned = [...text.matchAll(MENTION)].map((match) => match[1]).filter((id) => knownIds.has(id))
  return [...new Set(mentioned)]
}
