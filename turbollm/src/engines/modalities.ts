// What a running llama-server's model takes besides text, as the server itself reports it.
//
// Whether a GGUF model hears audio is decided by the projector it was loaded with (Ultravox, Voxtral, Qwen-Omni…), and
// nothing in the model file's name or the scanner's pairing says which kind a projector is. The server knows: GET
// /props answers `modalities: { vision, audio }` once the model is up. So the chat's "send the recording as audio"
// option is offered on that answer, not on a guess.
//
// An engine that has no /props, or whose /props names no modalities (other engine kinds, llama.cpp builds from before
// multimodal support), is "unknown": the caller falls back to what the model file declared.

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
