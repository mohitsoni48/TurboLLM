// ── Code launchpad mock data ──────────────────────────────────────────────────
//
// What's left here is genuinely still mock: the coding-activity stats/heatmap
// (diff stats/streaks beyond what the edit tool itself reports are an explicit
// fast-follow — Phase 1 plan §6 item 5) and the agent-mode/starter-task copy
// (real UI labels, not data). Repo/model/session data now come from the real
// backend — see code-api.ts, code-queries.ts, code-types.ts.

export type CodeRange = 'all' | '30d' | '7d'

export interface CodeStats {
  sessions: number
  tasksShipped: number
  filesTouched: number
  diffShipped: string
  activeDays: number
  currentStreak: string
  longestStreak: string
  favoriteModel: string
}

// Streaks + favorite model mirror the Usage screen's semantics: lifetime, not
// range-scoped — so they stay constant across the range switch, same as Usage.
export const CODE_STATS: Record<CodeRange, CodeStats> = {
  all: {
    sessions: 200,
    tasksShipped: 163,
    filesTouched: 1204,
    diffShipped: '+48.2K −19.1K',
    activeDays: 43,
    currentStreak: '4d',
    longestStreak: '33d',
    favoriteModel: 'Qwen3-Coder-30B',
  },
  '30d': {
    sessions: 46,
    tasksShipped: 38,
    filesTouched: 311,
    diffShipped: '+12.6K −4.8K',
    activeDays: 19,
    currentStreak: '4d',
    longestStreak: '33d',
    favoriteModel: 'Qwen3-Coder-30B',
  },
  '7d': {
    sessions: 11,
    tasksShipped: 9,
    filesTouched: 84,
    diffShipped: '+3.1K −1.2K',
    activeDays: 6,
    currentStreak: '4d',
    longestStreak: '33d',
    favoriteModel: 'Qwen3-Coder-30B',
  },
}

export const FUN_FACT =
  'Agents have shipped ~48K lines here — a little more than the entire DOOM engine.'

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

// ── Session heatmap days ──────────────────────────────────────────────────────

export interface SessionDay {
  /** Local calendar date, YYYY-MM-DD. */
  date: string
  sessions: number
}

/** Deterministic pseudo-random in [0, 1) — same output every render, so the mock
 *  heatmap never flickers between paints. */
function det(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

/** ~6 months of mock daily session counts ending today: quiet early months with a
 *  faint scatter, then a busy recent stretch — the same shape a real new user's
 *  graph would have. Weekday-weighted so weekends read lighter. */
export function mockSessionDays(totalDays = 182): SessionDay[] {
  const days: SessionDay[] = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let ago = totalDays - 1; ago >= 0; ago--) {
    const d = new Date(today)
    d.setDate(today.getDate() - ago)
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const weekday = d.getDay()
    const weekend = weekday === 0 || weekday === 6
    let sessions = 0
    if (ago <= 63) {
      // Recent ~9 weeks: active most weekdays, lighter weekends.
      const r = det(ago + 7)
      const ceiling = weekend ? 2 : 6
      sessions = r < 0.18 ? 0 : Math.round(det(ago * 3 + 1) * ceiling)
    } else if (det(ago) > 0.93) {
      // Early months: the occasional exploratory day.
      sessions = 1 + Math.round(det(ago * 2) * 2)
    }
    days.push({ date, sessions })
  }
  return days
}
