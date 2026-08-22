/** Link-API versions THIS build speaks. Moves INDEPENDENTLY of the app version and is
 *  bumped only on a breaking change to the /api/link/v1 contract.
 *
 *  This is the whole reason Turbo Link uses a façade rather than the internal API: two
 *  machines running `npx turbollm` WILL drift in app version, and this is the one place
 *  the contract between them lives (ADR-376). */
export const LINK_API_VERSIONS: readonly number[] = [1]

/** Highest version both sides speak, or null when there is no overlap.
 *
 *  Null is a first-class outcome, not an error: it drives the peer's "incompatible"
 *  state and the message "<host> is running an older TurboLLM — update it to link",
 *  which is diagnosable. Never throws — `theirs` arrives off the network and may be
 *  absent, empty, or not a number array at all (a URL that is not a TurboLLM daemon). */
export function negotiateVersion(
  mine: readonly number[],
  theirs: readonly number[] | undefined,
): number | null {
  if (!Array.isArray(theirs)) return null
  const usable = theirs.filter((v) => Number.isInteger(v) && v > 0)
  const common = mine.filter((v) => usable.includes(v))
  return common.length ? Math.max(...common) : null
}
