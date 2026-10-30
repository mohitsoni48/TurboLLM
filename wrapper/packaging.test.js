// packaging.test.js — the packaged app contains only the `files` allowlist (ADR-442, ADR-433).
const test = require('node:test')
const assert = require('node:assert/strict')
const { existsSync, readFileSync } = require('node:fs')
const { join, relative, sep } = require('node:path')

const config = require('./electron-builder.config.cjs')
const { TRAY_ICON } = require('./window-lifecycle')

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

// The `files` allowlist keeps wrapper/build out of the app, so the tray icon main.js loads from
// process.resourcesPath must be copied there by the top-level extraResources (every OS).
test('the tray icon main.js loads ships in the packaged app', () => {
  const mainSource = readFileSync(join(__dirname, 'main.js'), 'utf8')
  const copies = config.extraResources.filter((entry) => entry.to === TRAY_ICON.packaged)

  assert.match(mainSource, /join\(process\.resourcesPath, TRAY_ICON\.packaged\)/, 'the packaged app loads the icon from its resources folder')
  assert.equal(copies.length, 1, `extraResources must copy the tray icon to ${TRAY_ICON.packaged}`)
  assert.equal(copies[0].from, join(__dirname, TRAY_ICON.source), 'from the icon a dev run loads')
  assert.ok(existsSync(copies[0].from), `${TRAY_ICON.source} must exist`)
})

function relativeRequires (source) {
  return [...source.matchAll(LOCAL_REQUIRE)].map((match) => match[1])
}

function packagedPathOf (specifier) {
  const resolvedPath = require.resolve(join(__dirname, specifier))
  return relative(__dirname, resolvedPath).split(sep).join('/')
}
