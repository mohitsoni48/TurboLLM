// Self-improvement reviewer (spec 13 redesign §3, ADR-135; Reflexion).
//
// On "Reflect & complete", an LLM reviews the conversation and extracts AT MOST ONE
// evidence-grounded lesson — or NO_LESSON. The Phase-0 spike validated this exact recipe
// against a small local model: 0% false positives on clean runs, 100% recall on friction.
// The fragile bits the spike surfaced are baked in here (disable thinking, json_object,
// strip fences, exact model alias) so the loop can't silently degrade to NO_LESSON.
import type { Deps } from '../deps'
import { engineModelAlias } from '../engines/compat'

const REVIEWER_SYSTEM = `You review a COMPLETED, user-approved agent task and extract at most ONE reusable lesson — ONLY if there is concrete evidence of a problem.

The user already ACCEPTED the result. Your job is NOT to invent flaws or suggest generic improvements.

Output a JSON object: {"lesson": <string or null>, "evidence": <a verbatim quoted line from the conversation, or null>}

Rules:
- Output {"lesson": null, "evidence": null} UNLESS the conversation contains CONCRETE EVIDENCE of a problem: a tool error, the user correcting the agent, the agent retrying after a failure, or a clearly wasteful/inefficient path.
- If you DO find evidence, the lesson must be specific and reusable, and "evidence" MUST be a verbatim line quoted from the conversation that proves it.
- NEVER output a vague lesson like "could be more efficient" or "should communicate better" — those are rejected.
- If the task went smoothly with no concrete evidence of a problem, you MUST output null. A smooth task has NO lesson.
Respond with ONLY the JSON object, nothing else.`

export interface ReviewResult {
  lesson: string | null
  evidence: string | null
}

/** Run the reviewer over a conversation transcript. Returns the lesson (or null) — does
 *  NOT persist (the caller decides). Best-effort: returns {null,null} on any failure. */
export async function reviewConversation(
  d: Deps,
  transcript: { role: string; content: string }[],
): Promise<ReviewResult> {
  const ms = d.manager.status()
  const target = d.manager.target()
  if (ms.state !== 'running' || !ms.model || !target) return { lesson: null, evidence: null }

  const convoText = transcript.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n').slice(0, 24_000)
  const model = engineModelAlias(d.registry.active()?.kind ?? '') ?? ms.model.key

  try {
    const res = await fetch(`${target}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: REVIEWER_SYSTEM },
          { role: 'user', content: `Here is the completed task conversation:\n\n${convoText}\n\nExtract a lesson only if there is concrete evidence. Output ONLY the raw JSON object — no markdown fences, no explanation.` },
        ],
        temperature: 0.2,
        max_tokens: 600,
        reasoning_budget: 0,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: 'json_object' },
        stream: false,
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) return { lesson: null, evidence: null }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    let txt = data.choices?.[0]?.message?.content ?? ''
    txt = txt.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```json|```/gi, '').trim()
    const m = txt.match(/\{[\s\S]*\}/)
    if (!m) return { lesson: null, evidence: null }
    const j = JSON.parse(m[0]) as ReviewResult
    const lesson = typeof j.lesson === 'string' && j.lesson.trim() && j.lesson.toLowerCase() !== 'null' ? j.lesson.trim() : null
    // Reject a lesson with no evidence citation (the spike's anti-hallucination requirement).
    const evidence = typeof j.evidence === 'string' && j.evidence.trim() && j.evidence.toLowerCase() !== 'null' ? j.evidence.trim() : null
    if (lesson && !evidence) return { lesson: null, evidence: null }
    return { lesson, evidence }
  } catch {
    return { lesson: null, evidence: null }
  }
}
