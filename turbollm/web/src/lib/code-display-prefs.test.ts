import { beforeEach, describe, expect, it } from 'vitest'
import { getDisplayPref, toggleDisplayPref } from './code-display-prefs'

describe('code-display-prefs', () => {
  beforeEach(() => { localStorage.clear() })

  it('defaults both prefs to off', () => {
    expect(getDisplayPref('details')).toBe(false)
    expect(getDisplayPref('thinking')).toBe(false)
  })

  it('toggle flips the pref, returns the new value, and persists it', () => {
    expect(toggleDisplayPref('details')).toBe(true)
    expect(getDisplayPref('details')).toBe(true)
    expect(toggleDisplayPref('details')).toBe(false)
    expect(getDisplayPref('details')).toBe(false)
  })

  it('keeps the two prefs independent', () => {
    toggleDisplayPref('thinking')
    expect(getDisplayPref('thinking')).toBe(true)
    expect(getDisplayPref('details')).toBe(false)
  })
})
