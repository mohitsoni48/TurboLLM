// Run from turbollm/: npx tsx --test core/scripts/android-instrumented-tests.test.ts
// JUnit 4 rejects a @Test, @Before or @After method that returns a value, and AndroidJUnit4 reports that as the
// opaque "Failed to instantiate test runner class" on the whole class, so no device test of it ever runs (the core
// emulator job failed this way from M-2 on). `= runBlocking { ... }` returns whatever its last expression is, such as
// the Done event an assertIs hands back, so a device test must say runBlocking<Unit>. The emulator is the only other
// place this shows, and it is a 25-minute job, so the rule is pinned here.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BINDINGS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bindings', 'android')
const JUNIT_ANNOTATION = /^\s*@(Test|Before|After)\b/
const BLOCKING_BODY = /\bfun\s+(\w+)\([^)]*\)\s*=\s*runBlocking\s*\{/

function kotlinFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'build' ? [] : kotlinFiles(path)
    return entry.name.endsWith('.kt') ? [path] : []
  })
}

function deviceTestFiles(): string[] {
  return kotlinFiles(BINDINGS_DIR).filter((path) => path.split(/[\\/]/).includes('androidTest'))
}

/** The JUnit methods in `source` whose body is `= runBlocking {` with no explicit Unit, by name. */
function valueReturningJunitMethods(source: string): string[] {
  const lines = source.split(/\r?\n/)
  const names: string[] = []
  lines.forEach((line, index) => {
    const body = BLOCKING_BODY.exec(line)
    if (!body) return
    const annotated = lines.slice(Math.max(0, index - 2), index).some((above) => JUNIT_ANNOTATION.test(above))
    if (annotated) names.push(body[1])
  })
  return names
}

test('the detector flags an expression-bodied runBlocking test and accepts runBlocking<Unit>', () => {
  const flagged = ['  @Test(timeout = 1)', '  fun a() = runBlocking {', '  }'].join('\n')
  const fine = ['  @Test', '  fun b() = runBlocking<Unit> {', '  }'].join('\n')
  const helper = ['  private fun c() = runBlocking {', '  }'].join('\n')

  assert.deepEqual(valueReturningJunitMethods(flagged), ['a'])
  assert.deepEqual(valueReturningJunitMethods(fine), [])
  assert.deepEqual(valueReturningJunitMethods(helper), [])
})

test('there are device tests to check', () => {
  assert.ok(deviceTestFiles().length > 0)
})

test('no device test method returns the value of its runBlocking body', () => {
  for (const path of deviceTestFiles()) {
    const offenders = valueReturningJunitMethods(readFileSync(path, 'utf8'))
    assert.deepEqual(offenders, [], `${path}: write these as = runBlocking<Unit> { ... }`)
  }
})
