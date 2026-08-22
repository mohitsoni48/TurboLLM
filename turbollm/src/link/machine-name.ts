// Turbo Link (ADR-376): the ONE rule for what a linked machine may be called.
//
// A link's display name is not decoration — it is the first segment of every qualified
// `<machine>/<model>` id the router resolves on (model-id.ts). `parseRemoteId` splits on
// the FIRST slash, so a machine called `lab/rig` turns `lab/rig/Qwen3-35B` into machine
// `lab` + model `rig/Qwen3-35B`. No link is named `lab`, so `ModelRouter.resolveRemote`
// returns undefined, the id falls through to local resolution, and `resolveEntry`'s last
// clause — a case-insensitive SUBSTRING match on the model name — quietly answers with a
// local model: wrong weights, wrong machine, no error.
//
// That is design invariant 1's exact failure mode, reached through a field a REMOTE
// machine controls (`HelloResponse.machineName`, adopted at first handshake). So the
// separator is excluded at every boundary where a name is assigned, rather than being
// papered over in the parser — the parser cannot tell a hostile `lab/rig` from a
// legitimate local model key that happens to contain a slash (`unsloth/Qwen3-GGUF`), and
// making it fail closed on the latter would break real local models.

/** Longest name we will store. Long enough for any hostname; short enough that a hostile
 *  host cannot push a kilobyte of text into the peer's dropdown and settings list. */
const MAX_NAME_LEN = 64

/** Last-resort name. Only reachable when a host reports a name made ENTIRELY of
 *  separators/whitespace — an empty display name is unusable in the picker. */
export const FALLBACK_MACHINE_NAME = 'TurboLLM'

/** True when `name` can safely be the machine segment of a qualified id.
 *
 *  Deliberately narrow: `/` is the only character that changes how an id PARSES, and a
 *  rule that also banned, say, unicode would reject legitimate hostnames for no security
 *  gain. Backslash is included because a name is also rendered into user-facing copy and
 *  round-trips through config.json; keeping the two separators symmetrical costs nothing
 *  and stops a Windows-flavoured `lab\rig` from reading as a path anywhere downstream. */
export function isValidMachineName(name: string): boolean {
  const t = name.trim()
  return t.length > 0 && t.length <= MAX_NAME_LEN && !t.includes('/') && !t.includes('\\')
}

/** Coerce anything a host (or an old config) hands us into a name that satisfies
 *  {@link isValidMachineName}.
 *
 *  Used where there is NO user to tell: the `/hello` handshake adoption and the
 *  `os.hostname()` fallback. Where a human typed the name (PATCH /api/v1/links/:id) the
 *  caller validates and refuses instead — silently rewriting what someone just typed is
 *  worse than telling them it is not allowed. */
export function sanitizeMachineName(raw: string | null | undefined): string {
  const collapsed = (raw ?? '').replace(/[\\/]+/g, '-').replace(/\s+/g, ' ').trim()
  const capped = collapsed.slice(0, MAX_NAME_LEN).trim()
  // A name of nothing but separators collapses to '-' / '' — neither is a usable label.
  return /[^\s-]/.test(capped) ? capped : FALLBACK_MACHINE_NAME
}

/** A name that no OTHER link already answers to, case-insensitively.
 *
 *  `RemoteCatalog.linkByName` returns the FIRST case-insensitive match, so two links
 *  sharing a name produce identical qualified ids and both route to whichever is listed
 *  first — the realistic case being two Kaggle notebooks that both fell back to the same
 *  `os.hostname()`. Applied only where a name is ASSIGNED (link created, first handshake
 *  adopted, user rename accepted), never on every poll: re-deriving it on each probe would
 *  let two colliding links swap suffixes back and forth forever. */
export function uniqueMachineName(desired: string, taken: Iterable<string>): string {
  const used = new Set<string>()
  for (const t of taken) used.add(t.trim().toLowerCase())
  const base = sanitizeMachineName(desired)
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})`.slice(0, MAX_NAME_LEN)
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return base
}
