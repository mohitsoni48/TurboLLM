// The heard cut (arch 2.7, A4; ADR-464 "keep only the text heard"). A spoken reply the listener interrupted keeps the
// words up to the last whole sentence they heard, and the samples they heard. The page reports how long it played;
// how much text that was is an estimate (the estimator is a parameter: spike S1 may replace the proportional one with an
// interleave map). Never a word-boundary cut: a sentence half heard is not kept (arch 9). Pure: no store.

/** At or above this share of the clip heard, the reply counts as heard in full. Spike S1 may change it. */
export const HEARD_COMPLETE_FRACTION = 0.97

/** How many characters of `text` were heard after `heardMs` of a `clipMs` clip, before the sentence snap. */
export type HeardEstimator = (text: string, heardMs: number, clipMs: number) => number

/** The same share of the characters as of the clip, rounded down. */
export const proportionalEstimator: HeardEstimator = (text, heardMs, clipMs) => Math.floor((heardMs / clipMs) * text.length)

/** Where a sentence ends: . ! ? … and their full-width forms, or a line break. */
const SENTENCE_END = /[.!?…。！？\n]/g

/** The words heard: everything at or above HEARD_COMPLETE_FRACTION of the clip (or when the clip has no length),
 *  otherwise the text up to the last sentence end at or before the estimate, trimmed; '' when no sentence ended. */
export function heardText(text: string, heardMs: number, clipMs: number, estimate: HeardEstimator = proportionalEstimator): string {
  if (clipMs <= 0 || heardMs / clipMs >= HEARD_COMPLETE_FRACTION) return text
  const heardChars = Math.max(0, Math.min(text.length, estimate(text, heardMs, clipMs)))
  return text.slice(0, lastSentenceEnd(text.slice(0, heardChars))).trim()
}

/** The samples heard: whole PCM16 samples, never more than the clip holds, and none for less than one sample. */
export function heardPcm(pcm16: Buffer, sampleRate: number, heardMs: number): Buffer {
  const heardBytes = Math.floor((sampleRate * Math.max(0, heardMs)) / 1000) * 2
  const clipBytes = pcm16.length - (pcm16.length % 2)
  return pcm16.subarray(0, Math.min(heardBytes, clipBytes))
}

/** The length of `text` through its last sentence end, or 0 when it has none. */
function lastSentenceEnd(text: string): number {
  let end = 0
  for (const match of text.matchAll(SENTENCE_END)) end = match.index + match[0].length
  return end
}
