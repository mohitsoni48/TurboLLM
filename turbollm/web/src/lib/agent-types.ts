// ── Skills (the global library any chat conversation can enable) ──────────────

export interface Skill {
  id: string
  name: string
  description: string
  instructions: string
  tools: string[]
  builtin?: boolean
}
