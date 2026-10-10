// The web's single-file model format set must stay identical to the daemon's download
// guard: the import dialog uses it to promise "this URL will download", and the daemon's
// enqueue uses its own copy to decide whether to accept. The web bundle cannot import
// daemon code (separate packages/builds), so parity is enforced the blunt way — this test
// reads the daemon's source and fails when the two definitions diverge.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { SINGLE_FILE_MODEL_RE } from './single-file-model'

describe('SINGLE_FILE_MODEL_RE — behaviour', () => {
  it('accepts .gguf and .litertlm, case-insensitive', () => {
    expect(SINGLE_FILE_MODEL_RE.test('model.Q4_K_M.gguf')).toBe(true)
    expect(SINGLE_FILE_MODEL_RE.test('gemma_q4.litertlm')).toBe(true)
    expect(SINGLE_FILE_MODEL_RE.test('model.GGUF')).toBe(true)
    expect(SINGLE_FILE_MODEL_RE.test('model.LitertLM')).toBe(true)
  })

  it('rejects everything that is not a standalone-loadable single file', () => {
    expect(SINGLE_FILE_MODEL_RE.test('model.safetensors')).toBe(false)
    expect(SINGLE_FILE_MODEL_RE.test('model.gguf.bak')).toBe(false)
    expect(SINGLE_FILE_MODEL_RE.test('gguf')).toBe(false)
    expect(SINGLE_FILE_MODEL_RE.test('model.bin')).toBe(false)
  })
})

describe('SINGLE_FILE_MODEL_RE — parity with the daemon', () => {
  it('is byte-identical to src/downloads/downloads.ts SINGLE_FILE_MODEL_RE', () => {
    // web/src/lib → ../../../src/downloads/downloads.ts is the daemon file, one package
    // up. jsdom rewrites `import.meta.url` to an http:// origin (useless for fs), so the
    // daemon source is located from the working directory instead: `npm test` in web/
    // (the canonical entry) or the daemon root both resolve. Extract its
    // `export const SINGLE_FILE_MODEL_RE = /…/flags` literal and compare source + flags,
    // so neither side can add/remove a format silently.
    const candidates = [
      resolve(process.cwd(), '../src/downloads/downloads.ts'), // cwd = turbollm/web
      resolve(process.cwd(), 'src/downloads/downloads.ts'), // cwd = turbollm (daemon root)
    ]
    const daemonPath = candidates.find((p) => existsSync(p))
    expect(daemonPath, 'daemon downloads.ts not found — run tests via npm test in web/').toBeTruthy()

    const daemonSrc = readFileSync(daemonPath!, 'utf8')
    const m = daemonSrc.match(/SINGLE_FILE_MODEL_RE\s*=\s*\/(.+)\/([a-z]*)\s*(?:\n|$)/)
    expect(m, 'daemon SINGLE_FILE_MODEL_RE literal not found — was it renamed?').toBeTruthy()

    expect(SINGLE_FILE_MODEL_RE.source).toBe(m![1])
    expect(SINGLE_FILE_MODEL_RE.flags).toBe(m![2])
  })
})
