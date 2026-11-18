// Which skills a brand-new conversation is created with. The defaults (Skills library → "On by default") apply to a plain
// chat, never to Blank (raw output, no injected instructions) or to an agent that lists skills of its own, and an
// untouched blank chat sends nothing, so the daemon seeds the defaults itself (a remote-access token cannot read them).
import { describe, it, expect } from 'vitest'
import { CHAT_UNSUPPORTED_SKILLS, skillIdsForNewConversation } from './chat-skills'

const plain = { selection: null, defaults: ['web'], agentSkillIds: undefined, isBlankAgent: false, named: [] as string[] }

describe('skillIdsForNewConversation', () => {
  it('sends nothing for an untouched plain chat, leaving the defaults to the daemon', () => {
    expect(skillIdsForNewConversation(plain)).toBeUndefined()
  })

  it('adds the skills the message names on top of the defaults', () => {
    expect(skillIdsForNewConversation({ ...plain, named: ['code'] })).toEqual(['web', 'code'])
  })

  it('sends exactly what the user picked, an empty pick meaning none', () => {
    expect(skillIdsForNewConversation({ ...plain, selection: [] })).toEqual([])
    expect(skillIdsForNewConversation({ ...plain, selection: ['code'], named: ['code', 'x'] })).toEqual(['code', 'x'])
  })

  it('gives Blank no default skills, but still the ones the user picks or names', () => {
    expect(skillIdsForNewConversation({ ...plain, isBlankAgent: true })).toEqual([])
    expect(skillIdsForNewConversation({ ...plain, isBlankAgent: true, named: ['code'] })).toEqual(['code'])
  })

  it('gives an agent with its own skill list that list, not the defaults', () => {
    expect(skillIdsForNewConversation({ ...plain, agentSkillIds: ['code'] })).toEqual(['code'])
  })

  it('keeps chat-unsupported skills out of the defaults', () => {
    expect(CHAT_UNSUPPORTED_SKILLS.has('filesystem')).toBe(true)
  })
})
