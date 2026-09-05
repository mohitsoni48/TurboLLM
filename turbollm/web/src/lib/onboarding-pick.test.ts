// Tests for onboarding's hardware-screened model pick.
//
// Vitest (not the repo root's `tsx --test`), matching vram-fit.test.ts — see that file's
// header for why new web tests go here rather than into vram.test.ts.
import { describe, expect, test } from 'vitest'
import { modelDisplayName, pickOnboardingModel, requiredMb, SMALL_DEVICE_LADDER } from './onboarding-pick'

// Verbatim from the daemon's BLESSED (src/onboarding/models.ts) — the entries this screen
// actually receives. Copied, not imported: web must not import from the daemon, and the
// point of the test is what the client does with what it is handed.
const G_T2 = { repo: 'unsloth/gemma-4-12b-it-GGUF', file: 'gemma-4-12b-it-Q4_K_M.gguf', bytes: 7_121_861_440 }
const C_T3 = { repo: 'unsloth/Qwen3.6-27B-GGUF', file: 'Qwen3.6-27B-Q4_K_M.gguf', bytes: 16_817_244_384 }
const T0_B = { repo: 'unsloth/gemma-4-E4B-it-GGUF', file: 'gemma-4-E4B-it-Q3_K_M.gguf', bytes: 4_058_137_728 }

const PHONE_4GB = { os: 'android/arm64', ramMB: 3891, gpus: [] }
const PHONE_8GB = { os: 'android/arm64', ramMB: 8192, gpus: [] }
const DESKTOP_16GB = { os: 'win32/x64', ramMB: 65536, gpus: [{ name: 'NVIDIA GeForce RTX 5070 Ti', vramMb: 16384 }] }
const LAPTOP_8GB_CPU = { os: 'win32/x64', ramMB: 8192, gpus: [] }

describe('pickOnboardingModel', () => {
  test('a real GPU box keeps the daemon.s pick untouched', () => {
    const pick = pickOnboardingModel(C_T3, DESKTOP_16GB)
    expect(pick).toMatchObject({ kind: 'pick', source: 'blessed', repo: C_T3.repo, file: C_T3.file })
  })

  // The bug this module exists for. T0-B has no system-RAM floor, so the daemon offers a
  // 4.06 GB download to a phone whose real budget is 1311 MB — first-run's opening move
  // would be a download that ends in an OOM.
  test('a ~3.8 GB phone never receives the 4 GB T0 entry', () => {
    const pick = pickOnboardingModel(T0_B, PHONE_4GB)
    expect(pick).toMatchObject({ kind: 'pick', source: 'small-device', repo: 'unsloth/Llama-3.2-1B-Instruct-GGUF' })
    if (pick.kind !== 'pick') throw new Error('unreachable')
    expect(pick.requiredMb).toBeLessThanOrEqual(pick.budgetMb)
  })

  test('a roomier phone gets the larger rung, not the smallest one', () => {
    const pick = pickOnboardingModel(T0_B, PHONE_8GB)
    expect(pick).toMatchObject({ kind: 'pick', source: 'small-device', repo: 'unsloth/gemma-4-E2B-it-GGUF' })
  })

  // Not phone-only: an 8 GB CPU-only laptop has ~3.7 GB of budget and is offered the same
  // 4.06 GB T0 entry by the daemon's VRAM-band logic.
  test('a small CPU-only laptop is screened the same way as a phone', () => {
    const pick = pickOnboardingModel(T0_B, LAPTOP_8GB_CPU)
    expect(pick).toMatchObject({ kind: 'pick', source: 'small-device' })
  })

  test('hardware not known yet trusts the daemon and claims no fit', () => {
    const pick = pickOnboardingModel(G_T2, null)
    expect(pick).toMatchObject({ kind: 'pick', source: 'blessed', budgetMb: 0 })
  })

  // `fitBudgetMb` returns 0 both for "no sysinfo" and for "no room at all"; only the
  // second may block a pick, or a 1.5 GB device gets handed a multi-gigabyte download.
  test('a device with no room after the OS reserve gets no recommendation at all', () => {
    const pick = pickOnboardingModel(T0_B, { os: 'android/arm64', ramMB: 1536, gpus: [] })
    expect(pick).toEqual({ kind: 'none', reason: 'too-big-for-hardware' })
  })

  // The daemon's `hf-search` kind carries no entry. If something real fits anyway, one
  // concrete offer beats the "you're on your own" dead end.
  test('no blessed entry still yields a pick when the ladder fits', () => {
    expect(pickOnboardingModel(null, PHONE_4GB)).toMatchObject({ kind: 'pick', source: 'small-device' })
    expect(pickOnboardingModel(null, null)).toEqual({ kind: 'none', reason: 'no-candidate' })
  })
})

describe('SMALL_DEVICE_LADDER', () => {
  test('stays a floor, not a second catalog', () => {
    expect(SMALL_DEVICE_LADDER.length).toBeLessThanOrEqual(3)
  })

  // ADR-338 Decision 6: never pull a vision projector or an MTP file. Both ladder repos
  // ship them, so this guards the ids themselves, not just the caller's excludeMmproj.
  test('no mmproj or MTP file ever enters the ladder', () => {
    for (const c of SMALL_DEVICE_LADDER) {
      expect(c.file.endsWith('.gguf'), c.file).toBe(true)
      expect(/^mmproj|^mtp-/i.test(c.file), c.file).toBe(false)
      expect(c.bytes).toBeGreaterThan(0)
    }
  })

  test('the smallest rung actually fits the physical test device', () => {
    // 1311 MB is fitBudgetMb's answer for the ~3.8 GB phone (pinned in vram-fit.test.ts).
    expect(requiredMb(SMALL_DEVICE_LADDER[0].bytes)).toBeLessThanOrEqual(1311)
  })
})

describe('modelDisplayName', () => {
  test('drops the owner and the GGUF packaging suffix, keeps the searchable id', () => {
    expect(modelDisplayName('unsloth/gemma-4-12b-it-GGUF')).toBe('gemma-4-12b-it')
    expect(modelDisplayName('unsloth/Qwen3.6-35B-A3B-GGUF')).toBe('Qwen3.6-35B-A3B')
    expect(modelDisplayName('unsloth/Llama-3.2-1B-Instruct-GGUF')).toBe('Llama-3.2-1B-Instruct')
    // A repo that is only the suffix must not render as an empty string.
    expect(modelDisplayName('someone/GGUF')).toBe('GGUF')
  })
})
