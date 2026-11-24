// Which skills a brand-new conversation is created with. The defaults (Skills library → "On by default") apply to a plain
// chat, never to Blank (raw output, no injected instructions) or to an agent that lists skills of its own, and an
// untouched blank chat sends nothing, so the daemon seeds the defaults itself (a remote-access token cannot read them).
import { describe, it, expect } from 'vitest'
import { CHAT_UNSUPPORTED_SKILLS, enabledSkillsOf, pendingSkillsFor, skillIdsForNewConversation } from './chat-skills'

// The skills an empty chat shows as on, before its first message. They have to be the ones that chat would start with: the
// picker and Thread settings build their next selection from them, and that selection becomes the new chat's skills.
describe('pendingSkillsFor', () => {
  const base = { selection: null, defaults: ['web'], agentSkillIds: undefined, isBlankAgent: false }

  it('shows the defaults on a plain chat the user has not touched', () => {
    expect(pendingSkillsFor(base)).toEqual(['web'])
  })

  it('shows none on Blank, so picking a skill there does not drag the defaults in', () => {
    expect(pendingSkillsFor({ ...base, isBlankAgent: true })).toEqual([])
  })

  it('shows none for an agent with a skill list of its own, which is its whole allow-list', () => {
    expect(pendingSkillsFor({ ...base, agentSkillIds: ['code'] })).toEqual([])
    expect(pendingSkillsFor({ ...base, agentSkillIds: [] })).toEqual([])
  })

  it('shows exactly what the user picked, an empty pick included', () => {
    expect(pendingSkillsFor({ ...base, selection: ['code'] })).toEqual(['code'])
    expect(pendingSkillsFor({ ...base, selection: [] })).toEqual([])
    expect(pendingSkillsFor({ ...base, selection: ['code'], isBlankAgent: true })).toEqual(['code'])
  })
})

// The skills an OPEN chat has on. A chat the daemon stored without a skill list (everything created before defaults existed)
// has none: the defaults only seed a new chat, they are not a fallback for an old one.
describe('enabledSkillsOf', () => {
  it('uses the open chat\'s own list, and no list means none', () => {
    expect(enabledSkillsOf({ chatOpen: true, convSkillIds: ['code'], pending: ['web'] })).toEqual(['code'])
    expect(enabledSkillsOf({ chatOpen: true, convSkillIds: undefined, pending: ['web'] })).toEqual([])
    expect(enabledSkillsOf({ chatOpen: true, convSkillIds: [], pending: ['web'] })).toEqual([])
  })

  it('uses the pending skills while there is no chat yet', () => {
    expect(enabledSkillsOf({ chatOpen: false, convSkillIds: undefined, pending: ['web'] })).toEqual(['web'])
  })
})

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
