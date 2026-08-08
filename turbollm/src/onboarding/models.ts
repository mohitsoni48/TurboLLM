/** The blessed model list (spec 25 §5.4, ADR-338 Decision 6).
 *
 *  Hardcoded in the client on purpose: onboarding must work offline (ADR-009),
 *  and a network dependency in the first-run path is exactly where installs
 *  already fail. A repo pulled from HF degrades into the HF-search fallback via
 *  the `no_asset` recovery, never a dead end.
 *
 *  Repo ids, file names and byte sizes were read from the live HF API on
 *  2026-08-06 — they are exact, not recalled. Every entry still requires a
 *  confirmed on-device LOAD before shipping (ADR-239); a measured t/s is not
 *  required, since no onboarding surface displays a speed number.
 *
 *  NEVER add an `mmproj-*.gguf` (vision projector: pure added download before
 *  first token) or any MTP file — MTP auto-enable is a reproduced crash,
 *  worked around only by `speculative: "off"`, which every entry sets. */

import type { Role } from './profiles'

export interface BlessedEntry {
  id: string
  role: Role
  repo: string
  file: string
  bytes: number
  /** Inclusive lower bound of usable VRAM in MB; `null` means "no lower bound". */
  minVramMb: number | null
  /** Exclusive upper bound of usable VRAM in MB; `null` means "no upper bound". */
  maxVramMb: number | null
  /** Minimum system RAM in MB. Non-null only where expert offload needs it. */
  minSystemRamMb: number | null
}

const GB = 1024

export const BLESSED: readonly BlessedEntry[] = [
  // ── role: general — Casual, Enthusiast. Dense 12B; quant is the tier knob. ──
  //
  // THE 16 GB EDGE IS DELIBERATELY ASYMMETRIC BETWEEN ROLES — do not "harmonise" these.
  //   general: 16 GB is DENSE-side (G-T3, `minVramMb: 16 * GB`, spec 25 §5.4 "16–24 GB → Q5_K_M")
  //   coder:   16 GB is MoE-side   (C-LOW-B, `maxVramMb: 16 * GB + 1`, §5.4 "≤ 16 GB → 35B-A3B")
  //
  // The roles are doing different things at that boundary, which is why the same number resolves
  // two ways. `general` scales QUANT within one model (gemma-4-12b throughout), so the edge only
  // picks a slightly larger quant — Q5_K_M is 7.84 GiB on a 16 GB card, nowhere near the limit, and
  // which side 16 GB lands on is close to immaterial. `coder` SWITCHES MODEL FAMILIES there — MoE
  // 35B-A3B below, dense 27B above — so the edge decides whether experts spill to RAM at all, and
  // §7 pins it: "a 16 GB card with 16 GB system RAM must resolve to C-LOW-A, never C-LOW-B".
  //
  // (§5.2's "the two tables must not disagree on that edge" note is about the 32 GB Apple *unified*
  // boundary, not this one — it does not require these two to match.)
  { id: 'G-T1', role: 'general', repo: 'unsloth/gemma-4-12b-it-GGUF', file: 'gemma-4-12b-it-UD-Q3_K_XL.gguf', bytes: 6_022_684_480, minVramMb: 4 * GB, maxVramMb: 8 * GB, minSystemRamMb: null },
  { id: 'G-T2', role: 'general', repo: 'unsloth/gemma-4-12b-it-GGUF', file: 'gemma-4-12b-it-Q4_K_M.gguf', bytes: 7_121_861_440, minVramMb: 8 * GB, maxVramMb: 16 * GB, minSystemRamMb: null },
  { id: 'G-T3', role: 'general', repo: 'unsloth/gemma-4-12b-it-GGUF', file: 'gemma-4-12b-it-Q5_K_M.gguf', bytes: 8_413_576_000, minVramMb: 16 * GB, maxVramMb: 24 * GB, minSystemRamMb: null },
  { id: 'G-T4', role: 'general', repo: 'unsloth/gemma-4-12b-it-GGUF', file: 'gemma-4-12b-it-Q6_K.gguf', bytes: 9_786_022_720, minVramMb: 24 * GB, maxVramMb: null, minSystemRamMb: null },

  // ── role: coder — Developer only. MoE ≤16 GB (experts spill to RAM), dense above. ──
  { id: 'C-LOW-A', role: 'coder', repo: 'unsloth/Qwen3.6-35B-A3B-GGUF', file: 'Qwen3.6-35B-A3B-UD-Q2_K_XL.gguf', bytes: 12_290_628_576, minVramMb: 8 * GB, maxVramMb: 12 * GB, minSystemRamMb: null },
  // The 16 GB edge is INCLUSIVE toward the MoE side, hence `16 * GB + 1` against `fits()`'s
  // half-open [min, max) bands. Spec 25 §5.4 splits the coder family at "≤ 16 GB VRAM → 35B-A3B"
  // vs "> 16 GB → 27B", and §7 states it outright: "a 16 GB card with 16 GB system RAM must
  // resolve to C-LOW-A, never C-LOW-B" — which requires a 16 GB card to reach the MoE family in
  // the first place. With a plain `16 * GB` max, exactly 16 GB fell through to C-T3 and got the
  // DENSE 27B at 15.66 GiB on a 16 GB card with no RAM guard behind it. This is the one edge the
  // founder specified explicitly, so it is pinned by a boundary test.
  { id: 'C-LOW-B', role: 'coder', repo: 'unsloth/Qwen3.6-35B-A3B-GGUF', file: 'Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf', bytes: 16_845_511_648, minVramMb: 12 * GB, maxVramMb: 16 * GB + 1, minSystemRamMb: 32 * GB },
  { id: 'C-T3', role: 'coder', repo: 'unsloth/Qwen3.6-27B-GGUF', file: 'Qwen3.6-27B-Q4_K_M.gguf', bytes: 16_817_244_384, minVramMb: 16 * GB + 1, maxVramMb: 24 * GB, minSystemRamMb: null },
  { id: 'C-T4', role: 'coder', repo: 'unsloth/Qwen3.6-27B-GGUF', file: 'Qwen3.6-27B-Q5_K_M.gguf', bytes: 19_509_790_944, minVramMb: 24 * GB, maxVramMb: null, minSystemRamMb: null },

  // ── T0 — CPU-only / <4 GB. E4B is ~4B EFFECTIVE params, viable when
  //    bandwidth rather than VRAM is the bottleneck. Casual/Developer/
  //    Enthusiast only; Pro still takes the handoff. ──
  { id: 'T0-A', role: 'general', repo: 'unsloth/gemma-4-E4B-it-GGUF', file: 'gemma-4-E4B-it-Q4_K_M.gguf', bytes: 4_977_171_584, minVramMb: null, maxVramMb: 4 * GB, minSystemRamMb: 8 * GB },
  { id: 'T0-B', role: 'general', repo: 'unsloth/gemma-4-E4B-it-GGUF', file: 'gemma-4-E4B-it-Q3_K_M.gguf', bytes: 4_058_137_728, minVramMb: null, maxVramMb: 4 * GB, minSystemRamMb: null },
]

/** `https://huggingface.co/{repo}/resolve/main/{file}` — the stable HF download URL. */
export function downloadUrl(e: BlessedEntry): string {
  return `https://huggingface.co/${e.repo}/resolve/main/${e.file}`
}
