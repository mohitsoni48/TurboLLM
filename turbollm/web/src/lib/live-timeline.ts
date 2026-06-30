import type { LiveToolCall } from './chat-types'

// An ordered, interleaved view of a streaming assistant turn: text the model
// emits and the tools it calls, in the exact order they arrive over SSE. This is
// what makes the live bubble read like "wrote a bit → ran read_file → wrote more"
// instead of a detached stack of tool cards above the text.
export type LiveBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; call: LiveToolCall }

/** Append a content delta, merging into the trailing text block when there is one. */
export function appendTextDelta(timeline: LiveBlock[], delta: string): LiveBlock[] {
  const last = timeline[timeline.length - 1]
  if (last && last.kind === 'text') {
    const updated = timeline.slice()
    updated[updated.length - 1] = { kind: 'text', text: last.text + delta }
    return updated
  }
  return [...timeline, { kind: 'text', text: delta }]
}

/** Insert a new tool call at the current position, or update an existing one in place. */
export function upsertToolCall(timeline: LiveBlock[], call: LiveToolCall): LiveBlock[] {
  const idx = timeline.findIndex((b) => b.kind === 'tool' && b.call.id === call.id)
  if (idx >= 0) {
    const updated = timeline.slice()
    const prev = updated[idx] as { kind: 'tool'; call: LiveToolCall }
    // Keep the args/name from the first (pending) event if the later one omits them.
    updated[idx] = { kind: 'tool', call: { ...prev.call, ...call } }
    return updated
  }
  return [...timeline, { kind: 'tool', call }]
}
