// Skill tools for the chat loop.
//
// A skill is mostly instructions text (its named `tools` are already in the base
// ToolRegistry — web_search, fetch_url, run_code, MCP). The one exception is
// 'skill-creator', which grants save_skill: the only tool a skill can add beyond the
// base registry. FS/shell tools are deliberately NOT exposed in chat — that's reserved
// for the future Code surface, built on pi.
import type { ToolDefinition, ToolCall } from '../tools/tool-registry'

const SAVE_SKILL_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'save_skill',
    description: 'Save a reusable SKILL into the shared skill library (a SKILL.md file under ~/.turbollm/skills). Call this ONLY when the user EXPLICITLY asks to create or save a skill from this conversation (e.g. "make a skill out of this", "save this as a skill"). Do NOT call it proactively or suggest it on your own. This is the only way skills are saved — never use any external memory, knowledge-graph, or note tool.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short kebab-case id, e.g. "csv-summary"' },
        description: { type: 'string', description: 'One sentence: when to apply this skill' },
        procedure: { type: 'string', description: 'Concise step-by-step procedure (markdown)' },
      },
      required: ['name', 'procedure'],
    },
  },
}

/** The bundle the chat loop needs when the 'skill-creator' skill is enabled. */
export interface SkillCreatorToolset {
  defs: ToolDefinition[]
  execute: (call: ToolCall) => string
  names: Set<string>
}

/** Build the save_skill tool + executor. `onSaveSkill` triggers the in-chat skill
 *  author (background distill-from-conversation), returning a short message shown
 *  back to the model as the tool result. */
export function buildSaveSkillTool(onSaveSkill: (args: { name?: string; description?: string; procedure?: string }) => string): SkillCreatorToolset {
  const execute = (call: ToolCall): string => {
    if (call.name !== 'save_skill') return `Error: tool "${call.name}" is not available.`
    return onSaveSkill({
      name: typeof call.args.name === 'string' ? call.args.name : undefined,
      description: typeof call.args.description === 'string' ? call.args.description : undefined,
      procedure: typeof call.args.procedure === 'string' ? call.args.procedure : undefined,
    })
  }
  return { defs: [SAVE_SKILL_DEF], execute, names: new Set(['save_skill']) }
}
