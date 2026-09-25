// packaging.test.js — the packaged app contains only the `files` allowlist (ADR-442, ADR-433).
const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join, relative, sep } = require('node:path')

const config = require('./electron-builder.config.cjs')

const LOCAL_REQUIRE = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g
const TEST_FILE = /\.test\.js$/

test('the require parser finds relative requires and ignores packages', () => {
  const source = "require('./a')\nrequire(\"../b/c\")\nrequire('electron')"

  assert.deepEqual(relativeRequires(source), ['./a', '../b/c'])
})

test('every local module main.js requires ships in the packaged app', () => {
  const mainSource = readFileSync(join(__dirname, 'main.js'), 'utf8')

  for (const specifier of relativeRequires(mainSource)) {
    const packagedPath = packagedPathOf(specifier)

    assert.ok(!packagedPath.startsWith('..'), 'main.js must not require outside wrapper/: it would not be packaged')
    assert.ok(
      config.files.includes(packagedPath),
      `main.js requires ${packagedPath}: add it to files in electron-builder.config.cjs so it gets packaged`
    )
  }
})

test('no test file or fixture can be packaged', () => {
  const testEntries = config.files.filter((entry) => TEST_FILE.test(entry) || entry.startsWith('test-fixtures'))
  const wildcardsOutsideDependencies = config.files.filter(
    (entry) => entry.includes('*') && !entry.startsWith('node_modules/')
  )

  assert.deepEqual(testEntries, [])
  assert.deepEqual(wildcardsOutsideDependencies, [])
})

test('the app entry points are packaged', () => {
  assert.ok(config.files.includes('main.js'), 'main.js is the app entry point and must be in files')
  assert.ok(config.files.includes('package.json'), 'package.json names the entry point and must be in files')
})

function relativeRequires (source) {
  return [...source.matchAll(LOCAL_REQUIRE)].map((match) => match[1])
}

function packagedPathOf (specifier) {
  const resolvedPath = require.resolve(join(__dirname, specifier))
  return relative(__dirname, resolvedPath).split(sep).join('/')
}
