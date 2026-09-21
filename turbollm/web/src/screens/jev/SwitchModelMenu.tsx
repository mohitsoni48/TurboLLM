// The way out of the playground (ADR-434 (c), (i)(5)).
//
// An inline list rather than a dropdown: it is the only navigation this screen has, and it
// answers the question the screen raises — "how do I get back to Chat?" — without a click to
// discover it. Nothing here navigates; loading a chat model clears `status.jev`, and the
// Workspace gate takes the user back on its own.
import { ApiError, track } from '../../lib/api'
import type { LoadOptions, LoadTarget } from '../../lib/model-loader'
import { toast } from '../../components/ui/sonner'
import type { LoadedJev, ModelEntry } from '../../lib/types'

const NOTHING_LOADABLE = 'Nothing else here can load on the active engine. Change it on the Engines screen.'

type SwitchDeps = {
  stopEngine(key: string): Promise<unknown>
  requestLoad(target: LoadTarget, opts?: LoadOptions): void
}

export function SwitchModelMenu({
  current,
  models,
  onPick,
}: {
  current: LoadedJev
  models: ModelEntry[]
  onPick: (m: ModelEntry) => void
}) {
  const loadable = models.filter((m) => canLoad(m, current))

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      {loadable.length === 0 ? (
        <p className="text-[13px] text-muted">{NOTHING_LOADABLE}</p>
      ) : (
        <>
          <ModelGroup title="Chat models" models={loadable.filter((m) => !m.jev)} onPick={onPick} />
          <ModelGroup title="Jev models" models={loadable.filter((m) => m.jev)} onPick={onPick} />
        </>
      )}
    </div>
  )
}

/** ADR-427: a Jev model in a POOL slot keeps its own engine, so a chat pick has to eject that
 *  slot — a primary swap already replaces what is running. A slot that refuses to eject stops
 *  the switch and says so: loading on top of it would leave the playground open with no
 *  explanation (QA E17, H19). */
export async function switchToModel(current: LoadedJev, m: ModelEntry, deps: SwitchDeps): Promise<void> {
  track('workspace', 'jev_switch_model')
  if (needsEject(current, m) && !(await ejected(current, deps))) return
  deps.requestLoad(m)
}

/** Only a primary slot is replaced by the load itself. An unknown slot (the catalog fallback
 *  cannot read one) is ejected too: leaving a pool slot held keeps Workspace in the playground
 *  with nothing said, while an unnecessary stop only costs the engine a restart. */
function needsEject(current: LoadedJev, m: ModelEntry): boolean {
  return !m.jev && current.slot !== 'primary'
}

async function ejected(current: LoadedJev, deps: SwitchDeps): Promise<boolean> {
  try {
    await deps.stopEngine(current.key)
    return true
  } catch (e) {
    toast.error(switchFailureMessage(e))
    return false
  }
}

function switchFailureMessage(e: unknown): string {
  return `Could not switch model: ${e instanceof ApiError ? e.message : 'check the engine logs on the Engines screen.'}`
}

function ModelGroup({ title, models, onPick }: { title: string; models: ModelEntry[]; onPick: (m: ModelEntry) => void }) {
  if (models.length === 0) return null
  return (
    <div className="flex flex-col gap-1" role="group" aria-label={title}>
      <span className="text-[12px] font-medium text-muted">{title}</span>
      {models.map((m) => (
        <button
          key={m.key}
          type="button"
          onClick={() => onPick(m)}
          className="rounded px-2 py-1 text-left text-[13px] text-ink hover:bg-panel-2"
        >
          {m.name}
        </button>
      ))}
    </div>
  )
}

/** Only models that would really load right now — an offer that 400s is worse than no offer. */
function canLoad(m: ModelEntry, current: LoadedJev): boolean {
  return !m.incomplete && !m.parseError && m.compatibleWithActiveEngine && !m.embedding && m.key !== current.key
}
