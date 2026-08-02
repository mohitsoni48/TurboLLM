import { useId, useState } from 'react'
import type { RoutineDraft } from '../../lib/routine-form'
import { useChatAgents, useModels } from '../../lib/queries'
import { FsBrowser } from '../../screens/engines/FsBrowser'

const CODING_AGENT_OPTIONS: { value: 'pi' | 'claude_cli'; label: string }[] = [
  { value: 'pi', label: 'In-app pi engine' },
  { value: 'claude_cli', label: 'Terminal claude CLI (local gateway)' },
]
const PERMISSION_MODE_OPTIONS: { value: 'auto' | 'plan' | 'ask'; label: string }[] = [
  { value: 'ask', label: 'Ask before each tool call' },
  { value: 'auto', label: 'Auto (act, no prompts)' },
  { value: 'plan', label: 'Plan only (no execution)' },
]
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const inputCls = 'w-full rounded-md border border-border bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent placeholder:text-faint'
const labelCls = 'text-[12px] font-medium text-muted'

/** Switching flavor rewrites the draft so it carries ONLY the chosen flavor's fields, and so the
 *  permission mode the form is about to DISPLAY is actually present on the draft.
 *
 *  Two defects live on this one transition:
 *
 *  1. Safety. The permission-mode select renders `draft.permissionMode ?? 'ask'`, i.e. it shows
 *     "Ask before each tool call" as selected before the user has touched it. But
 *     `emptyRoutineDraft()` never sets the field and `isRoutineDraftComplete` does not require
 *     it, so the common path (pick Code, pick a workspace and a coding agent, never touch a
 *     control that already looks set) persists `permissionMode: undefined` — and the backend
 *     resolves that to `'auto'`, not `'ask'` (`src/routines/code-runner.ts`: `routine.permissionMode
 *     ?? 'auto'`). The routine would then edit files and run commands unattended while the UI
 *     that created it displayed the approval gate. Materialising the default here makes the
 *     displayed mode and the executed mode the same value.
 *  2. Dirty data. Only spreading `{ ...draft, flavor }` leaves the departing flavor's fields
 *     behind, and `src/routines/routine-routes.ts` validates only the chosen flavor's required
 *     field while persisting `agentId`/`workspacePath`/`codingAgent`/`permissionMode`
 *     unconditionally — so a chat routine ends up stored with a phantom workspace path (and a
 *     code routine with a phantom agentId), which then shows up as a phantom row in
 *     RoutineConfirmCard's update diff. */
function withFlavor(draft: RoutineDraft, flavor: RoutineDraft['flavor']): RoutineDraft {
  if (flavor === 'chat') return { ...draft, flavor, workspacePath: undefined, codingAgent: undefined, permissionMode: undefined }
  return { ...draft, flavor, agentId: undefined, permissionMode: draft.permissionMode ?? 'ask' }
}

/** The routine form's fields, and nothing else — fully controlled, with no submit, persist or
 *  validation logic of its own. Both surfaces that create/edit a routine embed this same
 *  component (the panel's create/edit page and the chat transcript's confirm card), so the
 *  two can never drift into offering different fields for the same object; whoever embeds it
 *  owns the draft state, the completeness gate (`isRoutineDraftComplete`) and the write.
 *
 *  Agents and models come from the real catalogs (`useChatAgents`/`useModels`), never a
 *  hardcoded list. Models are offered unfiltered — deliberately not narrowed to
 *  `compatibleWithActiveEngine` the way the Code launchpad's picker is: a routine names a
 *  model for a run that happens later, under whichever engine is active then, so filtering on
 *  today's engine would hide valid choices.
 *
 *  `lockFlavor` disables the Chat/Code toggle ALONE, leaving every other field editable —
 *  distinct from `disabled`, which inerts the whole form. Any surface editing a routine that
 *  already exists must set it: `PUT /api/v1/routines/:id` cannot change `flavor`
 *  (routine-api.ts's `updateRoutine`; routine-routes.ts's `validateUpdate` re-checks
 *  flavor-dependent invariants against the routine's CURRENT flavor). Left live, the toggle
 *  swaps which fields the form collects, the embedding confirm card's diff advertises code-only
 *  changes the flavor switch appears to justify, and the server persists those fields onto a
 *  routine whose flavor never moved — a gate that describes something other than what happens. */
export function RoutineFormFields({ draft, onChange, disabled, lockFlavor }: { draft: RoutineDraft; onChange: (d: RoutineDraft) => void; disabled?: boolean; lockFlavor?: boolean }) {
  const [browserOpen, setBrowserOpen] = useState(false)
  const agentsQ = useChatAgents()
  const modelsQ = useModels()
  const models = modelsQ.data?.models ?? []
  const agents = agentsQ.data ?? []
  // A controlled <select> whose value matches no <option> falls back to the first one — here the
  // placeholder — so the field would read as unset while the draft still holds a real value and
  // `isRoutineDraftComplete` still returns true: an enabled Confirm next to an apparently empty
  // required field, and an untouched submit silently re-persisting the invisible value. Happens
  // on first paint of an edit form before the catalog query resolves, and permanently once a
  // model/agent is deleted. Rendering the stored value as its own option keeps it visible.
  const orphanModelKey = draft.modelKey && !models.some((m) => m.key === draft.modelKey) ? draft.modelKey : null
  const orphanAgentId = draft.agentId && !agents.some((a) => a.id === draft.agentId) ? draft.agentId : null
  // Ids so each <label> actually points at its control — these are plain selects/inputs, not
  // wrapped controls, so without htmlFor a screen reader reads them as unlabelled.
  const uid = useId()
  const id = (field: string) => `${uid}-${field}`

  // Narrow the schedule rule once, up here, instead of re-narrowing (or casting) inside each
  // event handler below — TypeScript does not carry a discriminant narrowing of `draft.x` into
  // a callback, and the plan's `as` casts would paper over a real mismatch rather than catch it.
  const rule = draft.scheduleRule
  const clock = rule.kind === 'interval' ? null : rule
  const weekly = rule.kind === 'weekly' ? rule : null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className={labelCls}>Flavor</span>
        <div className="inline-flex w-fit rounded-md border border-border p-0.5" role="group" aria-label="Flavor">
          {(['chat', 'code'] as const).map((f) => (
            <button
              key={f}
              type="button"
              disabled={disabled || lockFlavor}
              aria-pressed={draft.flavor === f}
              onClick={() => onChange(withFlavor(draft, f))}
              className={`rounded px-3 py-1.5 text-[13px] font-medium transition-colors ${draft.flavor === f ? 'bg-accent/12 text-accent' : 'text-muted hover:text-ink'}`}
            >
              {f === 'chat' ? 'Chat' : 'Code'}
            </button>
          ))}
        </div>
        {/* Say why, rather than leaving two dead buttons the user has to guess about. */}
        {lockFlavor && <span className="text-[11px] text-faint">A routine&apos;s flavor is fixed once it exists — editing cannot change it.</span>}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className={labelCls} htmlFor={id('prompt')}>Task prompt</label>
        <textarea
          id={id('prompt')}
          disabled={disabled}
          className={`${inputCls} min-h-[100px] resize-y`}
          placeholder="What should this routine do each time it runs?"
          value={draft.prompt}
          onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className={labelCls} htmlFor={id('model')}>Model</label>
        <select id={id('model')} disabled={disabled} className={inputCls} value={draft.modelKey} onChange={(e) => onChange({ ...draft, modelKey: e.target.value })}>
          <option value="">Choose a model…</option>
          {orphanModelKey && <option value={orphanModelKey}>{orphanModelKey} (not in the current catalog)</option>}
          {models.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
        </select>
      </div>

      {draft.flavor === 'chat' ? (
        <div className="flex flex-col gap-1.5">
          <label className={labelCls} htmlFor={id('agent')}>Agent</label>
          <select id={id('agent')} disabled={disabled} className={inputCls} value={draft.agentId ?? ''} onChange={(e) => onChange({ ...draft, agentId: e.target.value || undefined })}>
            <option value="">Choose an agent…</option>
            {orphanAgentId && <option value={orphanAgentId}>{orphanAgentId} (not in the current catalog)</option>}
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label className={labelCls} htmlFor={id('workspace')}>Workspace</label>
            <div className="flex gap-2">
              <input id={id('workspace')} disabled={disabled} readOnly className={inputCls} placeholder="No workspace chosen" value={draft.workspacePath ?? ''} />
              <button type="button" disabled={disabled} onClick={() => setBrowserOpen(true)} className="shrink-0 rounded-md border border-border px-3 py-1.5 text-[13px] text-ink hover:bg-panel-2">
                Browse…
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelCls} htmlFor={id('coding-agent')}>Coding agent</label>
            <select
              id={id('coding-agent')}
              disabled={disabled}
              className={inputCls}
              value={draft.codingAgent ?? ''}
              onChange={(e) => onChange({ ...draft, codingAgent: (e.target.value || undefined) as RoutineDraft['codingAgent'] })}
            >
              <option value="">Choose…</option>
              {CODING_AGENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelCls} htmlFor={id('permission-mode')}>Permission mode</label>
            <select
              id={id('permission-mode')}
              disabled={disabled}
              className={inputCls}
              value={draft.permissionMode ?? 'ask'}
              onChange={(e) => onChange({ ...draft, permissionMode: e.target.value as RoutineDraft['permissionMode'] })}
            >
              {PERMISSION_MODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <label className={labelCls} htmlFor={id('schedule')}>Schedule</label>
        <select
          id={id('schedule')}
          disabled={disabled}
          className={inputCls}
          value={rule.kind}
          onChange={(e) => {
            const kind = e.target.value as 'interval' | 'daily' | 'weekly'
            if (kind === 'interval') onChange({ ...draft, scheduleRule: { kind: 'interval', everyMs: 60 * 60_000 } })
            else if (kind === 'daily') onChange({ ...draft, scheduleRule: { kind: 'daily', hour: 9, minute: 0 } })
            else onChange({ ...draft, scheduleRule: { kind: 'weekly', daysOfWeek: [1, 2, 3, 4, 5], hour: 9, minute: 0 } })
          }}
        >
          <option value="daily">Daily</option>
          <option value="weekly">Specific weekdays</option>
          <option value="interval">Every N minutes</option>
        </select>

        {rule.kind === 'interval' ? (
          <input
            disabled={disabled}
            type="number"
            min={1}
            aria-label="Minutes between runs"
            className={inputCls}
            value={Math.round(rule.everyMs / 60_000)}
            onChange={(e) => onChange({ ...draft, scheduleRule: { kind: 'interval', everyMs: Math.max(1, Number(e.target.value)) * 60_000 } })}
          />
        ) : clock ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              disabled={disabled}
              type="time"
              aria-label="Time of day"
              className={inputCls}
              style={{ width: 'auto' }}
              value={`${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(':').map(Number)
                // A cleared time input reports '' — keep the last valid time rather than writing
                // NaN into the rule (which would render an invalid value back into the input and
                // only be caught later by isRoutineDraftComplete's integer-range checks).
                if (!Number.isFinite(h) || !Number.isFinite(m)) return
                onChange({ ...draft, scheduleRule: { ...clock, hour: h, minute: m } })
              }}
            />
            {weekly && (
              <div className="flex gap-1" role="group" aria-label="Days of the week">
                {WEEKDAY_LABELS.map((label, i) => {
                  const on = weekly.daysOfWeek.includes(i)
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={disabled}
                      aria-pressed={on}
                      onClick={() => onChange({ ...draft, scheduleRule: { ...weekly, daysOfWeek: on ? weekly.daysOfWeek.filter((d) => d !== i) : [...weekly.daysOfWeek, i] } })}
                      className={`h-7 w-9 rounded text-[11px] font-medium transition-colors ${on ? 'bg-accent/12 text-accent' : 'text-muted hover:bg-panel-2'}`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <FsBrowser
        open={browserOpen}
        onOpenChange={setBrowserOpen}
        onSelect={(p) => { onChange({ ...draft, workspacePath: p }); setBrowserOpen(false) }}
        mode="folder"
        title="Choose a workspace"
        description="Pick the project folder this routine's Code runs will work in."
      />
    </div>
  )
}
