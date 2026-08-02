// Model-callable tool wrapping for the Routine feature (Phase 4). Two surfaces call into
// these SAME executors: chat's ToolRegistry (tool-registry.ts) and the in-app Code/pi session
// (code-session.ts, via ToolRegistry.executeTool too) — one implementation, not two.
//
// The terminal-agent CLI is deliberately NOT wired here — see this phase's "Corrected design"
// section: the CLI's own Bash tool can already `curl` the REST API directly, and Phase 1's
// `create_routine`→`pending_confirmation` server-side gate makes that safe with zero extra work.
//
// confirm: true — update_routine/delete_routine only. create_routine needs no such flag: Phase 1's
// ConversationStore.createRoutine() only ever inserts 'pending_confirmation' (the status is a SQL
// literal, not a parameter), so a tool call alone can never make a routine live. update/delete
// apply IMMEDIATELY in Phase 1's REST layer (no pending-diff state, unlike create) — the UI's own
// confirm dialog (Phase 5) is that gate for the frontend surface, but a model-callable tool has no
// dialog to show, so the two-phase preview/apply pattern here is what stands in for it on these two
// surfaces. Correspondingly, NO tool here exposes `status`, `nextFireAt`, or a confirm/activate
// action: arming a routine stays human-only, via PUT /api/v1/routines/:id/confirm.
//
// Every executor returns a plain string and never throws — matching builtin.ts's `execFetchUrl`/
// `execWebSearch` convention of surfacing failures as an `"Error: ..."` string the model can read
// and correct, rather than an exception the tool loop has to catch.
//
// CODE-FLAVOR AUTHORIZATION (`isCodeAuthorized`, the 3rd parameter of execCreateRoutine and
// execUpdateRoutine — READ THIS BEFORE WIRING THIS MODULE INTO ANYTHING):
// `POST /api/v1/routines` and `PUT /api/v1/routines/:id` both refuse to create or edit a
// CODE-flavor routine for a caller that is neither host-local nor holding a valid API key
// (routine-routes.ts's `codeGateBlocks`). That is a stronger bar than the app-wide `lanAuth`,
// which has an explicit "user opted into open LAN access" bypass (auth.ts's `bypassesAuth`) that
// `codeAuth` deliberately does not. A code-flavor routine schedules unattended code execution on
// the host on a timer, so authoring or editing one has to clear the same bar as the Code feature.
// These executors have no Hono `Context` and so CANNOT make that trust decision themselves — the
// CALLER must, and pass the answer in. Obligations per surface:
//   • Chat / ToolRegistry (Task 2/3): MUST compute it exactly as `codeGateBlocks` does —
//     `isLocalRequest(c, d) || verifyPresentedKey(c, d)` for the HTTP request driving the tool
//     loop — and thread it in. `POST /api/v1/chat` is behind `lanAuth` ONLY (server.ts:65;
//     `codeAuth` is scoped to `/api/v1/code/*` at :68), so without this a keyless LAN caller who
//     is blocked at the REST route could just ask the model to author the same code routine.
//   • In-app Code / pi session (Task 4): may pass `true` unconditionally. Every entry point to a
//     Code session is already behind `codeAuth`: `app.use('/api/v1/code/*', codeAuth(d))`
//     (server.ts:68) is registered BEFORE `registerCodeRoutes` (:86), so session creation
//     (`POST /api/v1/code/sessions`, code-routes.ts:140) and every subsequent turn
//     (`POST /api/v1/code/sessions/:id/messages`, :737) are gated, and the one non-Hono path —
//     the raw terminal WebSocket upgrade — applies the same check by hand
//     (terminal-routes.ts:423-424, `isLocalUpgrade || verifyKeyValue`). A Code session's mere
//     existence therefore already proves host-local-or-keyed.
// The parameter DEFAULTS TO FALSE so that a caller who forgets it blocks code-flavor authoring
// rather than silently permitting it — omission must fail closed, since the omission is exactly
// the bug this guards against. Chat-flavor create/update is unaffected by it, in every case.
import type { ConversationStore } from '../chat/db'
import type { Routine, RoutineFlavor, ScheduleRule, CodingAgentChoice } from './schema'
import { computeNextFireTime } from './schedule'
import { validateCreate, validateUpdate, CODE_GATE_MESSAGE, type RoutineBody } from './routine-routes'

/** The narrow slice of ConversationStore these 5 tools touch. A real ConversationStore instance
 *  satisfies this structurally (TypeScript structural typing) — no adapter needed at the call
 *  site (cli.ts just passes `db`). Kept narrow so tests can stub it without a real DB, and so the
 *  tool layer provably cannot reach `confirmRoutine` — the one human-only mutation. */
export interface RoutineToolsStore {
  createRoutine: ConversationStore['createRoutine']
  getRoutine: ConversationStore['getRoutine']
  listRoutines: ConversationStore['listRoutines']
  updateRoutine: ConversationStore['updateRoutine']
  deleteRoutine: ConversationStore['deleteRoutine']
  listRoutineRuns: ConversationStore['listRoutineRuns']
}

/** Trigger an already-confirmed routine to run immediately. Injected rather than hardcoded so this
 *  module owns only the tool contract: Phase 2/3's `RoutineScheduler.runNow` (or the REST
 *  `POST /api/v1/routines/:id/run-now` that wraps it) is bound in at wiring time, and swapping the
 *  backing mechanism never touches this file. */
export type RunRoutineNowFn = (routineId: string) => Promise<{ ok: true } | { ok: false; reason: string }>

const SCHEDULE_RULE_SCHEMA = {
  type: 'object',
  description:
    'The structured schedule. Set "kind" and only the fields that kind uses: ' +
    '"interval" uses everyMs; "daily" uses hour+minute; "weekly" uses daysOfWeek+hour+minute.',
  properties: {
    kind: { type: 'string', enum: ['interval', 'daily', 'weekly'] },
    everyMs: { type: 'number', description: 'Required when kind is "interval": milliseconds between fires.' },
    hour: { type: 'number', description: 'Required when kind is "daily" or "weekly": 0-23, local time.' },
    minute: { type: 'number', description: 'Required when kind is "daily" or "weekly": 0-59.' },
    daysOfWeek: {
      type: 'array', items: { type: 'number' },
      description: 'Required when kind is "weekly": 0=Sunday..6=Saturday.',
    },
  },
  required: ['kind'],
}

/** Every RoutineBody field whose declared type is a string. `validateCreate`/`validateUpdate` are
 *  written against a REST body that a UI produced, so they reach straight for `.trim()`; a model
 *  can and does emit `prompt: 42`, which would throw a raw TypeError out of the executor instead of
 *  returning the `"Error: ..."` string this layer promises. Checking types first is what makes
 *  reusing the REST validators safe here. */
const STRING_FIELDS = [
  'flavor', 'prompt', 'scheduleDisplay', 'modelKey', 'agentId', 'workspacePath', 'codingAgent', 'permissionMode',
] as const

function stringFieldProblem(args: Record<string, unknown>): string | null {
  for (const f of STRING_FIELDS) {
    if (args[f] !== undefined && typeof args[f] !== 'string') return `${f} must be a string.`
  }
  return null
}

// ── create_routine ──────────────────────────────────────────────────────────

export const CREATE_ROUTINE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'create_routine',
    description:
      'Create a new scheduled Routine — a saved task that fires automatically on a schedule with no ' +
      'user present. ALWAYS lands in "pending_confirmation" status: it is NOT active and will NEVER ' +
      'fire until a human explicitly confirms it (in the Routines panel). This tool cannot confirm a ' +
      'routine itself — after creating one, tell the user it needs their confirmation before it does ' +
      'anything. flavor "chat" runs through the normal chat tool-loop (web_search/fetch_url/run_code/ ' +
      'skills, no filesystem/shell access) and requires agentId (an existing Customize -> Agents ' +
      'persona id). flavor "code" runs a coding agent against a workspace and requires workspacePath ' +
      'and codingAgent. Schedule input is natural language on your side — YOU translate it into the ' +
      'structured scheduleRule plus a human-readable scheduleDisplay that accurately describes it.',
    parameters: {
      type: 'object',
      properties: {
        flavor: { type: 'string', enum: ['chat', 'code'], description: 'Which kind of routine this is.' },
        prompt: { type: 'string', description: 'The task to run, in the same words a user would ask it.' },
        scheduleDisplay: { type: 'string', description: 'Human-readable schedule, e.g. "Runs weekdays at 9:00 AM". Must accurately describe scheduleRule.' },
        scheduleRule: SCHEDULE_RULE_SCHEMA,
        modelKey: { type: 'string', description: 'The model key to pin this routine to (same identifiers shown in the model dropdown).' },
        agentId: { type: 'string', description: 'Required when flavor is "chat": an existing Customize -> Agents persona id.' },
        workspacePath: { type: 'string', description: 'Required when flavor is "code": absolute path to the workspace directory.' },
        codingAgent: { type: 'string', enum: ['pi', 'claude_cli'], description: 'Required when flavor is "code": which coding-agent implementation to pin.' },
        permissionMode: { type: 'string', enum: ['auto', 'plan', 'ask'], description: 'Optional, code flavor only: Code\'s permission mode for this routine\'s runs.' },
      },
      required: ['flavor', 'prompt', 'scheduleDisplay', 'scheduleRule', 'modelKey'],
    },
  },
}

/** `async` by contract, not because it awaits anything today: `ToolRegistry.executeTool` awaits
 *  every executor uniformly, and keeping the signature Promise-returning means a later backing
 *  call (validation against a live model list, say) is not a breaking change.
 *
 *  @param isCodeAuthorized Whether this caller has cleared the same bar `codeAuth` enforces —
 *  host-local OR holding a valid API key. Consulted ONLY when `flavor` is `'code'`; a chat-flavor
 *  create behaves identically whatever it is. DEFAULTS TO FALSE (fail closed): a caller that
 *  forgets to pass it can never author a code routine. See the module header for how each calling
 *  surface must compute it — Task 2/3 (chat) must mirror `routine-routes.ts`'s `codeGateBlocks`;
 *  Task 4 (in-app Code session) may pass `true`, since `codeAuth` already gated the session. */
export async function execCreateRoutine(
  args: Record<string, unknown>,
  store: RoutineToolsStore,
  isCodeAuthorized = false,
): Promise<string> {
  // Gate BEFORE validation, exactly as POST /api/v1/routines does (routine-routes.ts:152), so an
  // ungated caller learns nothing about the request shape from the error it gets back.
  if (args.flavor === 'code' && !isCodeAuthorized) return `Error: ${CODE_GATE_MESSAGE}`
  const typeProblem = stringFieldProblem(args)
  if (typeProblem) return `Error: ${typeProblem}`
  const b = args as unknown as RoutineBody
  const problem = validateCreate(b)
  if (problem) return `Error: ${problem}`
  const routine = store.createRoutine({
    flavor: b.flavor as RoutineFlavor,
    prompt: b.prompt!.trim(),
    scheduleDisplay: b.scheduleDisplay!.trim(),
    scheduleRule: b.scheduleRule as ScheduleRule,
    modelKey: b.modelKey!.trim(),
    agentId: b.agentId,
    workspacePath: b.workspacePath,
    codingAgent: b.codingAgent as CodingAgentChoice | undefined,
    permissionMode: b.permissionMode,
  })
  return `Created routine "${routine.id}" (${routine.scheduleDisplay}) in status "pending_confirmation". ` +
    'It will NOT run until a human confirms it in the Routines panel — tell the user to review and confirm it.'
}

// ── list_routines ───────────────────────────────────────────────────────────

export const LIST_ROUTINES_TOOL = {
  type: 'function' as const,
  function: {
    name: 'list_routines',
    description: 'List every saved Routine with its id, status, flavor, schedule, and prompt.',
    parameters: { type: 'object', properties: {} },
  },
}

export function execListRoutines(_args: Record<string, unknown>, store: RoutineToolsStore): string {
  const routines = store.listRoutines()
  if (routines.length === 0) return 'No routines exist yet.'
  return routines
    .map((r: Routine) => `- ${r.id} [${r.status}] ${r.flavor} — "${r.scheduleDisplay}" — ${r.prompt}`)
    .join('\n')
}

// ── update_routine (two-phase confirm) ──────────────────────────────────────

export const UPDATE_ROUTINE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'update_routine',
    description:
      'Change an existing routine\'s prompt/schedule/model/etc. SAFETY: call this FIRST WITHOUT ' +
      'confirm (or confirm: false) to preview the old->new diff — nothing is changed yet. Only after ' +
      'the user has seen the diff and explicitly agreed, call it AGAIN with confirm: true to actually ' +
      'apply it. Unlike create_routine, an update to an already-active routine takes effect ' +
      'immediately once applied — there is no further human confirmation step after this one.',
    parameters: {
      type: 'object',
      properties: {
        routineId: { type: 'string', description: 'The routine to update.' },
        prompt: { type: 'string' },
        scheduleDisplay: { type: 'string' },
        scheduleRule: SCHEDULE_RULE_SCHEMA,
        modelKey: { type: 'string' },
        workspacePath: { type: 'string' },
        codingAgent: { type: 'string', enum: ['pi', 'claude_cli'] },
        permissionMode: { type: 'string', enum: ['auto', 'plan', 'ask'] },
        confirm: { type: 'boolean', description: 'Must be true to actually apply the change. Omit or pass false to preview the diff only.' },
      },
      required: ['routineId'],
    },
  },
}

/** Deliberately excludes `status` and `nextFireAt`, which `ConversationStore.updateRoutine` does
 *  accept: routing either through a model-callable tool would be a second door into 'active',
 *  bypassing the human confirm step that is this whole feature's safety property. */
const UPDATABLE_FIELDS = [
  'prompt', 'scheduleDisplay', 'scheduleRule', 'modelKey', 'workspacePath', 'codingAgent', 'permissionMode',
] as const
type UpdatableField = (typeof UPDATABLE_FIELDS)[number]

/** @param isCodeAuthorized See {@link execCreateRoutine} and the module header. Consulted only when
 *  the STORED routine is code-flavor (or an incoming `flavor` says code, kept for symmetry with
 *  `PUT /api/v1/routines/:id`, which checks both so it stays correct if flavor ever becomes
 *  mutable). Also blocks the PREVIEW call, deliberately: the diff echoes the routine's stored
 *  `workspacePath`, which the REST layer does not hand an ungated caller either. DEFAULTS TO FALSE
 *  (fail closed). Updating a chat-flavor routine is unaffected by it. */
export function execUpdateRoutine(
  args: Record<string, unknown>,
  store: RoutineToolsStore,
  isCodeAuthorized = false,
): string {
  const id = String(args.routineId ?? '').trim()
  if (!id) return 'Error: routineId is required.'
  const existing = store.getRoutine(id)
  if (!existing) return `Error: no routine with id "${id}".`
  // Mirrors PUT /api/v1/routines/:id (routine-routes.ts:177-179), including checking both the
  // stored flavor and any incoming one, and gating before validation.
  if ((existing.flavor === 'code' || args.flavor === 'code') && !isCodeAuthorized) {
    return `Error: ${CODE_GATE_MESSAGE}`
  }

  const typeProblem = stringFieldProblem(args)
  if (typeProblem) return `Error: ${typeProblem}`

  const patch: RoutineBody = {}
  const changed: UpdatableField[] = []
  for (const f of UPDATABLE_FIELDS) {
    if (args[f] === undefined) continue
    changed.push(f)
    ;(patch as Record<string, unknown>)[f] = args[f]
  }
  if (changed.length === 0) return 'Error: at least one field to change is required.'

  // The REST layer's own PUT validation, reused verbatim (flavor-dependent invariants re-checked
  // against the STORED flavor, plus permissionMode/codingAgent/scheduleRule) …
  const problem = validateUpdate(patch, existing)
  if (problem) return `Error: ${problem}`
  // … plus the two emptiness checks PUT happens not to make. Blanking either field is never a
  // meaningful edit, and an empty modelKey would leave the routine unable to pick an engine at all.
  if (patch.scheduleDisplay !== undefined && !patch.scheduleDisplay.trim()) return 'Error: scheduleDisplay cannot be empty.'
  if (patch.modelKey !== undefined && !patch.modelKey.trim()) return 'Error: modelKey cannot be empty.'

  if (args.confirm !== true) {
    const lines = changed.map(
      (k) => `  ${k}: ${JSON.stringify((existing as unknown as Record<string, unknown>)[k])} -> ${JSON.stringify(patch[k])}`,
    )
    return `PREVIEW (not applied) — call again with confirm: true to apply:\n${lines.join('\n')}`
  }

  // Mirrors the PUT handler's patch construction exactly, including the next_fire_at recompute:
  // without it a live routine keeps firing on its OLD schedule until the next tick rewrites it.
  const storePatch: Parameters<RoutineToolsStore['updateRoutine']>[1] = {}
  if (patch.prompt !== undefined) storePatch.prompt = patch.prompt.trim()
  if (patch.scheduleDisplay !== undefined) storePatch.scheduleDisplay = patch.scheduleDisplay.trim()
  if (patch.scheduleRule !== undefined) {
    storePatch.scheduleRule = patch.scheduleRule
    if (existing.status === 'active') storePatch.nextFireAt = computeNextFireTime(patch.scheduleRule, new Date()).toISOString()
  }
  if (patch.modelKey !== undefined) storePatch.modelKey = patch.modelKey.trim()
  if (patch.workspacePath !== undefined) storePatch.workspacePath = patch.workspacePath
  if (patch.codingAgent !== undefined) storePatch.codingAgent = patch.codingAgent
  if (patch.permissionMode !== undefined) storePatch.permissionMode = patch.permissionMode
  // The store's return value is the ONLY evidence the write landed. `getRoutine` above is a
  // time-of-check; this is the time-of-use, and the row can vanish in between (a concurrent tool
  // call in the same loop, the UI, a REST client). Reporting success unconditionally would tell
  // the model — and through it the user — that a change was applied when it was not.
  const updated = store.updateRoutine(id, storePatch)
  if (!updated) return `Error: routine "${id}" no longer exists — nothing was updated.`
  return `Updated routine "${id}".`
}

// ── delete_routine (two-phase confirm) ──────────────────────────────────────

export const DELETE_ROUTINE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'delete_routine',
    description:
      'Permanently delete a routine AND its full run history (hard delete, no undo). SAFETY: call ' +
      'this FIRST WITHOUT confirm (or confirm: false) to see what would be deleted — nothing is ' +
      'deleted yet. Only after the user explicitly agrees, call it AGAIN with confirm: true.',
    parameters: {
      type: 'object',
      properties: {
        routineId: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true to actually delete. Omit or pass false to preview only.' },
      },
      required: ['routineId'],
    },
  },
}

export function execDeleteRoutine(args: Record<string, unknown>, store: RoutineToolsStore): string {
  const id = String(args.routineId ?? '').trim()
  if (!id) return 'Error: routineId is required.'
  const existing = store.getRoutine(id)
  if (!existing) return `Error: no routine with id "${id}".`
  const runCount = store.listRoutineRuns(id).length

  if (args.confirm !== true) {
    return `PREVIEW (not deleted) — routine "${id}" ("${existing.prompt}") has ${runCount} run(s) in its ` +
      'history. Deleting also removes that history permanently, with no undo. Call again with ' +
      'confirm: true to actually delete.'
  }

  // Same time-of-check/time-of-use window as execUpdateRoutine's mutation: `false` means the row
  // was already gone, so the model must not be told this call deleted anything.
  if (!store.deleteRoutine(id)) return `Error: routine "${id}" no longer exists — nothing was deleted.`
  return `Deleted routine "${id}" and its run history.`
}

// ── run_routine_now ──────────────────────────────────────────────────────────

export const RUN_ROUTINE_NOW_TOOL = {
  type: 'function' as const,
  function: {
    name: 'run_routine_now',
    description:
      'Trigger an already-confirmed routine to run immediately, without waiting for its next ' +
      'scheduled fire. Fails if the routine is still "pending_confirmation" — a human must confirm ' +
      'it first.',
    parameters: {
      type: 'object',
      properties: { routineId: { type: 'string' } },
      required: ['routineId'],
    },
  },
}

export async function execRunRoutineNow(
  args: Record<string, unknown>,
  store: RoutineToolsStore,
  runNow: RunRoutineNowFn,
): Promise<string> {
  const id = String(args.routineId ?? '').trim()
  if (!id) return 'Error: routineId is required.'
  const routine = store.getRoutine(id)
  if (!routine) return `Error: no routine with id "${id}".`
  // 'paused' is deliberately allowed, matching RoutineScheduler.runNow's own gate: only a routine
  // a human has never confirmed is off-limits to a manual trigger.
  if (routine.status === 'pending_confirmation') {
    return `Error: routine "${id}" is still pending confirmation — a human must confirm it before it can run.`
  }
  let result: Awaited<ReturnType<RunRoutineNowFn>>
  try {
    result = await runNow(id)
  } catch (e) {
    // The injected fn is wiring-owned (Phase 2/3); an outright throw from it must still surface as
    // this layer's Error-string contract rather than rejecting into the caller's tool loop.
    return `Error: could not run routine "${id}" now — ${e instanceof Error ? e.message : String(e)}`
  }
  return result.ok
    ? `Routine "${id}" is running now.`
    : `Could not run routine "${id}" now: ${result.reason}`
}
