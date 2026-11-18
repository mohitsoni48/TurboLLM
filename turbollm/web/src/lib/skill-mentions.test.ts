// '@skill-id' in the composer: a trailing '@partial' opens the skill picker, picking one completes the token, and a sent
// message turns on every skill it names, the way '/skill-id' at the start of a message already does.
import { describe, it, expect } from 'vitest'
import { completeMention, findMentionedSkillIds, trailingMentionQuery } from './skill-mentions'

const skills = [{ id: 'web-research' }, { id: 'code-review' }, { id: 'web' }]

describe('trailingMentionQuery', () => {
  it('reads the partial skill name after an @ at the end of the text', () => {
    expect(trailingMentionQuery('@')).toBe('')
    expect(trailingMentionQuery('@we')).toBe('we')
    expect(trailingMentionQuery('summarise this with @Web-Re')).toBe('web-re')
  })

  it('is null when the @ is inside a word, not at the end, or the token is finished', () => {
    expect(trailingMentionQuery('mail me at bob@example')).toBeNull()
    expect(trailingMentionQuery('@web then more')).toBeNull()
    expect(trailingMentionQuery('@web ')).toBeNull()
    expect(trailingMentionQuery('no mention')).toBeNull()
  })
})

describe('completeMention', () => {
  it('replaces the trailing token with the whole skill id and a space', () => {
    expect(completeMention('use @we', 'web-research')).toBe('use @web-research ')
    expect(completeMention('@', 'code-review')).toBe('@code-review ')
  })
})

describe('findMentionedSkillIds', () => {
  it('returns the ids of known skills named with @, once each, in order', () => {
    expect(findMentionedSkillIds('ask @code-review and @web-research, then @code-review again', skills)).toEqual(['code-review', 'web-research'])
  })

  it('ignores unknown names, email addresses, and a name that merely starts with a skill id', () => {
    expect(findMentionedSkillIds('@nope bob@web.com @web-researcher', skills)).toEqual([])
  })

  it('matches an id followed by punctuation', () => {
    expect(findMentionedSkillIds('(see @web.)', skills)).toEqual(['web'])
  })
})
