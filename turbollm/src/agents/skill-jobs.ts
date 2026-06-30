// Background skill author (spec 13 redesign; skill-creator model).
//
// Reads a conversation, interprets it into a reusable skill, and writes it as a SKILL.md
// into the shared library. This is the ONE place skills are created from chat — used by
// BOTH the "Save as skill" button (chat route) and the in-chat `save_skill` tool. Detached
// + tracked so it surfaces in the background-task indicator.
import type { Deps } from '../deps'
import { SkillStore, toSkillId, type Skill } from './skills'
import { distillFromConversation } from './distiller'

/**
 * Kick off authoring a skill from a conversation. Returns the bg-task id (or null if there
 * was nothing to read). Never throws — failures are reported through the task.
 */
export function saveSkillFromConversation(d: Deps, convId: string): string | null {
  const conv = d.db.getConversation(convId, true)
  if (!conv) return null
  const transcript = (conv.messages ?? [])
    .filter((m) => m.content)
    .map((m) => ({ role: m.role, content: m.content }))
  if (!transcript.length) return null

  const store = new SkillStore(d.store.dir())
  const taskId = d.agentTasks?.start('skill_from_conversation', conv.agentId ?? '', 'Writing a skill from this conversation', conv.id) ?? null
  void (async () => {
    try {
      if (taskId) d.agentTasks?.step(taskId, 'Reading the conversation and drafting a skill…')
      const s = await distillFromConversation(d, transcript)
      if (!s.name || !s.procedure) {
        if (taskId) d.agentTasks?.done(taskId, 'No clear reusable skill found in this conversation.')
        return
      }
      const id = toSkillId(s.name)
      if (!id) {
        if (taskId) d.agentTasks?.done(taskId, 'Could not derive a valid name for the skill.')
        return
      }
      if (store.has(id)) {
        if (taskId) d.agentTasks?.done(taskId, `A skill named "${id}" already exists — left it untouched.`)
        return
      }
      const skill: Skill = { id, name: s.name, description: s.description ?? '', instructions: s.procedure, tools: [] }
      store.write(skill)
      if (taskId) d.agentTasks?.done(taskId, `Saved skill: ${id}${s.description ? ' — ' + s.description : ''}`)
    } catch (e) {
      if (taskId) d.agentTasks?.fail(taskId, e instanceof Error ? e.message : 'skill save failed')
    }
  })()
  return taskId
}
