// ── Code launchpad mock data ──────────────────────────────────────────────────
//
// What's left here is genuinely still mock: the agent-mode/starter-task copy
// (real UI labels, not data). Everything else — repo/model/session data, and
// (as of the real codeStats() backend) the coding-activity stats/heatmap too —
// comes from the real backend. See code-api.ts, code-queries.ts, code-types.ts.

export type AgentModeId = 'auto' | 'plan' | 'ask'

export interface AgentMode {
  id: AgentModeId
  label: string
  desc: string
}

export const AGENT_MODES: AgentMode[] = [
  { id: 'auto', label: 'Auto', desc: 'Plans and edits end-to-end, asks only when blocked' },
  { id: 'plan', label: 'Plan first', desc: 'Shows a plan for approval before touching files' },
  { id: 'ask', label: 'Ask each step', desc: 'Approval gate on every file edit and command' },
]

export const STARTER_TASKS = [
  'Fix the failing test in engine-groups.test.ts',
  'Add a --verbose flag to the CLI',
  'Write unit tests for lib/vram.ts',
  'Explain how gateway auto model-swap works',
]
