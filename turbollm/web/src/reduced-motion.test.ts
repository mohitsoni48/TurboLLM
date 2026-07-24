// Final-gate item 5 (docs/specs/16-code-ui-redesign-test-plan.md §9): every real @keyframes-driven
// animation in the app must respect prefers-reduced-motion. code-phase0-reduced-motion.spec.ts
// (Playwright) drives the one case reachable interactively without heavy new fixture plumbing
// (.tllm-pulse, via the sidebar's live running-indicator dot); this is the "simple assertion the
// right media-query is present" check for the other real animation this audit found and fixed
// (.tllm-sheet + its paired .app-shell layout-shift), following the exact same source-string-check
// approach no-stray-hex.test.ts already uses for a different regression class.
//
// Deliberately narrow: this only guards the 5 real @keyframes-driven effects that exist today
// (tllm-rise, tllm-pulse, tllm-rise-in, tllm-sheet-in-right, tllm-sheet-out-right — confirmed
// exhaustive by grepping `@keyframes` across the whole src/ tree during this audit). Plain
// transition-colors/transition-transform/animate-spin usages are NOT covered here — they're
// consistently NOT gated anywhere in this app already (checked: animate-spin spinners across 17
// files, transition-transform chevrons across 13 files, zero prefers-reduced-motion handling on
// either anywhere), so adding it only inside index.css would be inventing a new, inconsistent
// convention rather than following the established one.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(join(import.meta.dirname, 'index.css'), 'utf8')

/** True iff `selector` appears inside SOME `@media (prefers-reduced-motion: reduce) { ... }`
 *  block in the stylesheet — a plain substring/brace scan, not a real CSS parser, but sufficient
 *  for this file's own hand-written, unminified structure (same trust level no-stray-hex.test.ts
 *  already places in a regex-based check of this same file). */
function hasReducedMotionOverrideFor(selector: string): boolean {
  const blocks = CSS.split(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/).slice(1)
  return blocks.some((block) => {
    // Take up to the block's own closing brace (the first top-level `}` after the opening one
    // consumed by the split above) — a naive depth-1 scan, correct for this file's nesting depth.
    let depth = 1
    let end = 0
    for (let i = 0; i < block.length; i++) {
      if (block[i] === '{') depth++
      else if (block[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    return block.slice(0, end).includes(selector)
  })
}

describe('index.css: every real @keyframes-driven animation respects prefers-reduced-motion', () => {
  it('every @keyframes definition has a reachable, real declaration (guards against this test silently checking nothing)', () => {
    const keyframeNames = [...CSS.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])
    expect(keyframeNames.sort()).toEqual(
      ['tllm-pulse', 'tllm-rise', 'tllm-rise-in', 'tllm-sheet-in-right', 'tllm-sheet-out-right'].sort(),
    )
  })

  it.each([
    ['.tllm-rise', 'entrance fade+rise (Code launchpad sections)'],
    ['.tllm-rise-in', 'entrance fade+rise (Code transcript rail entries, incl. queued cards)'],
    ['.tllm-pulse', 'infinite pulse (running-state dots incl. the sidebar live indicator, ADR-256)'],
  ])('%s (%s) has a prefers-reduced-motion override', (selector) => {
    expect(hasReducedMotionOverrideFor(selector)).toBe(true)
  })

  it('.tllm-sheet\'s open/close slide (used by the model-config panel AND Code\'s ContextUsageRing detail sheet) has a prefers-reduced-motion override', () => {
    expect(hasReducedMotionOverrideFor(`.tllm-sheet[data-state='open']`)).toBe(true)
    expect(hasReducedMotionOverrideFor(`.tllm-sheet[data-state='closed']`)).toBe(true)
  })

  it('.app-shell\'s paired padding-right layout shift also stops under reduced motion, so the panel and the shell never fall out of sync', () => {
    expect(hasReducedMotionOverrideFor('.app-shell')).toBe(true)
  })
})
