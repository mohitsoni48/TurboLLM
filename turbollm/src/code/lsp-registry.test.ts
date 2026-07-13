import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lspSpecForPath, lspSpecForLanguage, SUPPORTED_LSP_LANGUAGES } from './lsp-registry'

test('lspSpecForPath: detects TypeScript/JavaScript across extensions, sharing one language key', () => {
  const exts = ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs']
  for (const p of exts) {
    const spec = lspSpecForPath(p)
    assert.ok(spec, `expected a spec for ${p}`)
    assert.equal(spec!.language, 'typescript')
  }
})

test('lspSpecForPath: detects Python', () => {
  const spec = lspSpecForPath('src/main.py')
  assert.ok(spec)
  assert.equal(spec!.language, 'python')
  assert.equal(spec!.languageId, 'python')
})

test('lspSpecForPath: case-insensitive extension match', () => {
  assert.ok(lspSpecForPath('Component.TSX'))
  assert.ok(lspSpecForPath('script.PY'))
})

test('lspSpecForPath: returns null for unsupported/missing extensions', () => {
  assert.equal(lspSpecForPath('README.md'), null)
  assert.equal(lspSpecForPath('main.go'), null)
  assert.equal(lspSpecForPath('Makefile'), null)
  assert.equal(lspSpecForPath(''), null)
})

test('lspSpecForPath: correct languageId per extension (tsx vs ts, jsx vs js)', () => {
  assert.equal(lspSpecForPath('a.ts')!.languageId, 'typescript')
  assert.equal(lspSpecForPath('a.tsx')!.languageId, 'typescriptreact')
  assert.equal(lspSpecForPath('a.js')!.languageId, 'javascript')
  assert.equal(lspSpecForPath('a.jsx')!.languageId, 'javascriptreact')
})

test('lspSpecForLanguage: resolves by language name, case-insensitive, trims whitespace', () => {
  assert.ok(lspSpecForLanguage('typescript'))
  assert.ok(lspSpecForLanguage('TypeScript'))
  assert.ok(lspSpecForLanguage('  python  '))
  assert.equal(lspSpecForLanguage('kotlin'), null)
})

test('SUPPORTED_LSP_LANGUAGES: lists each language once, matching the two v1-scoped languages', () => {
  assert.deepEqual([...SUPPORTED_LSP_LANGUAGES].sort(), ['python', 'typescript'])
})
