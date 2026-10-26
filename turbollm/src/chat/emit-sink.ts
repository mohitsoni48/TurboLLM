// One emit seam for the generation loop, so the loop drives a chat turn's run (the ring buffer
// its viewers replay and tail, chat-runs.ts) or a test's own sink; the External Chat API's runs
// (ext/run-manager.ts) use the same seam for theirs. Structurally identical to ToolCallSink
// (tools/execute-with-approval.ts:9) — deliberately, so the tool loop's sink and the generation
// loop's sink are the same thing and can be passed straight through. A sink is handed
// structured data: serialization is each viewer's own (chat-routes.ts respondWithChatRun), so a
// reconnecting client is never handed double-encoded JSON.
export type EmitSink = (ev: { event: string; data: unknown }) => void | Promise<void>
