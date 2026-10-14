// promoteProbedInstall: the probe-then-swap unit shared by the zip and release install flows.
// The probe is a fake, so these tests are platform-independent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../test-support/tmp'
import { promoteProbedInstall, SwapBlockedError } from './zip-install'
import type { ProbeResult } from './probe'

const BIN = 'llama-server'
const PROBE_OK: ProbeResult = { version: 'b1', capabilities: { kvTypes: ['f16'], flags: [], flagInfo: [] } }

function stagedInstall(root: string, slug: string, content: string): string {
  const dir = join(root, 'build', `.${slug}-abcd1234.tmp`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, BIN), content)
  return dir
}

function priorInstall(root: string, slug: string, content: string): string {
  const dir = join(root, 'build', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, BIN), content)
  return dir
}

const okProbe = async () => PROBE_OK
const failingProbe = async (): Promise<ProbeResult> => {
  throw new Error('probe exploded')
}

test('promoteProbedInstall: with no prior install the tmp dir becomes build/<slug>', async () => {
  const root = tmpDir('promote-')
  const staged = stagedInstall(root, 'fresh', 'new')
  const res = await promoteProbedInstall({ enginesRoot: root, slug: 'fresh', tmpDir: staged, binFileName: BIN, probeFn: okProbe })
  assert.equal(res.finalBin, join(root, 'build', 'fresh', BIN))
  assert.deepEqual(res.probe, PROBE_OK)
  assert.equal(readFileSync(res.finalBin, 'utf8'), 'new')
})

test('promoteProbedInstall: a prior install is replaced and no parked .old dir remains', async () => {
  const root = tmpDir('promote-')
  priorInstall(root, 'slug', 'old')
  const staged = stagedInstall(root, 'slug', 'new')
  const res = await promoteProbedInstall({ enginesRoot: root, slug: 'slug', tmpDir: staged, binFileName: BIN, probeFn: okProbe })
  assert.equal(readFileSync(res.finalBin, 'utf8'), 'new')
  assert.deepEqual(readdirSync(join(root, 'build')).filter((d) => d.endsWith('.old')), [])
})

test('promoteProbedInstall: a throwing probe leaves the prior install byte-identical and propagates', async () => {
  const root = tmpDir('promote-')
  const prior = priorInstall(root, 'slug', 'old')
  const staged = stagedInstall(root, 'slug', 'new')
  await assert.rejects(
    promoteProbedInstall({ enginesRoot: root, slug: 'slug', tmpDir: staged, binFileName: BIN, probeFn: failingProbe }),
    /probe exploded/,
  )
  assert.equal(readFileSync(join(prior, BIN), 'utf8'), 'old')
  assert.ok(existsSync(staged), 'the caller owns tmp cleanup')
})

test('promoteProbedInstall: blockSwap refusing raises SwapBlockedError and keeps the prior install', async () => {
  const root = tmpDir('promote-')
  const prior = priorInstall(root, 'slug', 'old')
  const staged = stagedInstall(root, 'slug', 'new')
  await assert.rejects(
    promoteProbedInstall({
      enginesRoot: root,
      slug: 'slug',
      tmpDir: staged,
      binFileName: BIN,
      probeFn: okProbe,
      blockSwap: () => 'engine is running',
    }),
    (e: unknown) => e instanceof SwapBlockedError && /engine is running/.test(e.message),
  )
  assert.equal(readFileSync(join(prior, BIN), 'utf8'), 'old')
})

test('promoteProbedInstall: the probe sees the tmp path, not the final path', async () => {
  const root = tmpDir('promote-')
  const staged = stagedInstall(root, 'slug', 'new')
  const probed: string[] = []
  await promoteProbedInstall({
    enginesRoot: root,
    slug: 'slug',
    tmpDir: staged,
    binFileName: BIN,
    probeFn: async (bin) => {
      probed.push(bin)
      return PROBE_OK
    },
  })
  assert.deepEqual(probed, [join(staged, BIN)])
})
