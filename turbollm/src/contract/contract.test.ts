import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const dir = import.meta.dirname

const contractFiles = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))

/** Why a top-level statement does not belong in a types-only contract, or null when it does. */
function violation(s: ts.Statement): string | null {
  if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) return null
  if (ts.isImportDeclaration(s)) {
    const spec = (s.moduleSpecifier as ts.StringLiteral).text
    if (!s.importClause?.isTypeOnly) return `runtime import of '${spec}' (use import type)`
    // The web bundle's tsconfig loads no node types; a bare or node: specifier would drag them in.
    return spec.startsWith('./') ? null : `import of '${spec}' leaves the contract folder`
  }
  if (ts.isExportDeclaration(s)) {
    if (!s.isTypeOnly) return 'runtime re-export (use export type)'
    const spec = (s.moduleSpecifier as ts.StringLiteral | undefined)?.text
    return spec === undefined || spec.startsWith('./') ? null : `re-export of '${spec}' leaves the contract folder`
  }
  return `${ts.SyntaxKind[s.kind]} is a runtime statement`
}

/** Every reason the given source text does not belong in a types-only contract. */
function violations(name: string, text: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)
  return source.statements.map(violation).filter((v) => v !== null)
}

test('the contract folder holds at least one declaration file', () => {
  assert.ok(contractFiles.length > 0)
})

test('the check rejects runtime code, runtime imports and imports from outside the folder', () => {
  assert.equal(violations('a.ts', 'export const x = 1').length, 1)
  assert.equal(violations('a.ts', "import { a } from './b'").length, 1)
  assert.equal(violations('a.ts', "import type { Deps } from '../deps'").length, 1)
  assert.equal(violations('a.ts', "import type { A } from './b'\nexport type B = A").length, 0)
})

for (const file of contractFiles) {
  test(`contract/${file} declares types only`, () => {
    assert.deepEqual(violations(file, readFileSync(join(dir, file), 'utf8')), [])
  })
}
