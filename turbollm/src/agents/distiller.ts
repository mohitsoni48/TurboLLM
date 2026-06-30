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

const FOLDER_TEXT = /\.(md|txt|json|ya?ml|csv|js|ts|py|sh|html?|css)$/i

/** Collect up to `max` small text files under a folder as {name, content} pairs. */
function collectFolderFiles(folder: string, max: number): { name: string; content: string }[] {
  const files: { name: string; content: string }[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || files.length >= max) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (files.length >= max) return
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p, depth + 1); continue }
      if (!FOLDER_TEXT.test(e.name)) continue
      try {
        if (statSync(p).size > 200_000) continue
        const content = readFileSync(p, 'utf8').slice(0, 6000).trim()
        if (content) files.push({ name: e.name, content })
      } catch { /* skip */ }
    }
  }
  walk(folder, 0)
  return files
}

/**
 * Learn skills from a folder — ONE skill per file (the "point it at a folder" feature).
 * A skills library is typically one file per skill, so we distill each file independently
 * and return every skill that came out clean. Best-effort: files that don't yield a
 * reusable skill are simply skipped. `onProgress` drives the live bg-task step log.
 */
export async function distillSkillsFromFolder(
  d: Deps,
  folder: string,
  opts: { max?: number; onProgress?: (done: number, total: number, file: string) => void } = {},
): Promise<DistilledSkill[]> {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return []
  const max = opts.max ?? 12
  const files = collectFolderFiles(folder, max)
  if (!files.length) return []
  const out: DistilledSkill[] = []
  const seen = new Set<string>()
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    opts.onProgress?.(i, files.length, f.name)
    const s = await distill(d, `A reusable approach captured in "${f.name}":\n\n${f.content}`)
    if (s.name && s.procedure && !seen.has(s.name)) {
      seen.add(s.name)
      out.push(s)
    }
  }
  return out
}
