// The distiller's and the reviewer's one request to the loaded model: a JSON object (the Phase-0 recipe: thinking off,
// json_object, fence-strip, the exact model alias), or why there is none.
//
// Both turned every failure into "nothing found": a skill saved from a conversation reported "No clear reusable skill
// found in this conversation." and a folder "No skills found in that folder." when no model was running or the engine
// had refused the request, with no word of why. On `litert-lm serve` 0.18.0 every request to LFM2.5-230M or
// gemma-3-270m-it is refused ("500 RuntimeError: Failed to create conversation": it turns constrained decoding on for
// every request, which their data processors refuse), so on desktop and Termux those models never made a skill and
// nothing said so.
//
// And json_object is TurboLLM's own choice for every model, not the model's. On LiteRT-LM it is LLGuidance's JSON
// grammar from the first token, which takes a small model off the way it writes JSON (a fenced, indented object): on
// the Android app's server LFM2.5-230M and LFM2.5-VL-450M answered the distiller with {"name":", "} under it, and with
// the skill without it; Qwen3-0.6B and gemma-3-270m-it answered the same either way. The prompts ask for raw JSON and
// the callers strip fences and find the object, so a LiteRT-LM model is not sent it and writes its JSON its own way.
// llama.cpp and the other engines keep it.
import type { Deps } from '../deps'
import { shapeForEngine } from '../engines/compat'
import { engineErrorReason, engineErrorText } from '../engines/engine-error'
import { servingEngineKind } from '../engines/serving'

/** The model's text for `body` (a non-streaming chat request), or why there is none: the engine's own reason when it
 *  refused the request. */
export async function jsonCompletion(
  d: Deps,
  target: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ content: string } | { error: string }> {
  const kind = servingEngineKind(d)
  const b: Record<string, unknown> = { ...body }
  if (kind === 'litert-lm') delete b.response_format
  try {
    const res = await fetch(`${target}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(shapeForEngine(kind, b)),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const reason = await engineErrorReason(res)
      return { error: reason ? `Engine returned ${res.status}: ${engineErrorText(d, kind, reason)}` : `Engine returned ${res.status}` }
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> }
    return { content: data.choices?.[0]?.message?.content ?? '' }
  } catch (e) {
    return { error: `Engine request failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}
