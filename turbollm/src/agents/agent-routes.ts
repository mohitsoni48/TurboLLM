// Skill HTTP routes (spec 13 §7, redesigned): skills are the shared library any chat
// conversation can enable directly — there is no separate Agent surface anymore (its
// pi/run-manager engine stays intact underneath, reserved for a future "Code" surface).
//   GET    /api/v1/skills               — list Skill[]
//   POST   /api/v1/skills               — create/update a skill file
//   DELETE /api/v1/skills/:id           — delete (404 on builtin)
//   POST   /api/v1/skills/import        — create a skill from raw SKILL.md text (upload)
//   POST   /api/v1/skills/learn-folder  — point at a folder, import/distill skills from it
import type { Hono } from 'hono'
import type { Deps } from '../deps'
import { SkillStore, isBuiltinSkill, isValidSkillId, toSkillId, importSkillsFromFolder, fromSkillMd, type Skill } from './skills'
import { isLocalOrAuthenticated } from '../auth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function err(c: any, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body<T>(c: any): Promise<T> {
  try { return (await c.req.json()) as T } catch { return {} as T }
}

export function registerAgentRoutes(app: Hono, d: Deps): void {
  const skills = () => new SkillStore(d.store.dir())
  const SKILL_CAP = 200

  app.get('/api/v1/skills', (c) => c.json(skills().list()))

  app.post('/api/v1/skills', async (c) => {
    if (!isLocalOrAuthenticated(c, d)) return err(c, 403, 'forbidden', 'Skills can only be authored on the machine running TurboLLM.')
    const b = await body<Partial<Skill>>(c)
    if (!b.id?.trim() || !/^[a-z0-9-]+$/.test(b.id)) return err(c, 400, 'invalid_config_value', 'id must be kebab-case (a-z0-9-).')
    if (!b.name?.trim()) return err(c, 400, 'invalid_config_value', 'name is required.')
    if (isBuiltinSkill(b.id)) return err(c, 400, 'builtin_skill', 'Cannot overwrite a built-in skill.')
    if (!b.instructions?.trim()) return err(c, 400, 'invalid_config_value', 'instructions are required.')
    // Cap the library (review M4): each list() reads+parses every file.
    const lib = skills().list()
    if (!lib.some((s) => s.id === b.id) && lib.length >= SKILL_CAP) return err(c, 400, 'too_many_skills', `Skill limit reached (${SKILL_CAP}).`)
    const skill: Skill = {
      id: b.id.trim(),
      name: b.name.trim(),
      description: b.description?.trim() ?? '',
      instructions: b.instructions,
      tools: Array.isArray(b.tools) ? b.tools : [],
    }
    skills().write(skill)
    return c.json(skill, 201)
  })

  app.delete('/api/v1/skills/:id', (c) => {
    // Deleting a skill removes a file on disk → local-gate + validate the id can't escape.
    if (!isLocalOrAuthenticated(c, d)) return err(c, 403, 'forbidden', 'Skills can only be modified on the machine running TurboLLM.')
    const id = c.req.param('id')
    if (!isValidSkillId(id)) return err(c, 400, 'invalid_config_value', 'invalid skill id.')
    if (isBuiltinSkill(id)) return err(c, 400, 'builtin_skill', 'Built-in skills cannot be deleted.')
    skills().delete(id)
    return c.json({ ok: true })
  })

  // Create a skill directly from a raw SKILL.md file's text (the upload path — the
  // same frontmatter + instructions-body format save_skill/learn-folder produce).
  app.post('/api/v1/skills/import', async (c) => {
    if (!isLocalOrAuthenticated(c, d)) return err(c, 403, 'forbidden', 'Skills can only be authored on the machine running TurboLLM.')
    const b = await body<{ text?: string }>(c)
    const text = b.text?.trim()
    if (!text) return err(c, 400, 'invalid_input', 'text is required.')
    const draft = fromSkillMd('draft', text)
    if (!draft?.name) return err(c, 400, 'invalid_input', 'Could not parse a SKILL.md — expected YAML frontmatter (name/description/tools) followed by an instructions body.')
    const id = toSkillId(draft.name)
    if (!id) return err(c, 400, 'invalid_input', 'Could not derive a valid id from the skill name.')
    if (isBuiltinSkill(id)) return err(c, 400, 'builtin_skill', 'Cannot overwrite a built-in skill.')
    const store = skills()
    const lib = store.list()
    if (!lib.some((s) => s.id === id) && lib.length >= SKILL_CAP) return err(c, 400, 'too_many_skills', `Skill limit reached (${SKILL_CAP}).`)
    const skill: Skill = { id, name: draft.name, description: draft.description, instructions: draft.instructions, tools: draft.tools }
    store.write(skill)
    return c.json(skill, 201)
  })

  // Learn skills from a FOLDER. Local-gated (reads disk). Detached distill → store.
  app.post('/api/v1/skills/learn-folder', async (c) => {
    if (!isLocalOrAuthenticated(c, d)) return err(c, 403, 'forbidden', 'Local host only.')
    const b = await body<{ folder?: string }>(c)
    const folder = b.folder?.trim()
    if (!folder) return err(c, 400, 'invalid_input', 'folder is required.')
    const store = skills()
    if (store.userSkills().length >= SKILL_CAP) return err(c, 400, 'skill_cap', `Skill limit reached (${SKILL_CAP}).`)
    const taskId = d.agentTasks?.start('skill_from_folder', 'skills', `Learning from ${folder}`)
    void (async () => {
      try {
        if (taskId) d.agentTasks?.step(taskId, 'Scanning the folder for skills…')
        const room = Math.max(0, SKILL_CAP - store.userSkills().length)
        // Primary path: the folder is a skill library (SKILL.md files) — import them
        // verbatim, preserving names. No LLM, no renaming.
        const { imported, skipped } = importSkillsFromFolder(store, folder, {
          max: room,
          onProgress: (sid) => { if (taskId) d.agentTasks?.step(taskId, `Imported ${sid}`) },
        })
        if (imported.length > 0 || skipped.length > 0) {
          if (taskId) {
            const parts = [`Imported ${imported.length} skill${imported.length === 1 ? '' : 's'}`]
            if (skipped.length) parts.push(`${skipped.length} already in library`)
            d.agentTasks?.done(taskId, imported.length ? `${parts.join(', ')}: ${imported.join(', ')}` : parts.join(', '))
          }
          return
        }
        // Fallback: no SKILL.md found — distill reusable skills from the folder's text files.
        if (taskId) d.agentTasks?.step(taskId, 'No skill files found — distilling from the folder…')
        const { distillSkillsFromFolder } = await import('./distiller')
        const distilled = await distillSkillsFromFolder(d, folder, {
          max: Math.max(0, SKILL_CAP - store.userSkills().length),
          onProgress: (done, total, file) => {
            if (taskId) d.agentTasks?.step(taskId, `Distilling ${done + 1}/${total}: ${file}`)
          },
        })
        const added: string[] = []
        for (const s of distilled) {
          if (store.userSkills().length >= SKILL_CAP) break
          if (!s.name || !s.procedure) continue
          const skillId = toSkillId(s.name)
          if (!skillId || store.has(skillId) || isBuiltinSkill(skillId)) continue
          store.write({ id: skillId, name: s.name, description: s.description ?? '', instructions: s.procedure, tools: [] })
          added.push(skillId)
        }
        if (taskId) {
          d.agentTasks?.done(
            taskId,
            added.length > 0
              ? `Saved ${added.length} skill${added.length === 1 ? '' : 's'}: ${added.join(', ')}`
              : 'No skills found in that folder.',
          )
        }
      } catch (e) {
        if (taskId) d.agentTasks?.fail(taskId, e instanceof Error ? e.message : 'learn failed')
      }
    })()
    return c.json({ ok: true, learning: true })
  })
}
