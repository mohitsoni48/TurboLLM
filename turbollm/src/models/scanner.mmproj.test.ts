// Regression tests for mmproj-to-model pairing in Scanner.build (Discord thread,
// 2026-07-20). Bug: a modelDir containing more than one vision model's files (a manually
// curated folder, not one of TurboLLM's own per-repo downloads — see ADR-145) picked
// "the single largest mmproj in the directory" and attached it to EVERY model there,
// regardless of which model it actually belongs to. A model paired with the wrong
// projector fails to start with an incompatible vision tower.
//
// resolveMmproj() fixes this per model file: (1) one candidate is unambiguous, (2) a
// filename-correlated candidate wins when unique, (3) otherwise the closest-mtime
// candidate wins — the real repro (gemma-4-12B-it-qat-GGUF) ships a GENERICALLY named
// mmproj ("mmproj-F16.gguf") that carries no model identity to correlate by name at all,
// so the mtime tiebreak is what actually resolves that case.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ConfigStore } from '../config/config'
import { Scanner } from './scanner'

// walk() only records .gguf files >= 1 MiB (real mmproj files are much larger than this
// in practice, but the floor applies to the fixture too).
const BYTES = (1 << 20) + 16
const BUF = Buffer.alloc(BYTES)

function makeTmpRoot(): string {
  return join(tmpdir(), `turbollm-mmproj-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
}

function stubStore(root: string): ConfigStore {
  return {
    dir: () => root,
    snapshot: () => ({ modelDirs: [root] }),
  } as unknown as ConfigStore
}

/** Writes a file with an explicit mtime (seconds since epoch) so pairing-by-proximity
 *  is deterministic regardless of filesystem mtime resolution or write order. */
function writeAt(path: string, mtimeSec: number): void {
  writeFileSync(path, BUF)
  utimesSync(path, mtimeSec, mtimeSec)
}

async function scan(root: string) {
  const scanner = new Scanner(stubStore(root))
  await scanner.rescan()
  return scanner.list().models
}

test('a single mmproj in the directory pairs unambiguously (unchanged common case)', async () => {
  const root = makeTmpRoot()
  const dir = join(root, 'repo')
  mkdirSync(dir, { recursive: true })
  try {
    writeAt(join(dir, 'model-Q4_K_M.gguf'), 1000)
    writeAt(join(dir, 'mmproj-F16.gguf'), 1000)
    const models = await scan(root)
    assert.equal(models.length, 1)
    assert.equal(models[0].vision, true)
    assert.ok(models[0].mmprojPath?.endsWith('mmproj-F16.gguf'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('two models with GENERICALLY-named mmprojs (the real repro) pair by closest mtime, not by size', async () => {
  const root = makeTmpRoot()
  const dir = join(root, 'flat-folder') // a manually curated dir mixing two repos' files
  mkdirSync(dir, { recursive: true })
  try {
    // Model A's download landed around t=1000; its mmproj is the SMALLER file.
    writeAt(join(dir, 'model-a-Q4_K_M.gguf'), 1000)
    writeAt(join(dir, 'mmproj-a-F16.gguf'), 1005)
    // Model B's download landed much later, around t=5000; its mmproj is the LARGER file
    // — under the old "always pick the largest" bug, model A would have wrongly received
    // model B's (bigger) projector.
    writeAt(join(dir, 'model-b-Q4_K_M.gguf'), 5000)
    const bigMmprojPath = join(dir, 'mmproj-b-F16.gguf')
    writeFileSync(bigMmprojPath, Buffer.alloc(BYTES * 3))
    utimesSync(bigMmprojPath, 5005, 5005)

    const models = await scan(root)
    assert.equal(models.length, 2)
    const a = models.find((m) => m.path.includes('model-a'))
    const b = models.find((m) => m.path.includes('model-b'))
    assert.ok(a && b)
    assert.ok(a!.mmprojPath?.includes('mmproj-a'), `model A got ${a!.mmprojPath}`)
    assert.ok(b!.mmprojPath?.includes('mmproj-b'), `model B got ${b!.mmprojPath}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('filename correlation wins even when mtime proximity would suggest the other candidate', async () => {
  const root = makeTmpRoot()
  const dir = join(root, 'flat-folder')
  mkdirSync(dir, { recursive: true })
  try {
    // Two DISTINCT repos' files with no shared prefix between the model names themselves,
    // so any correlation match is a genuine one, not an artifact of a generic shared prefix.
    // gemma-4-alpha's own mmproj is named to correlate, but happens to have been touched
    // much later (e.g. a re-download of just the projector) — correlation must still win
    // over the closer-in-time but unrelated llava-beta mmproj.
    writeAt(join(dir, 'gemma-4-alpha-Q4_K_M.gguf'), 1000)
    writeAt(join(dir, 'llava-beta-Q4_K_M.gguf'), 1000)
    writeAt(join(dir, 'gemma-4-alpha-mmproj-F16.gguf'), 9000) // far in time, but correlates
    writeAt(join(dir, 'llava-beta-mmproj-F16.gguf'), 1001) // close in time, correlates to beta

    const models = await scan(root)
    const alpha = models.find((m) => m.path.includes('gemma-4-alpha'))
    const beta = models.find((m) => m.path.includes('llava-beta'))
    assert.ok(alpha && beta)
    assert.ok(alpha!.mmprojPath?.includes('gemma-4-alpha-mmproj'), `alpha got ${alpha!.mmprojPath}`)
    assert.ok(beta!.mmprojPath?.includes('llava-beta-mmproj'), `beta got ${beta!.mmprojPath}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
