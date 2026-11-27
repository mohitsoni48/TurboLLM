// What a running llama-server's model takes besides text, as the server itself reports it.
//
// Whether a GGUF model hears audio is decided by the projector it was loaded with (Ultravox, Voxtral, Qwen-Omni…), and
// nothing in the model file's name or the scanner's pairing says which kind a projector is. The server knows: GET
// /props answers `modalities: { vision, audio }` once the model is up. So the chat's "send the recording as audio"
// option is offered on that answer, not on a guess.
//
// An engine that has no /props, or whose /props names no modalities (other engine kinds, llama.cpp builds from before
// multimodal support), is "unknown": the caller falls back to what the model file declared.
//
// What a model gives back is a separate question with a separate answer. /props has no output flag; llama-server
// lists it on GET /v1/models, as `architecture.output_modalities`. A model that chats has "text" there, and one that
// also generates speech has "audio" as well. A text-to-speech model alone says ["audio"] and is served by /tts, not by
// a conversation, so "answers aloud" is the pair, never "audio" by itself.

/** How long the probe waits: /props is a small JSON the server builds from memory. */
const PROPS_TIMEOUT_MS = 3000

/** PURE: whether a /props body says the loaded model takes audio; null when it does not say either way. */
export function audioInputFromProps(props: unknown): boolean | null {
  if (typeof props !== 'object' || props === null) return null
  const modalities = (props as { modalities?: unknown }).modalities
  if (typeof modalities !== 'object' || modalities === null) return null
  const audio = (modalities as { audio?: unknown }).audio
  // A build that reports modalities but predates audio input has no `audio` key: it cannot take audio.
  return audio === true
}

/** Whether the model the engine on `port` has loaded takes audio input; null when the engine does not say. */
export async function probeAudioInput(port: number, fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/props`, { signal: AbortSignal.timeout(PROPS_TIMEOUT_MS) })
    if (!res.ok) {
      await res.body?.cancel()
      return null
    }
    return audioInputFromProps(await res.json())
  } catch {
    return null
  }
}

/** PURE: whether a /v1/models body says the loaded model answers a conversation with speech (both "text" and "audio"
 *  among its output modalities); null when the body carries no output_modalities list at all (older builds, other
 *  engines), which the caller treats as "no": without an engine that says so, no adapter could serve it anyway. */
export function audioOutputFromModels(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null) return null
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return null
  const first = data[0]
  if (typeof first !== 'object' || first === null) return null
  const architecture = (first as { architecture?: unknown }).architecture
  if (typeof architecture !== 'object' || architecture === null) return null
  const out = (architecture as { output_modalities?: unknown }).output_modalities
  if (!Array.isArray(out)) return null
  return out.includes('text') && out.includes('audio')
}

/** Whether the model the engine on `port` has loaded answers aloud; null when the engine does not say. */
export async function probeAudioOutput(port: number, fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(PROPS_TIMEOUT_MS) })
    if (!res.ok) {
      await res.body?.cancel()
      return null
    }
    return audioOutputFromModels(await res.json())
  } catch {
    return null
  }
}
