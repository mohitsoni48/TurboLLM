// Background agent-task registry (spec 13 redesign — bg task visibility).
//
// The self-improvement work (reviewing a completed task, distilling a skill from a
// conversation or a folder) runs DETACHED. Without this, the user gets a toast and then
// silence. This registry tracks each running bg task — kind, the conversation/agent it
// belongs to, a step log, and the terminal result — and is surfaced via GET /status
// (`agentTasks`), mirroring BuildState/ProvisionState. The UI shows them inline in the
// conversation and opens a side panel on click.
import { randomUUID } from 'node:crypto'

export type AgentTaskKind = 'review' | 'skill_from_conversation' | 'skill_from_folder'
export type AgentTaskStatus = 'running' | 'done' | 'failed'

export interface AgentTask {
  id: string
  kind: AgentTaskKind
  /** The conversation this task belongs to (for inline display). Null for folder learning. */
  convId?: string
  agentId: string
  /** Short human label, e.g. "Reflecting on this task" / "Learning from /docs". */
  label: string
  status: AgentTaskStatus
  /** Ordered step messages, oldest→newest. */
  steps: string[]
  /** Terminal result summary (the lesson/skill found, or "nothing to learn"). */
  result?: string
  error?: string
  startedAt: number
  endedAt?: number
}

const MAX_TASKS = 50          // ring cap on retained tasks
const KEEP_DONE_MS = 5 * 60_000 // keep finished tasks visible for 5 min

export class AgentTaskState {
  private tasks = new Map<string, AgentTask>()

  /** Begin a task; returns its id (use it for step/finish). */
  start(kind: AgentTaskKind, agentId: string, label: string, convId?: string): string {
    this.gc()
    const id = randomUUID()
    this.tasks.set(id, { id, kind, convId, agentId, label, status: 'running', steps: [], startedAt: Date.now() })
    return id
  }

  step(id: string, message: string): void {
    const t = this.tasks.get(id)
    if (t && t.status === 'running') t.steps.push(message)
  }

  done(id: string, result: string): void {
    const t = this.tasks.get(id)
    if (t) { t.status = 'done'; t.result = result; t.endedAt = Date.now() }
  }

  fail(id: string, error: string): void {
    const t = this.tasks.get(id)
    if (t) { t.status = 'failed'; t.error = error; t.endedAt = Date.now() }
  }

  /** All tasks (running first, then recently finished). For GET /status. */
  list(): AgentTask[] {
    this.gc()
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  get(id: string): AgentTask | undefined {
    return this.tasks.get(id)
  }

  /** Drop finished tasks older than KEEP_DONE_MS and enforce the ring cap. */
  private gc(): void {
    const now = Date.now()
    for (const [id, t] of this.tasks) {
      if (t.status !== 'running' && t.endedAt && now - t.endedAt > KEEP_DONE_MS) this.tasks.delete(id)
    }
    if (this.tasks.size > MAX_TASKS) {
      const sorted = [...this.tasks.values()].sort((a, b) => a.startedAt - b.startedAt)
      for (const t of sorted.slice(0, this.tasks.size - MAX_TASKS)) {
        if (t.status !== 'running') this.tasks.delete(t.id)
      }
    }
  }
}
