// Stray-hex regression check (spec 11 acceptance criterion #1, spec 16 §7 — promoted from a
// one-time manual audit to a real, always-running test rather than trusting a single pass to
// stay true forever). The Code screen source must never hardcode a color literal that bypasses
// index.css's token system (`var(--token)` only) — confirmed clean by the original Phase 0 audit
// (spec 14 §1.2: "font-mono is correctly scoped... no changes needed"; the audit found the same
// for color usage), so this test is a guard against future drift, not a currently-failing check.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CODE_SCREENS_DIR = join(import.meta.dirname, '.')

// `#`-prefixed hex color literals (3/4/6/8 hex digits, word-boundaried so this doesn't false-hit
// on things like URL fragments or non-color hex-looking tokens) and raw rgba()/hsla() function
// calls — the two ways to bypass `var(--token)` and inline a color directly.
const HEX_PATTERN = /#[0-9a-fA-F]{3,8}\b/
const FUNCTIONAL_COLOR_PATTERN = /\b(rgba?|hsla?)\(/

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.tsx'))
    .map((e) => join(dir, e.name))
}

describe('Code screens: no stray hex/rgba/hsla outside the token system', () => {
  const files = tsxFiles(CODE_SCREENS_DIR)

  it('found at least one .tsx file to check (guards against this test silently checking nothing)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file.split(/[\\/]/).pop()} uses only var(--token) for color, no inline hex/rgba/hsla`, () => {
      const src = readFileSync(file, 'utf8')
      const hexMatch = src.match(HEX_PATTERN)
      const funcMatch = src.match(FUNCTIONAL_COLOR_PATTERN)
      expect(hexMatch, `found a hardcoded hex color: ${hexMatch?.[0]}`).toBeNull()
      expect(funcMatch, `found a hardcoded rgba()/hsla() color: ${funcMatch?.[0]}`).toBeNull()
    })
  }
})
