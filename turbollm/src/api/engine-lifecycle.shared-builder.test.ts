// Source-level guard (D10, run 2026-09-13-autoload-last-model): startEngine must build its StartOpts
// through the shared buildStartOpts (src/engines/start-opts.ts), never inline.
//
// Why a source scan and not a behavioural test: D10 exists because a second copy of this builder, the
// boot resume's, drifted from startEngine's. KoboldCpp got llama-server flags, vLLM lost --max-model-len
// and tensor-parallel, and a pinned port was ignored. A re-introduced inline copy produces correct
// StartOpts on the day it lands, so no test of today's output can catch it; the damage only appears
// later, when one copy changes and the other does not. A source scan catches the copy at the point it
// is introduced. Precedent in this repo: src/code/worktree-wiring.test.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ENGINE_LIFECYCLE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'engine-lifecycle.ts'), 'utf8')

const INLINE_BUILDER_CALLS = [
  'profileToArgs(',
  'koboldcppProfileToArgs(',
  'vllmProfileToArgs(',
  'mlxSamplingArgs(',
  'resolveProfile(',
  'getModelProfile(',
]

test('engine-lifecycle.ts calls the shared buildStartOpts exactly once', () => {
  assert.equal(occurrences(ENGINE_LIFECYCLE, 'buildStartOpts('), 1)
})

test('engine-lifecycle.ts resolves no profile and builds no engine args of its own', () => {
  const inlineCalls = INLINE_BUILDER_CALLS.filter((call) => ENGINE_LIFECYCLE.includes(call))

  assert.deepEqual(inlineCalls, [], `build these through buildStartOpts instead:\n${inlineCalls.join('\n')}`)
})

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}
