// ── Skills (the global library any chat conversation can enable) ──────────────

/** Skills a chat cannot use (filesystem needs Code's repo access), so no chat picker offers them. */
export const CHAT_UNSUPPORTED_SKILLS = new Set(['filesystem'])

export interface Skill {
  id: string
  name: string
  description: string
  instructions: string
  tools: string[]
  builtin?: boolean
}
