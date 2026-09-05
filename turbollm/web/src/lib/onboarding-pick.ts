/** Onboarding's "here is YOUR model" pick — the client-side hardware guard on
 *  top of the daemon's blessed recommendation (spec 25 §5.2/§5.4).
 *
 *  WHY THIS EXISTS AT ALL, given `recommend()` already returns exactly one entry:
 *  the daemon's tiers are written in terms of **VRAM bands plus a system-RAM floor**
 *  (src/onboarding/models.ts), and its smallest rung, T0-B, is a 4.06 GB download with
 *  `minSystemRamMb: null` — i.e. no lower bound at all. That is fine for the CPU-only
 *  desktop the T0 tier was written for, and wrong for the ~3.8 GB Android phone the same
 *  onboarding now runs on: nothing on that device can hold 4 GB of weights (the phone's
 *  real budget is ~1.3 GB once the OS, the WebView and the app itself are subtracted —
 *  see `fitBudgetMb`), so the very first thing first-run does is queue a multi-gigabyte
 *  download that ends in an OOM. A recommendation that cannot load is worse than no
 *  recommendation, so this module screens the blessed entry against the SAME budget
 *  Discover's fits-my-hardware filter uses, and degrades to a smaller real model rather
 *  than to nothing.
 *
 *  Pure on purpose, mirroring the daemon's own `recommend()`: no I/O, no clock, no hooks,
 *  so every device tier — including hardware nobody here owns — is unit-testable with no
 *  mocks. The budget math itself is NOT re-implemented; `fitBudgetMb` is the one source of
 *  truth for "how much model can this machine hold", Android carve-out included. */

import { fitBudgetMb, type FitHardware } from './vram'

export interface CandidateModel {
  repo: string
  file: string
  bytes: number
}

/** Engine + a modest KV window on top of the weights. Deliberately the same 400 MB as
 *  vram.ts's `FIT_OVERHEAD_MB`, which is private to that module and which this file must
 *  not reach into (vram.ts is shared with Discover's filter and the load form). Same
 *  reasoning as there: charging `estimateVram`'s flat 800 MB against a phone's ~1.3 GB
 *  budget would reject every model that genuinely runs on it. */
const RUNTIME_OVERHEAD_MB = 400

/** Decimal MB, matching `estimateVram`'s `sizeBytes / 1e6` convention rather than MiB.
 *  The ~5% it overstates against a MiB budget lands on the safe side and is in any case
 *  well inside `RUNTIME_OVERHEAD_MB`'s own slack. */
export function requiredMb(bytes: number): number {
  return Math.round(bytes / 1e6) + RUNTIME_OVERHEAD_MB
}

/** The small-device ladder — what we fall back to when the daemon's blessed entry cannot
 *  physically load here. Largest-that-fits wins, so this is ordered by ascending size for
 *  readability only; the pick sorts explicitly.
 *
 *  Kept to two rungs on purpose. This is NOT a second model catalog competing with
 *  src/onboarding/models.ts — it is the floor under it, and every extra entry is another
 *  repo id that can rot. Both were read from the live HF tree API
 *  (`/api/models/{repo}/tree/main`) on 2026-09-05: repo, filename and exact byte size are
 *  transcribed, not recalled, which is the same standard `BLESSED` holds itself to. Both
 *  are plain instruct GGUFs on the stable `main` revision.
 *
 *  Neither is an `mmproj-*.gguf` or an MTP file (ADR-338 Decision 6 — the E2B repo ships
 *  both, and the caller must keep passing `excludeMmproj`). */
export const SMALL_DEVICE_LADDER: readonly CandidateModel[] = [
  // ~4 GB phones (the physical test device: ~1.3 GB of real budget). The only rung that
  // fits there at all — a 1B is genuinely modest, and it is still a shipping instruct
  // model that answers, which "nothing at all" is not.
  { repo: 'unsloth/Llama-3.2-1B-Instruct-GGUF', file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', bytes: 807_694_368 },
  // 6–8 GB phones and small CPU-only laptops. The founder's stated calibre ("gemma 4 e4b
  // kind") one size down: same family and publisher as the daemon's own T0 entries, which
  // is why this is the preferred rung whenever the budget reaches it.
  { repo: 'unsloth/gemma-4-E2B-it-GGUF', file: 'gemma-4-E2B-it-Q4_K_M.gguf', bytes: 3_106_738_272 },
]

export type OnboardingPick =
  | {
      kind: 'pick'
      /** 'blessed' = the daemon's own recommendation, unchanged. 'small-device' = it did
       *  not fit here, so we degraded. The UI says which, rather than quietly swapping. */
      source: 'blessed' | 'small-device'
      repo: string
      file: string
      bytes: number
      name: string
      requiredMb: number
      /** 0 when hardware is not known yet — the UI must not print a fit claim then. */
      budgetMb: number
    }
  | { kind: 'none'; reason: 'too-big-for-hardware' | 'no-candidate' }

/** The name a person would actually search for: owner and the `-GGUF` packaging suffix
 *  dropped, the model id itself left verbatim. Deliberately NOT prettified into title
 *  case — "Gemma 4 12B It" is not a string that exists anywhere on Hugging Face, and this
 *  is the one label the user has to be able to match against a repo page. */
export function modelDisplayName(repo: string): string {
  const tail = repo.slice(repo.lastIndexOf('/') + 1)
  return tail.replace(/[-_]?GGUF$/i, '') || tail
}

function fitsBudget(c: CandidateModel, budgetMb: number): boolean {
  return requiredMb(c.bytes) <= budgetMb
}

function asPick(c: CandidateModel, source: 'blessed' | 'small-device', budgetMb: number): OnboardingPick {
  return { kind: 'pick', source, repo: c.repo, file: c.file, bytes: c.bytes, name: modelDisplayName(c.repo), requiredMb: requiredMb(c.bytes), budgetMb }
}

/** Screen the daemon's pick against real local hardware, degrading to the ladder above.
 *
 *  `blessed` is null for the recommendation kinds that carry no entry (`hf-search`, and
 *  Pro's `discover` — though Pro never renders this at all). Even then the ladder still
 *  runs: if the daemon found nothing in its bands but a small model genuinely fits, one
 *  real offer beats the "browse Hugging Face yourself" dead end that first-run exists to
 *  remove.
 *
 *  `sys` is null while `useSysInfo()` is in flight or after it failed (that query never
 *  retries). We then trust the blessed entry and print no fit claim — the daemon computed
 *  it against the same machine, and blocking first-run on a second query would be a
 *  regression, not a guard. */
export function pickOnboardingModel(blessed: CandidateModel | null, sys: FitHardware | null): OnboardingPick {
  const budgetMb = sys ? fitBudgetMb(sys) : 0

  // `fitBudgetMb` returns 0 for two very different situations, and conflating them is how
  // a 1.5 GB device would end up being handed a 4 GB download: "no sysinfo yet" (unknown,
  // trust the daemon) vs "this machine has no room left after the OS reserve" (known, and
  // the answer is no). `ramMB` is what separates them.
  const hardwareKnown = !!sys && sys.ramMB > 0
  if (!hardwareKnown) return blessed ? asPick(blessed, 'blessed', 0) : { kind: 'none', reason: 'no-candidate' }

  if (blessed && fitsBudget(blessed, budgetMb)) return asPick(blessed, 'blessed', budgetMb)

  const fallback = [...SMALL_DEVICE_LADDER].filter((c) => fitsBudget(c, budgetMb)).sort((a, b) => a.bytes - b.bytes).pop()
  if (fallback) return asPick(fallback, 'small-device', budgetMb)

  return { kind: 'none', reason: blessed ? 'too-big-for-hardware' : 'no-candidate' }
}
