// Task-tracking tools (spec 13 §12.2) — the working doc + the model's done-signal.
// Granted by the builtin `task-tracking` skill. Factories close over the run's id +
// the DB so the model's calls persist to agent_run_docs and signal completion.
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { ConversationStore } from '../chat/db'

/** Signalled when the model calls complete_task — the run loop ends and enters
 *  awaiting-disposition (§14). */
export interface CompletionSignal {
  done: boolean
  summary: string
}

/** update_doc: the model maintains its structured progress doc. Survives /compact. */
export function createUpdateDocTool(db: ConversationStore, runId: string) {
  return defineTool({
    name: 'update_doc',
    label: 'Update Progress',
    description: 'Record or update your working progress document for this task: what is done, what is left, what was tried, and what is blocked. Call this regularly so progress survives context compaction.',
    parameters: Type.Object({
      content: Type.String({ description: 'The full updated progress document (markdown). Replaces the previous version.' }),
    }),
    execute: async (_id, params, _signal, _onUpdate, _ctx) => {
      db.upsertRunDoc(runId, params.content)
      return { content: [{ type: 'text', text: 'Progress doc updated.' }], details: undefined }
    },
  })
}

/** complete_task: the model's explicit done-signal. Flips the shared signal; the run
 *  manager ends the loop after the current turn and enters awaiting-disposition. */
export function createCompleteTaskTool(signal: CompletionSignal) {
  return defineTool({
    name: 'complete_task',
    label: 'Complete Task',
    description: 'Call this when you believe the task is fully complete. Provide a short summary of what you accomplished. This ends your work and hands the result to the user for review.',
    parameters: Type.Object({
      summary: Type.String({ description: 'A short summary of what was accomplished.' }),
    }),
    execute: async (_id, params, _signal, _onUpdate, _ctx) => {
      signal.done = true
      signal.summary = params.summary
      return { content: [{ type: 'text', text: 'Task marked complete. The user will review your work.' }], details: undefined }
    },
  })
}
