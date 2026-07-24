import { describe, expect, it } from 'vitest'
import { CODE_COMMANDS, matchCodeCommand, pickerCodeCommands } from './code-commands'

describe('matchCodeCommand', () => {
  it('matches /compact and captures its trailing instructions argument', () => {
    const m = matchCodeCommand('/compact focus on the auth module')
    expect(m?.id).toBe('compact')
    expect(m?.match[1]).toBe('focus on the auth module')
  })

  it('matches a bare /compact with an empty argument', () => {
    const m = matchCodeCommand('/compact')
    expect(m?.id).toBe('compact')
    expect(m?.match[1]?.trim() || undefined).toBeUndefined()
  })

  it('matches /clear and /resume (no argument)', () => {
    expect(matchCodeCommand('/clear')?.id).toBe('clear')
    expect(matchCodeCommand('/resume')?.id).toBe('resume')
  })

  it('matches the ADR-258 additions /init, /details, /thinking', () => {
    expect(matchCodeCommand('/init')?.id).toBe('init')
    expect(matchCodeCommand('/details')?.id).toBe('details')
    expect(matchCodeCommand('/thinking')?.id).toBe('thinking')
  })

  it('matches a !command shell escape, capturing bang and command', () => {
    const m = matchCodeCommand('!npm test')
    expect(m?.id).toBe('shell')
    expect(m?.match[1]).toBe('!')
    expect(m?.match[2]).toBe('npm test')
  })

  it('distinguishes !! (no model context) from ! (feeds the model)', () => {
    expect(matchCodeCommand('!!git status')?.match[1]).toBe('!!')
    expect(matchCodeCommand('! ls -la')?.match[1]).toBe('!') // whitespace after the bang is allowed
    expect(matchCodeCommand('! ls -la')?.match[2]).toBe('ls -la')
  })

  it('does NOT treat a lone bang (no command) as a shell command', () => {
    expect(matchCodeCommand('!')).toBeNull()
    expect(matchCodeCommand('!!  ')).toBeNull()
  })

  it('keeps the shell command out of the / picker (pickerVisible false)', () => {
    expect(pickerCodeCommands({ cleared: true }).some((c) => c.id === 'shell')).toBe(false)
  })

  it('is case-insensitive on the trigger', () => {
    expect(matchCodeCommand('/CLEAR')?.id).toBe('clear')
  })

  it('does not match /clear with trailing text (it takes no argument)', () => {
    // The old CLEAR_RE was anchored `^/clear\s*$` — extra text means it is NOT the clear command
    // (it falls through to a normal turn), so this must stay null to preserve that behavior.
    expect(matchCodeCommand('/clear the whole thing please')).toBeNull()
  })

  it('returns null for a non-built-in slash input (e.g. a skill) so the caller handles it', () => {
    expect(matchCodeCommand('/some-skill do the thing')).toBeNull()
  })

  it('returns null for ordinary prose', () => {
    expect(matchCodeCommand('please refactor the parser')).toBeNull()
  })
})

describe('pickerCodeCommands', () => {
  it('offers the always-available built-ins but NOT resume when there is nothing to resume', () => {
    const ids = pickerCodeCommands({ cleared: false }).map((c) => c.id)
    expect(ids).toEqual(['compact', 'clear', 'init', 'details', 'thinking'])
  })

  it('offers resume too once the session has cleared/reverted history', () => {
    const ids = pickerCodeCommands({ cleared: true }).map((c) => c.id)
    expect(ids).toEqual(['compact', 'clear', 'resume', 'init', 'details', 'thinking'])
  })

  it('carries the human-readable description for each command', () => {
    const compact = pickerCodeCommands({ cleared: false }).find((c) => c.id === 'compact')
    expect(compact?.description).toMatch(/summarize/i)
  })

  it('resume stays PARSEABLE even while hidden from the picker (matches regardless of visibility)', () => {
    // Visibility gates display only — typing /resume must still dispatch (the endpoint 409s when
    // there is nothing to resume), so matchCodeCommand must not depend on picker state.
    expect(pickerCodeCommands({ cleared: false }).some((c) => c.id === 'resume')).toBe(false)
    expect(matchCodeCommand('/resume')?.id).toBe('resume')
  })
})

describe('CODE_COMMANDS registry', () => {
  it('has unique ids', () => {
    const ids = CODE_COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('anchors every trigger pattern (^…$) so a command matches the WHOLE input, not a substring', () => {
    for (const cmd of CODE_COMMANDS) {
      expect(cmd.pattern.source.startsWith('^')).toBe(true)
      expect(cmd.pattern.source.endsWith('$')).toBe(true)
    }
  })
})
