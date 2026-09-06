/**
 * Generates src/templates/index.ts from src/templates/*.md.
 *
 *   node scripts-build-templates.mjs
 *
 * Why generate rather than import the .md directly: Wrangler CAN import markdown as a
 * text module, but Node cannot, and `test.mjs` runs the Worker under plain Node (this
 * project has no spare port for `wrangler dev` — ADR-401). A generated module is the
 * one form both understand. `test.mjs` re-runs this and fails if the output has
 * drifted, so a template edit that was never regenerated cannot reach production.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'src', 'templates')
export const OUT = join(DIR, 'index.ts')

export function generate() {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()

  const parts = files.map((f) => {
    const name = f.replace(/\.md$/, '').replace(/-([a-z])/g, (_m, c) => c.toUpperCase())
    // Escape only what a template literal actually cares about.
    const body = readFileSync(join(DIR, f), 'utf8')
      .split('\\').join('\\\\')
      .split('`').join('\\`')
      .split('${').join('\\${')
    return 'export const ' + name + ' = `' + body + '`\n'
  })

  return (
    '// GENERATED FILE — do not edit.\n' +
    '// Source: src/templates/*.md. Regenerate with: node scripts-build-templates.mjs\n' +
    '// (test.mjs fails if this file is stale, so an un-regenerated edit cannot ship.)\n\n' +
    parts.join('\n')
  )
}

if (process.argv[1] && process.argv[1].endsWith('scripts-build-templates.mjs')) {
  writeFileSync(OUT, generate())
  console.log('wrote ' + OUT)
}
