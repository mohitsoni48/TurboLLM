// The registry of spoken-reply runtimes, keyed by engine kind. Callers ask for the runtime of the engine serving the
// loaded model and get null when there is none; they never name a runtime themselves. A second runtime (vLLM-Omni,
// which answers /v1/chat/completions with `message.audio`) is one more entry here and one more file beside
// llamacpp-realtime.ts.
import { requestRealtimeAudioReply } from './llamacpp-realtime'
import type { AudioReplyRuntime } from './types'

export { AudioReplyError, DEFAULT_AUDIO_REPLY_MAX_TOKENS, type AudioReply, type AudioReplyRequest, type AudioReplyRuntime } from './types'

const llamaCppRealtime: AudioReplyRuntime = {
  reply: (baseUrl, req, signal) => requestRealtimeAudioReply(baseUrl, req, signal),
}

/** Keyed by the registry's engine `kind` (servingEngineKind). 'llama-server' is the kind of upstream llama.cpp and of
 *  its forks alike, so the kind alone cannot tell them apart; what does is the engine itself, which lists "audio" among
 *  the model's output modalities (modalities.ts) only when it has the realtime endpoint, and `speaksAudio` is only ever
 *  set from that answer. llamafile and KoboldCpp are other kinds and have no entry. */
const RUNTIMES: Record<string, AudioReplyRuntime> = {
  'llama-server': llamaCppRealtime,
}

/** The runtime that can get a spoken reply from an engine of this kind, or null when none can. */
export function audioReplyRuntimeFor(engineKind: string | undefined): AudioReplyRuntime | null {
  return (engineKind !== undefined && Object.hasOwn(RUNTIMES, engineKind) ? RUNTIMES[engineKind] : null) ?? null
}
