// Auto-memory extraction (Release 3): durable facts extracted from the user's own chat
// messages, injected into future NEW conversations. Mirrors autoTitle's out-of-band
// inference pattern (chat-routes.ts) but is fed a single clean string, never conversation
// history, attachments, or tool output — the strongest form of the "don't leak anything
// but the user's own words" guarantee.
import type { Deps } from '../deps'
import { engineModelAlias } from '../engines/compat'

const MIN_LENGTH = 12
const MAX_FACTS_PER_TURN = 5
const MAX_FACT_LENGTH = 200

function extractionPrompt(userText: string): string {
  return `Extract any durable personal facts the user stated about themselves in the message below — the kind of thing worth remembering for future conversations (name, role/job, location, preferences, hardware/software setup, ongoing projects, goals, recurring constraints).

Rules:
- Only use what the user explicitly said about themselves in THIS message. Never infer, guess, or invent.
- Skip one-off requests, questions, opinions about the current topic, or anything not durable (e.g. "I'm tired today" is not durable; "I work as a nurse" is).
- Each fact must be a short, self-contained sentence (max ~15 words) that makes sense with no other context.
- If there are no durable personal facts, reply with exactly: NONE
- Otherwise reply with ONLY a list, one fact per line, each line starting with "- ". No preamble, no explanation, nothing else.

User's message:
"""
${userText.slice(0, 2000)}
"""`
}

// Filler words common to first-person fact statements ("I live in X", "my name is Y") —
// stripped before the Jaccard comparison below, since two DIFFERENT facts of the same
// shape (e.g. "I live in Paris" vs "I live in Berlin") share every word except the one
// that actually matters, which otherwise pushes their overlap over the dedup threshold.
const FACT_STOPWORDS = new Set([
  'i', 'a', 'an', 'the', 'is', 'am', 'are', 'was', 'were', 'in', 'on', 'at',
  'as', 'my', 'of', 'to', 'for', 'and', 'or', 'with',
])

/** Cheap, pure string-similarity dedup — no second model call. Duplicate if either
 *  string contains the other, or word-overlap (Jaccard) over CONTENT words is high. */
export function isDuplicateFact(existing: string[], candidate: string): boolean {
  const norm = (s: string) => s.toLowerCase().trim().replace(/[.!?]+$/, '')
  const contentWords = (s: string) => new Set(s.split(/\s+/).filter((w) => w && !FACT_STOPWORDS.has(w)))
  const c = norm(candidate)
  if (!c) return true
  for (const e of existing) {
    const ne = norm(e)
    if (!ne) continue
    if (ne.includes(c) || c.includes(ne)) return true
    const ws1 = contentWords(ne)
    const ws2 = contentWords(c)
    const intersection = [...ws1].filter((w) => ws2.has(w)).length
    const union = new Set([...ws1, ...ws2]).size
    if (union > 0 && intersection / union >= 0.6) return true
  }
  return false
}

function parseFacts(raw: string): string[] {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() // strip any leaked reasoning
  if (!cleaned || /^none$/i.test(cleaned)) return []
  return cleaned
    .split('\n')
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter((l) => l.length > 0 && l.length <= MAX_FACT_LENGTH)
    .slice(0, MAX_FACTS_PER_TURN)
}

/** Fire-and-forget: extract durable facts from a just-sent user message and persist any
 *  new (non-duplicate) ones. Never throws — errors are silently swallowed, same as
 *  autoTitle, since this must never surface to the user or affect the chat response. */
export async function extractMemoryFacts(d: Deps, convId: string, userText: string, target: string): Promise<void> {
  try {
    if (userText.trim().length < MIN_LENGTH) return
    const ms = d.manager.status()
    if (ms.state !== 'running') return

    // Low-priority afterthought, same as autoTitle: acquire the engine gate at 'bg' so any
    // foreground chat or agent run preempts it, and release as soon as the call returns.
    const release = d.gate ? await d.gate.acquire('bg') : null
    let res: Response
    try {
      res = await fetch(`${target}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: engineModelAlias(d.registry.active()?.kind ?? '') ?? ms.model?.key,
          messages: [{ role: 'user', content: extractionPrompt(userText) }],
          stream: false,
          temperature: 0.2,
          max_tokens: 200,
          reasoning_budget: 0,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(20_000),
      })
    } finally {
      release?.()
    }
    if (!res.ok) return
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const facts = parseFacts(data.choices?.[0]?.message?.content ?? '')
    if (!facts.length) return

    const existing = d.db.listMemoryFacts().map((f) => f.factText)
    for (const fact of facts) {
      if (isDuplicateFact(existing, fact)) continue
      d.db.addMemoryFact({ factText: fact, sourceConvId: convId })
      existing.push(fact)
    }
  } catch { /* silently ignore */ }
}
