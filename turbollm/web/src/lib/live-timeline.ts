import type { LiveToolCall } from './chat-types'

// An ordered, interleaved view of a streaming assistant turn: text the model
// emits and the tools it calls, in the exact order they arrive over SSE. This is
// what makes the live bubble read like "wrote a bit → ran read_file → wrote more"
// instead of a detached stack of tool cards above the text.
// A `turn` block is a zero-content divider marking an agentic-round boundary within
// one assistant turn (Phase 2, ADR-249) — inserted between rounds so a long multi-round
// run reads as grouped rounds rather than one undifferentiated wall.
export type LiveBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; call: LiveToolCall }
  | { kind: 'turn'; index: number }

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
    // Merge, but NEVER let a later event (e.g. tool end, which omits the name/args)
    // clobber the name/args captured on the pending event.
    updated[idx] = {
      kind: 'tool',
      call: {
        ...prev.call,
        ...call,
        name: call.name && call.name !== 'undefined' ? call.name : prev.call.name,
        args: call.args && Object.keys(call.args).length ? call.args : prev.call.args,
      },
    }
    return updated
  }
  return [...timeline, { kind: 'tool', call }]
}

/** Fold a `tool_progress` snapshot into the matching tool-call block by id — the SAME upsert
 *  mechanism, narrowed to the live-output field. `partial` is CUMULATIVE (a full snapshot each
 *  time, not a delta), so it REPLACES rather than appends. A snapshot for a tool block that isn't
 *  in the timeline yet (progress before its `pending` frame, e.g. after a reconnect that dropped
 *  the opener) is ignored rather than synthesizing a nameless card. */
export function applyToolProgress(timeline: LiveBlock[], id: string, partial: string): LiveBlock[] {
  const idx = timeline.findIndex((b) => b.kind === 'tool' && b.call.id === id)
  if (idx < 0) return timeline
  const updated = timeline.slice()
  const prev = updated[idx] as { kind: 'tool'; call: LiveToolCall }
  updated[idx] = { kind: 'tool', call: { ...prev.call, partial } }
  return updated
}

/** Append an agentic-round divider (Phase 2). Called on a `turn` start for rounds AFTER the first
 *  (index > 0) — the first round needs no leading divider. */
export function appendTurnMarker(timeline: LiveBlock[], index: number): LiveBlock[] {
  return [...timeline, { kind: 'turn', index }]
}
