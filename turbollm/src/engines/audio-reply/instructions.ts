// The conversation as the one block of text a spoken-reply runtime takes. The realtime engines accept only user
// items and refuse an assistant's, so everything before the turn being answered travels as `instructions`: the system
// prompt, then the earlier turns as a plain transcript. Shared by the in-app chat (which builds its turns from stored
// messages) and the OpenAI gateway (which builds them from the request's), so both flatten identically.
import { estimateTokens } from '../../ext/context-limit'

/** One earlier turn, already as the words the model should see (a voice message is `[Voice message]` by now). */
export interface TranscriptTurn {
  role: 'user' | 'assistant'
  text: string
}

/** What the instructions say an earlier turn was, for a turn that was only spoken, in each direction. */
export const VOICE_MESSAGE_PLACEHOLDER = '[Voice message]'
export const SPOKEN_REPLY_PLACEHOLDER = '[Spoken reply]'

/** `head` (the system prompt, with any compaction summary) then the transcript of `turns`, bounded: the transcript is
 *  held to about half of `ctxMax` (counted as compaction counts) so the model keeps room for the new clip and its
 *  answer, dropping the oldest turns first. `head` is always kept; an empty turn is skipped. */
export function flattenInstructions(head: string, turns: TranscriptTurn[], ctxMax: number): string {
  const lines = turns
    .filter((t) => t.text.trim())
    .map((t) => ({ role: t.role, line: `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text.trim()}` }))
  const budget = Math.max(0, Math.floor(ctxMax / 2) - estimateTokens([{ role: 'system', content: head }]))
  let first = lines.length
  let used = 0
  while (first > 0) {
    const cost = estimateTokens([{ role: lines[first - 1].role, content: lines[first - 1].line }])
    if (used + cost > budget) break
    used += cost
    first--
  }
  const transcript = lines.slice(first).map((l) => l.line)
  return [head, transcript.length ? `Earlier conversation (text transcript):\n${transcript.join('\n')}` : ''].filter(Boolean).join('\n\n')
}

/** The typed words that came with a recording, which go beside it as the user's note: the recording is the input. */
export function withUserNote(instructions: string, note: string): string {
  return note ? [instructions, `The user also wrote, with this message: ${note}`].filter(Boolean).join('\n\n') : instructions
}
