// Skill distiller (spec 13 redesign §3.3, ADR-135; Voyager).
//
// Turns experience into a reusable skill: a name + description + procedure. Two sources —
// a successful conversation, or a folder of example files. Uses the Phase-0-validated
// gateway recipe (disable thinking + json_object + fence-strip + exact model alias) so the
// JSON is reliable on small local models. Best-effort: returns null on any failure.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Deps } from '../deps'
import { engineModelAlias } from '../engines/compat'

const DISTILL_SYSTEM = `You write a single reusable SKILL from the material provided. A skill captures a repeatable approach so it can be applied to similar future tasks.

Output a JSON object: {"name": <short kebab-case id>, "description": <one sentence: when to use this skill>, "procedure": <concise step-by-step procedure, markdown>}

Rules:
- The skill must be GENERAL and reusable, not a one-off answer to this specific input.
- "name" is a short kebab-case identifier (e.g. "csv-summary", "extract-config-values").
- "description" is one sentence describing WHEN to apply it.
- "procedure" is a concise, numbered set of steps — the how.
- If the material does not contain a clear reusable approach, output {"name": null, "description": null, "procedure": null}.
Respond with ONLY the JSON object, nothing else.`

export interface DistilledSkill {
  name: string | null
  description: string | null
  procedure: string | null
}

async function distill(d: Deps, material: string): Promise<DistilledSkill> {
  const ms = d.manager.status()
  const target = d.manager.target()
  if (ms.state !== 'running' || !ms.model || !target) return { name: null, description: null, procedure: null }
  const model = engineModelAlias(d.registry.active()?.kind ?? '') ?? ms.model.key
  try {
    const res = await fetch(`${target}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: DISTILL_SYSTEM },
          { role: 'user', content: `Material:\n\n${material.slice(0, 24_000)}\n\nWrite ONE reusable skill as raw JSON — no markdown fences.` },
        ],
        temperature: 0.3,
        max_tokens: 800,
        reasoning_budget: 0,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: 'json_object' },
        stream: false,
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) return { name: null, description: null, procedure: null }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    let txt = data.choices?.[0]?.message?.content ?? ''
    txt = txt.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```json|```/gi, '').trim()
    const m = txt.match(/\{[\s\S]*\}/)
    if (!m) return { name: null, description: null, procedure: null }
    const j = JSON.parse(m[0]) as DistilledSkill
    const valid = (s: unknown): string | null => typeof s === 'string' && s.trim() && s.toLowerCase() !== 'null' ? s.trim() : null
    const name = valid(j.name)
    const procedure = valid(j.procedure)
    if (!name || !procedure) return { name: null, description: null, procedure: null }
    return { name: name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64), description: valid(j.description) ?? '', procedure }
  } catch {
    return { name: null, description: null, procedure: null }
  }
}

/** Distill a skill from a successful conversation transcript. */
export function distillFromConversation(d: Deps, transcript: { role: string; content: string }[]): Promise<DistilledSkill> {
  const text = transcript.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n')
  return distill(d, `A successful completed task:\n\n${text}`)
}

/** Distill a skill from the files in a folder (the "learn from a folder" feature). Reads up
 *  to ~20 small text files under the folder (the agent's guard already vets the path). */
export function distillFromFolder(d: Deps, folder: string): Promise<DistilledSkill> {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    return Promise.resolve({ name: null, description: null, procedure: null })
  }
  const parts: string[] = []
  let budget = 20_000
  const TEXT = /\.(md|txt|json|ya?ml|csv|js|ts|py|sh|html?|css)$/i
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || budget <= 0) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (budget <= 0) return
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p, depth + 1); continue }
      if (!TEXT.test(e.name)) continue
      try {
        if (statSync(p).size > 200_000) continue
        const content = readFileSync(p, 'utf8').slice(0, 4000)
        parts.push(`### ${e.name}\n${content}`)
        budget -= content.length
      } catch { /* skip */ }
    }
  }
  walk(folder, 0)
  if (!parts.length) return Promise.resolve({ name: null, description: null, procedure: null })
  return distill(d, `Example files from a folder — learn a reusable skill from their patterns:\n\n${parts.join('\n\n')}`)
}
