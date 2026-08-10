// GitHub report: Qwen3.6-35B-A3B fails to load with its own correct, official mmproj —
// llama.cpp's mtmd n_embd compatibility check has a confirmed, still-open upstream bug for
// this architecture (ggml-org/llama.cpp#20899). TurboLLM can't validate mmproj/model
// compatibility itself without reimplementing (and inheriting the bugs of) llama.cpp's own
// check, so instead the FIRST load attempt retries once without --mmproj when it dies with a
// multimodal-load failure, rather than leaving an otherwise-loadable model unloaded.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mmprojFallbackNote, mmprojFallbackOpts, stripMmprojArgs } from './manager'
import type { ErrInfo, StartOpts } from './manager'

function opts(extraArgs: string[]): StartOpts {
  return {
    engine: { id: 'e', name: 'llama.cpp', binPath: '/bin/llama-server', kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
    model: { key: 'm', name: 'Qwen3.6-35B-A3B', quant: 'Q4_K_M', ctx: 4096, vision: true },
    modelPath: '/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf',
    extraArgs,
  }
}

function err(logTail: string[]): ErrInfo {
  return { code: 'engine_exited', message: 'The engine process exited unexpectedly.', exitCode: 1, logTail }
}

const MISMATCH_LOG = [
  "E mtmd_init_from_file: error: mismatch between text model (n_embd = 2048) and mmproj (n_embd = 5120)",
  "hint: you may be using wrong mmproj",
  "E srv    load_model: failed to load multimodal model, 'D:\\models\\mmproj-BF16.gguf'",
]

// ─── stripMmprojArgs ─────────────────────────────────────────────────────────

test('stripMmprojArgs removes --mmproj and its path value', () => {
  const out = stripMmprojArgs(['-m', 'model.gguf', '--mmproj', 'mmproj.gguf', '--ctx-size', '4096'])
  assert.deepEqual(out, ['-m', 'model.gguf', '--ctx-size', '4096'])
})

test('stripMmprojArgs removes --no-mmproj-offload', () => {
  const out = stripMmprojArgs(['--mmproj', 'p.gguf', '--no-mmproj-offload', '--jinja'])
  assert.deepEqual(out, ['--jinja'])
})

test('stripMmprojArgs is a no-op when neither flag is present', () => {
  const args = ['-m', 'model.gguf', '--ctx-size', '4096']
  assert.deepEqual(stripMmprojArgs(args), args)
})

// ─── mmprojFallbackOpts ──────────────────────────────────────────────────────

test('mmprojFallbackOpts returns a retry with --mmproj stripped on a multimodal load failure', () => {
  const fallback = mmprojFallbackOpts(opts(['-m', 'x.gguf', '--mmproj', 'mmproj.gguf']), err(MISMATCH_LOG))
  assert.ok(fallback)
  assert.deepEqual(fallback.extraArgs, ['-m', 'x.gguf'])
  // Everything else about opts is passed through unchanged.
  assert.equal(fallback.modelPath, '/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf')
})

test('mmprojFallbackOpts marks the retry model as non-vision — status()/reportLoad both read opts.model straight through', () => {
  const fallback = mmprojFallbackOpts(opts(['-m', 'x.gguf', '--mmproj', 'mmproj.gguf']), err(MISMATCH_LOG))
  assert.ok(fallback)
  assert.equal(fallback.model.vision, false)
  // Only vision changes — the rest of the model descriptor (name/quant/ctx) is untouched.
  assert.equal(fallback.model.name, 'Qwen3.6-35B-A3B')
  assert.equal(fallback.model.quant, 'Q4_K_M')
})

test('mmprojFallbackOpts also clears profile.useMmproj, when a profile is present', () => {
  const withProfile: StartOpts = { ...opts(['-m', 'x.gguf', '--mmproj', 'mmproj.gguf']), profile: { useMmproj: true } as StartOpts['profile'] }
  const fallback = mmprojFallbackOpts(withProfile, err(MISMATCH_LOG))
  assert.ok(fallback)
  assert.equal(fallback.profile?.useMmproj, false)
})

test('mmprojFallbackOpts leaves profile untouched (undefined) when the original opts had none', () => {
  const fallback = mmprojFallbackOpts(opts(['-m', 'x.gguf', '--mmproj', 'mmproj.gguf']), err(MISMATCH_LOG))
  assert.ok(fallback)
  assert.equal(fallback.profile, undefined)
})

test('mmprojFallbackOpts returns null when the load had no --mmproj to begin with', () => {
  assert.equal(mmprojFallbackOpts(opts(['-m', 'x.gguf']), err(MISMATCH_LOG)), null)
})

test('mmprojFallbackOpts returns null for an unrelated crash (self-limiting: no retry storm)', () => {
  const unrelated = err(['E srv  load_model: failed to open GGUF file: no such file or directory'])
  assert.equal(mmprojFallbackOpts(opts(['-m', 'x.gguf', '--mmproj', 'mmproj.gguf']), unrelated), null)
})

test('mmprojFallbackOpts is self-limiting: retrying its own output finds nothing to strip', () => {
  const first = mmprojFallbackOpts(opts(['-m', 'x.gguf', '--mmproj', 'mmproj.gguf']), err(MISMATCH_LOG))
  assert.ok(first)
  // If the retry ALSO failed with the same signature, a second call must not find another
  // --mmproj to strip — this is what actually prevents an infinite retry loop.
  assert.equal(mmprojFallbackOpts(first, err(MISMATCH_LOG)), null)
})

// ─── mmprojFallbackNote ──────────────────────────────────────────────────────

test('mmprojFallbackNote carries the original mismatch lines forward', () => {
  const note = mmprojFallbackNote(err(MISMATCH_LOG))
  assert.match(note, /n_embd = 2048/)
  assert.match(note, /n_embd = 5120/)
  assert.match(note, /retrying once without --mmproj/)
  assert.match(note, /not necessarily a wrong or corrupt file/)
})

test('mmprojFallbackNote falls back to the last few log lines when nothing matches the known patterns', () => {
  const note = mmprojFallbackNote(err(['some other unrelated engine output']))
  assert.match(note, /some other unrelated engine output/)
})
