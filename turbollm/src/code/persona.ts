// System-prompt text for a Code session, delivered via pi's real `appendSystemPrompt`
// option (plan §3, point 4 — a first-class, genuine system-role field, NOT smuggled into a
// user turn as the old adapter did). We APPEND rather than replace pi's default prompt on
// purpose: pi's default already documents the available tools and usage guidelines, which a
// weak LOCAL model (TurboLLM's core case) relies on far more than a frontier model does —
// replacing it would strip exactly the scaffolding those models need.

import type { Skill } from '../agents/skills'

export type CodeMode = 'auto' | 'plan' | 'ask'

// Same safety cap chat's own skill injection uses (chat-routes.ts) — a guard against a
// pathological file, not an everyday limit (real skills should always fit under it whole).
// Used by invoke_skill (code-session.ts) when it loads ONE skill's full instructions for its
// isolated subagent call — not by the catalog below, which never sees instructions at all.
const MAX_SKILL_INSTRUCTIONS_CHARS = 20_000

// Total budget for the name+description catalog (see skillCatalogBlock) — every skill in
// TurboLLM's shared SkillStore gets a one-line entry here regardless of size, since only the
// name/description are shown; this just bounds how many entries the list can grow to before
// it's a scanning problem in its own right. Measured on this box: 58 skills (6 builtin + 52
// personal/creative skills unrelated to coding) cost ~157K tokens when their FULL instructions
// were injected unconditionally — the actual cause of a 200K context filling in 1-2 messages,
// not a compaction bug.
//
// The catalog itself (names+descriptions only, all 58 skills, measured live via
// GET /api/v1/skills): 9,593 chars (~2,400 tokens). An earlier version of this comment claimed
// "well under" a 4,000-char budget WITHOUT actually measuring it first — wrong, and it silently
// dropped 33 of 58 skills from the catalog (confirmed live: the model couldn't see a real
// "wan-animate-reel" skill and told the user it didn't exist). 16,000 chars gives every current
// skill room plus growth, while remaining a real, enforced ceiling — and enormously smaller than
// the ~157K-token full-instructions bug this replaced either way.
const MAX_SKILL_CATALOG_CHARS = 16_000

/** Short product persona framing. */
export function basePersona(): string {
  return [
    'You are TurboLLM Code, a coding agent running fully locally on the user\'s own machine.',
    'You are working inside a single project directory. Keep changes tightly scoped to the task,',
    'prefer the smallest correct edit, and explain what you changed and why in your final reply.',
    'You cannot access anything outside the project directory — file tools are confined to it.',
  ].join(' ')
}

/** Per-mode behavioural framing. Mirrors the UI labels in code-mock.ts AGENT_MODES exactly:
 *  auto = "asks only when blocked", plan = "plan before touching files", ask = "approval gate". */
export function modeGuidance(mode: CodeMode): string {
  switch (mode) {
    case 'plan':
      return [
        'MODE: PLAN. You have READ-ONLY tools only (read, grep, find, ls). You cannot edit,',
        'write, or run commands in this mode. Explore the codebase as needed, then produce a',
        'clear, concrete, step-by-step implementation plan as your final message: which files',
        'to change, what each change is, and any risks. Do not ask for permission to explore —',
        'just investigate and deliver the plan.',
      ].join(' ')
    case 'ask':
      return [
        'MODE: ASK. Every file write, edit, and shell command is shown to the user for approval',
        'before it runs. Work in small, individually-reviewable steps and state briefly what each',
        'edit or command will do before making it, so the user can approve with full context.',
      ].join(' ')
    case 'auto':
    default:
      return [
        'MODE: AUTO. Plan and implement the task end-to-end. Make the edits and run the commands',
        'you need without asking for step-by-step approval; only stop to ask the user when you are',
        'genuinely blocked or a decision is ambiguous.',
      ].join(' ')
  }
}

/** Edit-tool reliability guidance (plan §Spike mitigation). pi's `edit` tool matches on the
 *  exact `oldText` you provide (with a Unicode/whitespace fuzzy fallback). A weak local model
 *  is more likely than a frontier model to hand it an `oldText` that doesn't uniquely match —
 *  the single biggest cause of failed edits on small models. This guidance makes precise,
 *  uniquely-anchored edits the default, which is a no-cost mitigation that materially lifts
 *  edit success on small models without any brittle retry/repair machinery. */
export function editReliabilityGuidance(): string {
  return [
    'When editing a file with the edit tool: first read the file, then copy the `oldText` you',
    'want to replace VERBATIM from what you read — exact characters, indentation, and line breaks.',
    'Include enough surrounding context that the `oldText` appears EXACTLY ONCE in the file, and',
    'keep each edit small (one focused change per edit). If an edit fails to match, re-read the',
    'file and copy the current exact text again rather than guessing. To create a brand-new file,',
    'use the write tool instead of edit.',
  ].join(' ')
}

/** The pi tool set for a Code mode. plan is READ-ONLY (its real safety mechanism): mutating
 *  tools simply aren't in the toolset, so nothing reaches the containment/approval hook to gate.
 *  auto/ask use pi's DEFAULT tool set (read/bash/edit/write) — returned as `undefined` so the
 *  caller omits the `tools` option entirely. Mirrors modeGuidance('plan') above (read/grep/find/
 *  ls), which must stay in sync with this list. */
export function toolsForMode(mode: CodeMode): string[] | undefined {
  return mode === 'plan' ? ['read', 'grep', 'find', 'ls'] : undefined
}

/** Formats a FULL skill (name/description/instructions) for direct injection — used only for
 *  ONE skill at a time, as the system prompt of invoke_skill's isolated subagent call
 *  (code-session.ts). Never used for the main session's own prompt anymore (see
 *  skillCatalogBlock below for that) — kept as its own function because chat's own
 *  conversations.skillIds picker still injects full instructions this same way
 *  (chat-routes.ts, ~line 697), and the two should stay byte-identical in format. */
export function skillsBlock(skills: Skill[]): string {
  if (!skills.length) return ''
  return 'Skills enabled for this chat (apply the relevant ones):\n\n' +
    skills.map((s) => `## ${s.name}\n${s.description}\n\n${s.instructions.trim().slice(0, MAX_SKILL_INSTRUCTIONS_CHARS)}`).join('\n\n---\n\n')
}

/** The main session's OWN view of the skill library: name + description only, one line each,
 *  budget-capped — NOT full instructions (that was the ~157K-token bug). Tells the model a
 *  skill exists and what it's for; the model calls invoke_skill(skillId, task) to actually load
 *  and use one, which runs it in an isolated subagent call so the full instructions never sit
 *  in the main context. Entries beyond the budget are dropped with a count, not silently —
 *  a model that can't see a skill can't know to ask for it, so cutting off gracefully beats
 *  crowding out real conversation to fit them all. */
export function skillCatalogBlock(skills: Skill[]): string {
  if (!skills.length) return ''
  const lines: string[] = []
  let used = 0
  let dropped = 0
  for (const s of skills) {
    const line = `- **${s.id}** — ${s.description}`
    // +1 for the joining newline.
    if (used + line.length + 1 > MAX_SKILL_CATALOG_CHARS) { dropped++; continue }
    lines.push(line)
    used += line.length + 1
  }
  const header = 'Skills available (call invoke_skill(skillId, task) to use one — do not guess at ' +
    'a skill\'s behavior from its name/description alone, invoke it):\n\n'
  const footer = dropped > 0 ? `\n\n…and ${dropped} more skill(s) not shown (catalog budget reached).` : ''
  return header + lines.join('\n') + footer
}

/** The full append-prompt block for a session, in order. `skills` defaults to empty so
 *  every existing call site (and test) that doesn't pass it keeps today's exact output. */
export function buildAppendPrompt(mode: CodeMode, skills: Skill[] = []): string[] {
  const blocks = [basePersona(), modeGuidance(mode)]
  // Read-only plan mode has no edit tool, so the edit guidance is irrelevant there.
  if (mode !== 'plan') blocks.push(editReliabilityGuidance())
  const catalog = skillCatalogBlock(skills)
  if (catalog) blocks.push(catalog)
  return blocks
}
