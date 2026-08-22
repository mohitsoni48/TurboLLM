// One emit seam for the generation loop, so the same loop can drive a live SSE stream OR a
// detached ring buffer. Structurally identical to ToolCallSink
// (tools/execute-with-approval.ts:9) — deliberately, so the tool loop's sink and the
// generation loop's sink are the same thing and can be passed straight through.
import type { streamSSE } from 'hono/streaming'

type StreamHandle = Parameters<Parameters<typeof streamSSE>[1]>[0]

export type EmitSink = (ev: { event: string; data: unknown }) => void | Promise<void>

/** Adapts a live Hono SSE stream to the sink. JSON stringification lives HERE, not in the
 *  generation loop, so a buffer sink keeps structured objects it can re-serialize per
 *  subscriber (and so a reconnecting client is not handed double-encoded JSON). */
export function sseSink(stream: StreamHandle): EmitSink {
  return (ev) => stream.writeSSE({ event: ev.event, data: JSON.stringify(ev.data) })
}
