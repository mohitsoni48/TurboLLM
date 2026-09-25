import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { releaseTmpDirs, tmpDir } from './tmp'

test('tmpDir: hands out an empty directory named with the prefix', () => {
  const dir = tmpDir('tmp-test-')

  assert.ok(statSync(dir).isDirectory())
  assert.deepEqual(readdirSync(dir), [])
  assert.match(basename(dir), /^tmp-test-/)
})

test('tmpDir: every directory of one process lives under one shared scratch root', () => {
  const first = tmpDir('tmp-test-')
  const second = tmpDir('tmp-test-')

  assert.notEqual(first, second)
  assert.equal(dirname(first), dirname(second))
  assert.equal(basename(dirname(dirname(first))), 'turbollm-tests')
})

test('releaseTmpDirs: removes everything handed out so far, and tmpDir keeps working afterwards', () => {
  const before = tmpDir('tmp-test-')
  writeFileSync(join(before, 'file.txt'), 'x')

  releaseTmpDirs()

  assert.equal(existsSync(before), false)
  assert.ok(existsSync(tmpDir('tmp-test-')))
})

// The lifecycle wiring (the end-of-file hook, the exit handler, the sweep at startup) only shows
// up in a real process, so these run a probe in a child that has its own temp folder.

const PROBE_SOURCE = `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from ${JSON.stringify(new URL('./tmp.ts', import.meta.url).href)}

const dir = tmpDir('probe-')
writeFileSync(join(dir, 'file.txt'), 'x')
writeFileSync(process.env.TMP_PROBE_REPORT, dir)
if (process.env.TMP_PROBE_DIE === '1') process.kill(process.pid, 'SIGKILL')
`

/** Runs the probe with `childTemp` as its temp folder and returns the directory it took. */
function runProbe(childTemp: string, options: { die: boolean }): string {
  const script = join(childTemp, 'probe.mjs')
  const report = join(childTemp, `report-${Date.now()}.txt`)
  writeFileSync(script, PROBE_SOURCE)
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
    env: {
      ...process.env,
      TEMP: childTemp,
      TMP: childTemp,
      TMPDIR: childTemp,
      TMP_PROBE_REPORT: report,
      TMP_PROBE_DIE: options.die ? '1' : '0',
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.ok(existsSync(report), `the probe never reported a directory: ${result.stderr}`)
  return readFileSync(report, 'utf8')
}

test('a process that finishes normally leaves no scratch directories behind', () => {
  const childTemp = tmpDir('probe-temp-')

  const dir = runProbe(childTemp, { die: false })

  assert.equal(existsSync(dir), false)
  assert.deepEqual(readdirSync(join(childTemp, 'turbollm-tests')), [])
})

test('a process killed without warning leaves its scratch root, which the next process to start sweeps away', () => {
  const childTemp = tmpDir('probe-temp-')

  const orphan = runProbe(childTemp, { die: true })
  assert.ok(existsSync(orphan), 'a killed process cannot clean up after itself')

  runProbe(childTemp, { die: false })

  assert.equal(existsSync(orphan), false)
})
