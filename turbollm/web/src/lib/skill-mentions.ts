const TRAILING_MENTION = /(^|\s)@[a-z0-9-]*$/i
const MENTION = /(?:^|\s)@([a-z0-9-]+)(?=$|[\s.,;:!?)\]]|['’])/gi

export function trailingMentionQuery(input: string): string | null {
  const match = /(?:^|\s)@([a-z0-9-]*)$/i.exec(input)
  return match ? match[1].toLowerCase() : null
}

export function completeMention(input: string, skillId: string): string {
  return input.replace(TRAILING_MENTION, `$1@${skillId} `)
}

export function dismissMention(input: string): string {
  return input.replace(TRAILING_MENTION, '$1')
}

/** Skill ids are lowercase, so a mention is matched case-insensitively, as the picker already does. */
export function findMentionedSkillIds(text: string, skills: ReadonlyArray<{ id: string }>): string[] {
  const knownIds = new Set(skills.map((skill) => skill.id))
  const mentioned = [...text.matchAll(MENTION)].map((match) => match[1].toLowerCase()).filter((id) => knownIds.has(id))
  return [...new Set(mentioned)]
}
