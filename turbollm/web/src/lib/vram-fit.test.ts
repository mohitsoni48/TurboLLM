// Tests for Discover's fits-my-hardware filter (vram.ts's repo-level helpers).
//
// A separate file from vram.test.ts on purpose: that one predates Vitest and is in
// vite.config.ts's `exclude` list because it uses `node:test` and runs under the repo
// root's `tsx --test`. New web tests are Vitest, so they go in their own file rather than
// dragging vram.test.ts across runners.
import { describe, expect, test } from 'vitest'
import { fitBudgetMb, repoFitsHardware, repoFitVerdict, repoParamsB } from './vram'

describe('repoParamsB', () => {
  test('reads the usual GGUF repo names', () => {
    expect(repoParamsB('unsloth/Qwen3.6-27B-GGUF')).toBe(27)
    expect(repoParamsB('bartowski/Meta-Llama-3.1-8B-Instruct-GGUF')).toBe(8)
    expect(repoParamsB('unsloth/Llama-3.2-1B-Instruct-GGUF')).toBe(1)
    expect(repoParamsB('google/gemma-3-270m-it-qat-q4_0-gguf')).toBe(0.27)
  })

  test('an MoE name reports TOTAL params, whichever side of the name they are on', () => {
    // The A-prefixed number is active params — it never bounds what has to be resident.
    expect(repoParamsB('unsloth/Qwen3.6-35B-A3B-GGUF')).toBe(35)
    expect(repoParamsB('Qwen/Qwen3-Coder-480B-A35B-Instruct')).toBe(480)
    // OLMoE uses the reverse order (active first), which is why we take the max, not the first.
    expect(repoParamsB('allenai/OLMoE-1B-7B-0924')).toBe(7)
  })

  test('8x7B multiplies out (over-estimates Mixtral\'s real ~47B, which is the safe side)', () => {
    expect(repoParamsB('TheBloke/Mixtral-8x7B-Instruct-v0.1-GGUF')).toBe(56)
  })

  test('non-size numbers do not read as parameter counts', () => {
    // Regression guards for the three shapes that break a naive /(\d+)b/ regex: a version
    // number, a quant name, and a context-length suffix in millions.
    expect(repoParamsB('mistralai/Mistral-7B-Instruct-v0.3')).toBe(7)
    expect(repoParamsB('unsloth/Qwen2.5-7B-Instruct-1M-GGUF')).toBe(7)
    expect(repoParamsB('someone/model-Q8_0-GGUF')).toBe(null)
    expect(repoParamsB('openai/whisper-large-v3')).toBe(null)
  })
})

describe('fitBudgetMb', () => {
  test('Android budgets RAM only, with headroom for the OS and the app', () => {
    // The physical test device: ~3.8 GB, no GPU pool at all.
    const budget = fitBudgetMb({ os: 'android/arm64', ramMB: 3891, gpus: [] })
    expect(budget).toBe(1311)
    expect(budget).toBeLessThan(3891) // never the full stick
  })

  test('a desktop GPU box pools VRAM AND system RAM (partial/MoE offload is real here)', () => {
    // ADR-338 Decision 6 deliberately sends a 35B MoE to a 16 GB card because experts
    // spill to RAM — a VRAM-only budget would hide TurboLLM's own recommendation.
    const budget = fitBudgetMb({
      os: 'win32/x64',
      ramMB: 65536,
      gpus: [{ name: 'NVIDIA GeForce RTX 5070 Ti', vramMb: 16384 }],
    })
    expect(budget).toBe(16384 + (Math.round(65536 * 0.7) - 2048))
  })

  test('a CPU-only desktop still gets a budget', () => {
    expect(fitBudgetMb({ os: 'linux/x64', ramMB: 16384, gpus: [] })).toBe(Math.round(16384 * 0.7) - 2048)
  })

  test('no sysinfo yet reports 0 so the caller can hide the filter instead of filtering on a guess', () => {
    expect(fitBudgetMb({ os: '', ramMB: 0, gpus: [] })).toBe(0)
  })
})

describe('repoFitVerdict', () => {
  const phone = fitBudgetMb({ os: 'android/arm64', ramMB: 3891, gpus: [] })

  test('a phone keeps the small models and drops the ones it cannot hold', () => {
    expect(repoFitVerdict('unsloth/Llama-3.2-1B-Instruct-GGUF', phone)).toBe('fits')
    expect(repoFitVerdict('unsloth/Qwen3-4B-Instruct-GGUF', phone)).toBe('too-big')
    expect(repoFitVerdict('unsloth/Qwen3.6-35B-A3B-GGUF', phone)).toBe('too-big')
  })

  test('the same 35B MoE fits a 16 GB + 64 GB desktop', () => {
    const desktop = fitBudgetMb({
      os: 'win32/x64',
      ramMB: 65536,
      gpus: [{ name: 'NVIDIA GeForce RTX 5070 Ti', vramMb: 16384 }],
    })
    expect(repoFitVerdict('unsloth/Qwen3.6-35B-A3B-GGUF', desktop)).toBe('fits')
  })

  // repoFitVerdict itself still distinguishes 'unknown' from 'too-big' — that's a real
  // distinction the function reports honestly. It's repoFitsHardware, below, that collapses
  // them into one boolean for the UI; this test is about the raw verdict only.
  test('an unreadable name gets its own verdict, distinct from too-big', () => {
    expect(repoFitVerdict('openai/whisper-large-v3', phone)).toBe('unknown')
  })

  test('no budget means no verdict at all', () => {
    expect(repoFitVerdict('unsloth/Llama-3.2-1B-Instruct-GGUF', 0)).toBe('unknown')
  })
})

describe('repoFitsHardware', () => {
  const phone = fitBudgetMb({ os: 'android/arm64', ramMB: 7655, gpus: [] })

  // The actual bug report: with the filter on, a 7.7 GB Android phone still showed
  // Qwen3.8-Flash-Next, GLM-5.3-Flash and DeepSeek-V4-Flash-Vision-Exp — none carry a "<N>B"
  // token, all fell through to 'unknown', and the old policy (only hide 'too-big') let them all
  // stay visible. This must be false for every one of them, and it must not regress silently.
  test.each([
    'unsloth/Qwen3.8-Flash-Next-GGUF',
    'orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF',
    'unsloth/GLM-5.3-Flash-GGUF',
    'unsloth/DeepSeek-V4-Flash-Vision-Exp-GGUF',
    'AngelSlim/Hy4-preview-GGUF',
  ])('hides the unsized codename model %s', (repo) => {
    expect(repoFitVerdict(repo, phone)).toBe('unknown')
    expect(repoFitsHardware(repo, phone)).toBe(false)
  })

  test('still shows a repo whose size the name actually states', () => {
    expect(repoFitsHardware('XHToken/Spark-X2.5-4B-GGUF', phone)).toBe(true)
    expect(repoFitsHardware('unsloth/Llama-3.2-1B-Instruct-GGUF', phone)).toBe(true)
  })

  test('still hides a named model that is genuinely too big', () => {
    expect(repoFitsHardware('unsloth/Qwen3.6-35B-A3B-GGUF', phone)).toBe(false)
  })
})
